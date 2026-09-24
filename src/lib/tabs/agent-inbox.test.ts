import { describe, expect, it } from 'vitest';
import type { AiCommandPayload } from '../tauri/events';
import { createAgentInbox, deliverable } from './agent-inbox';

function payload(id: number, cmd: AiCommandPayload['cmd'] = 'ask'): AiCommandPayload {
  return {
    id, cmd, path: '/b.md', line: null, find: null, content: null, show: false, question: 'Q?',
    options: ['A', 'B'], multi: false, freeText: false, timeoutSecs: 300, firstUse: false,
    focus: false, transient: false, fresh: false,
  };
}

describe('createAgentInbox', () => {
  it('KeepsWhatWaitsPerTabInOrder_AndHandsItOverOnce', () => {
    const inbox = createAgentInbox();
    inbox.park('b', { kind: 'ask', payload: payload(1), deadline: 10 });
    inbox.park('b', { kind: 'ask', payload: payload(2), deadline: 10 });
    inbox.park('c', { kind: 'ask', payload: payload(3), deadline: 10 });
    expect(inbox.take('b').map((i) => i.payload.id)).toEqual([1, 2]);
    expect(inbox.take('b')).toEqual([]);
    expect(inbox.has('c')).toBe(true);
  });

  it('ALaterPulseReplacesAnEarlierOne', () => {
    const inbox = createAgentInbox();
    inbox.park('b', { kind: 'pulse', payload: payload(1, 'show') });
    inbox.park('b', { kind: 'ask', payload: payload(2), deadline: 10 });
    inbox.park('b', { kind: 'pulse', payload: payload(3, 'show') });
    expect(inbox.take('b').map((i) => i.payload.id)).toEqual([2, 3]);
  });

  it('ForgettingATabDropsItsItemsAndSaysWhich', () => {
    const inbox = createAgentInbox();
    inbox.park('b', { kind: 'ask', payload: payload(1), deadline: 10 });
    expect(inbox.forget('b').map((i) => i.payload.id)).toEqual([1]);
    expect(inbox.has('b')).toBe(false);
    expect(inbox.forget('ghost')).toEqual([]);
  });
});

describe('deliverable', () => {
  it('DropsAsksPastTheirDeadline_KeepsPulses', () => {
    const items = [
      { kind: 'ask' as const, payload: payload(1), deadline: 100 },
      { kind: 'ask' as const, payload: payload(2), deadline: 200 },
      { kind: 'pulse' as const, payload: payload(3, 'show') },
    ];
    expect(deliverable(items, 150).map((i) => i.payload.id)).toEqual([2, 3]);
  });
});
