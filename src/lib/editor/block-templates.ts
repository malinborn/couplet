/** Shared block insertion templates used by hover menu and slash commands. */

import { markdownTable } from 'markdown-table';
import { t } from '../i18n';

export interface BlockTemplate {
  /** Short identifier (used as slash command suffix and hover menu detail).
   * Untranslated on purpose — `/table` is what the user types, matched
   * verbatim by `slash-commands.ts`. */
  id: string;
  /**
   * i18n key for the human-readable label — not literal text. This array is
   * module-level, evaluated before `main.ts` installs the catalog, so a
   * literal string here would freeze in whatever language happened to be
   * active at import time (normally none yet). Resolved with `t()` by
   * consumers (`hover-menu.ts`, `slash-commands.ts`), which run well after
   * boot.
   */
  labelKey: string;
  /**
   * Markdown text to insert. For most templates this is language-neutral
   * (`# `, `- `, …) and can be used as-is. The `table` template's insert is
   * NOT this static fallback — its header text is translated and its dash
   * row has to be repadded to match, which a static string can't do. Use
   * `resolveTemplateInsert()`, never `tpl.insert` directly.
   */
  insert: string;
  /** Cursor offset from end of inserted text (negative = move back). */
  cursorOffset?: number;
}

export const blockTemplates: BlockTemplate[] = [
  { id: 'h1', labelKey: 'editor.block_templates.h1', insert: '# ' },
  { id: 'h2', labelKey: 'editor.block_templates.h2', insert: '## ' },
  { id: 'h3', labelKey: 'editor.block_templates.h3', insert: '### ' },
  { id: 'h4', labelKey: 'editor.block_templates.h4', insert: '#### ' },
  { id: 'h5', labelKey: 'editor.block_templates.h5', insert: '##### ' },
  { id: 'h6', labelKey: 'editor.block_templates.h6', insert: '###### ' },
  { id: 'ul', labelKey: 'editor.block_templates.ul', insert: '- ' },
  { id: 'ol', labelKey: 'editor.block_templates.ol', insert: '1. ' },
  { id: 'task', labelKey: 'editor.block_templates.task', insert: '- [ ] ' },
  { id: 'code', labelKey: 'editor.block_templates.code', insert: '```\n\n```', cursorOffset: -4 },
  {
    id: 'table',
    labelKey: 'editor.block_templates.table',
    // English fallback only — real insertions go through
    // `resolveTemplateInsert()`, which rebuilds this with translated headers
    // and correctly repadded alignment (owner's explicit decision: inserted
    // content is translated, unlike most template metadata here).
    insert: '| Column 1 | Column 2 |\n|----------|----------|\n| -        | -        |\n',
  },
  { id: 'quote', labelKey: 'editor.block_templates.quote', insert: '> ' },
  { id: 'hr', labelKey: 'editor.block_templates.hr', insert: '---\n' },
];

/**
 * The markdown text to actually insert for `tpl`.
 *
 * Every template but `table` just returns `tpl.insert` — plain markdown
 * syntax, the same in every language. `table`'s header row is user-visible
 * prose ("Column 1" / "Column 2"), so it is rebuilt through `markdownTable()`
 * instead of read off the static field: the library recomputes the dash
 * row's width from the translated header text, which a fixed-width literal
 * cannot do once a translation is longer than the English original (e.g.
 * "Столбец 1").
 */
export function resolveTemplateInsert(tpl: BlockTemplate): string {
  if (tpl.id !== 'table') return tpl.insert;
  const columns = [
    t('editor.block_templates.table_column', { n: 1 }),
    t('editor.block_templates.table_column', { n: 2 }),
  ];
  // `-` filler for the data row: Lezer's GFM table parser excludes
  // whitespace-only rows from the Table node (see preview/CLAUDE.md), so an
  // empty cell has to carry visible content, not blank padding.
  return `${markdownTable([columns, ['-', '-']], { align: null, padding: true })}\n`;
}
