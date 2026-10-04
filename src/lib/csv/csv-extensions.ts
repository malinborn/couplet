import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { livePreviewPlugin, previewRebuild } from '../editor/preview/plugin';
import { flavourFacet, LIVE_PREVIEW } from '../editor/preview/flavour';
import { tableConfig } from '../editor/preview/table-config';
import { csvEditGuard } from './csv-guard';

/**
 * What a CSV tab puts in the preview compartment, whatever the engine: the
 * table preview, no markdown table cap (the size limit for CSV is applied
 * earlier, at the disk boundary: `CSV_TABLE_MAX_ROWS` in `csv-codec.ts`),
 * empty (not `-`) new cells, and the one-table guard. One stable array — a
 * compartment reconfigure with the same value is a no-op.
 *
 * `previewRebuild` off for selection and viewport: one table is all a CSV
 * buffer holds and a table never reveals, so a caret move or a scroll cannot
 * change the decorations — rebuilding them was a whole-document pass per
 * click.
 *
 * The `cm-csv-file-mode` class (CSS hides the caret layer, the hover gutter
 * and the ⇔ toggle) comes from `editorAttributes`, not `classList`: CM6
 * rebuilds the editor's whole `class` attribute whenever focus changes
 * ("cm-editor" + cm-focused + theme classes + editorAttributes), so a class
 * added by hand vanished the moment the user left a cell overlay — and the
 * table-tall caret came back.
 */
export const csvPreviewExtensions: Extension = [
  livePreviewPlugin,
  flavourFacet.of(LIVE_PREVIEW),
  tableConfig.of({ maxLines: Infinity, placeholder: '' }),
  previewRebuild.of({ onSelection: false, onViewport: false }),
  csvEditGuard,
  EditorView.editorAttributes.of({ class: 'cm-csv-file-mode' }),
];
