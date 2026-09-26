import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import type { Decoration, EditorView } from '@codemirror/view';
import { markdownExtension } from '../markdown-language';
import { flavourFacet, LIVE_PREVIEW, LIVE_RENDER, type Flavour } from './flavour';
import { buildDecorations } from './plugin';
import { stripQuotePrefix } from './blocks';

interface Emitted {
  from: number;
  to: number;
  /** `line:<class>`, `mark:<class>`, `widget:<Name>` or `replace`. */
  kind: string;
}

function decorations(doc: string, flavour: Flavour, anchor = doc.length): Emitted[] {
  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [markdownExtension(), flavourFacet.of(flavour)],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  const view = { state } as unknown as EditorView;
  const out: Emitted[] = [];
  buildDecorations(view).between(0, doc.length, (from, to, value: Decoration) => {
    const spec = value.spec as { class?: string; widget?: { constructor: { name: string } } };
    let kind: string;
    if (spec.widget) kind = `widget:${spec.widget.constructor.name}`;
    else if (value.startSide < -1e8) kind = `line:${spec.class}`;
    else if (spec.class && to > from) kind = `mark:${spec.class}`;
    else kind = 'replace';
    out.push({ from, to, kind });
  });
  return out;
}

/** The text each `replace` hides, in document order. */
function hiddenText(doc: string, rows: Emitted[]): string[] {
  return rows.filter((r) => r.kind === 'replace').map((r) => doc.slice(r.from, r.to));
}

/** Line number (1-based) → the quote line class on it, if any. */
function quoteLines(doc: string, rows: Emitted[]): Record<number, string> {
  const out: Record<number, string> = {};
  for (const r of rows) {
    if (!r.kind.startsWith('line:') || !r.kind.includes('cm-md-blockquote')) continue;
    const line = doc.slice(0, r.from).split('\n').length;
    expect(out[line], `two quote line decorations on line ${line}`).toBeUndefined();
    out[line] = r.kind.slice('line:'.length);
  }
  return out;
}

const AWAY = 0; // tests put a paragraph before the quote when the caret must be outside

describe('blockquote contents are rendered', () => {
  for (const [name, flavour] of [
    ['live-preview', LIVE_PREVIEW],
    ['live-render', LIVE_RENDER],
  ] as const) {
    describe(name, () => {
      const doc = 'p\n\n> a **b** *i* `c` ~~s~~ [l](https://x.y)';

      it('decorates inline formatting inside a quote', () => {
        const rows = decorations(doc, flavour, AWAY);
        const kinds = rows.map((r) => r.kind);
        expect(kinds).toContain('mark:cm-md-bold');
        expect(kinds).toContain('mark:cm-md-italic');
        expect(kinds).toContain('mark:cm-md-inline-code');
        expect(kinds).toContain('mark:cm-md-strikethrough');
        expect(kinds).toContain('mark:cm-md-link');
        expect(hiddenText(doc, rows)).toEqual([
          '> ',
          '**',
          '**',
          '*',
          '*',
          '`',
          '`',
          '~~',
          '~~',
          '[',
          '](https://x.y)',
        ]);
      });

      it('hides every level of a nested quote and marks the line with its depth', () => {
        const nested = 'p\n\n> > deep **x**\n> back\n>\n> > again';
        const rows = decorations(nested, flavour, AWAY);
        // Touching markers are hidden as one range — see `BlockquoteLayout.hidden`.
        expect(hiddenText(nested, rows)).toEqual(['> > ', '**', '**', '> ', '>', '> > ']);
        expect(quoteLines(nested, rows)).toEqual({
          3: 'cm-md-blockquote cm-md-blockquote-d2',
          // A lazy continuation of the inner paragraph belongs to the inner quote.
          4: 'cm-md-blockquote cm-md-blockquote-d2',
          5: 'cm-md-blockquote cm-md-blockquote-d1',
          6: 'cm-md-blockquote cm-md-blockquote-d2',
        });
      });

      it('hides the second marker of a tight `>>` and a tab after `>`', () => {
        const tight = 'p\n\n>> tight\n>\ttab';
        expect(hiddenText(tight, decorations(tight, flavour, AWAY))).toEqual(['>> ', '>\t']);
      });

      it('gives a lazy continuation line the quote style', () => {
        const lazy = 'p\n\n> a\nlazy';
        expect(quoteLines(lazy, decorations(lazy, flavour, AWAY))).toEqual({
          3: 'cm-md-blockquote cm-md-blockquote-d1',
          4: 'cm-md-blockquote cm-md-blockquote-d1',
        });
      });

      it('renders a bullet, an ordered item and a checkbox inside a quote', () => {
        const lists = 'p\n\n> - a\n>   - b\n> 1. c\n> - [x] t';
        const rows = decorations(lists, flavour, AWAY);
        expect(rows.filter((r) => r.kind === 'widget:BulletWidget')).toHaveLength(2);
        expect(rows.filter((r) => r.kind === 'widget:CheckboxWidget')).toHaveLength(1);
        expect(rows.map((r) => r.kind)).toContain('mark:cm-md-list-mark cm-md-list-mark-w2');
        // The nested item still gets its list depth.
        expect(rows.map((r) => r.kind)).toContain('line:cm-md-list-d2');
        // The collapsed indent of the nested item must not reach back over
        // the space the quote marker already hides.
        const indent = rows.find((r) => r.kind === 'mark:cm-md-list-indent');
        expect(indent && lists.slice(indent.from, indent.to)).toBe('  ');
      });

      it('renders a heading inside a quote', () => {
        const h = 'p\n\n> ## head';
        const rows = decorations(h, flavour, AWAY);
        expect(rows.map((r) => r.kind)).toContain('line:cm-md-h2');
        expect(hiddenText(h, rows)).toEqual(['> ', '## ']);
      });

      it('replaces a quoted horizontal rule after the quote marker, not over it', () => {
        // Not `> a\n> ---`: that is a setext heading inside the quote.
        const hr = 'p\n\n> ***';
        const rows = decorations(hr, flavour, AWAY);
        expect(rows.map((r) => r.kind)).toContain('line:cm-md-hr');
        expect(hiddenText(hr, rows)).toEqual(['> ', '***']);
      });

      it('leaves a table inside a quote as raw text, markers still hidden', () => {
        const table = 'p\n\n> | a | b |\n> | - | - |\n> | **1** | 2 |';
        const rows = decorations(table, flavour, AWAY);
        expect(rows.some((r) => r.kind.includes('cm-md-table'))).toBe(false);
        expect(rows.some((r) => r.kind === 'widget:TableWidget')).toBe(false);
        expect(hiddenText(table, rows)).toEqual(['> ', '> ', '> ']);
      });
    });
  }
});

