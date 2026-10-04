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

export const DEFAULT_TABLE_CONFIG: Readonly<TableConfig> = Object.freeze({ maxLines: 500, placeholder: '-' });

export const tableConfig: Facet<Readonly<TableConfig>, Readonly<TableConfig>> = Facet.define({
  combine: (values) => (values.length ? values[values.length - 1] : DEFAULT_TABLE_CONFIG),
});
