// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommentWidget, isSendKey, type CommentActions, type CommentSpec } from './ai-comment';
import type { CommentThread } from '../comment-format';

/**
 * Chat mode — the default card. A real DOM (jsdom) rather than the fake one
 * `ai-comment.test.ts` uses: double-clicks, `replaceChild` and keyboard events
 * with `isComposing` are the subject here.
 */

function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 'c-aaaaaa',
    status: 'answered',
    line: 1,
    quote: 'цитата',
    replies: [
      { author: 'You', at: '2026-08-24 17:00:00 UTC', text: 'Успеем к **пятнице**?' },
      { author: 'agent', at: '2026-08-24 17:02:00 UTC', text: 'Да, если `без` ревью.' },
    ],
    ...overrides,
  };
}

function makeActions(overrides: Partial<CommentActions> = {}): CommentActions {
  return {
    save: vi.fn(),
    flush: vi.fn(),
    sendNow: vi.fn(),
    resolve: vi.fn(),
    handoff: vi.fn(),
    insertIntoText: vi.fn(),
    compose: vi.fn(),
    send: vi.fn(() => Promise.resolve(true)),
    edit: vi.fn(() => Promise.resolve(true)),
    editing: vi.fn(),
    ...overrides,
  };
}

function mount(spec: Partial<CommentSpec> = {}): { root: HTMLElement; actions: CommentActions; widget: CommentWidget } {
  const actions = spec.actions ?? makeActions();
  const widget = new CommentWidget({
    thread: thread(),
    orphaned: false,
    mode: 'chat',
    ...spec,
    actions,
  });
  const root = widget.toDOM();
  document.body.appendChild(root);
  return { root, actions, widget };
}

function key(el: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
}

