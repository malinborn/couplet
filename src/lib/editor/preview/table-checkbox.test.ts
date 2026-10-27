// @vitest-environment jsdom
/**
 * Task boxes in table cells: `[ ]`, `[x]`, `- [ ]` at the start of a cell are
 * drawn as a checkbox, and a click on it flips the three characters of the box
 * in that cell's source.
 *
 * Through a real `EditorView` and the real handlers, because what can go wrong
 * is positional: the table's DOM is patched in place across edits
 * (`TableWidget.updateDOM`), so a box drawn before an edit moved its cell must
 * still write where the cell is *now*.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdownExtension } from '../markdown-language';
import { livePreviewPlugin } from './plugin';
import { tableModeField } from './table-state';
import { CELL_TEXT_CLASS, TABLE_CHECKBOX_CLASS } from './tables';
import { aiCommentField } from '../ai-comment';
import { activeCellEditSession } from '../cell-edit-session';
import { readOnlyCompartment, readOnlyDocument } from '../read-only';
import { flavourFacet, LIVE_RENDER } from './flavour';
import { liveRenderExtensions } from '../live-render';

const TABLE = [
  '| Задача | ✔ | P |',
  '|---|---|---|',
  '| a | - [ ] | 48 |',
  '| b | [ ] | 45 |',
  '| c | [x] сделано | 12 |',
].join('\n');

const TWO_BOXES = [
  '| h | one | two |',
  '| --- | --- | --- |',
  '| r1 | [ ] | [X] **bold** |',
  '| r2 | * [x] | [ ] |',
].join('\n');

const views: EditorView[] = [];

afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  document.querySelectorAll('.cm-md-table-editor').forEach((el) => el.remove());
  document.body.innerHTML = '';
});

function makeView(doc: string, extra: Extension[] = []): EditorView {
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [
      markdownExtension(),
      tableModeField,
      aiCommentField,
      readOnlyCompartment.of([]),
      livePreviewPlugin,
      ...extra,
    ],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  const view = new EditorView({ state, parent: document.body });
  views.push(view);
  return view;
}

function docWith(table: string): string {
  return `intro\n\n${table}\n\nafter the table`;
}

function tableLines(view: EditorView): string[] {
  return view.state.doc.toString().split('\n').filter((l) => l.startsWith('|'));
}

/** Every task box in the table, in document order (row by row, left to right). */
function boxes(view: EditorView): HTMLInputElement[] {
  return [...view.dom.querySelectorAll<HTMLInputElement>(`input.${TABLE_CHECKBOX_CLASS}`)];
}

function mousedown(el: Element, button = 0): MouseEvent {
  const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button });
  el.dispatchEvent(e);
  return e;
}

function textElOf(box: HTMLElement): HTMLElement {
  const el = box.closest<HTMLElement>(`.${CELL_TEXT_CLASS}`);
  if (!el) throw new Error('box outside a cell text host');
  return el;
}

describe('task boxes in table cells — rendering', () => {
  it('draws a box for each box cell, checked as the source says, and hides the source', () => {
    const view = makeView(docWith(TABLE));
    const all = boxes(view);
    expect(all.map((b) => b.checked)).toEqual([false, false, true]);
    // The marker, the box and the space after it are not text on screen.
    expect(all.map((b) => textElOf(b).textContent)).toEqual(['', '', 'сделано']);
    // A plain cell is untouched.
    const p = [...view.dom.querySelectorAll<HTMLElement>(`.${CELL_TEXT_CLASS}`)].map(
      (el) => el.textContent
    );
    expect(p).toContain('48');
  });

  it('a box mid-cell stays text', () => {
    const view = makeView(docWith('| h |\n| --- |\n| a [ ] b |'));
    expect(boxes(view)).toHaveLength(0);
    expect(view.dom.textContent).toContain('a [ ] b');
  });
});

