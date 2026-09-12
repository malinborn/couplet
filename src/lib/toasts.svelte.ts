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
  | { kind: 'update'; latest: string; current: string; highlight?: string }
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
  | { kind: 'json-offer' };

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
  update: 1,
  session: 2,
  // Both AI notices sort last: neither is time-sensitive the way an update or a
  // restorable session is. They never coexist — one requires having never
  // connected, the other requires having just connected.
  'ai-nudge': 3,
  'ai-first-use': 3,
  // Sorts last of all: it is a direct response to something the user just
  // clicked, so it belongs nearest their attention rather than above notices
  // they have not acted on.
  'ai-watch-copied': 4,
  'ai-bind-copied': 4,
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
  };
}

export type ToastStore = ReturnType<typeof createToastStore>;
