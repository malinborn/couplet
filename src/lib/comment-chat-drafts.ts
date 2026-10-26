/**
 * Unsent text of chat-mode comment cards.
 *
 * In the live box every keystroke reaches the sidecar, so the file is the
 * second copy of what is being typed. In chat mode nothing is written until
 * Send — which makes the composer the *only* copy of a message the user has
 * not sent yet. The data-safety rule (CLAUDE.md: user text is never deleted
 * without a second copy) therefore needs a home for it here: `localStorage`,
 * so a card rebuild, a tab switch, a tab moving to another window and a
 * restart all bring it back — with a memory copy for when storage fails.
 *
 * Three kinds of text, all per document path:
 * - a reply being composed on an existing thread (by thread id);
 * - an inline edit of one of the user's own messages (by thread id);
 * - a new thread nobody has sent yet ("fresh"): it has no id in any file, so
 *   it carries its anchor (line, quote, context) and a key made from those
 *   plus the moment it was started.
 *
 * Every storage access is wrapped: storage can be missing, full or throwing
 * (private mode, quota), and that must never cost the in-memory copy.
 */

/** A new thread typed into a draft card and not sent yet. */
export interface FreshDraft {
  key: string;
  line: number;
  quote: string;
  prefix?: string;
  suffix?: string;
  text: string;
}

/** An inline edit in flight: the `at` of the message it revises, and the text. */
export interface ChatEditDraft {
  at: string;
  text: string;
}

interface PathDrafts {
  replies: Record<string, string>;
  edits: Record<string, ChatEditDraft>;
  fresh: FreshDraft[];
}

/** `localStorage` key prefix; the document path follows it. */
export const CHAT_DRAFTS_KEY_PREFIX = 'md-mini:commentChatDrafts:';

/**
 * Key of a fresh draft: its anchor and the moment it was started. The moment
 * is there so two cards opened on the same fragment stay two drafts.
 */
export function freshDraftKey(
  line: number,
  quote: string,
  context: { prefix?: string; suffix?: string },
  startedAt: number
): string {
  return JSON.stringify([line, quote, context.prefix ?? '', context.suffix ?? '', startedAt]);
}

