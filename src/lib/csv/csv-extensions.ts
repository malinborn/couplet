import type { Extension } from '@codemirror/state';
import { livePreviewPlugin } from '../editor/preview/plugin';
import { flavourFacet, LIVE_PREVIEW } from '../editor/preview/flavour';
import { tableConfig } from '../editor/preview/table-config';
import { csvEditGuard } from './csv-guard';

/**
 * What a CSV tab puts in the preview compartment, whatever the engine: the
 * table preview, no cap on rows, empty (not `-`) new cells, and the
 * one-table guard. One stable array — a compartment reconfigure with the same
 * value is a no-op.
 */
export const csvPreviewExtensions: Extension = [
  livePreviewPlugin,
  flavourFacet.of(LIVE_PREVIEW),
  tableConfig.of({ maxLines: Infinity, placeholder: '' }),
  csvEditGuard,
];
