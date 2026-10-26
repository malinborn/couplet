// @vitest-environment jsdom
/**
 * Computed table cells (math-ghost spec, "Computed table cells", revised
 * 2026-10-25): a cell stores `<expr> = <answer>`; a *verified* one shows the
 * answer with a small marker and the whole text as its title, anything else
 * stays text. The cell editor offers the answer as a hint chip that Tab
 * accepts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { SearchQuery } from '@codemirror/search';
import { markdownExtension } from '../markdown-language';
import { livePreviewPlugin } from './plugin';
import { tableModeField } from './table-state';
import { CELL_TEXT_CLASS } from './tables';
import { CELL_HINT_CLASS } from './cell-hint';
import { COMPUTED_CELL_CLASS } from '../math/cell';
import { addAiComment, aiCommentField, type CommentActions } from '../ai-comment';
import { collectMatches } from '../search/match-count';
import { widgetMatchRanges } from '../search/widget-matches';

const TABLE = [
  '| Статья | Сумма |',
  '| --- | --- |',
  '| Еда | 338 * 1.3 = 439.4 |',
  '| Старое | 338 * 1.3 = 500 |',
  '| Вопрос | 338 * 1.3 = |',
  '| Текст | просто текст |',
  '| Пусто | - |',
].join('\n');

const views: EditorView[] = [];

afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  document.querySelectorAll('.cm-md-table-editor').forEach((el) => el.remove());
  document.body.innerHTML = '';
  Reflect.deleteProperty(document, 'execCommand');
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

function chip(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.${CELL_HINT_CLASS}`);
}

function dblclick(el: HTMLElement): void {
  const cell = el.closest<HTMLElement>('.cm-md-table-cell');
  if (!cell) throw new Error('no cell');
  cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
}

function press(
  ta: HTMLTextAreaElement,
  key: string,
  mods: { meta?: boolean; shift?: boolean } = {}
): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key,
    metaKey: mods.meta ?? false,
    shiftKey: mods.shift ?? false,
    bubbles: true,
    cancelable: true,
  });
  ta.dispatchEvent(e);
  return e;
}

/** Type into the overlay the way the browser does: new value, caret at the end, `input`. */
function typeInto(ta: HTMLTextAreaElement, value: string): void {
  ta.value = value;
  ta.setSelectionRange(value.length, value.length);
  ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', bubbles: true }));
}

function editCell(view: EditorView, source: string, value: string): void {
  dblclick(cellBySource(view, source));
  const ta = overlay();
  ta.value = value;
  press(ta, 'Enter', { meta: true });
}

function tableLines(view: EditorView): string[] {
  return view.state.doc.toString().split('\n').filter((l) => l.startsWith('|'));
}

