import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Strikethrough, Table } from '@lezer/markdown';
import type { Extension } from '@codemirror/state';

/**
 * The markdown parser configuration, in one place.
 *
 * Two consumers need it and must not disagree: the editor's own
 * `languageCompartment` in `setup.ts`, and the throwaway states
 * `format-commands.ts` builds to run the inline-format toggles over text that
 * is not in the document yet — a table cell being edited in its overlay (#60).
 * If those two parsed markdown differently, "bold" would mean one thing in a
 * paragraph and another in a cell, which is exactly the second implementation
 * the whole arrangement exists to avoid.
 *
 * GFM is explicit: without `[Strikethrough, Table]` `~~x~~` produces no node
 * at all and the strikethrough toggle would silently only ever add markers.
 */
export function markdownExtension(): Extension {
  return markdown({
    base: markdownLanguage,
    codeLanguages: languages,
    extensions: [Strikethrough, Table],
  });
}
