import { describe, expect, it } from 'vitest';
import { decideLanding, type LandingInput } from './agent-landing';

const base: LandingInput = { cmd: 'show', active: false, focus: true, typing: false, liveAsk: false };

describe('decideLanding', () => {
  it('TheActiveTabIsHandledLive_WhateverTheCommand', () => {
    for (const cmd of ['show', 'edit', 'ask', 'open'] as const) {
      expect(decideLanding({ ...base, cmd, active: true, typing: true })).toBe('live');
    }
  });

  it('ShowAndOpenWithFocusSwitchWhenNobodyTypes', () => {
    expect(decideLanding(base)).toBe('activate');
    expect(decideLanding({ ...base, cmd: 'open' })).toBe('activate');
  });

  it('NeverTakesTheTabTheHumanTypesIn_FocusOrNot', () => {
    expect(decideLanding({ ...base, typing: true })).toBe('background');
  });

  it('NeverTakesTheViewFromAnotherAgentsQuestion', () => {
    expect(decideLanding({ ...base, liveAsk: true })).toBe('background');
  });

  it('WithoutFocusEverythingLandsInTheBackground', () => {
    expect(decideLanding({ ...base, focus: false })).toBe('background');
    expect(decideLanding({ ...base, cmd: 'open', focus: false })).toBe('background');
  });

  it('EditAndAskNeverSwitchTabs', () => {
    expect(decideLanding({ ...base, cmd: 'edit' })).toBe('background');
    expect(decideLanding({ ...base, cmd: 'ask' })).toBe('background');
  });
});
