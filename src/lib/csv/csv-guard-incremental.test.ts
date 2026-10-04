// The guard's incremental verdict must equal the full `tableToRows` verdict for
// every transaction. Property-style: seeded random edits plus hand-picked edge
// cases, over tables with and without trailing blank lines.
import { describe, it, expect } from 'vitest';
import { EditorState, Text, type ChangeSpec } from '@codemirror/state';
import { history } from '@codemirror/commands';
import { csvEditGuard, oneTableAfter, stillOneTable } from './csv-guard';
import { rowsToTable, tableToRows } from './csv-table';

/** mulberry32 — deterministic, so a failure reproduces from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const base = rowsToTable([['id', 'name', 'city'], ['1', 'Ann', 'Kazan'], ['2', 'Bob', ''], ['', '', '']]);
const TABLES: Record<string, string> = {
  canonical: base,
  noTrailingNewline: base.slice(0, -1),
  trailingBlanks: base + '\n  \n\t\n',
  trailingBlanksNoNewline: base + '\n   ',
  headOnly: '| a | b |\n| - | - |\n',
  headOnlyBlanks: '| a | b |\n| - | - |\n\n\n',
  narrowRows: '| a | b | c |\n|---|:-:|--:|\n| 1 |\n| 1 | 2 |\n',
  oneColumn: rowsToTable([['h'], ['x'], [''], ['y']]),
  escapedPipes: '| a | b |\n| - | - |\n| x \\| | y |\n| \\| | \\|\\| |\n',
  indented: '  | a | b |\n  | - | - |\n  | 1 | 2 |  \n',
  long: rowsToTable([['a', 'b', 'c'], ...Array.from({ length: 40 }, (_, i) => [String(i), i % 3 ? 'x' : '', 'y'])]) + '\n',
};

// Not tables at the start: the incremental path must not be taken from them.
const NON_TABLES: Record<string, string> = {
  csvText: 'a,b\n1,2\n',
  textBelow: base + 'hello\n',
  blankInside: '| a |\n| - |\n\n| x |\n',
  wideRow: '| a |\n| - |\n| 1 | 2 |\n',
  empty: '',
};

const TOKENS = [
  '|', '\n', ' ', '-', ':', 'a', 'x', '\\', '\\|', '| a |', '| a | b |', '| a | b | c |',
  '| a | b | c | d |', '\n| x | y |', '\n|   |   |   |', '|---|', '| - |', '\t', '\n\n', '  \n', '', 'b|',
];

function randomInsert(r: () => number): string {
  let s = '';
  const n = Math.floor(r() * 4);
  for (let i = 0; i < n; i++) s += TOKENS[Math.floor(r() * TOKENS.length)];
  return s;
}

/** 1–3 non-overlapping random changes, or a whole-line edit. */
function randomChanges(doc: Text, r: () => number): ChangeSpec[] {
  const kind = r();
  const len = doc.length;
  if (kind < 0.15 && doc.lines > 1) {
    const line = doc.line(1 + Math.floor(r() * doc.lines));
    // delete a line with its break / blank it / replace it
    const k = r();
    if (k < 0.33) return [{ from: line.from, to: Math.min(len, line.to + 1) }];
    if (k < 0.66) return [{ from: line.from, to: line.to, insert: r() < 0.5 ? '' : '   ' }];
    return [{ from: line.from, to: line.to, insert: randomInsert(r) }];
  }
  if (kind < 0.25) return [{ from: len, insert: randomInsert(r) }];
  const count = 1 + Math.floor(r() * 3);
  const points = Array.from({ length: count * 2 }, () => Math.floor(r() * (len + 1))).sort((a, b) => a - b);
  const changes: ChangeSpec[] = [];
  for (let i = 0; i < count; i++) {
    const from = points[2 * i];
    const to = r() < 0.5 ? from : Math.min(points[2 * i + 1], from + 6);
    changes.push({ from, to, insert: randomInsert(r) });
  }
  return changes;
}

const full = (doc: Text) => tableToRows(doc.toString()).ok;

