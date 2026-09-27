/**
 * Stash stage 04: react to the stash drawer opening or closing — and to
 * nothing else. The store's `state` is `$state.raw` and is replaced on every
 * query keystroke, sort, chip or ring move, so an effect that reads
 * `stashStore.state.open` directly re-runs on each of them. For the widen
 * (D15) that meant a fresh round of window IPC per keystroke, a second
 * «окно раздвинулось» toast, and a window the human narrowed while the stash
 * was open widening again on the next key. The `$derived` boolean only
 * notifies when its value changes. Call from a component's init (it needs an
 * effect owner); `edge` runs untracked.
 */
import { untrack } from 'svelte';

export function onStashOpenEdge(isOpen: () => boolean, edge: (open: boolean) => void): void {
  const open = $derived(isOpen());
  $effect(() => {
    const now = open;
    untrack(() => edge(now));
  });
}