describe('blockquote reveal in live-preview', () => {
  const doc = 'p\n\n> > deep **x**\n> plain';

  it('shows every quote marker while the caret is anywhere in the quote', () => {
    const rows = decorations(doc, LIVE_PREVIEW, doc.indexOf('plain'));
    expect(hiddenText(doc, rows)).toEqual(['**', '**']);
  });

  it('keeps the quote bar and depth up while the markers are revealed', () => {
    const away = quoteLines(doc, decorations(doc, LIVE_PREVIEW, AWAY));
    const inside = quoteLines(doc, decorations(doc, LIVE_PREVIEW, doc.indexOf('plain')));
    expect(inside).toEqual(away);
  });

  it('reveals the inner element under the caret by its own rule', () => {
    const rows = decorations(doc, LIVE_PREVIEW, doc.indexOf('x'));
    expect(rows.map((r) => r.kind)).not.toContain('mark:cm-md-bold');
  });

  it('never reveals under live-render', () => {
    const rows = decorations(doc, LIVE_RENDER, doc.indexOf('x'));
    expect(hiddenText(doc, rows)).toEqual(['> > ', '**', '**', '> ']);
  });
});

describe('a fenced code block inside a quote', () => {
  const doc = 'p\n\n> ```js\n> const x = 1;\n> ```';

  it('is rendered as a code block, fences hidden, language read past the `>`', () => {
    const rows = decorations(doc, LIVE_RENDER, AWAY);
    const kinds = rows.map((r) => r.kind);
    expect(kinds.filter((k) => k.includes('cm-md-code-fence-hidden'))).toHaveLength(2);
    expect(kinds.some((k) => k.includes('cm-md-code-line'))).toBe(true);
    expect(kinds).toContain('widget:CodeBlockHeaderWidget');
    expect(hiddenText(doc, rows)).toEqual(['> ', '> ', '> ']);
  });

  it('never becomes a mermaid diagram — its source would carry the prefixes', () => {
    const mermaid = 'p\n\n> ```mermaid\n> graph TD; A-->B\n> ```';
    const kinds = decorations(mermaid, LIVE_RENDER, AWAY).map((r) => r.kind);
    expect(kinds.some((k) => k.includes('mermaid'))).toBe(false);
    expect(kinds).toContain('widget:CodeBlockHeaderWidget');
  });
});

describe('stripQuotePrefix — what Copy puts on the clipboard for a quoted code block', () => {
  it('drops exactly one level per quote, keeping the code indentation', () => {
    expect(stripQuotePrefix('> const x = 1;\n>     indented\n>', 1)).toBe('const x = 1;\n    indented\n');
  });

  it('keeps a `>` that belongs to the code itself', () => {
    expect(stripQuotePrefix('> > deeper\n> > > x >= 1', 2)).toBe('deeper\n> x >= 1');
  });

  it('leaves unquoted code alone', () => {
    expect(stripQuotePrefix('> not a quote', 0)).toBe('> not a quote');
  });
});