describe('task boxes in table cells — clicking', () => {
  it('mousedown flips the box in its own cell and nothing else', () => {
    const view = makeView(docWith(TABLE));
    const [a, b, c] = boxes(view);

    const e = mousedown(a);
    expect(e.defaultPrevented).toBe(true);
    expect(tableLines(view)).toEqual([
      '| Задача | ✔ | P |',
      '|---|---|---|',
      '| a | - [x] | 48 |',
      '| b | [ ] | 45 |',
      '| c | [x] сделано | 12 |',
    ]);

    mousedown(c);
    expect(tableLines(view)[4]).toBe('| c | [ ] сделано | 12 |');
    mousedown(b);
    expect(tableLines(view)[3]).toBe('| b | [x] | 45 |');

    // The DOM follows the document.
    expect(boxes(view).map((x) => x.checked)).toEqual([true, true, false]);
  });

  it('two box cells per row, across rows; `[X]` reads checked and is written back unchecked', () => {
    const view = makeView(docWith(TWO_BOXES));
    expect(boxes(view).map((b) => b.checked)).toEqual([false, true, true, false]);

    mousedown(boxes(view)[1]); // r1 / two: [X] → [ ]
    mousedown(boxes(view)[3]); // r2 / two: [ ] → [x]
    mousedown(boxes(view)[2]); // r2 / one: * [x] → * [ ]

    expect(tableLines(view)).toEqual([
      '| h | one | two |',
      '| --- | --- | --- |',
      '| r1 | [ ] | [ ] **bold** |',
      '| r2 | * [ ] | [x] |',
    ]);
    expect(boxes(view).map((b) => b.checked)).toEqual([false, false, false, true]);
  });

  it('a box drawn before an edit moved its cell writes where the cell is now', () => {
    const view = makeView(docWith(TWO_BOXES));
    const wrap = view.dom.querySelector('.cm-md-table-wrap');
    const box = boxes(view)[3]; // r2 / two

    view.dispatch({ changes: { from: 0, insert: 'typed above the table ' } });
    // Patched in place, so this is still the box built before the edit.
    expect(view.dom.querySelector('.cm-md-table-wrap')).toBe(wrap);
    expect(boxes(view)[3]).toBe(box);

    mousedown(box);
    expect(tableLines(view)[3]).toBe('| r2 | * [x] | [x] |');
    expect(view.state.doc.toString().startsWith('typed above the table intro')).toBe(true);
  });

  it('a box still on screen after its cell lost the box writes nothing', () => {
    const view = makeView(docWith(TWO_BOXES));
    const box = boxes(view)[0]; // r1 / one: "[ ]"
    const before = view.state.doc.toString();
    const at = before.indexOf('| r1 | [ ]') + '| r1 | '.length;
    // Rewrites the cell's text in place; the stale element is detached by the
    // re-render, but its handler must not write into "foo" either way.
    view.dispatch({ changes: { from: at, to: at + 3, insert: 'foo' } });
    const after = view.state.doc.toString();
    mousedown(box);
    expect(view.state.doc.toString()).toBe(after);
  });

  it('one click is one undo step', async () => {
    const { history, undo } = await import('@codemirror/commands');
    const view = makeView(docWith(TABLE), [history()]);
    mousedown(boxes(view)[1]);
    expect(tableLines(view)[3]).toBe('| b | [x] | 45 |');
    undo(view);
    expect(tableLines(view)[3]).toBe('| b | [ ] | 45 |');
  });

  it('two quick clicks on one box are two undo steps', async () => {
    const { history, undo } = await import('@codemirror/commands');
    const view = makeView(docWith(TABLE), [history()]);
    mousedown(boxes(view)[1]);
    mousedown(boxes(view)[1]);
    expect(tableLines(view)[3]).toBe('| b | [ ] | 45 |');
    undo(view);
    expect(tableLines(view)[3]).toBe('| b | [x] | 45 |');
    undo(view);
    expect(tableLines(view)[3]).toBe('| b | [ ] | 45 |');
  });

  it('the native click toggle is cancelled — the box shows the document', () => {
    const view = makeView(docWith(TABLE));
    const box = boxes(view)[0];
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    box.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(tableLines(view)[2]).toBe('| a | - [ ] | 48 |');
  });

  it('a right button does nothing', () => {
    const view = makeView(docWith(TABLE));
    const before = view.state.doc.toString();
    mousedown(boxes(view)[0], 2);
    expect(view.state.doc.toString()).toBe(before);
  });

  it('double-clicking a box does not open the cell editor', () => {
    const view = makeView(docWith(TABLE));
    boxes(view)[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(document.querySelector('.cm-md-table-editor')).toBeNull();
    // Double-clicking the cell elsewhere still does.
    const cell = boxes(view)[2].closest<HTMLElement>('.cm-md-table-cell')!;
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    const ta = document.querySelector<HTMLTextAreaElement>('.cm-md-table-editor');
    expect(ta?.value).toBe('[x] сделано');
    ta!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });

  it('an open cell edit is committed before the toggle', () => {
    const view = makeView(docWith(TABLE));
    const pCell = [...view.dom.querySelectorAll<HTMLElement>(`.${CELL_TEXT_CLASS}`)]
      .find((el) => el.textContent === '48')!
      .closest<HTMLElement>('.cm-md-table-cell')!;
    pCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    const ta = document.querySelector<HTMLTextAreaElement>('.cm-md-table-editor')!;
    ta.value = '480000';
    ta.dispatchEvent(new Event('input', { bubbles: true }));

    // The commit lengthens row a, so it moves the cell of the box in row b:
    // the toggle must run after it, against the moved cell.
    mousedown(boxes(view)[1]);

    expect(tableLines(view)).toEqual([
      '| Задача | ✔ | P |',
      '|---|---|---|',
      '| a | - [ ] | 480000 |',
      '| b | [x] | 45 |',
      '| c | [x] сделано | 12 |',
    ]);
    expect(activeCellEditSession()).toBeNull();
  });

  it('read-only: no write', () => {
    const view = makeView(docWith(TABLE));
    view.dispatch({ effects: readOnlyCompartment.reconfigure(readOnlyDocument) });
    const before = view.state.doc.toString();
    const e = mousedown(boxes(view)[0]);
    expect(e.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe(before);
    expect(view.contentDOM.getAttribute('aria-readonly')).toBe('true');
  });

  it('live-render: the same box, and the toggle passes its transaction filters', () => {
    const view = makeView(docWith(TWO_BOXES), [flavourFacet.of(LIVE_RENDER), liveRenderExtensions()]);
    expect(boxes(view)).toHaveLength(4);
    mousedown(boxes(view)[1]);
    mousedown(boxes(view)[2]);
    expect(tableLines(view)).toEqual([
      '| h | one | two |',
      '| --- | --- | --- |',
      '| r1 | [ ] | [ ] **bold** |',
      '| r2 | * [ ] | [ ] |',
    ]);
  });
});
