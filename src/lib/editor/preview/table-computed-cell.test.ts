// @vitest-environment jsdom
/**
 * Computed table cells: a cell whose whole text is `<expr> =` shows the answer
 * with a small marker, and keeps the expression in the document, the tooltip
 * and the edit overlay (math-ghost spec, "Computed table cells").
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdownExtension } from '../markdown-language';
import { livePreviewPlugin } from './plugin';
import { tableModeField } from './table-state';
import { CELL_TEXT_CLASS } from './tables';
import { COMPUTED_CELL_CLASS } from '../math/cell';
import { addAiComment, aiCommentField, type CommentActions } from '../ai-comment';

const TABLE = [
  '| Статья | Сумма |',
  '| --- | --- |',
  '| Еда | 338 * 1.3 = |',
  '| Текст | просто текст |',
].join('\n');

const views: EditorView[] = [];

afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  document.querySelectorAll('.cm-md-table-editor').forEach((el) => el.remove());
  document.body.innerHTML = '';
});

function makeView(table = TABLE): EditorView {
  const doc = `intro\n\n${table}\n\nafter the table`;
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [markdownExtension(), tableModeField, aiCommentField, livePreviewPlugin],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  const view = new EditorView({ state, parent: document.body });
  views.push(view);
  return view;
}

function wrapEl(view: EditorView): HTMLElement {
  const el = view.dom.querySelector<HTMLElement>('.cm-md-table-wrap');
  if (!el) throw new Error('no table widget');
  return el;
}

function textEls(view: EditorView): HTMLElement[] {
  return [...view.dom.querySelectorAll<HTMLElement>(`.${CELL_TEXT_CLASS}`)];
}

/** The text element whose source range reads `source` in the document. */
function cellBySource(view: EditorView, source: string): HTMLElement {
  const el = textEls(view).find(
    (e) => view.state.sliceDoc(Number(e.dataset.sourceFrom), Number(e.dataset.sourceTo)) === source
  );
  if (!el) throw new Error(`no cell with source "${source}"`);
  return el;
}

function overlay(): HTMLTextAreaElement {
  const ta = document.querySelector<HTMLTextAreaElement>('.cm-md-table-editor');
  if (!ta) throw new Error('no cell edit overlay');
  return ta;
}

function dblclick(el: HTMLElement): void {
  const cell = el.closest<HTMLElement>('.cm-md-table-cell');
  if (!cell) throw new Error('no cell');
  cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
}

function commit(ta: HTMLTextAreaElement): void {
  ta.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })
  );
}

function editCell(view: EditorView, source: string, value: string): void {
  dblclick(cellBySource(view, source));
  const ta = overlay();
  ta.value = value;
  commit(ta);
}

function tableLines(view: EditorView): string[] {
  return view.state.doc.toString().split('\n').filter((l) => l.startsWith('|'));
}

