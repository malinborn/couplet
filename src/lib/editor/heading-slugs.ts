import { StateField, type EditorState, type StateEffect } from '@codemirror/state';
import { syntaxTree, foldedRanges, unfoldEffect } from '@codemirror/language';
import { EditorView } from '@codemirror/view';

export function slugify(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Only ATX headings (`# Foo`) are indexed; setext (`Foo\n===`) is not — matches
// the rest of the editor (folding.ts, preview/headings.ts) which is also ATX-only.
function buildIndex(state: EditorState): Map<string, number> {
  const map = new Map<string, number>();
  const counts = new Map<string, number>();
  const tree = syntaxTree(state);
  const doc = state.doc;

  tree.iterate({
    enter(node) {
      const name = node.name;
      if (!name.startsWith('ATXHeading') || name.length !== 11) return;

      const headerMark = node.node.getChild('HeaderMark');
      const textFrom = headerMark ? Math.min(headerMark.to + 1, node.to) : node.from;
      const raw = doc.sliceString(textFrom, node.to);
      const base = slugify(raw);
      if (!base) return;

      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      const slug = n === 0 ? base : `${base}-${n + 1}`;
      if (!map.has(slug)) {
        map.set(slug, doc.lineAt(node.from).from);
      }
    },
  });

  return map;
}

export const headingSlugsField = StateField.define<Map<string, number>>({
  create: (state) => buildIndex(state),
  update(value, tr) {
    if (!tr.docChanged) return value;
    return buildIndex(tr.state);
  },
});

export function getHeadingPos(state: EditorState, slug: string): number | null {
  const map = state.field(headingSlugsField, false);
  if (!map) return null;
  return map.get(slug) ?? null;
}

/**
 * Ведёт ли ссылка внутрь этого же документа.
 *
 * Признак — `#` в начале, а не отсутствие `http`. Без схемы бывают и файловые
 * ссылки (`./notes.md`, `../readme.md`), и `mailto:`, и они ведут наружу:
 * приняв их за якоря, мы бы молча никуда не переходили вместо того, чтобы
 * открыть. `#` — то, чем internal link в markdown и записывается.
 *
 * Правило живёт здесь одно на всех, кто по ссылкам ходит: обработчик клика
 * (`setup.ts`), ячейки таблиц (`preview/tables.ts`) и кнопка Open в
 * инспекторе (`live-render/inspector.ts`).
 */
export function isAnchor(url: string): boolean {
  return url.startsWith('#');
}

export function navigateToHeading(view: EditorView, rawSlug: string): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawSlug);
  } catch {
    decoded = rawSlug;
  }
  const slug = slugify(decoded);
  if (!slug) return;

  const pos = getHeadingPos(view.state, slug);
  if (pos === null) return;

  const effects: StateEffect<unknown>[] = [];
  const folded = foldedRanges(view.state);
  folded.between(pos, pos + 1, (from, to) => {
    effects.push(unfoldEffect.of({ from, to }));
  });
  effects.push(EditorView.scrollIntoView(pos, { y: 'start' }));
  view.dispatch({ effects });
}
