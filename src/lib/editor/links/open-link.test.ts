import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn(() => Promise.resolve()) }));

import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { markdownExtension } from '../markdown-language';
import { headingSlugsField } from '../heading-slugs';
import { documentPathField, setDocumentPath } from '../json-fence';
import {
  linkActionFor,
  linkControlFacet,
  openButtonLabel,
  openLink,
  resolveInState,
  type LinkControl,
} from './open-link';
import { fakeLinkControl } from './fake-link-control';

function viewFor(doc: string, docPath: string | null, control: LinkControl | null) {
  let state = EditorState.create({
    doc,
    extensions: [
      markdownExtension(),
      headingSlugsField,
      documentPathField,
      ...(control ? [linkControlFacet.of(control)] : []),
    ],
  });
  state = state.update({ effects: setDocumentPath.of(docPath) }).state;
  const dispatch = vi.fn();
  return { view: { state, dispatch } as unknown as EditorView, dispatch };
}

beforeEach(() => vi.mocked(shellOpen).mockClear());

describe('openLink', () => {
  it('jumps to a heading for #slug and never asks the control', async () => {
    const control = fakeLinkControl();
    const { view, dispatch } = viewFor('# Risks\n', '/r/a.md', control);
    await openLink(view, '#risks');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(control.calls).toEqual([]);
  });

  it('hands an external URL to the shell', async () => {
    const { view } = viewFor('', '/r/a.md', fakeLinkControl());
    await openLink(view, 'https://x.test');
    expect(shellOpen).toHaveBeenCalledWith('https://x.test');
  });

  it('opens a markdown file relative to the document, with its fragment', async () => {
    const control = fakeLinkControl();
    const { view } = viewFor('', '/r/docs/a.md', control);
    await openLink(view, 'plan.md#risks');
    expect(control.calls).toEqual(['pathKinds:/r/docs/plan.md', 'openFile:/r/docs/plan.md#risks']);
  });

  it('resolves ../ and ~/', async () => {
    const control = fakeLinkControl();
    const { view } = viewFor('', '/r/docs/a.md', control);
    await openLink(view, '../notes/b.md');
    await openLink(view, '~/c.md');
    expect(control.calls).toContain('openFile:/r/notes/b.md#');
    expect(control.calls).toContain('openFile:/Users/me/c.md#');
  });

  it('shows a non-document in Finder', async () => {
    const control = fakeLinkControl();
    const { view } = viewFor('', '/r/a.md', control);
    await openLink(view, 'diagram.png');
    expect(control.calls).toContain('reveal:/r/diagram.png');
  });

  it('shows a folder in Finder, even one named like a document', async () => {
    const control = fakeLinkControl();
    control.kinds.set('/r/docs.md', 'dir');
    const { view } = viewFor('', '/r/a.md', control);
    await openLink(view, 'docs.md');
    expect(control.calls).toContain('reveal:/r/docs.md');
  });

  it('reports a missing file instead of creating it', async () => {
    const control = fakeLinkControl();
    control.kinds.set('/r/gone.md', 'missing');
    const { view } = viewFor('', '/r/a.md', control);
    await openLink(view, 'gone.md');
    expect(control.calls).toEqual(['pathKinds:/r/gone.md', 'missing:/r/gone.md']);
  });

  it('a missing file a tab already holds (after «Create») opens that tab', async () => {
    const control = fakeLinkControl();
    control.kinds.set('/r/gone.md', 'missing');
    control.held.add('/r/gone.md');
    const { view } = viewFor('', '/r/a.md', control);
    await openLink(view, 'gone.md#top');
    expect(control.calls).toEqual(['pathKinds:/r/gone.md', 'openFile:/r/gone.md#top']);
  });

  it('when asking who holds it fails, a missing file is missing', async () => {
    const control = fakeLinkControl({ holds: () => Promise.reject(new Error('ipc down')) });
    control.kinds.set('/r/gone.md', 'missing');
    const { view } = viewFor('', '/r/a.md', control);
    await openLink(view, 'gone.md');
    expect(control.calls).toEqual(['pathKinds:/r/gone.md', 'missing:/r/gone.md']);
  });

  it('a relative link in an untitled document is unresolvable', async () => {
    const control = fakeLinkControl();
    const { view } = viewFor('', null, control);
    await openLink(view, 'plan.md');
    expect(control.calls).toEqual(['unresolvable:plan.md:untitled']);
  });

  it('a ~/ link before the home folder is known says so, not "save first"', async () => {
    const control = fakeLinkControl({ home: () => null });
    const { view } = viewFor('', '/r/a.md', control);
    await openLink(view, '~/b.md');
    expect(control.calls).toEqual(['unresolvable:~/b.md:no-home']);
  });

  it('an empty destination does nothing at all', async () => {
    const control = fakeLinkControl();
    const { view } = viewFor('', '/r/a.md', control);
    await openLink(view, '<>');
    expect(control.calls).toEqual([]);
    expect(shellOpen).not.toHaveBeenCalled();
  });

  it('opens the document anyway when the kind cannot be asked', async () => {
    const control = fakeLinkControl({ pathKinds: () => Promise.reject(new Error('ipc down')) });
    const { view } = viewFor('', '/r/a.md', control);
    await openLink(view, 'plan.md');
    expect(control.calls).toEqual(['openFile:/r/plan.md#']);
  });

  it('never rejects when opening fails: callers fire and forget (`void openLink`)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const control = fakeLinkControl({
      openFile: () => Promise.reject(new Error('tab_open failed')),
      reveal: () => Promise.reject(new Error('no Finder')),
    });
    const { view } = viewFor('', '/r/a.md', control);
    await expect(openLink(view, 'plan.md')).resolves.toBeUndefined();
    await expect(openLink(view, 'a.png')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it('without a control keeps the old behaviour: the URL goes to the shell', async () => {
    const { view } = viewFor('', '/r/a.md', null);
    await openLink(view, 'plan.md');
    expect(shellOpen).toHaveBeenCalledWith('plan.md');
  });
});

describe('linkActionFor and openButtonLabel', () => {
  it('names what a click will do', () => {
    const { view } = viewFor('', '/r/a.md', fakeLinkControl());
    const action = (url: string) => linkActionFor(resolveInState(view.state, url), true);
    expect(action('#x')).toBe('heading');
    expect(action('https://x')).toBe('external');
    expect(action('plan.md')).toBe('open-file');
    expect(action('a.png')).toBe('reveal');
    expect(linkActionFor(resolveInState(viewFor('', null, fakeLinkControl()).view.state, 'plan.md'), true)).toBe('unresolvable');
  });

  it('without a control every non-anchor is external', () => {
    const { view } = viewFor('', '/r/a.md', null);
    expect(linkActionFor(resolveInState(view.state, 'plan.md'), false)).toBe('external');
  });

  it('labels the inspector button per action', () => {
    expect(openButtonLabel('external')).toEqual({ text: 'Open', aria: 'Open link in browser' });
    expect(openButtonLabel('open-file')).toEqual({ text: 'Open file', aria: 'Open file' });
    expect(openButtonLabel('reveal')).toEqual({ text: 'Show in Finder', aria: 'Show in Finder' });
    expect(openButtonLabel('heading')).toEqual({ text: 'Jump to heading', aria: 'Jump to the heading' });
  });
});
