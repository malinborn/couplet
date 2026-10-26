import type { AnchorContext } from './comment-format';
import type { ChatDraftStore } from './comment-chat-drafts';
import type { CommentWriter } from './comment-writer';

/**
 * Chat mode's writes — Send, edit, resolve — and what is in flight.
 *
 * Out of `App.svelte` so the ordering can be tested: every one of these is a
 * sidecar write behind an IPC, and while it is on its way the card can be
 * rebuilt (the agent answers, the tab is switched away and back). Three rules
 * come out of that:
 *
 * - **A card whose write is in flight is `sending`** (`isSending`), and the
 *   app builds it locked. A rebuilt composer that came up editable with the
 *   text in flight would be one Enter away from sending it twice.
 * - **Kept text is cleared only when it is exactly what was written.** Text
 *   that is different by the time the write lands is the user's, not the
 *   write's, and stays.
 * - **A new thread being sent is not a draft any more and not a thread yet.**
 *   Resolving it waits for the create and resolves what it created; a tab
 *   switch meanwhile must not bring its card back from the kept text
 *   (`isFreshSending`).
 */

/** A new-thread card nothing has been written for yet (`commentDrafts` in App). */
export interface ChatDraftCard {
  line: number;
  quote: string;
  context: AnchorContext;
  /** Its key in the draft store. */
  freshKey: string;
}

export interface ChatSenderDeps {
  writer: CommentWriter;
  drafts: ChatDraftStore;
  /** The live map of draft cards. A getter: the app replaces the map on a document switch. */
  cards: () => Map<string, ChatDraftCard>;
  /** The document the window shows now. */
  path: () => string | null;
  create: (
    path: string,
    line: number,
    quote: string,
    text: string,
    context: AnchorContext
  ) => Promise<string>;
  reply: (path: string, id: string, text: string) => Promise<void>;
  edit: (path: string, id: string, originalAt: string, text: string) => Promise<void>;
  resolve: (path: string, id: string) => Promise<void>;
  /** A write failed: say so (`comment-error`). */
  reportError: (path: string, err: unknown) => void;
  /** A write landed: end any standing failure. */
  written: () => void;
  /** Live-box state of a thread being resolved: pending autosave, countdown. */
  forgetLive: (id: string) => void;
  /** A thread was just created in `path` — re-arm the watcher, put the caret back. */
  created: (path: string, realId: string) => Promise<void>;
  /** Put the caret back in this card's composer on the next rebuild. */
  focus: (id: string) => void;
  /** Rebuild the cards from the sidecar. */
  reload: () => Promise<void>;
}

export interface ChatSender {
  send(cardId: string, text: string): Promise<boolean>;
  edit(cardId: string, originalAt: string, text: string): Promise<boolean>;
  resolve(cardId: string): Promise<void>;
  /** A send or an edit of this card (draft id or thread id) is in flight. */
  isSending(path: string, id: string): boolean;
  /** This new thread's first message is on its way: its kept text is not a draft card. */
  isFreshSending(freshKey: string): boolean;
}

