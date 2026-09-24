import type { AiCommandPayload } from '../tauri/events';

/**
 * What waits for a background tab until it is shown (spec §5): an `ask` —
 * delivered then if its agent still waits and its deadline has not passed —
 * and the pulse of a `show` that landed in the background.
 */
export type InboxItem =
  | { kind: 'ask'; payload: AiCommandPayload; deadline: number }
  | { kind: 'pulse'; payload: AiCommandPayload };

export function createAgentInbox() {
  const byTab = new Map<string, InboxItem[]>();
  /** Everything waiting for `tabId`, once. */
  function take(tabId: string): InboxItem[] {
    const items = byTab.get(tabId) ?? [];
    byTab.delete(tabId);
    return items;
  }
  return {
    /** A later pulse replaces an earlier one: only the last "look here" matters. */
    park(tabId: string, item: InboxItem): void {
      const items = (byTab.get(tabId) ?? []).filter((i) => item.kind !== 'pulse' || i.kind !== 'pulse');
      items.push(item);
      byTab.set(tabId, items);
    },
    take,
    /** The tab is gone: drop what waited for it, and say what that was. */
    forget(tabId: string): InboxItem[] {
      return take(tabId);
    },
  };
}

export type AgentInbox = ReturnType<typeof createAgentInbox>;

/** Items still worth delivering at `now`: asks before their deadline, and every pulse. */
export function deliverable(items: readonly InboxItem[], now: number): InboxItem[] {
  return items.filter((i) => i.kind !== 'ask' || now < i.deadline);
}
