// @vitest-environment jsdom
/**
 * The `tableConfig` facet wired through a real `EditorView`.
 *
 * The facet's pure parts are covered in `table-config.test.ts`. What only a
 * view can show is the wiring: `decorateTable` has to read `maxLines` from the
 * state, and `livePreviewPlugin` has to rebuild when a compartment reconfigure
 * swaps the config — that transaction changes neither document nor selection,
 * so without the plugin's own check the widget would not appear until the next
 * keystroke.
 */
import { describe, it, expect } from 'vitest';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdownExtension } from '../markdown-language';
import { livePreviewPlugin } from './plugin';
import { tableConfig, DEFAULT_TABLE_CONFIG } from './table-config';

/** A table of `lines` source lines: header, delimiter, then data rows. */
function table(lines: number): string {
  const out = ['| a | b |', '| - | - |'];
  for (let i = 0; i < lines - 2; i++) out.push(`| ${i} | x |`);
  return out.join('\n');
}

describe('tableConfig through the view', () => {
  it('a reconfigure that lifts the cap draws a table the default left raw', () => {
    const doc = table(501);
    const config = new Compartment();
    const state = EditorState.create({
      doc,
      extensions: [markdownExtension(), config.of(tableConfig.of(DEFAULT_TABLE_CONFIG)), livePreviewPlugin],
    });
    // The parse budget would otherwise stop short of a 501-line table, and a
    // partial Table node is shorter than the cap — the test would pass for the
    // wrong reason.
    expect(ensureSyntaxTree(state, doc.length, 5000)).not.toBeNull();
    const view = new EditorView({ state });
    // `ensureSyntaxTree` advanced the parse outside the view, so the next
    // transaction — whatever it is — swaps in the finished tree and the plugin
    // rebuilds on `treeChanged`. Spend that on an empty transaction first, or
    // the reconfigure below would pass even with no `tableConfigChanged` check.
    view.dispatch({});

    expect(view.dom.querySelector('.cm-md-table')).toBeNull();

    view.dispatch({ effects: config.reconfigure(tableConfig.of({ maxLines: Infinity, placeholder: '' })) });

    expect(view.dom.querySelector('.cm-md-table')).not.toBeNull();
    view.destroy();
  });
});