export function createChatSender(deps: ChatSenderDeps): ChatSender {
  const { writer, drafts } = deps;
  const sending = new Set<string>();
  const sendingFresh = new Set<string>();
  const key = (path: string, id: string): string => `${path}\n${id}`;

  /** Mark `path`/`id` in flight around `fn`, rebuilding the cards afterwards
   * either way — a card rebuilt locked meanwhile is unlocked only by that. */
  async function inFlight<T>(path: string, id: string, fn: () => Promise<T>): Promise<T> {
    const k = key(path, id);
    sending.add(k);
    try {
      return await fn();
    } finally {
      sending.delete(k);
    }
  }

  async function sendNew(path: string, cardId: string, card: ChatDraftCard, text: string): Promise<boolean> {
    sendingFresh.add(card.freshKey);
    let realId: string | null | undefined;
    try {
      realId = await inFlight(path, cardId, () =>
        writer.enqueue(async () => {
          try {
            const id = await deps.create(path, card.line, card.quote, text, card.context);
            // Inside the queued step, so a resolve queued behind this create
            // already runs under the id the file gave the thread.
            writer.redirect(cardId, id);
            const kept = drafts.fresh(path).find((d) => d.key === card.freshKey);
            drafts.clearFresh(path, card.freshKey);
            // Typed differently since the send: the user's, kept under the thread.
            if (kept && kept.text !== text && kept.text.trim()) drafts.setReply(path, id, kept.text);
            const map = deps.cards();
            for (const [draftId, draft] of [...map]) {
              if (draft.freshKey === card.freshKey) map.delete(draftId);
            }
            return id;
          } catch (err) {
            deps.reportError(path, err);
            return null;
          }
        })
      );
    } finally {
      sendingFresh.delete(card.freshKey);
    }
    if (!realId) {
      await deps.reload();
      return false;
    }
    deps.written();
    if (deps.path() === path) {
      deps.focus(realId);
      await deps.created(path, realId);
    }
    await deps.reload();
    return true;
  }

  return {
    async send(cardId, text) {
      const path = deps.path();
      if (!path || !text.trim()) return false;
      const card = deps.cards().get(cardId);
      if (card) return sendNew(path, cardId, card, text);
      const id = writer.idFor(cardId);
      const sent = await inFlight(path, id, () =>
        writer.run(cardId, async (realId) => {
          try {
            await deps.reply(path, realId, text);
            return true;
          } catch (err) {
            deps.reportError(path, err);
            return false;
          }
        })
      );
      if (sent) {
        if (drafts.reply(path, id) === text) drafts.setReply(path, id, '');
        deps.written();
        if (deps.path() === path) deps.focus(id);
      }
      await deps.reload();
      return sent === true;
    },

    async edit(cardId, originalAt, text) {
      const path = deps.path();
      if (!path || !text.trim()) return false;
      const id = writer.idFor(cardId);
      const written = await inFlight(path, id, () =>
        writer.run(cardId, async (realId) => {
          try {
            await deps.edit(path, realId, originalAt, text);
            return true;
          } catch (err) {
            deps.reportError(path, err);
            return false;
          }
        })
      );
      if (written) {
        const kept = drafts.edit(path, id);
        if (kept && kept.at === originalAt && kept.text === text) drafts.setEdit(path, id, null);
        deps.written();
      }
      await deps.reload();
      return written === true;
    },

    async resolve(cardId) {
      const path = deps.path();
      if (!path) return;
      const id = writer.idFor(cardId);
      deps.forgetLive(id);
      const card = deps.cards().get(id);
      if (card && !sending.has(key(path, id))) {
        // Nothing was ever written; just drop the card — and its kept text,
        // which resolving is the explicit way to throw away.
        deps.cards().delete(id);
        drafts.clearFresh(path, card.freshKey);
        await deps.reload();
        return;
      }
      // Queued: behind a draft's first write (a live start, or a chat send in
      // flight) it runs under the id the file gave the thread, and resolves
      // what that write created. A failure puts the card back with a toast.
      await writer.run(cardId, async (realId) => {
        deps.forgetLive(realId);
        const left = deps.cards().get(realId);
        if (left) {
          // The create failed: still nothing on disk.
          deps.cards().delete(realId);
          drafts.clearFresh(path, left.freshKey);
          return;
        }
        try {
          await deps.resolve(path, realId);
          // A resolved card is gone from the screen; its unsent text with it.
          drafts.forgetThread(path, realId);
        } catch (err) {
          deps.reportError(path, err);
        }
      });
      await deps.reload();
    },

    isSending: (path, id) => sending.has(key(path, id)) || sending.has(key(path, writer.idFor(id))),
    isFreshSending: (freshKey) => sendingFresh.has(freshKey),
  };
}
