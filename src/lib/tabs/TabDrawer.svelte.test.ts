// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import TabDrawer, { type TabDrawerHandle } from './TabDrawer.svelte';
import { DWELL_ARM_PX, DWELL_CAPTURE_MS, HOVER_CLOSE_MS, HOVER_OPEN_MS } from './drawer-state';
import type { TabListState, TabMeta } from './tab-model';
import { GOT_MS, type CarouselWindow } from './carousel';

/*
 * The drawer's keyboard and pointer contract against a stand-in for the
 * editor: a contenteditable that records every key it receives. What is proved
 * here is where a key is DELIVERED — dispatched on `document.activeElement`,
 * the way a real key reaches the focused element — not what CodeMirror would
 * do with it. (`.svelte.test.ts`: the props are a `$state` so a test can change
 * the list under a mounted drawer.)
 */

function tab(id: string, path: string | null, unviewed = false): TabMeta {
  return { id, path, dirty: false, openedAt: 0, viewedAt: 0, unviewed };
}

function initialList(): TabListState {
  return {
    tabs: [tab('a', '/p/alpha.md'), tab('b', '/p/beta.md'), tab('c', '/p/gamma.md'), tab('d', null)],
    activeId: 'a',
  };
}

interface Props {
  list: TabListState;
  handle: TabDrawerHandle | undefined;
}

