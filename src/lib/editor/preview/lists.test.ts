import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { Strikethrough, Table } from '@lezer/markdown';
import type { Decoration } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import { flavourFacet, LIVE_PREVIEW, LIVE_RENDER, type Flavour } from './flavour.js';
import { decorateListItem, listItemDepth, listMarkColumns } from './lists.js';

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, extensions: [Strikethrough, Table] }),
    ],
  });
}

/** `[line number, depth]` for every ListItem in the document. */
function depthsByLine(doc: string): [number, number][] {
  const state = makeState(doc);
  const out: [number, number][] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'ListItem') return;
      out.push([state.doc.lineAt(node.from).number, listItemDepth(node.node)]);
    },
  });
  return out.sort((a, b) => a[0] - b[0]);
}

describe('listItemDepth', () => {
  it('counts bullet nesting from one', () => {
    const doc = [
      '- top',
      '  - second',
      '    - third',
      '      - fourth',
      '- back to top',
    ].join('\n');
    expect(depthsByLine(doc)).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 1],
    ]);
  });

  it('counts ordered nesting the same way', () => {
    const doc = ['1. one', '2. two', '   1. inner a', '   2. inner b'].join('\n');
    expect(depthsByLine(doc)).toEqual([
      [1, 1],
      [2, 1],
      [3, 2],
      [4, 2],
    ]);
  });

  it('steps by one per level regardless of how wide the source indent is', () => {
    // Four-space indents must not read as two levels — the depth comes from
    // the tree, not from counting spaces.
    const wide = ['- top', '    - second', '        - third'].join('\n');
    expect(depthsByLine(wide).map(([, d]) => d)).toEqual([1, 2, 3]);
  });

  it('counts a list nested inside a blockquote from one', () => {
    const doc = ['> - quoted top', '>   - quoted second'].join('\n');
    expect(depthsByLine(doc).map(([, d]) => d)).toEqual([1, 2]);
  });

  // #44: md-mini's own Tab used to insert two spaces whatever the marker was,
  // which never reaches an ordered item's content column. The sub-item then
  // parses as a *sibling*, which is why the rendered indent "danced": two
  // levels at the same depth, then a jump where four spaces finally nested.
  it('does not nest an ordered sub-item indented by only two spaces', () => {
    const doc = ['1. one', '  1. looks nested but is not'].join('\n');
    expect(depthsByLine(doc).map(([, d]) => d)).toEqual([1, 1]);
  });

  it('nests an ordered sub-item indented to the content column', () => {
    const doc = ['1. one', '   1. genuinely nested'].join('\n');
    expect(depthsByLine(doc).map(([, d]) => d)).toEqual([1, 2]);
  });
});

describe('listMarkColumns', () => {
  /** `[line number, columns]` for every ListItem in the document. */
  function columnsByLine(doc: string): [number, number][] {
    const state = makeState(doc);
    const out: [number, number][] = [];
    syntaxTree(state).iterate({
      enter(node) {
        if (node.name !== 'ListItem') return;
        out.push([
          state.doc.lineAt(node.from).number,
          listMarkColumns(node.node, state.doc),
        ]);
      },
    });
    return out.sort((a, b) => a[0] - b[0]);
  }

  it('reserves two columns for a bullet list', () => {
    expect(columnsByLine(['- a', '- b'].join('\n')).map(([, c]) => c)).toEqual([2, 2]);
  });

  it('reserves two columns for single-digit numbers', () => {
    expect(columnsByLine(['1. a', '2. b'].join('\n')).map(([, c]) => c)).toEqual([2, 2]);
  });

  // The whole point: `9.` gets the same box as `10.`, so one level's items
  // all start their text on the same column.
  it('widens every item of a list that reaches two digits', () => {
    const doc = ['8. a', '9. b', '10. c', '11. d'].join('\n');
    expect(columnsByLine(doc).map(([, c]) => c)).toEqual([3, 3, 3, 3]);
  });

  it('sizes a nested list independently of its parent', () => {
    const doc = ['10. ten', '    1. inner', '    2. inner two'].join('\n');
    expect(columnsByLine(doc)).toEqual([
      [1, 3],
      [2, 2],
      [3, 2],
    ]);
  });

  it('caps the box so a runaway list cannot push text off the line', () => {
    const items = Array.from({ length: 12 }, (_, i) => `${i + 995}. item`);
    expect(columnsByLine(items.join('\n')).map(([, c]) => c)).toEqual(
      items.map(() => 4)
    );
  });
});

