import { describe, it, expect } from 'vitest';
import { latestOnly } from './latest-only';

describe('latestOnly', () => {
  it('KeepsTheMostRecentRequestCurrent', () => {
    const gate = latestOnly();
    const first = gate.begin();
    expect(first()).toBe(true);
    const second = gate.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('InvalidateRetiresEveryPendingRequest', () => {
    const gate = latestOnly();
    const pending = gate.begin();
    gate.invalidate();
    expect(pending()).toBe(false);
    expect(gate.begin()()).toBe(true);
  });

  it('DropsALanguageThatFinishesLoadingAfterTheStateWasSwapped', async () => {
    // The shape Editor.svelte relies on: a code language resolves after its
    // tab was left, and must not reconfigure the state that replaced it.
    const gate = latestOnly();
    const applied: string[] = [];
    let resolveLoad: (lang: string) => void = () => {};
    const load = new Promise<string>((resolve) => { resolveLoad = resolve; });

    const isCurrent = gate.begin();
    const done = load.then((lang) => {
      if (isCurrent()) applied.push(lang);
    });
    gate.invalidate();
    resolveLoad('python');
    await done;

    expect(applied).toEqual([]);
  });

  it('DropsAnOlderLanguageThatResolvesAfterANewerOne', async () => {
    const gate = latestOnly();
    const applied: string[] = [];
    let resolveSlow: (lang: string) => void = () => {};
    const slow = new Promise<string>((resolve) => { resolveSlow = resolve; });

    const slowCurrent = gate.begin();
    const slowDone = slow.then((lang) => { if (slowCurrent()) applied.push(lang); });
    const fastCurrent = gate.begin();
    await Promise.resolve('rust').then((lang) => { if (fastCurrent()) applied.push(lang); });
    resolveSlow('python');
    await slowDone;

    expect(applied).toEqual(['rust']);
  });
});