function type(area: HTMLTextAreaElement, value: string): void {
  area.value = value;
  area.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Let the promise an action returned settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const composer = (root: HTMLElement) =>
  root.querySelector<HTMLTextAreaElement>('.cm-ai-comment-composer')!;
const sendButton = (root: HTMLElement) =>
  root.querySelector<HTMLButtonElement>('.cm-ai-comment-send')!;

afterEach(() => {
  document.body.replaceChildren();
});

describe('chat mode — messages', () => {
  it('shows every reply as a message, the trailing own one included', () => {
    const { root } = mount({
      thread: thread({
        status: 'open',
        replies: [
          ...thread().replies,
          { author: 'You', at: '2026-08-24 17:04:00 UTC', text: 'И ещё вопрос' },
        ],
      }),
    });
    const messages = root.querySelectorAll('.cm-ai-comment-reply');
    expect(messages).toHaveLength(3);
    expect(messages[2].textContent).toContain('И ещё вопрос');
    // …and the composer does not hold it: it was sent.
    expect(composer(root).value).toBe('');
  });

  it('tells the user\'s messages from the agent\'s', () => {
    const { root } = mount();
    const [own, agent] = root.querySelectorAll('.cm-ai-comment-reply');
    expect(own.classList.contains('cm-ai-comment-msg-own')).toBe(true);
    expect(agent.classList.contains('cm-ai-comment-msg-agent')).toBe(true);
  });

  it('renders the markdown of both sides', () => {
    const { root } = mount();
    const [own, agent] = root.querySelectorAll('.cm-ai-comment-text');
    expect(own.querySelector('strong')?.textContent).toBe('пятнице');
    expect(agent.querySelector('code')?.textContent).toBe('без');
    expect(own.getAttribute('contenteditable')).toBe('true');
  });

  it('has no countdown, no send-now and no autosave label', () => {
    const { root } = mount();
    expect(root.querySelector('.cm-ai-comment-countdown')).toBeNull();
    expect(root.querySelector('.cm-ai-comment-send-now')).toBeNull();
    expect(root.querySelector('.cm-ai-comment-saved')).toBeNull();
  });

  it('marks an edited message, and the original it replaces as superseded', () => {
    const { root } = mount({
      thread: thread({
        status: 'open',
        replies: [
          ...thread().replies,
          {
            author: 'You',
            at: '2026-08-24 17:03:00 UTC',
            replaces: '2026-08-24 17:00:00 UTC',
            text: 'Успеем к четвергу?',
          },
        ],
      }),
    });
    const [original, agent, revision] = root.querySelectorAll('.cm-ai-comment-reply');
    expect(original.classList.contains('cm-ai-comment-superseded')).toBe(true);
    expect(original.querySelector('.cm-ai-comment-badge')?.textContent).toBe('replaced below');
    expect(agent.classList.contains('cm-ai-comment-superseded')).toBe(false);
    expect(revision.querySelector('.cm-ai-comment-badge')?.textContent).toBe('edited');
    // Both stay on screen: before and after is the point.
    expect(original.textContent).toContain('пятнице');
  });

  it('offers the clipboard prompt, insert-into-text and resolve on an answered thread', () => {
    const { root, actions } = mount();
    const labels = [...root.querySelectorAll('.cm-ai-comment-actions button')].map((b) => b.textContent);
    expect(labels).toEqual(['copy prompt for agent', 'insert into text', 'resolve']);
    root.querySelectorAll<HTMLButtonElement>('.cm-ai-comment-actions button')[1].click();
    expect(actions.insertIntoText).toHaveBeenCalledWith('c-aaaaaa', 'Да, если `без` ревью.');
  });

  it('has no clipboard prompt for a card nothing was sent from yet', () => {
    const { root } = mount({ thread: thread({ id: 'draft:1', status: 'paused', replies: [] }) });
    const labels = [...root.querySelectorAll('.cm-ai-comment-actions button')].map((b) => b.textContent);
    expect(labels).toEqual(['resolve']);
  });
});

describe('chat mode — composer', () => {
  it('names the agent: placeholder, button and hint', () => {
    const { root } = mount();
    expect(composer(root).placeholder).toBe('Message to the agent…');
    expect(sendButton(root).textContent).toBe('Send to agent ↵');
    expect(root.querySelector('.cm-ai-comment-hint')?.textContent).toContain('the agent waits');
    expect(composer(root).getAttribute('data-comment-input')).toBe('c-aaaaaa');
  });

  it('keeps Send disabled while the box is empty', () => {
    const { root } = mount();
    expect(sendButton(root).disabled).toBe(true);
    type(composer(root), '   ');
    expect(sendButton(root).disabled).toBe(true);
    type(composer(root), 'вопрос');
    expect(sendButton(root).disabled).toBe(false);
  });

  it('reports every keystroke through compose, so the app can keep the text', () => {
    const { root, actions } = mount();
    type(composer(root), 'во');
    type(composer(root), 'вопрос');
    expect(actions.compose).toHaveBeenNthCalledWith(1, 'c-aaaaaa', 'во');
    expect(actions.compose).toHaveBeenNthCalledWith(2, 'c-aaaaaa', 'вопрос');
  });

  it('Enter sends', async () => {
    const { root, actions } = mount();
    type(composer(root), 'Почему так?');
    const event = key(composer(root), { key: 'Enter' });
    expect(event.defaultPrevented).toBe(true);
    expect(actions.send).toHaveBeenCalledWith('c-aaaaaa', 'Почему так?');
    await settle();
    expect(composer(root).value).toBe('');
  });

  it('Shift+Enter is a newline, not a send', () => {
    const { root, actions } = mount();
    type(composer(root), 'строка');
    const event = key(composer(root), { key: 'Enter', shiftKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(actions.send).not.toHaveBeenCalled();
  });

  it('an Enter that confirms an IME composition does not send', () => {
    const { root, actions } = mount();
    type(composer(root), 'にほん');
    const event = key(composer(root), { key: 'Enter', isComposing: true });
    expect(event.defaultPrevented).toBe(false);
    expect(actions.send).not.toHaveBeenCalled();
  });

  it('⌘Enter sends too', () => {
    const { root, actions } = mount();
    type(composer(root), 'да');
    key(composer(root), { key: 'Enter', metaKey: true, shiftKey: true });
    expect(actions.send).toHaveBeenCalledWith('c-aaaaaa', 'да');
  });

  it('an empty box sends nothing', () => {
    const { root, actions } = mount();
    type(composer(root), '  \n ');
    key(composer(root), { key: 'Enter' });
    sendButton(root).click();
    expect(actions.send).not.toHaveBeenCalled();
  });

  it('the button sends the same way', () => {
    const { root, actions } = mount();
    type(composer(root), 'кнопкой');
    sendButton(root).click();
    expect(actions.send).toHaveBeenCalledWith('c-aaaaaa', 'кнопкой');
  });

  it('a failed send keeps the text in the box', async () => {
    const actions = makeActions({ send: vi.fn(() => Promise.resolve(false)) });
    const { root } = mount({ actions });
    type(composer(root), 'не потеряй меня');
    key(composer(root), { key: 'Enter' });
    expect(composer(root).readOnly).toBe(true);
    await settle();
    expect(composer(root).value).toBe('не потеряй меня');
    expect(composer(root).readOnly).toBe(false);
    expect(sendButton(root).disabled).toBe(false);
  });

  it('does not send twice while a send is on its way', () => {
    const actions = makeActions({ send: vi.fn(() => new Promise<boolean>(() => {})) });
    const { root } = mount({ actions });
    type(composer(root), 'раз');
    key(composer(root), { key: 'Enter' });
    key(composer(root), { key: 'Enter' });
    sendButton(root).click();
    expect(actions.send).toHaveBeenCalledTimes(1);
  });

  it('keeps its keys away from CM6 keymaps', () => {
    const { root } = mount();
    const outside = vi.fn();
    root.addEventListener('keydown', outside);
    key(composer(root), { key: 'Escape' });
    key(composer(root), { key: 'a' });
    expect(outside).not.toHaveBeenCalled();
  });

  it('starts with the in-flight draft the app kept', () => {
    const { root } = mount({ draft: 'набранное до пересборки' });
    expect(composer(root).value).toBe('набранное до пересборки');
    expect(sendButton(root).disabled).toBe(false);
  });

  it('writes nothing when its DOM goes away — nothing is sent until Send', () => {
    const { actions, widget } = mount();
    widget.destroy();
    expect(actions.flush).not.toHaveBeenCalled();
  });
});

describe('chat mode — editing your own message', () => {
  const ownMessage = (root: HTMLElement) => root.querySelectorAll<HTMLElement>('.cm-ai-comment-reply')[0];
  const agentMessage = (root: HTMLElement) => root.querySelectorAll<HTMLElement>('.cm-ai-comment-reply')[1];
  const editBox = (root: HTMLElement) => root.querySelector<HTMLTextAreaElement>('.cm-ai-comment-edit-input');

  function dblclick(el: Element): void {
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  }

  it('a double-click on your message opens it for editing, prefilled', () => {
    const { root, actions } = mount();
    dblclick(ownMessage(root).querySelector('.cm-ai-comment-text')!);
    expect(editBox(root)?.value).toBe('Успеем к **пятнице**?');
    expect(ownMessage(root).querySelector('.cm-ai-comment-text')).toBeNull();
    expect(actions.editing).toHaveBeenCalledWith('c-aaaaaa', {
      at: '2026-08-24 17:00:00 UTC',
      text: 'Успеем к **пятнице**?',
    });
  });

  it('a double-click on the agent\'s message does nothing', () => {
    const { root, actions } = mount();
    dblclick(agentMessage(root));
    expect(editBox(root)).toBeNull();
    expect(actions.editing).not.toHaveBeenCalled();
  });

  it('saving appends a revision of the original, named by its time', async () => {
    const { root, actions } = mount();
    dblclick(ownMessage(root));
    type(editBox(root)!, 'Успеем к четвергу?');
    key(editBox(root)!, { key: 'Enter' });
    expect(actions.edit).toHaveBeenCalledWith('c-aaaaaa', '2026-08-24 17:00:00 UTC', 'Успеем к четвергу?');
    await settle();
    expect(actions.editing).toHaveBeenLastCalledWith('c-aaaaaa', null);
  });

  it('the Save button does the same; Shift+Enter is a newline', () => {
    const { root, actions } = mount();
    dblclick(ownMessage(root));
    type(editBox(root)!, 'a\nb');
    expect(key(editBox(root)!, { key: 'Enter', shiftKey: true }).defaultPrevented).toBe(false);
    root.querySelector<HTMLButtonElement>('.cm-ai-comment-edit .cm-ai-comment-primary')!.click();
    expect(actions.edit).toHaveBeenCalledWith('c-aaaaaa', '2026-08-24 17:00:00 UTC', 'a\nb');
  });

  it('Escape cancels and puts the message back', () => {
    const { root, actions } = mount();
    const outside = vi.fn();
    root.addEventListener('keydown', outside);
    dblclick(ownMessage(root));
    type(editBox(root)!, 'передумал');
    key(editBox(root)!, { key: 'Escape' });
    expect(outside).not.toHaveBeenCalled();
    expect(editBox(root)).toBeNull();
    expect(ownMessage(root).querySelector('.cm-ai-comment-text')?.textContent).toBe('Успеем к пятнице?');
    expect(actions.edit).not.toHaveBeenCalled();
    expect(actions.editing).toHaveBeenLastCalledWith('c-aaaaaa', null);
  });

  it('unchanged or emptied text just closes the editor', () => {
    const { root, actions } = mount();
    dblclick(ownMessage(root));
    key(editBox(root)!, { key: 'Enter' });
    expect(editBox(root)).toBeNull();
    dblclick(ownMessage(root));
    type(editBox(root)!, '   ');
    key(editBox(root)!, { key: 'Enter' });
    expect(editBox(root)).toBeNull();
    expect(actions.edit).not.toHaveBeenCalled();
  });

  it('a failed save keeps the editor open with the text', async () => {
    const actions = makeActions({ edit: vi.fn(() => Promise.resolve(false)) });
    const { root } = mount({ actions });
    dblclick(ownMessage(root));
    type(editBox(root)!, 'новая версия');
    key(editBox(root)!, { key: 'Enter' });
    await settle();
    expect(editBox(root)?.value).toBe('новая версия');
  });

  it('an edit in flight comes back after a rebuild', () => {
    const { root } = mount({ edit: { at: '2026-08-24 17:00:00 UTC', text: 'полуправка' } });
    expect(editBox(root)?.value).toBe('полуправка');
  });
});

describe('chat mode — eq()', () => {
  it('a card in another mode is a different card', () => {
    const actions = makeActions();
    const chat = new CommentWidget({ thread: thread(), orphaned: false, actions, mode: 'chat' });
    const live = new CommentWidget({ thread: thread(), orphaned: false, actions, mode: 'live' });
    expect(chat.eq(live)).toBe(false);
    expect(live.eq(new CommentWidget({ thread: thread(), orphaned: false, actions }))).toBe(true);
  });

  it('a sent message rebuilds the card even though it is the user\'s trailing reply', () => {
    const actions = makeActions();
    const before = new CommentWidget({ thread: thread({ status: 'answered' }), orphaned: false, actions, mode: 'chat' });
    const after = new CommentWidget({
      thread: thread({
        status: 'answered',
        replies: [...thread().replies, { author: 'You', at: '17:05', text: 'ещё' }],
      }),
      orphaned: false,
      actions,
      mode: 'chat',
    });
    expect(before.eq(after)).toBe(false);
  });

  it('composer text and an open edit do not rebuild the card', () => {
    const actions = makeActions();
    const a = new CommentWidget({ thread: thread(), orphaned: false, actions, mode: 'chat' });
    const b = new CommentWidget({
      thread: thread(),
      orphaned: false,
      actions,
      mode: 'chat',
      draft: 'печатаю',
      edit: { at: 'x', text: 'y' },
    });
    expect(a.eq(b)).toBe(true);
  });
});

describe('isSendKey', () => {
  const base = { key: 'Enter', isComposing: false, keyCode: 13, metaKey: false, ctrlKey: false, shiftKey: false };
  it('Enter yes, Shift+Enter no, ⌘/Ctrl+Enter yes, composing no, other keys no', () => {
    expect(isSendKey(base)).toBe(true);
    expect(isSendKey({ ...base, shiftKey: true })).toBe(false);
    expect(isSendKey({ ...base, metaKey: true })).toBe(true);
    expect(isSendKey({ ...base, ctrlKey: true })).toBe(true);
    expect(isSendKey({ ...base, isComposing: true })).toBe(false);
    expect(isSendKey({ ...base, keyCode: 229 })).toBe(false);
    expect(isSendKey({ ...base, key: 'a' })).toBe(false);
  });
});