describe('verified cells in the table widget', () => {
  it('a cell storing the right answer shows it with the marker and the whole text as title', () => {
    const view = makeView();
    const el = cellBySource(view, '338 * 1.3 = 439.4');

    expect(el.classList.contains(COMPUTED_CELL_CLASS)).toBe(true);
    expect(el.getAttribute('title')).toBe('338 * 1.3 = 439.4');
    expect(el.firstChild?.textContent).toBe('439.4');
    const mark = el.querySelector('.cm-md-cell-computed-mark');
    expect(mark?.textContent).toBe('ƒ');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
  });

  it.each([
    ['a stale answer', '338 * 1.3 = 500'],
    ['no answer', '338 * 1.3 ='],
    ['plain text', 'просто текст'],
  ])('%s renders as text, exactly as before', (_label, source) => {
    const view = makeView();
    const el = cellBySource(view, source);
    expect(el.classList.contains(COMPUTED_CELL_CLASS)).toBe(false);
    expect(el.hasAttribute('title')).toBe(false);
    expect(el.childNodes.length).toBe(1);
    expect(el.textContent).toBe(source);
  });

  it('shows the stored number as written (thousands space, decimal comma)', () => {
    const view = makeView(
      ['| a | b |', '| --- | --- |', '| 1 200 * 3 = 3 600 | 3 600 + 439,4 = 4 039,4 |'].join('\n')
    );
    expect(cellBySource(view, '1 200 * 3 = 3 600').firstChild?.textContent).toBe('3 600');
    expect(cellBySource(view, '3 600 + 439,4 = 4 039,4').firstChild?.textContent).toBe('4 039,4');
  });

  it('the edit overlay opens the stored text', () => {
    const view = makeView();
    dblclick(cellBySource(view, '338 * 1.3 = 439.4'));
    expect(overlay().value).toBe('338 * 1.3 = 439.4');
  });

  it('committing a wrong answer turns a verified cell into text, in the same DOM', () => {
    const view = makeView();
    const wrap = wrapEl(view);
    editCell(view, '338 * 1.3 = 439.4', '338 * 1.3 = 1');

    expect(wrapEl(view)).toBe(wrap);
    const el = cellBySource(view, '338 * 1.3 = 1');
    expect(el.textContent).toBe('338 * 1.3 = 1');
    expect(el.classList.contains(COMPUTED_CELL_CLASS)).toBe(false);
    expect(el.hasAttribute('title')).toBe(false);
  });

  it('committing the right answer into a plain cell verifies it, in the same DOM', () => {
    const view = makeView();
    const wrap = wrapEl(view);
    editCell(view, 'просто текст', '10 / 4 = 2.5');

    expect(wrapEl(view)).toBe(wrap);
    const el = cellBySource(view, '10 / 4 = 2.5');
    expect(el.firstChild?.textContent).toBe('2.5');
    expect(el.getAttribute('title')).toBe('10 / 4 = 2.5');
  });

  it('a parked caret in a verified cell maps to the end of the cell text', () => {
    const view = makeView();
    const el = cellBySource(view, '338 * 1.3 = 439.4');
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    const text = el.firstChild;
    if (!text) throw new Error('empty cell');
    document.getSelection()?.collapse(text, 1);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    const at = view.state.doc.toString().indexOf('338 * 1.3 = 439.4');
    expect(view.state.selection.main.head).toBe(at + '338 * 1.3 = 439.4'.length);
  });

  it('a comment anchored anywhere in a verified cell marks the whole answer', () => {
    const view = makeView();
    const at = view.state.doc.toString().indexOf('338 * 1.3 = 439.4');
    const actions: CommentActions = {
      save: () => {},
      flush: () => {},
      sendNow: () => {},
      resolve: () => {},
      handoff: () => {},
      insertIntoText: () => {},
      compose: () => {},
      send: () => Promise.resolve(false),
      edit: () => Promise.resolve(false),
      editing: () => {},
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

describe('⌘F highlights in a verified cell', () => {
  function ranges(view: EditorView, search: string): { all: string[]; current: string[] } {
    const matches = collectMatches(view.state, new SearchQuery({ search }));
    const r = widgetMatchRanges(view, matches);
    return { all: r.all.map((x) => x.toString()), current: r.current.map((x) => x.toString()) };
  }

  it('a match of the stored answer highlights the whole rendered answer', () => {
    const view = makeView();
    expect(collectMatches(view.state, new SearchQuery({ search: '439.4' })).from).toHaveLength(1);
    expect(ranges(view, '439.4').all).toEqual(['439.4']);
  });

  it('a match inside the expression highlights the whole answer too', () => {
    const view = makeView();
    // `1.3` is in three cells; only the verified one draws something other than its source.
    const r = ranges(view, '1.3');
    expect(r.all).toContain('439.4');
    expect(r.all.filter((t) => t === '1.3')).toHaveLength(2);
  });

  it('the current match in a verified cell is drawn as current', () => {
    const view = makeView();
    const from = view.state.doc.toString().indexOf('439.4');
    view.dispatch({ selection: { anchor: from, head: from + 5 } });
    expect(ranges(view, '439.4')).toEqual({ all: [], current: ['439.4'] });
  });
});

describe('the cell editor hint', () => {
  it('typing `338 * 1.3 =` shows the chip `= 439.4 ⇥`', () => {
    const view = makeView();
    dblclick(cellBySource(view, '-'));
    typeInto(overlay(), '338 * 1.3 =');

    expect(chip()?.textContent).toBe('= 439.4 ⇥');
    expect(chip()?.getAttribute('aria-hidden')).toBe('true');
  });

  it('no chip when the caret is not at the end, or there is no question', () => {
    const view = makeView();
    dblclick(cellBySource(view, '-'));
    const ta = overlay();
    typeInto(ta, 'Итого 5 + 3 =');
    expect(chip()).toBeNull();
    typeInto(ta, '338 * 1.3 = 439.4');
    expect(chip()).toBeNull();
    typeInto(ta, '338 * 1.3 =');
    expect(chip()).not.toBeNull();
    ta.setSelectionRange(2, 2);
    ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
    expect(chip()).toBeNull();
  });

  it('opening a cell selects its text: no chip until the caret is at the end', () => {
    const view = makeView();
    dblclick(cellBySource(view, '338 * 1.3 ='));
    expect(chip()).toBeNull();
  });

  it('Tab accepts once (one narrowed insertText), the next Tab moves to the next cell', () => {
    const view = makeView();
    dblclick(cellBySource(view, '-'));
    const ta = overlay();
    typeInto(ta, '338 * 1.3 =   ');

    const exec = vi.fn((command: string, _ui?: boolean, value?: string): boolean => {
      if (command !== 'insertText') return false;
      ta.setRangeText(value ?? '', ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', bubbles: true }));
      return true;
    });
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });

    const first = press(ta, 'Tab');
    expect(first.defaultPrevented).toBe(true);
    // The spaces after `=` collapse into one. The edit is narrowed to what
    // changed: the first space stays, the other two become the answer.
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('insertText', false, '439.4');
    expect(ta.value).toBe('338 * 1.3 = 439.4');
    expect(ta.selectionStart).toBe(ta.value.length);
    expect(chip()).toBeNull();
    expect(overlay()).toBe(ta);

    // The next Tab is the table's: commit and move along the row (wrapping).
    press(ta, 'Tab');
    expect(tableLines(view)[6]).toBe('| Пусто | 338 * 1.3 = 439.4 |');
    expect(overlay()).not.toBe(ta);
    expect(overlay().value).toBe('Пусто');
  });

  it('Shift+Tab with a chip shown is the table’s: commits the question unchanged and moves back', () => {
    const view = makeView();
    dblclick(cellBySource(view, '-'));
    const ta = overlay();
    typeInto(ta, '338 * 1.3 =');
    expect(chip()).not.toBeNull();

    press(ta, 'Tab', { shift: true });

    expect(tableLines(view)[6]).toBe('| Пусто | 338 * 1.3 = |');
    expect(overlay()).not.toBe(ta);
    expect(overlay().value).toBe('Пусто');
    expect(chip()).toBeNull();
  });

  it('a chip never outlives its editor when another cell is double-clicked', () => {
    const view = makeView();
    dblclick(cellBySource(view, '-'));
    typeInto(overlay(), '338 * 1.3 =');
    expect(chip()).not.toBeNull();

    dblclick(cellBySource(view, 'просто текст'));

    expect(document.querySelectorAll('.cm-md-table-editor')).toHaveLength(1);
    expect(chip()).toBeNull();
  });

  it('Tab re-checks the text before writing: a stale chip writes nothing', () => {
    const view = makeView();
    dblclick(cellBySource(view, '-'));
    const ta = overlay();
    typeInto(ta, '338 * 1.3 =');
    // The text changes without an event the chip hears (a script, an IME).
    ta.value = '338 * 1.3 = 1';
    ta.setSelectionRange(ta.value.length, ta.value.length);

    press(ta, 'Tab');

    // No answer appended: the Tab was the table's.
    expect(tableLines(view)[6]).toBe('| Пусто | 338 * 1.3 = 1 |');
  });

  it('Tab without a chip moves to the next cell exactly as before', () => {
    const view = makeView();
    dblclick(cellBySource(view, '-'));
    const ta = overlay();
    typeInto(ta, 'просто');
    press(ta, 'Tab');

    expect(tableLines(view)[6]).toBe('| Пусто | просто |');
    expect(overlay().value).toBe('Пусто');
  });

  it('Esc hides the chip and keeps the editor; a second Esc closes it as before', () => {
    const view = makeView();
    dblclick(cellBySource(view, '-'));
    const ta = overlay();
    typeInto(ta, '338 * 1.3 =');

    press(ta, 'Escape');
    expect(chip()).toBeNull();
    expect(document.querySelector('.cm-md-table-editor')).toBe(ta);
    // A key release or a caret event does not bring a dismissed chip back.
    ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
    expect(chip()).toBeNull();

    press(ta, 'Escape');
    expect(document.querySelector('.cm-md-table-editor')).toBeNull();
    expect(tableLines(view)[6]).toBe('| Пусто | - |');
  });

  it('typing after Esc re-evaluates: a space after `=` brings the chip back', () => {
    const view = makeView();
    dblclick(cellBySource(view, '-'));
    const ta = overlay();
    typeInto(ta, '338 * 1.3 =');
    press(ta, 'Escape');
    typeInto(ta, '338 * 1.3 = ');
    expect(chip()?.textContent).toBe('= 439.4 ⇥');
  });

  it('undoing an accepted answer brings the chip back', () => {
    const view = makeView();
    dblclick(cellBySource(view, '-'));
    const ta = overlay();
    typeInto(ta, '338 * 1.3 =');
    press(ta, 'Tab');
    expect(ta.value).toBe('338 * 1.3 = 439.4');

    // The native undo restores the text and fires `input` (historyUndo).
    ta.value = '338 * 1.3 =';
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new InputEvent('input', { inputType: 'historyUndo', bubbles: true }));
    expect(chip()?.textContent).toBe('= 439.4 ⇥');
  });

  it('the chip goes away with the editor', () => {
    const view = makeView();
    dblclick(cellBySource(view, '-'));
    const ta = overlay();
    typeInto(ta, '338 * 1.3 =');
    press(ta, 'Enter', { meta: true });

    expect(chip()).toBeNull();
    // ⌘↩ commits what was typed — the hint is never written by itself.
    expect(tableLines(view)[6]).toBe('| Пусто | 338 * 1.3 = |');
  });
});
