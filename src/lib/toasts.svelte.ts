/**
 * Stack of persistent notifications shown at the bottom-right of a window.
 *
 * Nothing auto-dismisses; every toast waits for its close button. Ordering is
 * explicit rather than insertion-based, because the update check only fires 15s
 * after launch and would otherwise land below the session toast.
 */

export type ToastPayload =
  /**
   * A save did not reach the disk (#18). The only toast here that reports lost
   * work rather than an opportunity: without it a refused write — a file whose
   * ACL denies replacement, a full or read-only volume — reached nothing but
   * `console.error`, and the user kept typing into a document that had stopped
   * being saved. It carries the OS's own message because "could not save" on
   * its own gives no one anything to act on.
   */
  | { kind: 'save-error'; fileName: string; message: string }
  /**
   * A comment sidecar write did not reach the disk (#54). Separate from
   * `save-error` for two reasons that both bite: the document's toast tells the
   * user to press ⌘S, which saves the document and does nothing for a comment,
   * and a successful document save calls `dismissKind('save-error')` — which
   * would wipe a standing comment failure the moment an unrelated autosave
   * landed.
   *
   * It earns a toast at all because the sidecar is the one file with no second
   * copy anywhere. The document has a dirty flag that reschedules the write and
   * a recovery snapshot every five seconds; a comment box has neither, and
   * since #23/#36 it holds the reply a human is still typing. Before this,
   * every failed sidecar write reached `console.error` and nothing else.
   */
  | { kind: 'comment-error'; fileName: string; message: string }
  /**
   * A language change (native menu, `apply_language_change` in `lib.rs`)
   * failed to persist — a read-only or full app data directory, same failure
   * shape `save-error`/`comment-error` already cover. Without this, the only
   * signal was an `eprintln!`, invisible in a bundled app: the user clicks a
   * language, nothing visibly happens, indistinguishable from a broken menu
   * item. Carries the OS's own message for the same reason `save-error` does.
   */
  | { kind: 'language-error'; message: string }
  /**
   * A tab switch or close did nothing because the document's latest edits
   * have not reached the disk yet — a save still in flight. Not `save-error`:
   * nothing failed and ⌘S is not the remedy, and `hasKind('save-error')` is
   * what refuses every switch. The next successful save withdraws it.
   */
  | { kind: 'unsaved-blocked'; fileName: string }
  /**
   * A file could not be read to be shown in a tab — opened, switched to, or
   * restored. The tab is not shown (an empty buffer on that path would be
   * autosaved over the file), and without this the key or click that asked
   * for it did nothing visible at all.
   */
  | { kind: 'open-error'; fileName: string; message: string }
  | { kind: 'update'; latest: string; current: string; highlight?: string }
  /**
   * Answers to a manual "Check for Updates…" click (#82) — the automatic
   * checker stays silent on these two outcomes, but a click always gets a
   * reply. `update` itself (above) still covers "a newer version exists",
   * reused via `report_update`'s `force` flag so it bypasses dismissal
   * suppression instead of being a second "found" toast.
   */
  | { kind: 'update-none' }
  | { kind: 'update-check-failed' }
  | { kind: 'session'; count: number }
  /** Startup nudge for someone who has never connected an agent. */
  | { kind: 'ai-nudge' }
  /** Raised the first time an agent actually drives this install. */
  | { kind: 'ai-first-use' }
  /**
   * The watch prompt was put on the clipboard — or could not be, when the
   * document has never been saved and so has no path to watch. Persistent like
   * every other toast here, which suits this one: the instruction stays on
   * screen while the user switches to their agent.
   */
  | { kind: 'ai-watch-copied'; saved: boolean }
  /**
   * The bind-to-agent prompt was put on the clipboard by the top-left button
   * (#29) — or could not be, because the document has never been saved and so
   * has no path to hand an agent. Persistent like the rest: the instruction
   * has to stay up while the user switches to their agent and pastes.
   */
  | { kind: 'ai-bind-copied'; saved: boolean }
  /**
   * Freshly pasted content parses as JSON worth expanding (#30). The only
   * toast here that offers an action on the document rather than reporting
   * something already done — deliberately, because the document must never
   * reformat itself. Withdrawn when the offer stops applying.
   */
  | { kind: 'json-offer' }
  /**
   * Одноразовое «у нас есть темы».
   *
   * Тем стало четыре, и все они живут в меню, которое человек открывает раз в
   * жизни — в результате про них знает только тот, кто их и добавил. Тост
   * показывается один раз за установку и ничего не предлагает нажать: его
   * единственная задача — назвать меню. Дальше разбираются сами.
   */
  | { kind: 'themes-nudge' };

export type ToastKind = ToastPayload['kind'];

export interface ToastEntry {
  id: number;
  payload: ToastPayload;
}

/** Lower sorts higher in the stack. */
const ORDER: Record<ToastKind, number> = {
  // Top of the stack, above everything: it is the only notice that means work
  // is being lost right now, and it stays up until the next save succeeds.
  'save-error': 0,
  // Same rank as the document's: both mean work is being lost right now. They
  // can legitimately coexist — a volume that has gone read-only fails the
  // document and the sidecar alike — and then the two sort together at the top.
  'comment-error': 0,
  // Same rank again, same reasoning: a read-only app data directory that
  // breaks a language change is exactly as urgent as a failed save.
  'language-error': 0,
  update: 1,
  // Direct responses to the same menu click that produces `update` above —
  // sorts right beside it rather than with the "just clicked" group below,
  // since it answers the identical question.
  'update-none': 1,
  'update-check-failed': 1,
  session: 2,
  // Both AI notices sort last: neither is time-sensitive the way an update or a
  // restorable session is. They never coexist — one requires having never
  // connected, the other requires having just connected.
  'ai-nudge': 3,
  'ai-first-use': 3,
  // Рядом с AI-подсказками и по той же причине: не срочно. Совпасть с ними
  // может — обе одноразовые и обе про «а так тоже можно».
  'themes-nudge': 3,
  // Sorts last of all: it is a direct response to something the user just
  // clicked, so it belongs nearest their attention rather than above notices
  // they have not acted on.
  'ai-watch-copied': 4,
  'ai-bind-copied': 4,
  // A direct answer to the key the user just pressed, like the two above.
  'unsaved-blocked': 4,
  'open-error': 4,
  // Sorts below everything: it is the only toast that is still waiting on a
  // decision, so it belongs closest to the pointer that has to make it.
  'json-offer': 5,
};

export function createToastStore() {
  let entries = $state<ToastEntry[]>([]);
  let nextId = 1;

  function sorted(list: ToastEntry[]): ToastEntry[] {
    return [...list].sort((a, b) => ORDER[a.payload.kind] - ORDER[b.payload.kind]);
  }

  return {
    get toasts(): ToastEntry[] {
      return entries;
    },

    /** Replaces any existing toast of the same kind. Returns the new id. */
    push(payload: ToastPayload): number {
      const id = nextId++;
      entries = sorted([
        ...entries.filter((e) => e.payload.kind !== payload.kind),
        { id, payload },
      ]);
      return id;
    },

    dismiss(id: number): void {
      entries = entries.filter((e) => e.id !== id);
    },

    dismissKind(kind: ToastKind): void {
      entries = entries.filter((e) => e.payload.kind !== kind);
    },

    /** Whether a toast of `kind` is currently standing. */
    hasKind(kind: ToastKind): boolean {
      return entries.some((e) => e.payload.kind === kind);
    },
  };
}

export type ToastStore = ReturnType<typeof createToastStore>;
