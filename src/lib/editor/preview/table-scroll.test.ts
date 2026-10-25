// @vitest-environment jsdom
/**
 * Scrolling to a match inside a rendered table goes to the cell, not to the
 * table's bottom edge (where every body row's zero-height line sits). jsdom has
 * no layout, so rects are stubbed; the browser check is in the report.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdownExtension } from '../markdown-language';
import { livePreviewPlugin } from './plugin';
import { tableModeField } from './table-state';
import { CELL_TEXT_CLASS } from './tables';
import { cellScrollDelta, tableCellScroll } from './table-scroll';
import { createExtensions } from '../setup';

const DOC = [
  'intro',
  '',
  '| h1 | h2 |',
  '| --- | --- |',
  '| a1 | 338 * 1.3 = 439.4 |',
  '| b1 | hello |',
  '',
  'after the table',
].join('\n');

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  document.body.innerHTML = '';
});

function makeView(): EditorView {
  const state = EditorState.create({
    doc: DOC,
    extensions: [markdownExtension(), tableModeField, livePreviewPlugin, tableCellScroll],
  });
  ensureSyntaxTree(state, DOC.length, 5000);
  const view = new EditorView({ state, parent: document.body });
  views.push(view);
  return view;
}

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top, toJSON: () => ({}) };
}

/** Stub layout: scroller 0–600, header row 32 px, the cell holding `needle` at `cellTop`. */
function layout(view: EditorView, needle: string, cellTop: number): void {
  view.scrollDOM.getBoundingClientRect = () => rect(0, 600);
  const header = view.dom.querySelector<HTMLElement>('.cm-md-table-row-header');
  if (header) header.getBoundingClientRect = () => rect(cellTop - 200, 32);
  const at = view.state.doc.toString().indexOf(needle);
  for (const el of view.dom.querySelectorAll<HTMLElement>(`.${CELL_TEXT_CLASS}`)) {
    if (Number(el.dataset.sourceFrom) <= at && at < Number(el.dataset.sourceTo)) {
      const cell = el.closest<HTMLElement>('.cm-md-table-cell');
      if (cell) cell.getBoundingClientRect = () => rect(cellTop, 30);
    }
  }
}

function runHandlers(
  view: EditorView,
  from: number,
  to: number,
  y: 'nearest' | 'start' | 'end' | 'center' = 'nearest'
): boolean {
  const range = EditorSelection.range(from, to);
  return view.state
    .facet(EditorView.scrollHandler)
    .some((h) => h(view, range, { x: 'nearest', y, xMargin: 5, yMargin: 5 }));
}

describe('cellScrollDelta', () => {
  const room = { top: 40, bottom: 600 };
  it.each([
    ['nearest, above', { top: -300, bottom: -270 }, 'nearest', -340],
    ['nearest, below', { top: 900, bottom: 930 }, 'nearest', 330],
    ['nearest, visible', { top: 100, bottom: 130 }, 'nearest', 0],
    ['nearest, taller than the room keeps the top', { top: 900, bottom: 2000 }, 'nearest', 860],
    ['start', { top: 900, bottom: 930 }, 'start', 860],
    ['end', { top: 900, bottom: 930 }, 'end', 330],
    ['center', { top: 900, bottom: 930 }, 'center', 595],
  ] as const)('%s', (_label, cell, y, delta) => {
    expect(cellScrollDelta(cell, room, y)).toBe(delta);
  });
});

describe('tableCellScroll', () => {
  it('scrolls down to a match in a body cell below the window', () => {
    const view = makeView();
    layout(view, '439.4', 2000);
    const at = view.state.doc.toString().indexOf('439.4');

    expect(runHandlers(view, at, at + 5)).toBe(true);
    // Below the window: its bottom lands 5 px above the scroller's bottom.
    expect(view.scrollDOM.scrollTop).toBe(2000 + 30 - 595);
  });

  it('a match in a cell above the window scrolls up to just below the header', () => {
    const view = makeView();
    view.scrollDOM.scrollTop = 5000;
    layout(view, 'hello', -1000);
    const at = view.state.doc.toString().indexOf('hello');

    expect(runHandlers(view, at, at + 5)).toBe(true);
    // jsdom clamps nothing: 5000 - (0 + 32 + 5 - (-1000)).
    expect(view.scrollDOM.scrollTop).toBe(5000 - 1037);
  });

  it('a range outside every cell, or across two cells, is left to CM6', () => {
    const view = makeView();
    layout(view, 'hello', 2000);
    const doc = view.state.doc.toString();
    expect(runHandlers(view, doc.indexOf('after'), doc.indexOf('after') + 5)).toBe(false);
    expect(runHandlers(view, doc.indexOf('a1'), doc.indexOf('439.4') + 5)).toBe(false);
  });

  it('a position outside any table returns at once, without touching the DOM', () => {
    const view = makeView();
    const query = vi.spyOn(Element.prototype, 'querySelectorAll');
    const domAt = vi.spyOn(view, 'domAtPos');
    try {
      const at = view.state.doc.toString().indexOf('after');
      expect(runHandlers(view, at, at + 5)).toBe(false);
      expect(query).not.toHaveBeenCalled();
      expect(domAt).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
      domAt.mockRestore();
    }
  });

  it('a header cell scrolls to the window top — the header is not under itself', () => {
    const view = makeView();
    view.scrollDOM.scrollTop = 5000;
    layout(view, 'h2', -1000);
    const at = view.state.doc.toString().indexOf('h2');

    expect(runHandlers(view, at, at + 2)).toBe(true);
    // No header height reserved: 5000 - (0 + 5 - (-1000)).
    expect(view.scrollDOM.scrollTop).toBe(5000 - 1005);
  });

  it("y: 'center' centres the cell in the room below the header", () => {
    const view = makeView();
    layout(view, 'hello', 2000);
    const at = view.state.doc.toString().indexOf('hello');

    expect(runHandlers(view, at, at + 5, 'center')).toBe(true);
    // Cell middle 2015, room 37–595 → middle 316.
    expect(view.scrollDOM.scrollTop).toBe(2015 - 316);
  });

  it('is installed by the editor setup', () => {
    const state = EditorState.create({ doc: '', extensions: createExtensions() });
    expect(state.facet(EditorView.scrollHandler)).toContain(
      EditorState.create({ extensions: tableCellScroll }).facet(EditorView.scrollHandler)[0]
    );
  });
});
