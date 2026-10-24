// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdownExtension } from '../markdown-language';
import { documentPathField, setDocumentPath } from '../json-fence';
import { linkControlFacet, type LinkControl } from './open-link';
import { fakeLinkControl } from './fake-link-control';
import { createDocumentState } from '../state-factory';
import {
  createLinkDropTarget,
  dropPointToClient,
  insertLinkAt,
  linkDropCaretField,
  linkTextFor,
  padLink,
  setLinkDropCaret,
} from './link-drop';

const PROJECT = { projectRoot: '/r', docPath: '/r/docs/a.md' };

function projectControl(): LinkControl {
  return fakeLinkControl({ project: async (docPath) => ({ projectRoot: '/r', docPath }) });
}

let views: EditorView[] = [];
afterEach(() => {
  for (const v of views) v.destroy();
  views = [];
});

/** A real view whose geometry jsdom cannot give: a fixed rectangle, and every point maps to `pos`. */
function viewFor(
  doc: string,
  opts: { path?: string | null; control?: LinkControl | null; readOnly?: boolean; pos?: number } = {}
): EditorView {
  const control = opts.control === undefined ? projectControl() : opts.control;
  let state = EditorState.create({
    doc,
    extensions: [
      markdownExtension(),
      documentPathField,
      linkDropCaretField,
      ...(control ? [linkControlFacet.of(control)] : []),
      ...(opts.readOnly ? [EditorState.readOnly.of(true)] : []),
    ],
  });
  state = state.update({ effects: setDocumentPath.of(opts.path === undefined ? '/r/docs/a.md' : opts.path) }).state;
  const view = new EditorView({ state });
  views.push(view);
  view.scrollDOM.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  const pos = opts.pos ?? 4;
  view.posAtCoords = (() => pos) as unknown as EditorView['posAtCoords'];
  return view;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('pure helpers', () => {
  it('linkTextFor joins one link per item with ", "', () => {
    expect(
      linkTextFor(
        [
          { path: '/r/docs/plan.md', title: null },
          { path: '/n/x.md', title: 'Ideas' },
        ],
        PROJECT.docPath,
        PROJECT.projectRoot
      )
    ).toBe('[plan](plan.md), [Ideas](/n/x.md)');
  });

  it('padLink adds a space only where the drop point touches a word', () => {
    expect(padLink('L', 'a', 'b')).toBe(' L ');
    expect(padLink('L', ' ', ' ')).toBe('L');
    expect(padLink('L', '', '')).toBe('L');
    expect(padLink('L', 'a', '.')).toBe(' L');
    expect(padLink('L', '\n', ')')).toBe('L');
  });

  it('dropPointToClient divides by the page zoom only — the position is already in points (wry)', () => {
    expect(dropPointToClient({ x: 400, y: 200 }, 1)).toEqual({ x: 400, y: 200 });
    expect(dropPointToClient({ x: 400, y: 200 }, 1.25)).toEqual({ x: 320, y: 160 });
    expect(dropPointToClient({ x: 10, y: 20 }, 0)).toEqual({ x: 10, y: 20 });
  });
});

describe('the drop caret', () => {
  it('is set, mapped through edits and cleared', () => {
    let state = EditorState.create({ doc: 'hello world', extensions: [linkDropCaretField] });
    state = state.update({ effects: setLinkDropCaret.of(5) }).state;
    state = state.update({ changes: { from: 0, insert: 'ab' } }).state;
    expect(state.field(linkDropCaretField)).toBe(7);
    state = state.update({ effects: setLinkDropCaret.of(null) }).state;
    expect(state.field(linkDropCaretField)).toBeNull();
  });

  it('is installed with a LinkControl', () => {
    expect(createDocumentState('x', 0, [], { linkControl: fakeLinkControl() }).field(linkDropCaretField, false)).toBeNull();
    expect(createDocumentState('x', 0, []).field(linkDropCaretField, false)).toBeUndefined();
  });
});

describe('insertLinkAt', () => {
  it('inserts the link, moves the caret after it and clears the drop caret', () => {
    const view = viewFor('see  here');
    view.dispatch({ effects: setLinkDropCaret.of(4) });
    expect(insertLinkAt(view, 4, [{ path: '/r/docs/plan.md', title: null }], PROJECT)).toBe(true);
    expect(view.state.doc.toString()).toBe('see [plan](plan.md) here');
    expect(view.state.selection.main.head).toBe(19);
    expect(view.state.field(linkDropCaretField)).toBeNull();
  });

  it('refuses a read-only document', () => {
    const view = viewFor('see  here', { readOnly: true });
    expect(insertLinkAt(view, 4, [{ path: '/r/docs/plan.md', title: null }], PROJECT)).toBe(false);
    expect(view.state.doc.toString()).toBe('see  here');
  });
});

describe('createLinkDropTarget', () => {
  it('the text is a target only in a markdown document with a LinkControl', () => {
    expect(createLinkDropTarget(() => viewFor('x')).over(10, 10)).toBe(true);
    expect(createLinkDropTarget(() => viewFor('x', { path: '/r/a.py' })).over(10, 10)).toBe(false);
    expect(createLinkDropTarget(() => viewFor('x', { path: '/r/t.csv' })).over(10, 10)).toBe(false);
    expect(createLinkDropTarget(() => viewFor('x', { control: null })).over(10, 10)).toBe(false);
    expect(createLinkDropTarget(() => viewFor('x', { readOnly: true })).over(10, 10)).toBe(false);
    expect(createLinkDropTarget(() => viewFor('x')).over(900, 10)).toBe(false);
    expect(createLinkDropTarget(() => undefined).over(10, 10)).toBe(false);
  });

  it('hover shows the caret under the pointer, clear removes it', () => {
    const view = viewFor('see  here', { pos: 4 });
    const target = createLinkDropTarget(() => view);
    target.hover(10, 10);
    expect(view.state.field(linkDropCaretField)).toBe(4);
    target.clear();
    expect(view.state.field(linkDropCaretField)).toBeNull();
  });

  it('drop holds the position, asks the project, then inserts there', async () => {
    const control = projectControl();
    const view = viewFor('see  here', { control, pos: 4 });
    const target = createLinkDropTarget(() => view);
    expect(target.drop(10, 10, [{ path: '/r/docs/plan.md', title: null }])).toBe(true);
    expect(view.state.field(linkDropCaretField)).toBe(4);
    await flush();
    expect(view.state.doc.toString()).toBe('see [plan](plan.md) here');
    expect(view.state.field(linkDropCaretField)).toBeNull();
  });

  it('a project that cannot be asked gives an absolute link', async () => {
    const control = fakeLinkControl({ project: () => Promise.reject(new Error('down')) });
    const view = viewFor('see  here', { control, pos: 4 });
    createLinkDropTarget(() => view).drop(10, 10, [{ path: '/r/docs/plan.md', title: null }]);
    await flush();
    expect(view.state.doc.toString()).toBe('see [plan](/r/docs/plan.md) here');
  });

  it('nothing lands in a state that replaced the dropped-on one', async () => {
    const view = viewFor('see  here', { pos: 4 });
    createLinkDropTarget(() => view).drop(10, 10, [{ path: '/r/docs/plan.md', title: null }]);
    view.setState(EditorState.create({ doc: 'other', extensions: [linkDropCaretField] }));
    await flush();
    expect(view.state.doc.toString()).toBe('other');
  });

  it('a drop with nothing to link is no drop', () => {
    const view = viewFor('x');
    expect(createLinkDropTarget(() => view).drop(10, 10, [])).toBe(false);
  });
});
