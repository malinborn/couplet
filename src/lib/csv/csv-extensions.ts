import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { livePreviewPlugin } from '../editor/preview/plugin';
import { flavourFacet, LIVE_PREVIEW } from '../editor/preview/flavour';
import { tableConfig } from '../editor/preview/table-config';
import { csvEditGuard } from './csv-guard';

/**
 * What a CSV tab puts in the preview compartment, whatever the engine: the
 * table preview, no cap on rows, empty (not `-`) new cells, and the
 * one-table guard. One stable array — a compartment reconfigure with the same
 * value is a no-op.
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
  csvEditGuard,
  EditorView.editorAttributes.of({ class: 'cm-csv-file-mode' }),
];
