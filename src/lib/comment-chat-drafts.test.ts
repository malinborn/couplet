import { describe, expect, it } from 'vitest';
import { createChatDraftStore, freshDraftKey, CHAT_DRAFTS_KEY_PREFIX } from './comment-chat-drafts';

/** A `Storage` backed by a map — Node's own `localStorage` is a no-op under vitest. */
function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
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

/** One storage for the store's whole life — the accessor is called on every read. */
function storageOf(storage: Storage): () => Storage {
  return () => storage;
}

const DOC = '/repo/spec.md';

describe('createChatDraftStore', () => {
  it('keeps a reply being composed, per document and thread', () => {
    const store = createChatDraftStore(storageOf(memoryStorage()));
    store.setReply(DOC, 'c-aaaaaa', 'почти дописал');
    expect(store.reply(DOC, 'c-aaaaaa')).toBe('почти дописал');
    expect(store.reply(DOC, 'c-bbbbbb')).toBeUndefined();
    expect(store.reply('/repo/other.md', 'c-aaaaaa')).toBeUndefined();
  });

  it('survives a restart through storage', () => {
    const storage = memoryStorage();
    const first = createChatDraftStore(() => storage);
    first.setReply(DOC, 'c-aaaaaa', 'ответ');
    first.setEdit(DOC, 'c-aaaaaa', { at: '17:00', text: 'правка' });
    const anchor = { key: freshDraftKey(3, 'цитата', { prefix: 'до ' }, 1), line: 3, quote: 'цитата', prefix: 'до ' };
    first.setFresh(DOC, anchor, 'новый вопрос');

    const second = createChatDraftStore(() => storage);
    expect(second.reply(DOC, 'c-aaaaaa')).toBe('ответ');
    expect(second.edit(DOC, 'c-aaaaaa')).toEqual({ at: '17:00', text: 'правка' });
    expect(second.fresh(DOC)).toEqual([{ ...anchor, suffix: undefined, text: 'новый вопрос' }]);
  });

  it('blank text removes the draft, and an empty document leaves no key behind', () => {
    const storage = memoryStorage();
    const store = createChatDraftStore(() => storage);
    store.setReply(DOC, 'c-aaaaaa', 'x');
    expect(storage.data.has(CHAT_DRAFTS_KEY_PREFIX + DOC)).toBe(true);
    store.setReply(DOC, 'c-aaaaaa', '   ');
    expect(store.reply(DOC, 'c-aaaaaa')).toBeUndefined();
    expect(storage.data.has(CHAT_DRAFTS_KEY_PREFIX + DOC)).toBe(false);
  });

  it('updates a fresh draft in place and clears it once sent', () => {
    const store = createChatDraftStore(storageOf(memoryStorage()));
    const anchor = { key: 'k1', line: 1, quote: 'q' };
    store.setFresh(DOC, anchor, 'раз');
    store.setFresh(DOC, anchor, 'раз два');
    store.setFresh(DOC, { key: 'k2', line: 2, quote: 'q2' }, 'другой');
    expect(store.fresh(DOC).map((d) => d.text)).toEqual(['раз два', 'другой']);
    store.clearFresh(DOC, 'k1');
    expect(store.fresh(DOC).map((d) => d.key)).toEqual(['k2']);
  });

  it('forgetThread drops the composer and the edit of one thread only', () => {
    const store = createChatDraftStore(storageOf(memoryStorage()));
    store.setReply(DOC, 'c-aaaaaa', 'a');
    store.setEdit(DOC, 'c-aaaaaa', { at: '1', text: 'b' });
    store.setReply(DOC, 'c-bbbbbb', 'c');
    store.forgetThread(DOC, 'c-aaaaaa');
    expect(store.reply(DOC, 'c-aaaaaa')).toBeUndefined();
    expect(store.edit(DOC, 'c-aaaaaa')).toBeUndefined();
    expect(store.reply(DOC, 'c-bbbbbb')).toBe('c');
  });

  it('keeps working in memory when storage throws or is missing', () => {
    const throwing = createChatDraftStore(() => {
      throw new Error('SecurityError');
    });
    throwing.setReply(DOC, 'c-aaaaaa', 'держу в памяти');
    expect(throwing.reply(DOC, 'c-aaaaaa')).toBe('держу в памяти');

    const full = memoryStorage();
    full.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    const store = createChatDraftStore(() => full);
    store.setReply(DOC, 'c-aaaaaa', 'и тут');
    expect(store.reply(DOC, 'c-aaaaaa')).toBe('и тут');

    const none = createChatDraftStore(() => null);
    none.setReply(DOC, 'c-aaaaaa', 'без хранилища');
    expect(none.reply(DOC, 'c-aaaaaa')).toBe('без хранилища');
  });

  it('ignores corrupt or hand-edited storage instead of failing', () => {
    const storage = memoryStorage();
    storage.setItem(CHAT_DRAFTS_KEY_PREFIX + DOC, '{not json');
    expect(createChatDraftStore(() => storage).fresh(DOC)).toEqual([]);

    storage.setItem(
      CHAT_DRAFTS_KEY_PREFIX + DOC,
      JSON.stringify({ replies: { ok: 'текст', bad: 42 }, fresh: [{ key: 'k' }, 'junk'], edits: [] })
    );
    const store = createChatDraftStore(() => storage);
    expect(store.reply(DOC, 'ok')).toBe('текст');
    expect(store.reply(DOC, 'bad')).toBeUndefined();
    expect(store.fresh(DOC)).toEqual([]);
  });

  // Every window has its own store over the one shared `localStorage`, and a
  // tab moves between windows. Window A typed in a document, the tab moved
  // to B, B sent the message; A's next write (any draft of that document)
  // must neither bring the sent text back nor drop what B holds.
  it('two windows over one storage never resurrect or delete each other\'s drafts', () => {
    const shared = memoryStorage();
    const windowA = createChatDraftStore(() => shared);
    const windowB = createChatDraftStore(() => shared);

    windowA.setReply(DOC, 'c-aaaaaa', 'отправлю из другого окна');
    windowA.setFresh(DOC, { key: 'k-a', line: 1, quote: 'q' }, 'новый тред из A');
    // The tab moves to B, which sees the text and sends it.
    expect(windowB.reply(DOC, 'c-aaaaaa')).toBe('отправлю из другого окна');
    windowB.setReply(DOC, 'c-aaaaaa', '');
    windowB.clearFresh(DOC, 'k-a');
    windowB.setReply(DOC, 'c-bbbbbb', 'B набирает');

    // A writes something else for the same document afterwards.
    windowA.setEdit(DOC, 'c-cccccc', { at: '17:00', text: 'правка из A' });

    for (const store of [windowA, windowB, createChatDraftStore(() => shared)]) {
      expect(store.reply(DOC, 'c-aaaaaa')).toBeUndefined();
      expect(store.fresh(DOC)).toEqual([]);
      expect(store.reply(DOC, 'c-bbbbbb')).toBe('B набирает');
      expect(store.edit(DOC, 'c-cccccc')).toEqual({ at: '17:00', text: 'правка из A' });
    }
  });

  it('text a refused write kept in memory is not lost to the next read', () => {
    const storage = memoryStorage();
    const store = createChatDraftStore(() => storage);
    store.setReply(DOC, 'c-aaaaaa', 'раз');
    const setItem = storage.setItem;
    storage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    store.setReply(DOC, 'c-aaaaaa', 'раз два');
    expect(store.reply(DOC, 'c-aaaaaa')).toBe('раз два');
    // Storage recovers: the next write carries the memory copy out.
    storage.setItem = setItem;
    store.setReply(DOC, 'c-bbbbbb', 'ещё');
    const fresh = createChatDraftStore(() => storage);
    expect(fresh.reply(DOC, 'c-aaaaaa')).toBe('раз два');
    expect(fresh.reply(DOC, 'c-bbbbbb')).toBe('ещё');
  });

  it('a fresh-draft key tells two cards on one fragment apart', () => {
    expect(freshDraftKey(1, 'q', {}, 1)).not.toBe(freshDraftKey(1, 'q', {}, 2));
    expect(freshDraftKey(1, 'q', { prefix: 'a' }, 1)).not.toBe(freshDraftKey(1, 'q', {}, 1));
  });
});
