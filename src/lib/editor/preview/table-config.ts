import { Facet } from '@codemirror/state';

/**
 * What a document type may tune about table rendering, and nothing else.
 *
 * - `maxLines`: tables longer than this stay raw markdown (a performance guard
 *   for prose documents; a CSV document lifts it).
 * - `placeholder`: what a new row's or new column's cells hold. Markdown
 *   keeps `-`; a CSV document uses `''`, since `-` would be written to the
 *   file as data.
 *
 * The default is today's behaviour, so a state that never provides the facet
 * (every markdown document) is unaffected.
 */
export interface TableConfig {
  maxLines: number;
  placeholder: string;
}

/**
 * Markdown default: 1000 data rows (+ header and delimiter lines). Measured
 * 2026-10-04 in WebKit after the zebra and `updateDOM` work: up to 1000 rows a
 * document with one table types, moves the caret and commits cells exactly
 * like one with no table; from ~1500 a cell commit misses a frame and typing
 * below the table makes CM6 re-measure its viewport several times; 2000 adds
 * 30–40 ms per keystroke in the app. Raising it further needs those two fixed
 * first (see `src/lib/editor/preview/CLAUDE.md`, "CSV documents").
 */
export const DEFAULT_TABLE_CONFIG: Readonly<TableConfig> = Object.freeze({ maxLines: 1002, placeholder: '-' });

export const tableConfig: Facet<Readonly<TableConfig>, Readonly<TableConfig>> = Facet.define({
  combine: (values) => (values.length ? values[values.length - 1] : DEFAULT_TABLE_CONFIG),
});