describe('stillOneTable — same verdict as tableToRows', () => {
  it('agrees on seeded random edits of every table', () => {
    let fastLong = 0;
    let totalLong = 0;
    for (const [name, md] of Object.entries(TABLES)) {
      expect(tableToRows(md).ok, name).toBe(true);
      const start = Text.of(md.split('\n'));
      for (let seed = 1; seed <= 1500; seed++) {
        const r = rng(seed * 7919 + md.length);
        const state = EditorState.create({ doc: start });
        const tr = state.update({ changes: randomChanges(start, r) });
        if (!tr.docChanged) continue;
        if (name === 'long') totalLong++;
        const verdict = stillOneTable(start, tr.changes, tr.newDoc);
        if (verdict === null) continue;
        if (name === 'long') fastLong++;
        if (verdict !== full(tr.newDoc)) {
          throw new Error(`${name} seed ${seed}: incremental ${verdict}, full ${!verdict}\n` +
            `before ${JSON.stringify(md)}\nafter  ${JSON.stringify(tr.newDoc.toString())}`);
        }
      }
    }
    // The shortcut must actually be the common path, not a perpetual fallback
    // (small tables fall back often: their head is most of the document).
    expect(fastLong / totalLong).toBeGreaterThan(0.6);
  });

  it.each([
    ['cell edit', (d: Text) => { const l = d.line(3); return { from: l.from + 2, to: l.from + 3, insert: 'ONE' }; }, true],
    ['append a row', (d: Text) => ({ from: d.line(d.lines - 1).to, insert: '\n| x | y | z |' }), true],
    ['append a too-wide row', (d: Text) => ({ from: d.line(d.lines - 1).to, insert: '\n| x | y | z | w |' }), false],
    ['delete a data row', (d: Text) => ({ from: d.line(3).from, to: d.line(4).from }), true],
    ['blank a middle row', (d: Text) => ({ from: d.line(3).from, to: d.line(3).to }), false],
    ['blank the last row', (d: Text) => ({ from: d.line(d.lines - 1).from, to: d.line(d.lines - 1).to }), true],
    ['text after the table', (d: Text) => ({ from: d.length, insert: 'hello' }), false],
    ['open a row', (d: Text) => ({ from: d.line(4).from, to: d.line(4).from + 1 }), false],
    ['escape the closing pipe', (d: Text) => ({ from: d.line(4).to - 1, insert: '\\' }), false],
  ])('%s', (_name, change, expected) => {
    const start = Text.of(TABLES.canonical.split('\n'));
    const tr = EditorState.create({ doc: start }).update({ changes: change(start) });
    expect(full(tr.newDoc)).toBe(expected);
    expect(stillOneTable(start, tr.changes, tr.newDoc)).toBe(expected);
  });

  it('a row typed below trailing blank lines is caught by the tail scan', () => {
    const start = Text.of(TABLES.trailingBlanks.split('\n'));
    const tr = EditorState.create({ doc: start }).update({ changes: { from: start.length, insert: '| 9 | 9 | 9 |' } });
    expect(full(tr.newDoc)).toBe(false);
    expect(stillOneTable(start, tr.changes, tr.newDoc)).toBe(false);
  });

  it('falls back when the header or the delimiter row is touched', () => {
    const start = Text.of(TABLES.canonical.split('\n'));
    for (const at of [start.line(1).to - 1, start.line(2).from + 1, 0]) {
      const tr = EditorState.create({ doc: start }).update({ changes: { from: at, insert: ' | x' } });
      expect(stillOneTable(start, tr.changes, tr.newDoc)).toBeNull();
    }
  });
});

describe('oneTableAfter — the guard, edit after edit', () => {
  it('accepts exactly the edits tableToRows accepts, along random walks', () => {
    for (const md of [...Object.values(TABLES), ...Object.values(NON_TABLES)]) {
      for (let walk = 1; walk <= 25; walk++) {
        const r = rng(walk * 104729 + md.length);
        let state = EditorState.create({ doc: md, extensions: [csvEditGuard, history()] });
        for (let step = 0; step < 60; step++) {
          const changes = randomChanges(state.doc, r);
          const unfiltered = state.update({ changes, filter: false });
          if (!unfiltered.docChanged) continue;
          const expected = full(unfiltered.newDoc);
          const next = state.update({ changes }).state;
          const accepted = next.doc !== state.doc;
          if (accepted !== expected) {
            throw new Error(`walk ${walk} step ${step}: guard ${accepted}, full ${expected}\n` +
              `before ${JSON.stringify(state.doc.toString())}\nafter  ${JSON.stringify(unfiltered.newDoc.toString())}`);
          }
          if (accepted) state = next;
          if (state.doc.length > 4000) break;
        }
      }
    }
  });

  it('a start document that is not a table gets the full check', () => {
    const start = EditorState.create({ doc: NON_TABLES.textBelow });
    // Removing the stray line makes it a table: only the full check can see that.
    const line = start.doc.line(start.doc.lines - 1);
    const tr = start.update({ changes: { from: line.from, to: line.to } });
    expect(oneTableAfter(tr)).toBe(true);
  });
});
