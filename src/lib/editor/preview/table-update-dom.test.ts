// @vitest-environment jsdom
/**
 * `TableWidget.updateDOM` — the table's DOM patched in place instead of rebuilt.
 *
 * The danger in keeping a DOM across edits is not the patch itself but every
 * handler built with it: a commit moves every position after the edited cell,
 * typing above the table moves all of them, and a handler that remembered a
 * cell's range at build time would now write somewhere else. These tests go
 * through a real `EditorView` and the real handlers — double-click, the
 * overlay's keys, the parked-caret replay, the row/column buttons — always
 * *after* an edit that was patched in, and always assert both that the DOM was
 * kept (so the handler really is the old one) and where the write landed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdownExtension } from '../markdown-language';
import { livePreviewPlugin } from './plugin';
import { tableModeField, getTableMode } from './table-state';
import { CELL_TEXT_CLASS } from './tables';
import { addAiComment, aiCommentField, removeAiComment, type CommentActions } from '../ai-comment';
import { activeCellEditSession } from '../cell-edit-session';

const TABLE = [
  '| h1 | h2 | h3 |',
  '| --- | --- | --- |',
  '| a1 | a2 | a3 |',
  '| b1 | b2 | b3 |',
].join('\n');

const views: EditorView[] = [];

afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  document.querySelectorAll('.cm-md-table-editor').forEach((el) => el.remove());
  document.body.innerHTML = '';
});

function makeView(doc: string): EditorView {
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

/** A doc with prose around the table, caret parked well after it. */
function docWithTable(table = TABLE): string {
  return `intro\n\n${table}\n\nafter the table`;
}

function wrapEl(view: EditorView): HTMLElement {
  const el = view.dom.querySelector<HTMLElement>('.cm-md-table-wrap');
  if (!el) throw new Error('no table widget');
  return el;
}

function textEls(view: EditorView): HTMLElement[] {
  return [...view.dom.querySelectorAll<HTMLElement>(`.${CELL_TEXT_CLASS}`)];
}

function textEl(view: EditorView, text: string): HTMLElement {
  const el = textEls(view).find((e) => e.textContent === text);
  if (!el) throw new Error(`no cell reading "${text}"`);
  return el;
}

function cellOf(el: HTMLElement): HTMLElement {
  const cell = el.closest<HTMLElement>('.cm-md-table-cell');
  if (!cell) throw new Error('no cell');
  return cell;
}

function overlay(): HTMLTextAreaElement {
  const ta = document.querySelector<HTMLTextAreaElement>('.cm-md-table-editor');
  if (!ta) throw new Error('no cell edit overlay');
  return ta;
}

function dblclick(el: HTMLElement): void {
  cellOf(el).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
}

function press(
  ta: HTMLTextAreaElement,
  key: string,
  mods: { meta?: boolean; shift?: boolean } = {}
): void {
  ta.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      metaKey: mods.meta ?? false,
      shiftKey: mods.shift ?? false,
      bubbles: true,
      cancelable: true,
    })
  );
}

function mousedown(el: Element): void {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
}

/** Double-click the cell reading `text`, replace its content, commit with ⌘↩. */
function editCell(view: EditorView, text: string, value: string): void {
  dblclick(textEl(view, text));
  const ta = overlay();
  ta.value = value;
  press(ta, 'Enter', { meta: true });
}

/** Every rendered cell's source range reads back, in the document, as what it shows. */
function expectRangesMatchDoc(view: EditorView): void {
  for (const el of textEls(view)) {
    const from = Number(el.dataset.sourceFrom);
    const to = Number(el.dataset.sourceTo);
    expect(view.state.sliceDoc(from, to)).toBe(el.textContent);
  }
}

function tableLines(view: EditorView): string[] {
  return view.state.doc.toString().split('\n').filter((l) => l.startsWith('|'));
}

