import { describe, expect, it, vi } from 'vitest';
import { createChatSender, type ChatDraftCard, type ChatSenderDeps } from './comment-chat-send';
import { createChatDraftStore } from './comment-chat-drafts';
import { createCommentWriter } from './comment-writer';

const DOC = '/repo/spec.md';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

/** A promise the test settles by hand — an IPC still on its way. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(overrides: Partial<ChatSenderDeps> = {}) {
  const storage = memoryStorage();
  const drafts = createChatDraftStore(() => storage);
  const writer = createCommentWriter(async () => null);
  let cards = new Map<string, ChatDraftCard>();
  const deps: ChatSenderDeps = {
    writer,
    drafts,
    cards: () => cards,
    path: () => DOC,
    create: vi.fn(async () => 'c-new000'),
    reply: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    resolve: vi.fn(async () => {}),
    reportError: vi.fn(),
    written: vi.fn(),
    forgetLive: vi.fn(),
    created: vi.fn(async () => {}),
    focus: vi.fn(),
    reload: vi.fn(async () => {}),
    ...overrides,
  };
  const sender = createChatSender(deps);
  return {
    sender,
    deps,
    drafts,
    get cards() {
      return cards;
    },
    /** A document switch empties the app's map. */
    switchAway() {
      cards = new Map();
    },
  };
}

const CARD: ChatDraftCard = { line: 3, quote: 'цитата', context: {}, freshKey: 'k-1' };

describe('chat sender — a reply in flight', () => {
  it('marks the card sending until the write lands, then rebuilds', async () => {
    const write = deferred<void>();
    const t = setup({ reply: vi.fn(() => write.promise) });
    t.drafts.setReply(DOC, 'c-aaaaaa', 'вопрос');
    const sent = t.sender.send('c-aaaaaa', 'вопрос');
    await flush();
    // A rebuild now (the agent answered) must build the composer locked…
    expect(t.sender.isSending(DOC, 'c-aaaaaa')).toBe(true);
    // …and the kept text is still there until the write lands.
    expect(t.drafts.reply(DOC, 'c-aaaaaa')).toBe('вопрос');
    write.resolve();
    expect(await sent).toBe(true);
    expect(t.sender.isSending(DOC, 'c-aaaaaa')).toBe(false);
    expect(t.drafts.reply(DOC, 'c-aaaaaa')).toBeUndefined();
    expect(t.deps.reload).toHaveBeenCalled();
  });

  it('keeps text that differs from what was sent', async () => {
    const write = deferred<void>();
    const t = setup({ reply: vi.fn(() => write.promise) });
    const sent = t.sender.send('c-aaaaaa', 'первое');
    await flush();
    t.drafts.setReply(DOC, 'c-aaaaaa', 'второе, набранное после');
    write.resolve();
    await sent;
    expect(t.drafts.reply(DOC, 'c-aaaaaa')).toBe('второе, набранное после');
  });

  it('a failed send unlocks, keeps the text, reports and rebuilds', async () => {
    const t = setup({ reply: vi.fn(async () => Promise.reject(new Error('EACCES'))) });
    t.drafts.setReply(DOC, 'c-aaaaaa', 'не потеряй');
    expect(await t.sender.send('c-aaaaaa', 'не потеряй')).toBe(false);
    expect(t.sender.isSending(DOC, 'c-aaaaaa')).toBe(false);
    expect(t.drafts.reply(DOC, 'c-aaaaaa')).toBe('не потеряй');
    expect(t.deps.reportError).toHaveBeenCalled();
    expect(t.deps.reload).toHaveBeenCalled();
  });

  it('an edit in flight is sending too, and its kept edit goes only if it is what was written', async () => {
    const write = deferred<void>();
    const t = setup({ edit: vi.fn(() => write.promise) });
    t.drafts.setEdit(DOC, 'c-aaaaaa', { at: '17:00', text: 'правка' });
    const done = t.sender.edit('c-aaaaaa', '17:00', 'правка');
    await flush();
    expect(t.sender.isSending(DOC, 'c-aaaaaa')).toBe(true);
    expect(t.drafts.edit(DOC, 'c-aaaaaa')).toEqual({ at: '17:00', text: 'правка' });
    write.resolve();
    expect(await done).toBe(true);
    expect(t.drafts.edit(DOC, 'c-aaaaaa')).toBeUndefined();
    expect(t.deps.edit).toHaveBeenCalledWith(DOC, 'c-aaaaaa', '17:00', 'правка');
  });
});

