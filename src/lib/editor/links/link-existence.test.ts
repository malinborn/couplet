// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdownExtension } from '../markdown-language';
import { documentPathField, setDocumentPath } from '../json-fence';
import { linkControlFacet, type LinkControl } from './open-link';
import { fakeLinkControl } from './fake-link-control';
import {
  LINK_CHECK_DELAY_MS,
  fileLinkPaths,
  linkExistence,
  linkExistenceField,
  setLinkExistence,
} from './link-existence';

const DOC = '[a](plan.md) [b](gone.md) [c](https://x.test) [d](#top) see [1]';

function stateFor(control: LinkControl, doc = DOC, path: string | null = '/r/a.md'): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [markdownExtension(), documentPathField, linkControlFacet.of(control), linkExistence],
  });
  return state.update({ effects: setDocumentPath.of(path) }).state;
}

let view: EditorView | null = null;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  view?.destroy();
  view = null;
  vi.useRealTimers();
});

describe('fileLinkPaths', () => {
  it('lists the resolved file targets of rendered links only', () => {
    const state = stateFor(fakeLinkControl());
    expect(fileLinkPaths(state, 0, state.doc.length)).toEqual(['/r/plan.md', '/r/gone.md']);
  });
});

describe('linkExistenceField', () => {
  it('merges answers and forgets them when the document path changes', () => {
    let state = stateFor(fakeLinkControl());
    state = state.update({ effects: setLinkExistence.of(new Map([['/r/plan.md', true]])) }).state;
    expect(state.field(linkExistenceField).get('/r/plan.md')).toBe(true);
    state = state.update({ effects: setDocumentPath.of('/other/b.md') }).state;
    expect(state.field(linkExistenceField).size).toBe(0);
  });
});

describe('the checker', () => {
  it('asks once for the links in view after a quiet period, then caches', async () => {
    const control = fakeLinkControl();
    control.kinds.set('/r/gone.md', 'missing');
    view = new EditorView({ state: stateFor(control) });
    expect(control.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(LINK_CHECK_DELAY_MS + 1);
    expect(control.calls).toEqual(['pathKinds:/r/plan.md,/r/gone.md']);
    const known = view.state.field(linkExistenceField);
    expect(known.get('/r/plan.md')).toBe(true);
    expect(known.get('/r/gone.md')).toBe(false);

    view.dispatch({ changes: { from: view.state.doc.length, insert: ' more' } });
    await vi.advanceTimersByTimeAsync(LINK_CHECK_DELAY_MS + 1);
    expect(control.calls).toHaveLength(1);
  });

  it('a failed ask leaves the links unknown and is retried on the next change', async () => {
    let fail = true;
    const control = fakeLinkControl();
    const pathKinds = control.pathKinds;
    control.pathKinds = (paths) => (fail ? Promise.reject(new Error('down')) : pathKinds(paths));
    view = new EditorView({ state: stateFor(control) });
    await vi.advanceTimersByTimeAsync(LINK_CHECK_DELAY_MS + 1);
    expect(view.state.field(linkExistenceField).size).toBe(0);
    fail = false;
    view.dispatch({ changes: { from: 0, insert: ' ' } });
    await vi.advanceTimersByTimeAsync(LINK_CHECK_DELAY_MS + 1);
    expect(view.state.field(linkExistenceField).get('/r/plan.md')).toBe(true);
  });

  it('a state shown again (a tab switched back to) re-checks what it knew', async () => {
    const control = fakeLinkControl();
    control.kinds.set('/r/gone.md', 'missing');
    view = new EditorView({ state: stateFor(control) });
    await vi.advanceTimersByTimeAsync(LINK_CHECK_DELAY_MS + 1);
    const cached = view.state;
    expect(cached.field(linkExistenceField).get('/r/gone.md')).toBe(false);

    control.kinds.delete('/r/gone.md'); // «Create» in another tab saved it
    view.setState(stateFor(control, 'other'));
    view.setState(cached);
    expect(view.state.field(linkExistenceField).get('/r/gone.md')).toBe(false); // no flicker
    await vi.advanceTimersByTimeAsync(LINK_CHECK_DELAY_MS + 1);
    expect(view.state.field(linkExistenceField).get('/r/gone.md')).toBe(true);
  });

  it('on window focus re-checks what it knows and replaces it in one go', async () => {
    const control = fakeLinkControl();
    control.kinds.set('/r/gone.md', 'missing');
    view = new EditorView({ state: stateFor(control) });
    await vi.advanceTimersByTimeAsync(LINK_CHECK_DELAY_MS + 1);
    expect(view.state.field(linkExistenceField).get('/r/gone.md')).toBe(false);

    control.kinds.delete('/r/gone.md'); // created elsewhere
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(LINK_CHECK_DELAY_MS + 1);
    expect(view.state.field(linkExistenceField).get('/r/gone.md')).toBe(true);
  });
});
