// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import TabDrawer, { type TabDrawerHandle } from './TabDrawer.svelte';
import { HOVER_OPEN_MS } from './drawer-state';
import type { TabListState, TabMeta } from './tab-model';

/*
 * The drawer's keyboard contract against a stand-in for the editor: a
 * contenteditable that records every key it receives. What is proved here is
 * where a key is DELIVERED — dispatched on `document.activeElement`, the way a
 * real key reaches the focused element — not what CodeMirror would do with it.
 */

function tab(id: string, path: string | null): TabMeta {
  return { id, path, dirty: false, openedAt: 0, viewedAt: 0, unviewed: false };
}

const LIST: TabListState = {
  tabs: [tab('a', '/p/alpha.md'), tab('b', '/p/beta.md'), tab('c', null)],
  activeId: 'a',
};

interface Harness {
  editor: HTMLElement;
  editorKeys: string[];
  handle: () => TabDrawerHandle;
  root: () => HTMLElement;
  onreorder: ReturnType<typeof vi.fn>;
  destroy: () => void;
}

let h: Harness;

beforeAll(() => {
  // jsdom lacks these; the drawer only needs them not to throw.
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
  Element.prototype.scrollTo ??= function () {} as Element['scrollTo'];
  Element.prototype.animate ??= function () {
    return { cancel() {}, finished: Promise.resolve(), onfinish: null } as unknown as Animation;
  };
  Element.prototype.getAnimations ??= () => [];
  globalThis.CSS ??= {} as typeof CSS;
  CSS.escape ??= (s: string) => s;
});

function setup(): Harness {
  const editor = document.createElement('div');
  editor.setAttribute('contenteditable', 'true');
  editor.tabIndex = 0;
  document.body.appendChild(editor);
  const editorKeys: string[] = [];
  editor.addEventListener('keydown', (e) => editorKeys.push(e.key));

  const target = document.createElement('div');
  document.body.appendChild(target);
  const props: { handle: TabDrawerHandle | undefined } = { handle: undefined };
  const onreorder = vi.fn();
  const component = mount(TabDrawer, {
    target,
    props: {
      list: LIST,
      windowNumber: 3,
      compact: false,
      source: {
        held: () => '',
        read: () => Promise.resolve(''),
        gitInfo: (paths: string[]) => Promise.resolve(paths.map(() => null)),
      },
      onactivate: () => {},
      onclose: () => {},
      onreorder,
      onnewwindows: () => {},
      get handle() {
        return props.handle;
      },
      set handle(v: TabDrawerHandle | undefined) {
        props.handle = v;
      },
    },
  });
  flushSync();
  return {
    editor,
    editorKeys,
    handle: () => {
      if (!props.handle) throw new Error('no handle');
      return props.handle;
    },
    root: () => target.querySelector<HTMLElement>('.tab-drawer')!,
    onreorder,
    destroy: () => {
      unmount(component);
      target.remove();
      editor.remove();
    },
  };
}

/** A key as the webview delivers it: to whatever has focus. */
function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const e = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...init });
  const to = document.activeElement ?? document.body;
  to.dispatchEvent(e);
  to.dispatchEvent(new KeyboardEvent('keyup', { key, code, bubbles: true, cancelable: true, ...init }));
  return e;
}

/** The editor had the last input: a key typed into it. */
function typeInEditor(): void {
  h.editor.focus();
  press('x');
  h.editorKeys.length = 0;
}

async function settle(): Promise<void> {
  flushSync();
  await tick();
  await Promise.resolve();
  flushSync();
}

function query(): string {
  return h.root().querySelector('.s-q')?.textContent ?? '';
}

function pointer(el: Element, type: string, init: MouseEventInit = {}): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: false, cancelable: true, ...init }));
}

beforeEach(() => {
  h = setup();
});

afterEach(() => {
  h.destroy();
  vi.useRealTimers();
});

