// @vitest-environment jsdom
/**
 * The selection over code reaches the screen only if its span is INSIDE the
 * code's: the code's opaque background is what hid the selection, and a span
 * outside it would sit under that background again with every pure test of
 * `codeSelection()` still green. CM6 nests marks by precedence — higher is
 * inner — so this pins `Prec.highest` and the plugin's place outside the
 * preview compartment, through a real `EditorView`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdownExtension } from './markdown-language';
import { livePreviewPlugin } from './preview/plugin';
import { LIVE_RENDER, flavourFacet } from './preview/flavour';
import { previewCompartment } from './setup';
import { codeSelectionHighlight } from './code-selection';

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function mount(doc: string, anchor: number, head: number): EditorView {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [
      markdownExtension(),
      codeSelectionHighlight,
      // As App installs live-render, where code is never revealed.
      previewCompartment.of([livePreviewPlugin, flavourFacet.of(LIVE_RENDER)]),
    ],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  view = new EditorView({ state, parent: document.body });
  return view;
}

describe('codeSelectionHighlight in the DOM', () => {
  it('puts the selection span inside inline code (the reported case)', () => {
    const doc = 'path (локально) / `D_HR_PLATFORM_URL` here';
    const v = mount(doc, 7, doc.indexOf('PLATFORM'));
    const inside = v.contentDOM.querySelector('.cm-md-inline-code .cm-md-code-selection');
    expect(inside?.textContent).toBe('D_HR_');
  });

  it('puts the selection span inside a fenced code line and flags whole lines', () => {
    const doc = 'before\n```bash\nexport A=1\n\nexport B=2\n```\nafter';
    const v = mount(doc, 0, doc.indexOf('B=2'));
    const spans = v.contentDOM.querySelectorAll('.cm-md-code-line .cm-md-code-selection');
    expect(spans.length).toBeGreaterThan(0);
    const whole = [...v.contentDOM.querySelectorAll('.cm-md-code-line.cm-md-code-line-selected')];
    // The first line also hosts the header widget (language, Copy).
    expect(whole).toHaveLength(2);
    expect(whole[0].textContent).toMatch(/export A=1$/);
    expect(whole[1].textContent).toBe('');
  });
});
