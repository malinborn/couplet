import { describe, it, expect, vi } from 'vitest';
import { EditorState, type Transaction } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { codeFolding, foldEffect } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { Strikethrough, Table } from '@lezer/markdown';
import { slugify, headingSlugsField, getHeadingPos, navigateToHeading, isAnchor } from './heading-slugs';

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        extensions: [Strikethrough, Table],
      }),
      headingSlugsField,
    ],
  });
}

describe('slugify', () => {
  const cases: Array<[string, string]> = [
    ['Hello, World!', 'hello-world'],
    ['Установка приложения!', 'установка-приложения'],
    ['Шаг 1: установка', 'шаг-1-установка'],
    ['  leading and trailing  ', 'leading-and-trailing'],
    ['multiple   spaces', 'multiple-spaces'],
    ['kebab-already-here', 'kebab-already-here'],
    ['emoji 🎉 stripped', 'emoji-stripped'],
    ['a/b\\c.d:e', 'abcde'],
    ['', ''],
    ['!!!', ''],
    // Leading/trailing dashes — both raw and produced by stripped punctuation
    ['-edge-', 'edge'],
    ['--foo--', 'foo'],
    ['!Foo!', 'foo'],
    ['Hello -- World', 'hello-world'],
  ];

  for (const [input, expected] of cases) {
    it(`"${input}" → "${expected}"`, () => {
      expect(slugify(input)).toBe(expected);
    });
  }
});

describe('headingSlugsField', () => {
  it('indexes ATX headings by slug → line start position', () => {
    const doc = '# Hello\n\nbody\n\n## Установка\n\nmore\n';
    const state = makeState(doc);
    expect(getHeadingPos(state, 'hello')).toBe(0);
    expect(getHeadingPos(state, 'установка')).toBe(doc.indexOf('## Установка'));
  });

  it('returns null for unknown slug', () => {
    const state = makeState('# A\n');
    expect(getHeadingPos(state, 'nope')).toBeNull();
  });

  it('disambiguates duplicate slugs with -2, -3 suffixes', () => {
    const doc = '## Шаг 1\n\nx\n\n## Шаг 1\n\ny\n\n## Шаг 1\n';
    const state = makeState(doc);
    const first = doc.indexOf('## Шаг 1');
    const second = doc.indexOf('## Шаг 1', first + 1);
    const third = doc.indexOf('## Шаг 1', second + 1);
    expect(getHeadingPos(state, 'шаг-1')).toBe(first);
    expect(getHeadingPos(state, 'шаг-1-2')).toBe(second);
    expect(getHeadingPos(state, 'шаг-1-3')).toBe(third);
  });

  it('ignores empty headings (no slug)', () => {
    const state = makeState('## \n\nbody\n');
    expect(getHeadingPos(state, '')).toBeNull();
  });

  it('rebuilds on document change', () => {
    const initial = makeState('# Old\n');
    expect(getHeadingPos(initial, 'old')).toBe(0);
    const tr = initial.update({ changes: { from: 0, to: initial.doc.length, insert: '# New\n' } });
    const updated = tr.state;
    expect(getHeadingPos(updated, 'new')).toBe(0);
    expect(getHeadingPos(updated, 'old')).toBeNull();
  });

  it('does not index setext headings', () => {
    const state = makeState('Foo\n===\n\nbody\n');
    expect(getHeadingPos(state, 'foo')).toBeNull();
  });
});

// Structural mock: navigateToHeading only touches view.state and view.dispatch,
// so a real EditorView (which needs DOM) isn't required.
function makeView(state: EditorState): {
  view: EditorView;
  calls: Array<{ effects: ReturnType<typeof EditorView.scrollIntoView>[] }>;
} {
  const calls: Array<{ effects: ReturnType<typeof EditorView.scrollIntoView>[] }> = [];
  const view = {
    state,
    dispatch: vi.fn((spec: { effects?: unknown }) => {
      const e = spec.effects;
      const arr = Array.isArray(e) ? e : e !== undefined ? [e] : [];
      calls.push({ effects: arr as ReturnType<typeof EditorView.scrollIntoView>[] });
    }),
  } as unknown as EditorView;
  return { view, calls };
}

describe('navigateToHeading', () => {
  it('dispatches a scrollIntoView effect for a known slug', () => {
    const { view, calls } = makeView(makeState('# Hello\n\nbody\n'));
    navigateToHeading(view, 'hello');
    expect(calls).toHaveLength(1);
    expect(calls[0].effects.length).toBeGreaterThanOrEqual(1);
  });

  it('runs raw input through slugify (uppercase + URL-encoded)', () => {
    const { view, calls } = makeView(makeState('# Установка\n\nbody\n'));
    navigateToHeading(view, '%D0%A3%D1%81%D1%82%D0%B0%D0%BD%D0%BE%D0%B2%D0%BA%D0%B0');
    expect(calls).toHaveLength(1);
  });

  it('is a silent no-op for unknown slug', () => {
    const { view, calls } = makeView(makeState('# Hello\n'));
    navigateToHeading(view, 'nope');
    expect(calls).toHaveLength(0);
  });

  it('is a silent no-op for empty fragment', () => {
    const { view, calls } = makeView(makeState('# Hello\n'));
    navigateToHeading(view, '');
    expect(calls).toHaveLength(0);
  });

  it('emits unfoldEffect when target heading is inside a folded range', () => {
    // Build a state with codeFolding extension so foldEffect can take hold,
    // and a multi-section doc so the first heading's fold contains a body line
    // plus the next heading's slug position.
    const doc = '# Top\n\nbody1\n\n## Inner\n\nbody2\n';
    const startState = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Strikethrough, Table] }),
        codeFolding(),
        headingSlugsField,
      ],
    });
    // Fold "# Top" to swallow "## Inner" too — fold range starts after the
    // first line and ends at end of doc.
    const innerPos = doc.indexOf('## Inner');
    const tr: Transaction = startState.update({
      effects: foldEffect.of({ from: doc.indexOf('\n'), to: doc.length }),
    });
    const folded = tr.state;
    const { view, calls } = makeView(folded);
    navigateToHeading(view, 'inner');
    expect(calls).toHaveLength(1);
    // Should have both an unfold effect AND a scrollIntoView effect (2+ total)
    expect(calls[0].effects.length).toBeGreaterThanOrEqual(2);
    // sanity: index points at the heading we asked for
    expect(getHeadingPos(folded, 'inner')).toBe(innerPos);
  });
});

/**
 * Признак «ссылка внутрь документа». Живёт в одном месте на три обработчика:
 * клик (`setup.ts`), ячейку таблицы (`preview/tables.ts`) и кнопку Open в
 * инспекторе (`live-render/inspector.ts`) — она на якоре раньше молчала.
 */
describe('isAnchor', () => {
  it('TreatsHashLinksAsInternal', () => {
    expect(isAnchor('#heading')).toBe(true);
    expect(isAnchor('#только-скилл-без-правки-конфига')).toBe(true);
  });

  // Не «нет http — значит своя»: без схемы бывают файловые ссылки и mailto,
  // и приняв их за якоря, мы бы молча никуда не переходили вместо открытия.
  it('DoesNotTreatSchemelessLinksAsInternal', () => {
    for (const url of ['./notes.md', '../readme.md', 'notes.md', 'mailto:a@b.c', 'example.com']) {
      expect(isAnchor(url), url).toBe(false);
    }
    expect(isAnchor('https://couplet.pro')).toBe(false);
  });
});