describe('TableWidget.updateDOM — patched, not rebuilt', () => {
  it('typing above the table keeps the widget DOM and moves every source range', () => {
    const view = makeView(docWithTable());
    const wrap = wrapEl(view);
    const b2 = textEl(view, 'b2');

    view.dispatch({ changes: { from: 0, insert: 'more ' } });
    view.dispatch({ changes: { from: 0, insert: 'and more ' } });

    expect(wrapEl(view)).toBe(wrap);
    expect(textEl(view, 'b2')).toBe(b2);
    expect(Number(b2.dataset.sourceFrom)).toBe(view.state.doc.toString().indexOf('b2'));
    expectRangesMatchDoc(view);
  });

  it('a commit patches only the cell and keeps the rest of the DOM', () => {
    const view = makeView(docWithTable());
    const wrap = wrapEl(view);
    const a2 = textEl(view, 'a2');

    editCell(view, 'a1', 'a much longer first cell');

    expect(wrapEl(view)).toBe(wrap);
    expect(textEl(view, 'a2')).toBe(a2);
    expect(textEl(view, 'a much longer first cell')).toBeTruthy();
    expectRangesMatchDoc(view);
  });

  it('commit A, then open and commit B through the same old DOM — B lands at its new place', () => {
    const view = makeView(docWithTable());
    const wrap = wrapEl(view);

    editCell(view, 'a1', 'ALPHA ONE'); // moves a2, a3 and every b cell
    editCell(view, 'a2', 'BETA'); // a2's dblclick handler was built before the first commit
    editCell(view, 'b3', 'Z');

    expect(wrapEl(view)).toBe(wrap);
    expect(tableLines(view)).toEqual([
      '| h1 | h2 | h3 |',
      '| --- | --- | --- |',
      '| ALPHA ONE | BETA | a3 |',
      '| b1 | b2 | Z |',
    ]);
    expectRangesMatchDoc(view);
  });

  it('the overlay opened after a patch shows the cell as it is now', () => {
    const view = makeView(docWithTable());
    editCell(view, 'b1', 'new');
    view.dispatch({ changes: { from: 0, insert: 'xx' } });

    dblclick(textEl(view, 'new'));
    expect(overlay().value).toBe('new');
    press(overlay(), 'Escape');
  });

  it('Tab and Enter navigate to the right cells after in-place patches (#68)', () => {
    const view = makeView(docWithTable());
    const wrap = wrapEl(view);
    view.dispatch({ changes: { from: 0, insert: 'typed above ' } });

    dblclick(textEl(view, 'a1'));
    overlay().value = 'A1!';
    press(overlay(), 'Tab');
    // The overlay moved to a2 — found by the source range updateDOM rewrote.
    expect(overlay().value).toBe('a2');
    expect(view.dom.querySelector('.cm-md-table-cell-editing')?.textContent).toBe('a2');

    overlay().value = 'A2!';
    press(overlay(), 'Enter');
    expect(overlay().value).toBe('b2');

    overlay().value = 'B2!';
    press(overlay(), 'Enter', { meta: true });

    expect(wrapEl(view)).toBe(wrap);
    expect(tableLines(view)).toEqual([
      '| h1 | h2 | h3 |',
      '| --- | --- | --- |',
      '| A1! | A2! | a3 |',
      '| b1 | B2! | b3 |',
    ]);
  });

  it('typing into a parked cell replays into the overlay at the cell’s new place (#53)', () => {
    const view = makeView(docWithTable());
    editCell(view, 'a1', 'shifted far to the right');

    const exec = vi.fn((command: string, _ui?: boolean, value?: string): boolean => {
      const ta = document.activeElement;
      if (!(ta instanceof HTMLTextAreaElement) || command !== 'insertText') return false;
      ta.setRangeText(value ?? '', ta.selectionStart, ta.selectionEnd, 'end');
      return true;
    });
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    try {
      textEl(view, 'a3').dispatchEvent(
        new InputEvent('beforeinput', {
          inputType: 'insertText',
          data: 'Q',
          bubbles: true,
          cancelable: true,
        })
      );
      expect(exec).toHaveBeenCalledWith('insertText', false, 'Q');
      press(overlay(), 'Enter', { meta: true });
    } finally {
      Reflect.deleteProperty(document, 'execCommand');
    }

    expect(tableLines(view)[2]).toBe('| shifted far to the right | a2 | Q |');
  });

  it('a comment appearing and going away patches the highlight in place (#62)', () => {
    const view = makeView(docWithTable());
    const wrap = wrapEl(view);
    const at = view.state.doc.toString().indexOf('b2');
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
        thread: { id: 'c-aaaaaa', status: 'open', line: 1, quote: 'b2', replies: [] },
        pos: at,
        to: at + 2,
        orphaned: false,
        actions,
      }),
    });

    const mark = (): Element | null =>
      view.dom.querySelector(`.${CELL_TEXT_CLASS} [data-comment-anchor="c-aaaaaa"]`);
    expect(wrapEl(view)).toBe(wrap);
    expect(mark()?.textContent).toBe('b2');

    // Typing above moves the anchor and the cell together: still marked.
    view.dispatch({ changes: { from: 0, insert: '# ' } });
    expect(wrapEl(view)).toBe(wrap);
    expect(mark()?.textContent).toBe('b2');

    view.dispatch({ effects: removeAiComment.of('c-aaaaaa') });
    expect(wrapEl(view)).toBe(wrap);
    expect(mark()).toBeNull();
  });

  it('a row reorder keeps the shape and is patched — cells, ranges and the next edit all follow', () => {
    const view = makeView(docWithTable());
    const wrap = wrapEl(view);
    const doc = view.state.doc.toString();
    const a = '| a1 | a2 | a3 |';
    const b = '| b1 | b2 | b3 |';
    const from = doc.indexOf(a);
    view.dispatch({ changes: { from, to: from + a.length + 1 + b.length, insert: `${b}\n${a}` } });

    expect(wrapEl(view)).toBe(wrap);
    expect(textEls(view).map((e) => e.textContent)).toEqual([
      'h1', 'h2', 'h3', 'b1', 'b2', 'b3', 'a1', 'a2', 'a3',
    ]);
    expectRangesMatchDoc(view);

    // The first data row's handlers were built when it showed a1.
    editCell(view, 'b1', 'B');
    expect(tableLines(view)[2]).toBe('| B | b2 | b3 |');
  });

  it('⇔ after typing above the table toggles this table, and the mode change rebuilds', () => {
    const view = makeView(docWithTable());
    const wrap = wrapEl(view);
    view.dispatch({ changes: { from: 0, insert: 'shift ' } });
    expect(wrapEl(view)).toBe(wrap);

    mousedown(wrap.querySelector('.cm-md-table-btn-toggle')!);

    const nodeFrom = view.state.doc.toString().indexOf('| h1');
    expect(getTableMode(view.state, nodeFrom)).toBe('full');
    expect(wrapEl(view)).not.toBe(wrap);
    expect(wrapEl(view).getAttribute('data-mode')).toBe('full');
  });

  it('delete row after a patched commit rewrites exactly the table (stale nodeTo would cut it wrong)', () => {
    const view = makeView(docWithTable());
    const wrap = wrapEl(view);
    editCell(view, 'a1', 'grown a lot longer');
    expect(wrapEl(view)).toBe(wrap);

    const rows = wrap.querySelectorAll('.cm-md-table-row-data');
    mousedown(rows[1].querySelector('.cm-md-table-btn-del-row-left')!);

    const text = view.state.doc.toString();
    expect(text.startsWith('intro\n\n')).toBe(true);
    expect(text.endsWith('\n\nafter the table')).toBe(true);
    expect(text).toContain('grown a lot longer');
    expect(text).not.toContain('b1');
    // One row fewer is a different shape: rebuilt, not patched.
    expect(wrapEl(view)).not.toBe(wrap);
    expectRangesMatchDoc(view);
  });

  it('add row after typing above the table inserts under the last row', () => {
    const view = makeView(docWithTable());
    const wrap = wrapEl(view);
    view.dispatch({ changes: { from: 0, insert: 'typed ' } });
    expect(wrapEl(view)).toBe(wrap);

    mousedown(wrap.querySelector('.cm-md-table-btn-add-row')!);

    const lines = tableLines(view);
    expect(lines).toHaveLength(5);
    expect(lines[3]).toBe('| b1 | b2 | b3 |');
    expect(view.state.doc.toString().endsWith('\n\nafter the table')).toBe(true);
  });

  it('add and delete column after a patched commit use the current table', () => {
    const view = makeView(docWithTable());
    editCell(view, 'h1', 'a wider header');

    mousedown(wrapEl(view).querySelector('.cm-md-table-btn-add-col')!);
    expect(tableLines(view).every((l) => l.split('|').length === 6)).toBe(true);
    expect(tableLines(view)[0]).toContain('a wider header');

    editCell(view, 'a1', 'also wider than before');
    const wrap = wrapEl(view);
    const header = textEl(view, 'h2');
    cellOf(header).dispatchEvent(new MouseEvent('mouseenter'));
    mousedown(wrap.querySelector('.cm-md-table-col-ctrl .cm-md-table-btn-del')!);

    const lines = tableLines(view);
    expect(lines.some((l) => l.includes('h2'))).toBe(false);
    expect(lines[2]).toContain('also wider than before');
    expect(view.state.doc.toString().endsWith('\n\nafter the table')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Two tables of one shape, and the open overlay
// ---------------------------------------------------------------------------

const TABLE_A = ['| ha | hb |', '| --- | --- |', '| a1 | a2 |'].join('\n');
const TABLE_B = ['| hc | hd |', '| --- | --- |', '| b1 | b2 |'].join('\n');
const TWO_TABLES = `x\n\n${TABLE_A}\n\ny\n\n${TABLE_B}\n\nz`;

/** The `.cm-md-table-wrap` of the table whose header reads `header`. */
function wrapOf(view: EditorView, header: string): HTMLElement {
  const wrap = textEl(view, header).closest<HTMLElement>('.cm-md-table-wrap');
  if (!wrap) throw new Error(`no table with header ${header}`);
  return wrap;
}

/** Append a data row after `lastRow`, the way an AI edit would — overlay left open. */
function appendRowAfter(view: EditorView, lastRow: string, row: string): void {
  const at = view.state.doc.toString().indexOf(lastRow) + lastRow.length;
  view.dispatch({ changes: { from: at, insert: `\n${row}` } });
}

describe('updateDOM only reuses its own table, and the overlay maps its own range', () => {
  it('a row added to table A while a1 is open: ⌘↩ writes a1, not b1 of the same-shape table B', () => {
    // CM6's tile cache hands updateDOM the DOM of *any* cached widget of the
    // class — here A's old DOM, which B's new widget matches in shape.
    const view = makeView(TWO_TABLES);
    const oldA = wrapOf(view, 'ha');
    const oldB = wrapOf(view, 'hc');
    dblclick(textEl(view, 'a1'));
    overlay().value = 'EDITED';

    appendRowAfter(view, '| a1 | a2 |', '| a3 | a4 |');

    // A changed shape and was rebuilt; B moved and kept its *own* DOM. Had B
    // adopted A's old DOM, the editing class would now sit on b1.
    expect(oldA.isConnected).toBe(false);
    expect(wrapOf(view, 'hc')).toBe(oldB);
    expect(view.dom.querySelector('.cm-md-table-cell-editing')).toBeNull();

    press(overlay(), 'Enter', { meta: true });

    const text = view.state.doc.toString();
    expect(text).toContain('| EDITED | a2 |');
    expect(text).toContain(TABLE_B);
    expect(text).not.toContain('a1');
  });

  it('b1 open while a row is added to table A: the commit leaves B intact', () => {
    const view = makeView(TWO_TABLES);
    dblclick(textEl(view, 'b1'));
    overlay().value = 'B ONE';

    appendRowAfter(view, '| a1 | a2 |', '| a3 | a4 |');
    press(overlay(), 'Enter', { meta: true });

    expect(view.state.doc.toString()).toBe(
      `x\n\n${TABLE_A}\n| a3 | a4 |\n\ny\n\n${TABLE_B.replace('b1', 'B ONE')}\n\nz`
    );
  });

  it('typing between two same-shape tables keeps each table on its own DOM', () => {
    const view = makeView(TWO_TABLES);
    const a = wrapOf(view, 'ha');
    const b = wrapOf(view, 'hc');

    const at = view.state.doc.toString().indexOf('y');
    view.dispatch({ changes: { from: at, insert: 'typing ' } });

    expect(wrapOf(view, 'ha')).toBe(a);
    expect(wrapOf(view, 'hc')).toBe(b);
    expectRangesMatchDoc(view);
  });
});

describe('the overlay, opened before an edit above the table', () => {
  it('⌘↩ writes at the cell’s new place', () => {
    const view = makeView(docWithTable());
    dblclick(textEl(view, 'a2'));
    overlay().value = 'NEW';
    view.dispatch({ changes: { from: 0, insert: 'typed while the overlay was open ' } });

    press(overlay(), 'Enter', { meta: true });

    expect(tableLines(view)[2]).toBe('| a1 | NEW | a3 |');
  });

  it('Tab commits at the new place and moves to the next cell', () => {
    const view = makeView(docWithTable());
    dblclick(textEl(view, 'a2'));
    overlay().value = 'NEW';
    view.dispatch({ changes: { from: 0, insert: 'line one\nline two\n' } });

    press(overlay(), 'Tab');

    expect(tableLines(view)[2]).toBe('| a1 | NEW | a3 |');
    expect(overlay().value).toBe('a3');
    press(overlay(), 'Escape');
  });

  it('💬 (commitAndMap) maps onto the committed text at its new place', () => {
    const view = makeView(docWithTable());
    dblclick(textEl(view, 'a2'));
    overlay().value = 'commented';
    view.dispatch({ changes: { from: 0, insert: 'shift ' } });

    const session = activeCellEditSession();
    if (!session) throw new Error('no published session');
    const range = session.commitAndMap(0, 'commented'.length);

    expect(range).not.toBeNull();
    expect(tableLines(view)[2]).toBe('| a1 | commented | a3 |');
    expect(range?.from).toBe(view.state.doc.toString().indexOf('commented'));
    expect(view.state.sliceDoc(range?.from ?? 0, range?.to ?? 0)).toBe('commented');
  });

  it('a row added inside the table above the open cell: Enter still walks from the right row', () => {
    const view = makeView(docWithTable());
    dblclick(textEl(view, 'a1'));
    overlay().value = 'A!';
    // A data row slipped in between the delimiter and the open row.
    const at = view.state.doc.toString().indexOf('| a1');
    view.dispatch({ changes: { from: at, insert: '| n1 | n2 | n3 |\n' } });

    press(overlay(), 'Enter');

    expect(tableLines(view)[3]).toBe('| A! | a2 | a3 |');
    expect(overlay().value).toBe('b1');
    press(overlay(), 'Escape');
  });

  it('the open cell’s row deleted under it: the commit is refused, nothing is written', () => {
    const view = makeView(docWithTable());
    dblclick(textEl(view, 'a2'));
    overlay().value = 'lost';
    const row = '| a1 | a2 | a3 |\n';
    const at = view.state.doc.toString().indexOf(row);
    view.dispatch({ changes: { from: at, to: at + row.length } });
    const before = view.state.doc.toString();

    press(overlay(), 'Enter', { meta: true });

    expect(view.state.doc.toString()).toBe(before);
    expect(document.querySelector('.cm-md-table-editor')).toBeNull();
  });

  it('the cell rewritten by someone else: last writer wins, into the rewritten range', () => {
    const view = makeView(docWithTable());
    dblclick(textEl(view, 'a2'));
    overlay().value = 'mine';
    const at = view.state.doc.toString().indexOf('a2');
    view.dispatch({ changes: { from: at, to: at + 2, insert: 'theirs, longer' } });

    press(overlay(), 'Enter', { meta: true });

    expect(tableLines(view)[2]).toBe('| a1 | mine | a3 |');
  });
});

describe('caret parking and drags after a patch', () => {
  it('mousedown → mouseup on a cell puts the document caret at the cell’s new position', () => {
    const view = makeView(docWithTable());
    const b2 = textEl(view, 'b2');
    view.dispatch({ changes: { from: 0, insert: 'moved ' } });
    expect(textEl(view, 'b2')).toBe(b2);

    b2.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    const text = b2.firstChild;
    if (!text) throw new Error('empty cell');
    document.getSelection()?.collapse(text, 1);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    expect(view.state.selection.main.head).toBe(view.state.doc.toString().indexOf('b2') + 1);
  });

  it('row drag after a patched commit reorders the current rows', () => {
    const view = makeView(docWithTable());
    editCell(view, 'a1', 'a much longer cell');
    const rows = wrapEl(view).querySelectorAll('.cm-md-table-row-data');

    // jsdom has no layout: every rect is 0×0, so clientY -1 drops before row 0.
    mousedown(rows[1].querySelector('.cm-md-table-btn-drag-row')!);
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: -1, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    const lines = tableLines(view);
    expect(lines[2]).toMatch(/^\| b1 /);
    expect(lines[3]).toMatch(/^\| a much longer cell /);
    expect(view.state.doc.toString().endsWith('\n\nafter the table')).toBe(true);
  });

  it('column drag after a patched commit reorders the current columns', () => {
    const view = makeView(docWithTable());
    editCell(view, 'a2', 'a much longer cell');
    const wrap = wrapEl(view);

    cellOf(textEl(view, 'h2')).dispatchEvent(new MouseEvent('mouseenter'));
    mousedown(wrap.querySelector('.cm-md-table-col-ctrl .cm-md-table-btn-drag-col')!);
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: -1, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    const lines = tableLines(view);
    expect(lines[0]).toMatch(/^\| h2 +\| h1 /);
    expect(lines[2]).toMatch(/^\| a much longer cell \| a1 /);
    expect(view.state.doc.toString().endsWith('\n\nafter the table')).toBe(true);
  });
});