describe('chat sender — a new thread', () => {
  it('creates it, moves the card to the new id and clears its kept text', async () => {
    const t = setup();
    t.cards.set('draft:1', CARD);
    t.drafts.setFresh(DOC, { key: 'k-1', line: 3, quote: 'цитата' }, 'первое сообщение');
    expect(await t.sender.send('draft:1', 'первое сообщение')).toBe(true);
    expect(t.deps.create).toHaveBeenCalledWith(DOC, 3, 'цитата', 'первое сообщение', {});
    expect(t.cards.size).toBe(0);
    expect(t.drafts.fresh(DOC)).toEqual([]);
    expect(t.deps.focus).toHaveBeenCalledWith('c-new000');
    expect(t.deps.created).toHaveBeenCalled();
  });

  it('a resolve pressed while the first Send is in flight resolves the thread it creates', async () => {
    const create = deferred<string>();
    const t = setup({ create: vi.fn(() => create.promise) });
    t.cards.set('draft:1', CARD);
    t.drafts.setFresh(DOC, { key: 'k-1', line: 3, quote: 'цитата' }, 'текст');
    const sent = t.sender.send('draft:1', 'текст');
    await flush();
    expect(t.sender.isSending(DOC, 'draft:1')).toBe(true);

    const resolved = t.sender.resolve('draft:1');
    await flush();
    // Not dropped on the spot: the write is already on its way.
    expect(t.deps.resolve).not.toHaveBeenCalled();

    create.resolve('c-new000');
    await sent;
    await resolved;
    expect(t.deps.resolve).toHaveBeenCalledWith(DOC, 'c-new000');
    expect(t.cards.size).toBe(0);
    expect(t.drafts.fresh(DOC)).toEqual([]);
  });

  it('a resolve queued behind a failed create just drops the card', async () => {
    const create = deferred<string>();
    const t = setup({ create: vi.fn(() => create.promise) });
    t.cards.set('draft:1', CARD);
    t.drafts.setFresh(DOC, { key: 'k-1', line: 3, quote: 'цитата' }, 'текст');
    const sent = t.sender.send('draft:1', 'текст');
    await flush();
    const resolved = t.sender.resolve('draft:1');
    create.reject(new Error('EROFS'));
    expect(await sent).toBe(false);
    await resolved;
    expect(t.deps.resolve).not.toHaveBeenCalled();
    expect(t.cards.size).toBe(0);
    expect(t.drafts.fresh(DOC)).toEqual([]);
  });

  it('while the create is in flight its kept text is not a card to bring back, and none is left behind', async () => {
    const create = deferred<string>();
    const t = setup({ create: vi.fn(() => create.promise) });
    t.cards.set('draft:1', CARD);
    t.drafts.setFresh(DOC, { key: 'k-1', line: 3, quote: 'цитата' }, 'текст');
    const sent = t.sender.send('draft:1', 'текст');
    await flush();
    // The window switched away and back: the app's map was emptied, and
    // reloadComments asks before re-adopting the kept text as a card.
    t.switchAway();
    expect(t.sender.isFreshSending('k-1')).toBe(true);
    // Had it been adopted anyway, the create's landing removes it.
    t.cards.set('draft:7', { ...CARD });
    create.resolve('c-new000');
    await sent;
    expect(t.sender.isFreshSending('k-1')).toBe(false);
    expect(t.cards.size).toBe(0);
    expect(t.drafts.fresh(DOC)).toEqual([]);
  });

  it('resolving a draft card with no send in flight drops it at once', async () => {
    const t = setup();
    t.cards.set('draft:1', CARD);
    t.drafts.setFresh(DOC, { key: 'k-1', line: 3, quote: 'цитата' }, 'передумал');
    await t.sender.resolve('draft:1');
    expect(t.cards.size).toBe(0);
    expect(t.drafts.fresh(DOC)).toEqual([]);
    expect(t.deps.resolve).not.toHaveBeenCalled();
  });

  it('resolving a thread forgets its kept text and its live state', async () => {
    const t = setup();
    t.drafts.setReply(DOC, 'c-aaaaaa', 'несданное');
    await t.sender.resolve('c-aaaaaa');
    expect(t.deps.resolve).toHaveBeenCalledWith(DOC, 'c-aaaaaa');
    expect(t.deps.forgetLive).toHaveBeenCalledWith('c-aaaaaa');
    expect(t.drafts.reply(DOC, 'c-aaaaaa')).toBeUndefined();
  });
});