function empty(): PathDrafts {
  return { replies: {}, edits: {}, fresh: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whatever storage holds, as a well-formed record — junk is dropped, not trusted. */
function sanitize(raw: unknown): PathDrafts {
  const out = empty();
  if (!isRecord(raw)) return out;
  if (isRecord(raw.replies)) {
    for (const [id, text] of Object.entries(raw.replies)) {
      if (typeof text === 'string' && text.trim()) out.replies[id] = text;
    }
  }
  if (isRecord(raw.edits)) {
    for (const [id, edit] of Object.entries(raw.edits)) {
      if (isRecord(edit) && typeof edit.at === 'string' && typeof edit.text === 'string') {
        out.edits[id] = { at: edit.at, text: edit.text };
      }
    }
  }
  if (Array.isArray(raw.fresh)) {
    for (const item of raw.fresh) {
      if (
        isRecord(item) &&
        typeof item.key === 'string' &&
        typeof item.line === 'number' &&
        typeof item.quote === 'string' &&
        typeof item.text === 'string' &&
        item.text.trim()
      ) {
        out.fresh.push({
          key: item.key,
          line: item.line,
          quote: item.quote,
          prefix: typeof item.prefix === 'string' ? item.prefix : undefined,
          suffix: typeof item.suffix === 'string' ? item.suffix : undefined,
          text: item.text,
        });
      }
    }
  }
  return out;
}

function isEmpty(drafts: PathDrafts): boolean {
  return (
    Object.keys(drafts.replies).length === 0 &&
    Object.keys(drafts.edits).length === 0 &&
    drafts.fresh.length === 0
  );
}

export interface ChatDraftStore {
  /** The reply being composed on thread `id`. */
  reply(path: string, id: string): string | undefined;
  /** Keep it; blank text removes it — there is nothing to keep. */
  setReply(path: string, id: string, text: string): void;
  /** The inline edit open on thread `id`. */
  edit(path: string, id: string): ChatEditDraft | undefined;
  /** Keep it, or drop it with `null`. */
  setEdit(path: string, id: string, edit: ChatEditDraft | null): void;
  /** Every unsent new thread of `path`, oldest first. */
  fresh(path: string): FreshDraft[];
  /** Keep a new thread's text under its anchor; blank text removes it. */
  setFresh(path: string, anchor: Omit<FreshDraft, 'text'>, text: string): void;
  /** It was sent, or its card resolved. */
  clearFresh(path: string, key: string): void;
  /** Thread `id` was sent to, or resolved: its composer and edit go. */
  forgetThread(path: string, id: string): void;
}

/** A deep copy, so the memory fallback never shares objects with a caller. */
function structuredCloneDrafts(drafts: PathDrafts): PathDrafts {
  return {
    replies: { ...drafts.replies },
    edits: Object.fromEntries(Object.entries(drafts.edits).map(([id, e]) => [id, { ...e }])),
    fresh: drafts.fresh.map((d) => ({ ...d })),
  };
}

export function createChatDraftStore(storage: () => Storage | null): ChatDraftStore {
  /**
   * Fallback only. `localStorage` is shared by every window of the app, and a
   * document's tab moves between windows — so storage, not a per-window
   * cache, is the truth: every read goes to it and every change is a
   * read → modify → write of it. A cache would hand one window's stale copy
   * back to storage on its next write, bringing back a draft another window
   * already sent (a duplicate send one Enter away) or deleting text another
   * window is holding.
   *
   * The memory copy answers only when storage cannot: missing, throwing, or
   * refusing our last write for this path (`unsaved`) — then it is the one
   * place that text still lives.
   */
  const memory = new Map<string, PathDrafts>();
  const unsaved = new Set<string>();

  const load = (path: string): PathDrafts => {
    const fallback = (): PathDrafts => structuredCloneDrafts(memory.get(path) ?? empty());
    if (unsaved.has(path)) return fallback();
    let raw: string | null;
    try {
      const store = storage();
      if (!store) return fallback();
      raw = store.getItem(CHAT_DRAFTS_KEY_PREFIX + path);
    } catch {
      return fallback();
    }
    let drafts = empty();
    try {
      if (raw) drafts = sanitize(JSON.parse(raw));
    } catch {
      // Corrupt: start from nothing rather than fail the card.
    }
    memory.set(path, structuredCloneDrafts(drafts));
    return drafts;
  };

  const persist = (path: string, drafts: PathDrafts): void => {
    memory.set(path, structuredCloneDrafts(drafts));
    try {
      const store = storage();
      if (!store) {
        unsaved.add(path);
        return;
      }
      if (isEmpty(drafts)) store.removeItem(CHAT_DRAFTS_KEY_PREFIX + path);
      else store.setItem(CHAT_DRAFTS_KEY_PREFIX + path, JSON.stringify(drafts));
      unsaved.delete(path);
    } catch {
      // Full or refused: the memory copy holds it for this run.
      unsaved.add(path);
    }
  };

  return {
    reply: (path, id) => load(path).replies[id],
    setReply(path, id, text) {
      const drafts = load(path);
      if (text.trim()) drafts.replies[id] = text;
      else delete drafts.replies[id];
      persist(path, drafts);
    },
    edit: (path, id) => load(path).edits[id],
    setEdit(path, id, edit) {
      const drafts = load(path);
      if (edit) drafts.edits[id] = { at: edit.at, text: edit.text };
      else delete drafts.edits[id];
      persist(path, drafts);
    },
    fresh: (path) => load(path).fresh.map((draft) => ({ ...draft })),
    setFresh(path, anchor, text) {
      const drafts = load(path);
      const index = drafts.fresh.findIndex((draft) => draft.key === anchor.key);
      if (!text.trim()) {
        if (index >= 0) drafts.fresh.splice(index, 1);
      } else if (index >= 0) {
        drafts.fresh[index].text = text;
      } else {
        drafts.fresh.push({ ...anchor, text });
      }
      persist(path, drafts);
    },
    clearFresh(path, key) {
      const drafts = load(path);
      drafts.fresh = drafts.fresh.filter((draft) => draft.key !== key);
      persist(path, drafts);
    },
    forgetThread(path, id) {
      const drafts = load(path);
      delete drafts.replies[id];
      delete drafts.edits[id];
      persist(path, drafts);
    },
  };
}