describe('TabDrawer — the keyboard follows the drawer (I4a)', () => {
  it('⌘J moves focus into the drawer: editing keys never reach the editor', async () => {
    h.editor.focus();
    h.handle().toggle();
    await settle();
    expect(h.root().contains(document.activeElement)).toBe(true);
    for (const key of ['Backspace', ' ', 'Tab', 'Enter', 'Delete']) press(key);
    expect(h.editorKeys).toEqual([]);
  });

  it('a letter goes to the search, not to the editor', async () => {
    h.editor.focus();
    h.handle().toggle();
    await settle();
    press('b');
    await settle();
    expect(query()).toBe('b');
    expect(h.editorKeys).toEqual([]);
  });

  it('a hover-open after typing in the editor leaves the keys there (Q5)', async () => {
    vi.useFakeTimers();
    typeInEditor();
    pointer(h.root().querySelector('.notch')!, 'pointerenter');
    vi.advanceTimersByTime(HOVER_OPEN_MS);
    await settle();
    expect(h.root().querySelector('.drawer')?.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(h.editor);
    press('q');
    press('Backspace');
    expect(h.editorKeys).toEqual(['q', 'Backspace']);
    expect(query()).toBe('');
  });

  it('a click into the editor counts as input there too (Q5: "the last input")', async () => {
    vi.useFakeTimers();
    h.editor.focus();
    h.editor.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    pointer(h.root().querySelector('.notch')!, 'pointerenter');
    vi.advanceTimersByTime(HOVER_OPEN_MS);
    await settle();
    expect(document.activeElement).toBe(h.editor);
    press('q');
    expect(h.editorKeys).toEqual(['q']);
  });

  it('…until the pointer enters the drawer: then focus moves in and Backspace stays out of the editor', async () => {
    vi.useFakeTimers();
    typeInEditor();
    pointer(h.root().querySelector('.notch')!, 'pointerenter');
    vi.advanceTimersByTime(HOVER_OPEN_MS);
    await settle();
    pointer(h.root().querySelector('.drawer')!, 'pointerenter');
    await settle();
    expect(h.root().contains(document.activeElement)).toBe(true);
    press('Backspace');
    press(' ');
    press('z');
    await settle();
    expect(h.editorKeys).toEqual([]);
    expect(query()).toBe('z');
  });

  it('a hover-open when the last input was not in the editor takes the keyboard at once', async () => {
    vi.useFakeTimers();
    h.editor.focus(); // focused, but nothing was typed or clicked there
    pointer(h.root().querySelector('.notch')!, 'pointerenter');
    vi.advanceTimersByTime(HOVER_OPEN_MS);
    await settle();
    expect(h.root().contains(document.activeElement)).toBe(true);
    press('Backspace');
    expect(h.editorKeys).toEqual([]);
  });

  it('focus pulled back to the editor while the drawer has the keyboard returns to the drawer', async () => {
    h.handle().toggle();
    await settle();
    h.editor.focus();
    await settle();
    expect(h.root().contains(document.activeElement)).toBe(true);
    press('Backspace');
    expect(h.editorKeys).toEqual([]);
  });

  it('closing gives focus back to the editor', async () => {
    h.editor.focus();
    h.handle().toggle();
    await settle();
    press('Escape');
    await settle();
    expect(document.activeElement).toBe(h.editor);
    press('k');
    expect(h.editorKeys).toEqual(['k']);
  });
});

describe('TabDrawer — key routing', () => {
  it('ignores a key the IME is composing (I4c)', async () => {
    h.handle().toggle();
    await settle();
    press('a', { isComposing: true });
    press('a', { keyCode: 229 } as KeyboardEventInit);
    await settle();
    expect(query()).toBe('');
  });

  it('sort keys work before the drawer has the keyboard (I4d)', async () => {
    vi.useFakeTimers();
    typeInEditor();
    pointer(h.root().querySelector('.notch')!, 'pointerenter');
    vi.advanceTimersByTime(HOVER_OPEN_MS);
    await settle();
    const e = press('u', { metaKey: true, ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(h.onreorder).toHaveBeenCalledTimes(1);
    expect(h.editorKeys).toEqual([]);
  });

  it('⇧ follows every event, so a ⇧ released outside the window does not stick (I4b)', async () => {
    h.handle().toggle();
    await settle();
    const shiftDown = () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', shiftKey: true, bubbles: true })
      );
    const shown = () => {
      flushSync();
      return h.root().classList.contains('shift');
    };
    shiftDown();
    expect(shown()).toBe(true);
    // Released outside the window: no keyup. The next pointer event says so.
    h.root().querySelector('.drawer-wrap')!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
    expect(shown()).toBe(false);
    shiftDown();
    expect(shown()).toBe(true);
    // …and so does the next key.
    press('ArrowDown');
    expect(shown()).toBe(false);
  });
});
