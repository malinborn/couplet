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

const DOC = '/repo/spec.md';

describe('createChatDraftStore', () => {
  it('keeps a reply being composed, per document and thread', () => {
    const store = createChatDraftStore(() => memoryStorage());
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
    const store = createChatDraftStore(() => memoryStorage());
    const anchor = { key: 'k1', line: 1, quote: 'q' };
    store.setFresh(DOC, anchor, 'раз');
    store.setFresh(DOC, anchor, 'раз два');
    store.setFresh(DOC, { key: 'k2', line: 2, quote: 'q2' }, 'другой');
    expect(store.fresh(DOC).map((d) => d.text)).toEqual(['раз два', 'другой']);
    store.clearFresh(DOC, 'k1');
    expect(store.fresh(DOC).map((d) => d.key)).toEqual(['k2']);
  });

  it('forgetThread drops the composer and the edit of one thread only', () => {
    const store = createChatDraftStore(() => memoryStorage());
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

  it('a fresh-draft key tells two cards on one fragment apart', () => {
    expect(freshDraftKey(1, 'q', {}, 1)).not.toBe(freshDraftKey(1, 'q', {}, 2));
    expect(freshDraftKey(1, 'q', { prefix: 'a' }, 1)).not.toBe(freshDraftKey(1, 'q', {}, 1));
  });
});