describe('decorateListItem', () => {
  interface Emitted {
    from: number;
    to: number;
    spec: string;
  }

  /** Every decoration `decorateListItem` emits for the item on `line`. */
  function emitted(doc: string, line: number, anchor: number, flavour: Flavour): Emitted[] {
    const state = EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        markdown({ base: markdownLanguage, extensions: [Strikethrough, Table] }),
        flavourFacet.of(flavour),
      ],
    });
    const view = { state } as unknown as EditorView;
    const out: Emitted[] = [];
    const sink = {
      add(from: number, to: number, value: Decoration) {
        const spec = value.spec as { class?: string; widget?: { constructor: { name: string } } };
        out.push({
          from,
          to,
          spec: spec.class ?? (spec.widget ? spec.widget.constructor.name : 'replace'),
        });
      },
    };
    syntaxTree(state).iterate({
      enter(node) {
        if (node.name !== 'ListItem') return;
        if (state.doc.lineAt(node.from).number !== line) return;
        decorateListItem(view, node.node, sink);
      },
    });
    return out;
  }

  const doc = ['- alpha', '  - bravo'].join('\n');
  const caretOnBravo = doc.indexOf('bravo') + 1;
  const caretAway = 1;
  const layout = (rows: Emitted[]) => rows.filter((r) => r.spec.startsWith('cm-md-list'));

  it('collapses the source indent and reserves the marker column', () => {
    const out = emitted(doc, 2, caretAway, LIVE_PREVIEW);
    expect(out).toContainEqual({ from: 8, to: 10, spec: 'cm-md-list-indent' });
    expect(out).toContainEqual({
      from: 10,
      to: 11,
      spec: 'cm-md-list-mark cm-md-list-mark-w2',
    });
  });

  // Why both of those are emitted before the reveal check: clicking into an
  // item must not move it sideways.
  it('emits the same indent and marker box when the caret reveals the marker', () => {
    const away = emitted(doc, 2, caretAway, LIVE_PREVIEW);
    const on = emitted(doc, 2, caretOnBravo, LIVE_PREVIEW);
    expect(layout(on)).toEqual(layout(away));
    // …and the caret is still what decides the bullet itself.
    expect(away.some((r) => r.spec === 'BulletWidget')).toBe(true);
    expect(on.some((r) => r.spec === 'BulletWidget')).toBe(false);
  });

  it('lays a live-render item out exactly like a live-preview one', () => {
    const preview = emitted(doc, 2, caretAway, LIVE_PREVIEW);
    const render = emitted(doc, 2, caretAway, LIVE_RENDER);
    expect(render).toEqual(preview);
  });

  it('keeps the bullet up under live-render even with the caret on the line', () => {
    const out = emitted(doc, 2, caretOnBravo, LIVE_RENDER);
    expect(out.some((r) => r.spec === 'BulletWidget')).toBe(true);
  });

  it('leaves the marker column to the checkbox widget on a task item', () => {
    const out = emitted('- [ ] task', 1, 0, LIVE_PREVIEW);
    expect(out.some((r) => r.spec.includes('cm-md-list-mark'))).toBe(false);
    expect(out.some((r) => r.spec === 'CheckboxWidget')).toBe(true);
  });

  describe('a ticked task', () => {
    const done = (rows: Emitted[]) => rows.filter((r) => r.spec === 'cm-md-task-done');

    it('greys its text, starting past the space after the marker', () => {
      const text = '- [x] task';
      expect(done(emitted(text, 1, 0, LIVE_PREVIEW))).toEqual([
        { from: text.indexOf('task'), to: text.length, spec: 'cm-md-task-done' },
      ]);
    });

    it('leaves an unticked one alone', () => {
      expect(done(emitted('- [ ] task', 1, 0, LIVE_PREVIEW))).toEqual([]);
    });

    // One range per line, each starting past the indent — the line-through must
    // not hang to the left of a continuation line's first word.
    it('covers a wrapped continuation line but stops before a nested child', () => {
      const text = ['- [x] parent', '  still the parent', '  - [ ] child'].join('\n');
      const ranges = done(emitted(text, 1, 0, LIVE_PREVIEW));
      expect(ranges.map((r) => text.slice(r.from, r.to))).toEqual([
        'parent',
        'still the parent',
      ]);
    });

    it('marks a ticked child without touching its unticked parent', () => {
      const text = ['- [ ] parent', '  - [x] child'].join('\n');
      expect(done(emitted(text, 1, 0, LIVE_PREVIEW))).toEqual([]);
      const [range] = done(emitted(text, 2, 0, LIVE_PREVIEW));
      expect(text.slice(range.from, range.to)).toBe('child');
    });

    // The checkbox is drawn whatever the caret is doing, so the text it
    // describes has to follow it — otherwise clicking into a done item would
    // undo the greying while the tick stays on.
    it('stays greyed with the caret on the line, in either flavour', () => {
      const text = '- [x] task';
      const caret = text.indexOf('task') + 1;
      expect(done(emitted(text, 1, caret, LIVE_PREVIEW))).toHaveLength(1);
      expect(done(emitted(text, 1, caret, LIVE_RENDER))).toHaveLength(1);
    });

    it('adds nothing for an empty item', () => {
      expect(done(emitted('- [x]', 1, 0, LIVE_PREVIEW))).toEqual([]);
      expect(done(emitted('- [x] ', 1, 0, LIVE_PREVIEW))).toEqual([]);
    });

    // The inline decorators still run over the same span; the wrapper only
    // recolours, so bold stays bold. Guards the range, not the CSS.
    it('spans inline formatting rather than stopping at it', () => {
      const text = '- [x] **bold** and *it*';
      const [range] = done(emitted(text, 1, 0, LIVE_PREVIEW));
      expect(text.slice(range.from, range.to)).toBe('**bold** and *it*');
    });
  });
});
