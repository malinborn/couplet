// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import { EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { history, redo, undo } from '@codemirror/commands';
import { markdownExtension } from '../markdown-language';
import { setAiHighlights } from '../ai-highlight';
import { mathGhost, mathGhostField } from './ghost';

// jsdom lays nothing out; CM6's measure pass asks a Range for its rects.
if (!('getClientRects' in Range.prototype)) {
  Object.assign(Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new DOMRect() });
}

let fellThrough = 0;
const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

function makeView(doc: string, extra: Extension[] = []): EditorView {
  fellThrough = 0;
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        markdownExtension(),
        history(),
        mathGhost(),
        // Stands in for list indent etc.: what Tab does when no ghost is shown.
        keymap.of([{ key: 'Tab', run: () => (fellThrough++, true) }]),
        ...extra,
      ],
    }),
  });
  views.push(view);
  return view;
}

/** A human keystroke at the caret. */
function type(view: EditorView, text: string): void {
  const at = view.state.selection.main.head;
  view.dispatch({
    changes: { from: at, insert: text },
    selection: { anchor: at + text.length },
    userEvent: 'input.type',
  });
}

function press(view: EditorView, key: string): boolean {
  return runScopeHandlers(view, new KeyboardEvent('keydown', { key }), 'editor');
}

function ghost(view: EditorView) {
  return view.state.field(mathGhostField);
}

function ghostText(view: EditorView): string | null {
  return view.contentDOM.querySelector('.cm-math-ghost')?.textContent ?? null;
}

describe('math ghost', () => {
  it('typing `=` after an expression offers the answer', () => {
    const view = makeView('338 * 1.3 ');
    type(view, '=');
    expect(ghost(view)?.answer).toBe('439.4');
    expect(ghostText(view)).toBe(' 439.4');
  });

  it('after spaces the ghost carries no leading space', () => {
    const view = makeView('338 * 1.3 =');
    type(view, ' ');
    expect(ghostText(view)).toBe('439.4');
  });

  it('moving the caret without an edit hides it', () => {
    const view = makeView('338 * 1.3 ');
    type(view, '=');
    view.dispatch({ selection: { anchor: 0 } });
    expect(ghost(view)).toBeNull();
    expect(ghostText(view)).toBeNull();
  });

  it('Tab writes the answer with one space and is one undo step', () => {
    const view = makeView('338 * 1.3 ');
    type(view, '=');
    expect(press(view, 'Tab')).toBe(true);
    expect(view.state.doc.toString()).toBe('338 * 1.3 = 439.4');
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    expect(ghost(view)).toBeNull();
    expect(fellThrough).toBe(0);

    undo(view);
    expect(view.state.doc.toString()).toBe('338 * 1.3 =');
  });

  it('typing right after Tab does not join the accepted answer in one undo step', () => {
    const view = makeView('338 * 1.3 ');
    type(view, '=');
    press(view, 'Tab');
    type(view, '!');
    undo(view);
    expect(view.state.doc.toString()).toBe('338 * 1.3 = 439.4');
  });

  it('undoing an accept brings the ghost back, redoing it clears it', () => {
    const view = makeView('338 * 1.3 ');
    type(view, '=');
    press(view, 'Tab');
    undo(view);
    expect(ghost(view)?.answer).toBe('439.4');
    expect(ghostText(view)).toBe(' 439.4');
    redo(view);
    expect(view.state.doc.toString()).toBe('338 * 1.3 = 439.4');
    expect(ghost(view)).toBeNull();
  });

  it('a read-only document is never written: Tab falls through', () => {
    const view = makeView('338 * 1.3 ', [EditorState.readOnly.of(true)]);
    type(view, '=');
    expect(press(view, 'Tab')).toBe(true);
    expect(fellThrough).toBe(1);
    expect(view.state.doc.toString()).toBe('338 * 1.3 =');
  });

  it('the ghost is hidden from assistive technology', () => {
    const view = makeView('338 * 1.3 ');
    type(view, '=');
    expect(view.contentDOM.querySelector('.cm-math-ghost')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('Tab collapses the spaces typed after `=`', () => {
    const view = makeView('338 * 1.3 =  ');
    type(view, ' ');
    press(view, 'Tab');
    expect(view.state.doc.toString()).toBe('338 * 1.3 = 439.4');
  });

  it('Tab without a ghost falls through to the next handler', () => {
    const view = makeView('hello');
    type(view, '!');
    press(view, 'Tab');
    expect(fellThrough).toBe(1);
    expect(view.state.doc.toString()).toBe('hello!');
  });

  it('Esc hides the ghost; without one Esc is not taken', () => {
    const view = makeView('338 * 1.3 ');
    type(view, '=');
    expect(press(view, 'Escape')).toBe(true);
    expect(ghost(view)).toBeNull();
    expect(press(view, 'Escape')).toBe(false);
  });

  it('after Esc, a space brings it back', () => {
    const view = makeView('338 * 1.3 ');
    type(view, '=');
    press(view, 'Escape');
    type(view, ' ');
    expect(ghost(view)?.answer).toBe('439.4');
  });

  it('after Esc, deleting `=` and typing it again brings it back', () => {
    const view = makeView('338 * 1.3 ');
    type(view, '=');
    press(view, 'Escape');
    const end = view.state.doc.length;
    view.dispatch({
      changes: { from: end - 1, to: end },
      selection: { anchor: end - 1 },
      userEvent: 'delete.backward',
    });
    expect(ghost(view)).toBeNull();
    type(view, '=');
    expect(ghost(view)?.answer).toBe('439.4');
  });

  it('works on an old line: caret at its end, then a space', () => {
    const view = makeView('338 * 1.3 =\nдальше текст');
    view.dispatch({ selection: { anchor: 11 } });
    type(view, ' ');
    expect(ghost(view)?.answer).toBe('439.4');
  });

  it('an agent edit never offers an answer', () => {
    const view = makeView('338 * 1.3 ');
    view.dispatch({
      changes: { from: 10, insert: '=' },
      selection: { anchor: 11 },
      effects: setAiHighlights.of([{ from: 10, to: 11 }]),
    });
    expect(ghost(view)).toBeNull();
  });

  it('a reload from disk never offers an answer', () => {
    const view = makeView('338 * 1.3 ');
    view.dispatch({
      changes: { from: 10, insert: '=' },
      selection: { anchor: 11 },
      annotations: Transaction.addToHistory.of(false),
    });
    expect(ghost(view)).toBeNull();
  });

  it('an IME composition step never offers an answer', () => {
    const view = makeView('338 * 1.3 ');
    view.dispatch({
      changes: { from: 10, insert: '=' },
      selection: { anchor: 11 },
      userEvent: 'input.type.compose',
    });
    expect(ghost(view)).toBeNull();
  });

  it('a non-empty selection never offers an answer', () => {
    const view = makeView('338 * 1.3 ');
    view.dispatch({
      changes: { from: 10, insert: '=' },
      selection: { anchor: 0, head: 11 },
      userEvent: 'input.type',
    });
    expect(ghost(view)).toBeNull();
  });
});