interface Harness {
  editor: HTMLElement;
  editorKeys: string[];
  props: Props;
  handle: () => TabDrawerHandle;
  root: () => HTMLElement;
  onreorder: ReturnType<typeof vi.fn>;
  onactivate: ReturnType<typeof vi.fn>;
  onrestorefocus: ReturnType<typeof vi.fn>;
  windows: ReturnType<typeof vi.fn>;
  onmove: ReturnType<typeof vi.fn>;
  oncarousel: ReturnType<typeof vi.fn>;
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

function setup(list: TabListState = initialList()): Harness {
  const editor = document.createElement('div');
  editor.setAttribute('contenteditable', 'true');
  editor.tabIndex = 0;
  document.body.appendChild(editor);
  const editorKeys: string[] = [];
  editor.addEventListener('keydown', (e) => editorKeys.push(e.key));

  const target = document.createElement('div');
  document.body.appendChild(target);
  const props = $state<Props>({ list, handle: undefined });
  const onreorder = vi.fn();
  const onactivate = vi.fn();
  const onrestorefocus = vi.fn();
  const windows = vi.fn(async (): Promise<CarouselWindow[]> => []);
  const onmove = vi.fn();
  const oncarousel = vi.fn();
  const component = mount(TabDrawer, {
    target,
    props: {
      get list() {
        return props.list;
      },
      windowNumber: 3,
      compact: false,
      source: {
        held: () => '',
        read: () => Promise.resolve(''),
        gitInfo: (paths: string[]) => Promise.resolve(paths.map(() => null)),
      },
      onactivate,
      onclose: () => {},
      onreorder,
      onnewwindows: () => {},
      carouselSource: { windows: () => windows() },
      onmove,
      oncarousel,
      onrestorefocus,
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
    props,
    handle: () => {
      if (!props.handle) throw new Error('no handle');
      return props.handle;
    },
    root: () => target.querySelector<HTMLElement>('.tab-drawer')!,
    onreorder,
    onactivate,
    onrestorefocus,
    windows,
    onmove,
    oncarousel,
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
  await tick();
  flushSync();
}

function query(): string {
  return h.root().querySelector('.s-q')?.textContent ?? '';
}

function el(selector: string): HTMLElement {
  const found = h.root().querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`no ${selector}`);
  return found;
}

function card(id: string): HTMLElement {
  return el(`[data-tab-id="${id}"]`);
}

function pointer(target: Element | Window, type: string, init: PointerEventInit = {}): PointerEvent {
  const e = new PointerEvent(type, { bubbles: type !== 'pointerenter' && type !== 'pointerleave', cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

/** Rest on the notch (at `NOTCH`) until a hover-open, with fake timers on. */
const NOTCH = { clientX: 10, clientY: 60 };

async function hoverOpen(): Promise<void> {
  pointer(el('.notch'), 'pointerenter', NOTCH);
  pointer(el('.notch'), 'pointermove', NOTCH);
  vi.advanceTimersByTime(HOVER_OPEN_MS);
  await settle();
  expect(el('.drawer').hasAttribute('inert')).toBe(false);
}

function drawerHasKeys(): boolean {
  return h.root().contains(document.activeElement);
}

beforeEach(() => {
  h = setup();
});

afterEach(() => {
  h.destroy();
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'elementFromPoint');
});

describe('TabDrawer — the keyboard follows the drawer (I4a)', () => {
  it('⌘J moves focus into the drawer: editing keys never reach the editor', async () => {
    h.editor.focus();
    h.handle().toggle();
    await settle();
    expect(drawerHasKeys()).toBe(true);
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

  it('a hover-open when the last input was not in the editor takes the keyboard at once', async () => {
    vi.useFakeTimers();
    h.editor.focus(); // focused, but nothing was typed or clicked there
    await hoverOpen();
    expect(drawerHasKeys()).toBe(true);
    press('Backspace');
    expect(h.editorKeys).toEqual([]);
  });

  it('focus pulled back to the editor while the drawer has the keyboard returns to the drawer', async () => {
    h.handle().toggle();
    await settle();
    h.editor.focus();
    await settle();
    expect(drawerHasKeys()).toBe(true);
    press('Backspace');
    expect(h.editorKeys).toEqual([]);
  });

  it('…but not from a panel with a keyboard of its own (CodeMirror search, Recent Files)', async () => {
    const panels = document.createElement('div');
    panels.className = 'cm-panels';
    const input = document.createElement('input');
    panels.appendChild(input);
    document.body.appendChild(panels);
    h.handle().toggle();
    await settle();
    input.focus();
    await settle();
    expect(document.activeElement).toBe(input);
    panels.remove();
  });
});

describe('TabDrawer — the pointer takes the keyboard only on purpose (Q5)', () => {
  it('a hover-open after typing in the editor leaves the keys there', async () => {
    vi.useFakeTimers();
    typeInEditor();
    await hoverOpen();
    expect(document.activeElement).toBe(h.editor);
    press('q');
    press('Backspace');
    expect(h.editorKeys).toEqual(['q', 'Backspace']);
    expect(query()).toBe('');
  });

  it('a click into the editor counts as input there too ("the last input")', async () => {
    vi.useFakeTimers();
    h.editor.focus();
    pointer(h.editor, 'pointerdown');
    await hoverOpen();
    expect(document.activeElement).toBe(h.editor);
    press('q');
    expect(h.editorKeys).toEqual(['q']);
  });

  it('the pointer passing through the drawer does not take the keys', async () => {
    vi.useFakeTimers();
    typeInEditor();
    await hoverOpen();
    pointer(el('.drawer'), 'pointerenter');
    vi.advanceTimersByTime(300);
    pointer(el('.drawer'), 'pointerleave');
    vi.advanceTimersByTime(DWELL_CAPTURE_MS);
    await settle();
    expect(document.activeElement).toBe(h.editor);
    press('q');
    expect(h.editorKeys).toEqual(['q']);
  });

  it('a slow pass across the drawer does not take them: every move restarts the wait', async () => {
    vi.useFakeTimers();
    typeInEditor();
    await hoverOpen();
    pointer(el('.drawer'), 'pointerenter', NOTCH);
    for (let i = 1; i <= 6; i++) {
      vi.advanceTimersByTime(100);
      pointer(el('.drawer'), 'pointermove', { clientX: NOTCH.clientX + i * 60, clientY: NOTCH.clientY });
    }
    pointer(el('.drawer'), 'pointerleave');
    vi.advanceTimersByTime(DWELL_CAPTURE_MS * 2);
    await settle();
    expect(document.activeElement).toBe(h.editor);
  });

  it('a twitch of the hand that rests on the notch does not arm the wait', async () => {
    vi.useFakeTimers();
    typeInEditor();
    await hoverOpen();
    // The drawer slid in under the pointer; a few pixels of movement land inside.
    pointer(el('.drawer'), 'pointerenter', { clientX: 12, clientY: 62 });
    pointer(el('.drawer'), 'pointermove', { clientX: 14, clientY: 63 });
    vi.advanceTimersByTime(DWELL_CAPTURE_MS * 2);
    await settle();
    expect(document.activeElement).toBe(h.editor);
    press('q');
    expect(h.editorKeys).toEqual(['q']);
  });

  it('moving into the drawer and resting there takes them: focus moves in, Backspace stays out of the editor', async () => {
    vi.useFakeTimers();
    typeInEditor();
    await hoverOpen();
    pointer(el('.drawer'), 'pointerenter', NOTCH);
    pointer(el('.drawer'), 'pointermove', { clientX: NOTCH.clientX + DWELL_ARM_PX, clientY: NOTCH.clientY });
    vi.advanceTimersByTime(DWELL_CAPTURE_MS - 1);
    await settle();
    expect(document.activeElement).toBe(h.editor);
    vi.advanceTimersByTime(1);
    await settle();
    expect(drawerHasKeys()).toBe(true);
    press('Backspace');
    press(' ');
    press('z');
    await settle();
    expect(h.editorKeys).toEqual([]);
    expect(query()).toBe('z');
  });

  it('a press inside the drawer takes them at once', async () => {
    vi.useFakeTimers();
    typeInEditor();
    await hoverOpen();
    pointer(el('.drawer-head'), 'pointerdown', { button: 0 });
    await settle();
    expect(drawerHasKeys()).toBe(true);
  });

  it('so does a scroll inside the drawer', async () => {
    vi.useFakeTimers();
    typeInEditor();
    await hoverOpen();
    el('.tab-list').dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 }));
    await settle();
    expect(drawerHasKeys()).toBe(true);
  });

  it('typing into the drawer is input outside the editor: the next hover-open takes the keys', async () => {
    vi.useFakeTimers();
    typeInEditor();
    h.handle().toggle();
    await settle();
    press('b');
    press('Escape');
    press('Escape');
    await settle();
    expect(document.activeElement).toBe(h.editor);
    await hoverOpen();
    expect(drawerHasKeys()).toBe(true);
  });
});

describe('TabDrawer — focus comes back on close', () => {
  it('Esc gives focus back to the editor', async () => {
    h.editor.focus();
    h.handle().toggle();
    await settle();
    press('Escape');
    await settle();
    expect(document.activeElement).toBe(h.editor);
    press('k');
    expect(h.editorKeys).toEqual(['k']);
  });

  it('a press on the notch or the scrim does not blur the editor (WebKit)', async () => {
    const notchDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    el('.notch').dispatchEvent(notchDown);
    expect(notchDown.defaultPrevented).toBe(true);
    const scrimDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    el('.scrim').dispatchEvent(scrimDown);
    expect(scrimDown.defaultPrevented).toBe(true);
  });

  it('the scrim closes and returns focus to the editor', async () => {
    h.editor.focus();
    h.handle().toggle();
    await settle();
    pointer(el('.scrim'), 'pointerdown');
    await settle();
    expect(document.activeElement).toBe(h.editor);
  });

  it('opened with focus nowhere: closing asks the app to put it in the editor', async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    el('.notch').click();
    await settle();
    expect(drawerHasKeys()).toBe(true);
    press('Escape');
    await settle();
    expect(h.onrestorefocus).toHaveBeenCalledTimes(1);
  });

  it('a focused card that goes away hands the keyboard to its neighbour, not to <body>', async () => {
    h.editor.focus();
    h.handle().toggle();
    await settle();
    press('ArrowDown'); // from the active tab a → b
    await settle();
    expect(document.activeElement).toBe(card('b'));
    const list = h.props.list;
    h.props.list = { ...list, tabs: list.tabs.filter((t) => t.id !== 'b') };
    await settle();
    await settle();
    expect(document.activeElement).toBe(card('c'));
    press('Enter');
    expect(h.onactivate).toHaveBeenCalledWith('c');
  });

  it('focus that was on <body> all along is not the drawer\'s to give back', async () => {
    vi.useFakeTimers();
    typeInEditor();
    h.editor.blur(); // a fresh load blurs the editor on purpose
    await hoverOpen();
    expect(document.activeElement).toBe(document.body);
    h.handle().close();
    await settle();
    expect(h.onrestorefocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it('with the keyboard dropped on <body> anyway, Esc still gives it back', async () => {
    h.editor.focus();
    h.handle().toggle();
    await settle();
    (document.activeElement as HTMLElement).blur();
    // No focusout target: the window keeps routing, and closing restores.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    await settle();
    expect(document.activeElement).toBe(h.editor);
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
    await hoverOpen();
    const e = press('u', { metaKey: true, ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(h.onreorder).toHaveBeenCalledTimes(1);
    expect(h.editorKeys).toEqual([]);
  });

  it('Enter presses a focused drawer button, and with no card to open is left alone', async () => {
    h.handle().toggle();
    await settle();
    const idle = press('Enter');
    expect(idle.defaultPrevented).toBe(false);
    const sort = el('.sort-btn');
    sort.focus();
    const onButton = press('Enter');
    expect(onButton.defaultPrevented).toBe(false);
    expect(h.onactivate).not.toHaveBeenCalled();
  });

  it('Enter on the focused notch opens the top search result rather than pressing the notch', async () => {
    h.handle().toggle();
    await settle();
    press('b');
    await settle();
    el('.notch').focus();
    const e = press('Enter');
    expect(e.defaultPrevented).toBe(true);
    expect(h.onactivate).toHaveBeenCalledWith('b');
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
    pointer(el('.drawer-wrap'), 'pointermove');
    expect(shown()).toBe(false);
    shiftDown();
    expect(shown()).toBe(true);
    // …and so does the next key.
    press('ArrowDown');
    expect(shown()).toBe(false);
  });
});

describe('TabDrawer — a gesture whose pointerup is lost', () => {
  async function startDrag(): Promise<void> {
    h.handle().toggle();
    await settle();
    pointer(card('b'), 'pointerdown', { button: 0, buttons: 1, clientX: 10, clientY: 10 });
    pointer(window, 'pointermove', { buttons: 1, clientX: 40, clientY: 40 });
    flushSync();
    expect(h.root().parentElement!.querySelector('.ghost')).not.toBeNull();
  }

  function ghost(): Element | null {
    return h.root().parentElement!.querySelector('.ghost');
  }

  it('is cancelled when the window loses focus: no reorder, no activation', async () => {
    await startDrag();
    window.dispatchEvent(new Event('blur'));
    flushSync();
    expect(ghost()).toBeNull();
    pointer(window, 'pointerup', { clientX: 40, clientY: 40 });
    expect(h.onreorder).not.toHaveBeenCalled();
    expect(h.onactivate).not.toHaveBeenCalled();
  });

  it('is cancelled by a move with no button held', async () => {
    await startDrag();
    pointer(window, 'pointermove', { buttons: 0, clientX: 50, clientY: 50 });
    flushSync();
    expect(ghost()).toBeNull();
    pointer(window, 'pointerup', { clientX: 50, clientY: 50 });
    expect(h.onreorder).not.toHaveBeenCalled();
    expect(h.onactivate).not.toHaveBeenCalled();
  });

  it('a press that lost its pointerup does not open the card later', async () => {
    h.handle().toggle();
    await settle();
    pointer(card('b'), 'pointerdown', { button: 0, buttons: 1, clientX: 10, clientY: 10 });
    pointer(window, 'pointermove', { buttons: 0, clientX: 11, clientY: 10 });
    pointer(window, 'pointerup', { clientX: 11, clientY: 10 });
    expect(h.onactivate).not.toHaveBeenCalled();
  });
});

describe('TabDrawer — the notch count', () => {
  it('replays its jump for every unviewed tab that arrives', async () => {
    const notch = el('.notch');
    const removed = vi.spyOn(notch.classList, 'remove');
    const add = (id: string) => {
      const list = h.props.list;
      h.props.list = { ...list, tabs: [...list.tabs, tab(id, `/p/${id}.md`, true)] };
      flushSync();
    };
    add('e');
    expect(notch.classList.contains('bump')).toBe(true);
    add('f');
    expect(removed).toHaveBeenCalledWith('bump');
    expect(notch.classList.contains('bump')).toBe(true);
  });

  it('does not jump when a restored window first publishes its unviewed tabs', () => {
    h.destroy();
    h = setup({ tabs: [], activeId: null });
    h.props.list = { tabs: [tab('a', '/p/alpha.md'), tab('e', '/p/e.md', true)], activeId: 'a' };
    flushSync();
    expect(el('.notch').classList.contains('bump')).toBe(false);
    // An arrival after that still does.
    h.props.list = { ...h.props.list, tabs: [...h.props.list.tabs, tab('f', '/p/f.md', true)] };
    flushSync();
    expect(el('.notch').classList.contains('bump')).toBe(true);
  });

  it('does not jump for unviewed tabs it was mounted with', () => {
    h.destroy();
    h = setup({ tabs: [tab('a', '/p/alpha.md'), tab('e', '/p/e.md', true)], activeId: 'a' });
    expect(el('.notch').classList.contains('bump')).toBe(false);
  });
});

describe('TabDrawer — the selection bar', () => {
  it('keeps its buttons out of the Tab order while nothing is selected', async () => {
    h.handle().toggle();
    await settle();
    // The property, not the attribute: jsdom does not reflect `inert`.
    const bar = el('.sel-bar');
    expect(bar.inert).toBe(true);
    expect(bar.querySelectorAll('button').length).toBeGreaterThan(0);

    pointer(card('b'), 'pointerdown', { button: 0, shiftKey: true, clientX: 100, clientY: 100 });
    pointer(window, 'pointerup', { button: 0, clientX: 100, clientY: 100 });
    await settle();
    expect(bar.classList.contains('on')).toBe(true);
    expect(bar.inert).toBe(false);
  });
});

describe('TabDrawer — the window carousel (plan 05)', () => {
  const other = (label: string, number: number): CarouselWindow => ({
    label,
    number,
    project: 'p',
    branch: null,
    tabCount: 1,
    activePath: `/p/${label}.md`,
    head: '',
  });
  const page = () => h.root().parentElement!;
  const carousel = () => page().querySelector('.carousel');
  const option = (i: number) => page().querySelector<HTMLElement>(`[data-carousel-item="${i}"]`);
  const listbox = () => page().querySelector<HTMLElement>('[role="listbox"]');

  function shiftClick(id: string): void {
    pointer(card(id), 'pointerdown', { button: 0, shiftKey: true, clientX: 100, clientY: 100 });
    pointer(window, 'pointerup', { button: 0, clientX: 100, clientY: 100 });
  }

  /** Grab `id` and carry it onto the page, right of the (zero-width in jsdom) drawer. */
  async function dragOut(id: string): Promise<void> {
    pointer(card(id), 'pointerdown', { button: 0, buttons: 1, clientX: 10, clientY: 10 });
    pointer(window, 'pointermove', { buttons: 1, clientX: 600, clientY: 300 });
    await settle();
    await settle();
  }

  it('DraggingACardOntoThePageOpensTheCarousel_BackOverTheDrawerClosesIt', async () => {
    h.windows.mockResolvedValue([other('editor-2', 7)]);
    h.handle().toggle();
    await settle();
    await dragOut('b');
    expect(carousel()).not.toBeNull();
    expect(option(1)).not.toBeNull();
    expect(h.oncarousel).toHaveBeenLastCalledWith(true);
    pointer(window, 'pointermove', { buttons: 1, clientX: -10, clientY: 300 });
    await settle();
    expect(carousel()).toBeNull();
    expect(h.oncarousel).toHaveBeenLastCalledWith(false);
  });

  it('DroppingOnAThumbnailMovesTheDraggedTab', async () => {
    h.windows.mockResolvedValue([other('editor-2', 7)]);
    h.handle().toggle();
    await settle();
    await dragOut('b');
    document.elementFromPoint = vi.fn(() => option(1));
    pointer(window, 'pointermove', { buttons: 1, clientX: 610, clientY: 300 });
    await settle();
    expect(option(1)?.classList.contains('hot')).toBe(true);
    expect(page().querySelector('.ghost-bar span')?.textContent).toBe('→ #7');
    pointer(window, 'pointerup', { clientX: 610, clientY: 300 });
    await settle();
    expect(h.onmove).toHaveBeenCalledWith(['b'], { kind: 'window', label: 'editor-2' });
    expect(h.onreorder).not.toHaveBeenCalled();
  });

  it('DroppingOnThePageOffAnyThumbnailCancels', async () => {
    h.windows.mockResolvedValue([other('editor-2', 7)]);
    h.handle().toggle();
    await settle();
    await dragOut('b');
    document.elementFromPoint = vi.fn(() => page().querySelector<HTMLElement>('.car-view'));
    pointer(window, 'pointermove', { buttons: 1, clientX: 610, clientY: 300 });
    pointer(window, 'pointerup', { clientX: 610, clientY: 300 });
    await settle();
    expect(h.onmove).not.toHaveBeenCalled();
    expect(h.onreorder).not.toHaveBeenCalled();
    expect(carousel()).toBeNull();
  });

  it('BackOverTheDrawerADropReordersAsBefore', async () => {
    h.handle().toggle();
    await settle();
    el('.tab-list').getBoundingClientRect = () => new DOMRect(0, 0, 300, 600);
    await dragOut('b');
    expect(carousel()).not.toBeNull();
    pointer(window, 'pointermove', { buttons: 1, clientX: 100, clientY: 590 });
    await settle();
    expect(carousel()).toBeNull();
    pointer(window, 'pointerup', { clientX: 100, clientY: 590 });
    await settle();
    expect(h.onmove).not.toHaveBeenCalled();
    expect(h.onreorder).toHaveBeenCalledTimes(1);
  });

  it('DroppingOnNewWindowMovesTheGroupInListOrder_AsOneGhost', async () => {
    h.handle().toggle();
    await settle();
    shiftClick('d');
    shiftClick('b');
    await settle();
    await dragOut('d');
    expect(page().querySelectorAll('.ghost')).toHaveLength(1);
    expect(page().querySelector('.ghost-count')?.textContent).toBe('2');
    document.elementFromPoint = vi.fn(() => option(0));
    pointer(window, 'pointermove', { buttons: 1, clientX: 601, clientY: 300 });
    pointer(window, 'pointerup', { clientX: 601, clientY: 300 });
    await settle();
    expect(h.onmove).toHaveBeenCalledWith(['b', 'd'], { kind: 'new-window' });
  });

  it('EscCancelsADrag_NothingMoves_TheDrawerStaysOpen', async () => {
    h.handle().toggle();
    await settle();
    await dragOut('b');
    press('Escape');
    await settle();
    expect(page().querySelector('.ghost')).toBeNull();
    expect(carousel()).toBeNull();
    pointer(window, 'pointerup', { clientX: 600, clientY: 300 });
    expect(h.onmove).not.toHaveBeenCalled();
    expect(el('.drawer').hasAttribute('inert')).toBe(false);
  });

  it('CmdMOpensTheCarouselForTheSelection_ArrowsAndEnterMoveIt', async () => {
    h.windows.mockResolvedValue([other('editor-2', 7), other('editor-3', 8)]);
    h.handle().toggle();
    await settle();
    shiftClick('c');
    shiftClick('b');
    await settle();
    press('m', { metaKey: true, ctrlKey: true });
    await settle();
    await settle();
    expect(document.activeElement).toBe(listbox());
    expect(listbox()!.getAttribute('aria-activedescendant')).toBe(option(1)!.id);
    press('ArrowDown');
    await settle();
    expect(listbox()!.getAttribute('aria-activedescendant')).toBe(option(2)!.id);
    press('Enter');
    await settle();
    expect(h.onmove).toHaveBeenCalledWith(['b', 'c'], { kind: 'window', label: 'editor-3' });
  });

  it('CmdMWithoutASelectionMovesTheActiveTab_EscGivesTheKeysBackToTheList', async () => {
    h.handle().toggle();
    await settle();
    press('m', { metaKey: true, ctrlKey: true });
    await settle();
    await settle();
    // One window: only «+ Новое окно», and the keyboard is on it.
    expect(listbox()!.getAttribute('aria-activedescendant')).toBe(option(0)!.id);
    expect(option(1)).toBeNull();
    press('x');
    expect(query(), 'no key reaches the search behind the carousel').toBe('');
    press('Escape');
    await settle();
    expect(carousel()).toBeNull();
    expect(document.activeElement).toBe(el('.tab-list'));
    press('m', { metaKey: true, ctrlKey: true });
    await settle();
    await settle();
    press('Enter');
    await settle();
    expect(h.onmove).toHaveBeenCalledWith(['a'], { kind: 'new-window' });
  });

  it('ToAWindowOnTheSelectionBarOpensTheCarouselForTheSelection', async () => {
    h.handle().toggle();
    await settle();
    shiftClick('c');
    await settle();
    const button = [...el('.sel-bar').querySelectorAll('button')].find((b) => b.textContent === 'To a window…');
    button!.click();
    await settle();
    await settle();
    expect(document.activeElement).toBe(listbox());
    press('Enter');
    await settle();
    expect(h.onmove).toHaveBeenCalledWith(['c'], { kind: 'new-window' });
  });

  it('AHoverOpenedDrawerStaysWhileTheCarouselIsUp_AThumbnailClickMoves', async () => {
    vi.useFakeTimers();
    await hoverOpen();
    press('m', { metaKey: true, ctrlKey: true });
    await settle();
    await settle();
    expect(carousel()).not.toBeNull();
    // On its way to a thumbnail the pointer leaves the wrap.
    pointer(el('.drawer-wrap'), 'pointerleave');
    vi.advanceTimersByTime(HOVER_CLOSE_MS * 3);
    await settle();
    expect(carousel()).not.toBeNull();
    expect(el('.drawer').hasAttribute('inert')).toBe(false);
    option(0)!.click();
    expect(h.onmove).toHaveBeenCalledWith(['a'], { kind: 'new-window' });
    // The pulse plays out, then the hover close it held off.
    vi.advanceTimersByTime(GOT_MS - 1);
    await settle();
    expect(carousel()).not.toBeNull();
    vi.advanceTimersByTime(1);
    await settle();
    expect(carousel()).toBeNull();
    vi.advanceTimersByTime(HOVER_CLOSE_MS);
    await settle();
    expect(el('.drawer').inert, 'closed (jsdom does not reflect inert)').toBe(true);
  });

  it('AHoverOpenedDrawerOutlivesTheDropsPulse', async () => {
    vi.useFakeTimers();
    await hoverOpen();
    await dragOut('b');
    pointer(el('.drawer-wrap'), 'pointerleave');
    document.elementFromPoint = vi.fn(() => option(0));
    pointer(window, 'pointermove', { buttons: 1, clientX: 610, clientY: 300 });
    pointer(window, 'pointerup', { clientX: 610, clientY: 300 });
    await settle();
    expect(h.onmove).toHaveBeenCalledWith(['b'], { kind: 'new-window' });
    vi.advanceTimersByTime(HOVER_CLOSE_MS);
    await settle();
    expect(option(0)?.classList.contains('got')).toBe(true);
    vi.advanceTimersByTime(GOT_MS - HOVER_CLOSE_MS);
    await settle();
    expect(carousel()).toBeNull();
    expect(el('.drawer').hasAttribute('inert')).toBe(false);
    vi.advanceTimersByTime(HOVER_CLOSE_MS);
    await settle();
    expect(el('.drawer').inert, 'closed (jsdom does not reflect inert)').toBe(true);
  });

  it('DuringThePulseAfterEnterTheKeysAreTheListsAgain', async () => {
    h.handle().toggle();
    await settle();
    press('m', { metaKey: true, ctrlKey: true });
    await settle();
    await settle();
    press('Enter');
    await settle();
    expect(carousel()).not.toBeNull();
    press('x');
    await settle();
    expect(query()).toBe('x');
  });

  it('DuringADragKeysAreSwallowed_CmdMDoesNothing', async () => {
    h.handle().toggle();
    await settle();
    await dragOut('b');
    expect(press('x').defaultPrevented).toBe(true);
    press('ArrowDown');
    press('m', { metaKey: true, ctrlKey: true });
    await settle();
    await settle();
    expect(query()).toBe('');
    expect(listbox()!.hasAttribute('aria-activedescendant')).toBe(false);
    document.elementFromPoint = vi.fn(() => option(0));
    pointer(window, 'pointermove', { buttons: 1, clientX: 610, clientY: 300 });
    pointer(window, 'pointerup', { clientX: 610, clientY: 300 });
    await settle();
    expect(h.onmove).toHaveBeenCalledTimes(1);
    expect(h.onmove).toHaveBeenCalledWith(['b'], { kind: 'new-window' });
  });

  it('ADragStartedUnderCmdMsCarouselGetsItsOwn', async () => {
    h.handle().toggle();
    await settle();
    press('m', { metaKey: true, ctrlKey: true });
    await settle();
    await settle();
    expect(document.activeElement).toBe(listbox());
    await dragOut('b');
    expect(carousel()).not.toBeNull();
    expect(listbox()!.hasAttribute('aria-activedescendant')).toBe(false);
    document.elementFromPoint = vi.fn(() => option(0));
    pointer(window, 'pointermove', { buttons: 1, clientX: 610, clientY: 300 });
    pointer(window, 'pointerup', { clientX: 610, clientY: 300 });
    await settle();
    expect(h.onmove).toHaveBeenCalledTimes(1);
    expect(h.onmove).toHaveBeenCalledWith(['b'], { kind: 'new-window' });
  });

  it('InKeysModeAPressOffTheThumbnailsCancels_OnOneItDoesNot', async () => {
    h.handle().toggle();
    await settle();
    press('m', { metaKey: true, ctrlKey: true });
    await settle();
    await settle();
    pointer(option(0)!, 'pointerdown', { button: 0 });
    await settle();
    expect(carousel()).not.toBeNull();
    pointer(page().querySelector('.car-view')!, 'pointerdown', { button: 0 });
    await settle();
    expect(carousel()).toBeNull();
    expect(document.activeElement).toBe(el('.tab-list'));
    expect(h.onmove).not.toHaveBeenCalled();
  });

  it('AWindowBlurOrAClosedDrawerMidDragTakesTheCarouselDown', async () => {
    h.handle().toggle();
    await settle();
    await dragOut('b');
    expect(h.oncarousel).toHaveBeenLastCalledWith(true);
    window.dispatchEvent(new Event('blur'));
    await settle();
    expect(carousel()).toBeNull();
    expect(h.oncarousel).toHaveBeenLastCalledWith(false);
    await dragOut('c');
    expect(h.oncarousel).toHaveBeenLastCalledWith(true);
    h.handle().close();
    await settle();
    expect(carousel()).toBeNull();
    expect(h.oncarousel).toHaveBeenLastCalledWith(false);
    expect(el('.drawer').inert, 'closed (jsdom does not reflect inert)').toBe(true);
    expect(h.onmove).not.toHaveBeenCalled();
  });

  it('AWindowsFetchThatResolvesAfterCloseIsDropped', async () => {
    let resolve: (windows: CarouselWindow[]) => void = () => {};
    h.windows.mockReturnValueOnce(
      new Promise<CarouselWindow[]>((r) => {
        resolve = r;
      })
    );
    h.handle().toggle();
    await settle();
    press('m', { metaKey: true, ctrlKey: true });
    await settle();
    press('Escape');
    await settle();
    press('m', { metaKey: true, ctrlKey: true });
    await settle();
    await settle();
    expect(option(0)).not.toBeNull();
    resolve([other('editor-2', 7)]);
    await settle();
    await settle();
    expect(option(0)).not.toBeNull();
    expect(option(1)).toBeNull();
  });
});