describe('computed table cells', () => {
  it('a cell reading `338 * 1.3 =` shows the answer, the marker and the expression as its title', () => {
    const view = makeView();
    const el = cellBySource(view, '338 * 1.3 =');

    expect(el.classList.contains(COMPUTED_CELL_CLASS)).toBe(true);
    expect(el.getAttribute('title')).toBe('338 * 1.3 =');
    expect(el.firstChild?.textContent).toBe('439.4');
    const mark = el.querySelector('.cm-md-cell-computed-mark');
    expect(mark?.textContent).toBe('ƒ');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    // The document keeps the expression.
    expect(tableLines(view)[2]).toBe('| Еда | 338 * 1.3 = |');
  });

  it('a plain cell renders exactly as before: its text, no class, no title, no marker', () => {
    const view = makeView();
    const el = cellBySource(view, 'просто текст');

    expect(el.classList.contains(COMPUTED_CELL_CLASS)).toBe(false);
    expect(el.hasAttribute('title')).toBe(false);
    expect(el.childNodes.length).toBe(1);
    expect(el.textContent).toBe('просто текст');
  });

  it('mirrors the input’s number style in a cell (thousands space, decimal comma)', () => {
    const view = makeView(
      ['| a | b |', '| --- | --- |', '| 1 200 * 3 = | 3 600 + 439,4 = |'].join('\n')
    );
    expect(cellBySource(view, '1 200 * 3 =').firstChild?.textContent).toBe('3 600');
    expect(cellBySource(view, '3 600 + 439,4 =').firstChild?.textContent).toBe('4 039,4');
  });

  it('a header cell computes too — one rendering path', () => {
    const view = makeView(['| 2 + 2 = | b |', '| --- | --- |', '| x | y |'].join('\n'));
    expect(cellBySource(view, '2 + 2 =').firstChild?.textContent).toBe('4');
  });

  it('prose before the expression stays text', () => {
    const view = makeView(['| a |', '| --- |', '| Итого 5 + 3 = |'].join('\n'));
    const el = cellBySource(view, 'Итого 5 + 3 =');
    expect(el.textContent).toBe('Итого 5 + 3 =');
    expect(el.classList.contains(COMPUTED_CELL_CLASS)).toBe(false);
  });

  it('the edit overlay opens the stored expression, not the answer', () => {
    const view = makeView();
    dblclick(cellBySource(view, '338 * 1.3 ='));
    expect(overlay().value).toBe('338 * 1.3 =');
  });

  it('committing a plain value turns a computed cell plain, in the same DOM', () => {
    const view = makeView();
    const wrap = wrapEl(view);
    editCell(view, '338 * 1.3 =', 'много');

    expect(wrapEl(view)).toBe(wrap);
    expect(tableLines(view)[2]).toBe('| Еда | много |');
    const el = cellBySource(view, 'много');
    expect(el.textContent).toBe('много');
    expect(el.classList.contains(COMPUTED_CELL_CLASS)).toBe(false);
    expect(el.hasAttribute('title')).toBe(false);
  });

  it('committing an expression into a plain cell makes it computed, in the same DOM', () => {
    const view = makeView();
    const wrap = wrapEl(view);
    editCell(view, 'просто текст', '10 / 4 =');

    expect(wrapEl(view)).toBe(wrap);
    const el = cellBySource(view, '10 / 4 =');
    expect(el.firstChild?.textContent).toBe('2.5');
    expect(el.classList.contains(COMPUTED_CELL_CLASS)).toBe(true);
    expect(el.getAttribute('title')).toBe('10 / 4 =');
  });

  it('keeps the source range of the expression on the element', () => {
    const view = makeView();
    const el = cellBySource(view, '338 * 1.3 =');
    const at = view.state.doc.toString().indexOf('338 * 1.3 =');
    expect(Number(el.dataset.sourceFrom)).toBe(at);
    expect(Number(el.dataset.sourceTo)).toBe(at + '338 * 1.3 ='.length);
  });

  it('a parked caret in a computed cell maps to the end of the expression', () => {
    const view = makeView();
    const el = cellBySource(view, '338 * 1.3 =');
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    const text = el.firstChild;
    if (!text) throw new Error('empty cell');
    // Between "4" and "3" of the answer: no character of the source is there.
    document.getSelection()?.collapse(text, 1);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    const at = view.state.doc.toString().indexOf('338 * 1.3 =');
    expect(view.state.selection.main.head).toBe(at + '338 * 1.3 ='.length);
  });

  it('typing into a parked computed cell appends to the expression', () => {
    const view = makeView();
    const el = cellBySource(view, '338 * 1.3 =');
    const text = el.firstChild;
    if (!text) throw new Error('empty cell');
    el.focus();
    document.getSelection()?.collapse(text, 2);

    const exec = vi.fn((command: string, _ui?: boolean, value?: string): boolean => {
      const ta = document.activeElement;
      if (!(ta instanceof HTMLTextAreaElement) || command !== 'insertText') return false;
      ta.setRangeText(value ?? '', ta.selectionStart, ta.selectionEnd, 'end');
      return true;
    });
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    try {
      el.dispatchEvent(
        new InputEvent('beforeinput', { inputType: 'insertText', data: ' ', bubbles: true, cancelable: true })
      );
      expect(overlay().value).toBe('338 * 1.3 = ');
      commit(overlay());
    } finally {
      Reflect.deleteProperty(document, 'execCommand');
    }
    // `encodeForCommit` keeps the cell as typed; the table still reads it back computed.
    expect(cellBySource(view, '338 * 1.3 =').firstChild?.textContent).toBe('439.4');
  });

  it('a comment anchored in a computed cell marks the whole answer', () => {
    const view = makeView();
    const at = view.state.doc.toString().indexOf('338');
    const actions: CommentActions = {
      save: () => {},
      flush: () => {},
      sendNow: () => {},
      resolve: () => {},
      handoff: () => {},
      insertIntoText: () => {},
    };
    view.dispatch({
      effects: addAiComment.of({
        thread: { id: 'c-bbbbbb', status: 'open', line: 1, quote: '338', replies: [] },
        pos: at,
        to: at + 3,
        orphaned: false,
        actions,
      }),
    });

    const mark = view.dom.querySelector(`.${CELL_TEXT_CLASS} [data-comment-anchor="c-bbbbbb"]`);
    expect(mark?.textContent).toBe('439.4');
  });
});
