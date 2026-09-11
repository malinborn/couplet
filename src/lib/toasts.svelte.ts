/**
 * Stack of persistent notifications shown at the bottom-right of a window.
 *
 * Nothing auto-dismisses; every toast waits for its close button. Ordering is
 * explicit rather than insertion-based, because the update check only fires 15s
 * after launch and would otherwise land below the session toast.
 */

export type ToastPayload =
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
  | { kind: 'ai-bind-copied'; saved: boolean };

export type ToastKind = ToastPayload['kind'];

export interface ToastEntry {
  id: number;
  payload: ToastPayload;
}

/** Lower sorts higher in the stack. */
const ORDER: Record<ToastKind, number> = {
  update: 0,
  session: 1,
  // Both AI notices sort last: neither is time-sensitive the way an update or a
  // restorable session is. They never coexist — one requires having never
  // connected, the other requires having just connected.
  'ai-nudge': 2,
  'ai-first-use': 2,
  // Sorts last of all: it is a direct response to something the user just
  // clicked, so it belongs nearest their attention rather than above notices
  // they have not acted on.
  'ai-watch-copied': 3,
  'ai-bind-copied': 3,
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
