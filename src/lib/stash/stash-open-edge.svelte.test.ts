// @vitest-environment jsdom
import { flushSync } from 'svelte';
import { describe, expect, it } from 'vitest';
import { onStashOpenEdge } from './stash-open-edge.svelte';

describe('onStashOpenEdge', () => {
  it('fires once per change of the open flag, not on every replacement of the state', () => {
    let state = $state.raw({ open: false, query: '' });
    const edges: boolean[] = [];
    const stop = $effect.root(() => {
      onStashOpenEdge(
        () => state.open,
        (open) => edges.push(open)
      );
    });
    flushSync();
    expect(edges).toEqual([false]);

    state = { open: true, query: '' };
    flushSync();
    // A query, a sort, a ring move: the store hands out a new state object each time.
    state = { open: true, query: 's' };
    flushSync();
    state = { open: true, query: 'sa' };
    flushSync();
    expect(edges).toEqual([false, true]);

    state = { open: false, query: '' };
    flushSync();
    expect(edges).toEqual([false, true, false]);
    stop();
  });

  it('does not track what the edge handler reads', () => {
    const state = $state.raw({ open: true });
    let other = $state(0);
    let calls = 0;
    const stop = $effect.root(() => {
      onStashOpenEdge(
        () => state.open,
        () => {
          void other;
          calls += 1;
        }
      );
    });
    flushSync();
    other = 1;
    flushSync();
    expect(calls).toBe(1);
    stop();
  });
});
