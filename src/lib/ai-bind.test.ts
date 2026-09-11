import { describe, it, expect } from 'vitest';
import {
  buildBindPrompt,
  magnetOffset,
  revealProgress,
  MAGNET_RADIUS,
  MAGNET_MAX_PULL,
  REVEAL_NEAR,
  REVEAL_FAR,
} from './ai-bind';

describe('buildBindPrompt', () => {
  const path = '/Users/me/notes/spec.md';

  it('names the absolute path in the opening line', () => {
    expect(buildBindPrompt(path).split('\n')[0]).toContain(path);
  });

  it('never leaves a <file> placeholder for an agent to run literally', () => {
    const prompt = buildBindPrompt(path);
    expect(prompt).not.toContain('<file>');
    expect(prompt).not.toContain('<path>');
  });

  it('substitutes the real path into every mdmini command', () => {
    const prompt = buildBindPrompt(path);
    for (const line of prompt.split('\n')) {
      if (line.includes('mdmini ') && !line.includes('mdmini` is not')) {
        expect(line).toContain(path);
      }
    }
  });

  it('covers the four verbs that make a document two-way', () => {
    const prompt = buildBindPrompt(path);
    expect(prompt).toContain('mdmini show');
    expect(prompt).toContain('mdmini edit');
    expect(prompt).toContain('mdmini ask');
    expect(prompt).toContain('mdmini question');
    expect(prompt).toContain('mdmini answer');
  });

  it('warns that edit takes the whole document, not a diff', () => {
    // The one instruction that silently corrupts a file when ignored.
    expect(buildBindPrompt(path)).toContain('not a diff');
  });

  it('tells the agent to speak up when the CLI is missing', () => {
    expect(buildBindPrompt(path)).toContain('not on your PATH');
  });

  it('survives a path with spaces without losing it', () => {
    const spaced = '/Users/me/My Notes/a doc.md';
    expect(buildBindPrompt(spaced)).toContain(spaced);
  });
});

describe('magnetOffset', () => {
  const anchor = { x: 100, y: 100 };

  it('is inert beyond the radius', () => {
    const far = { x: 100 + MAGNET_RADIUS, y: 100 };
    expect(magnetOffset({ pointer: far, anchor })).toEqual({ x: 0, y: 0 });
  });

  it('is inert well beyond the radius', () => {
    expect(magnetOffset({ pointer: { x: 5000, y: 5000 }, anchor })).toEqual({ x: 0, y: 0 });
  });

  it('yields exactly zero when the pointer sits on the anchor', () => {
    // No direction to move in — anything else here is jitter under the click.
    expect(magnetOffset({ pointer: { ...anchor }, anchor })).toEqual({ x: 0, y: 0 });
  });

  it('pulls toward the pointer, not away from it', () => {
    const right = magnetOffset({ pointer: { x: 130, y: 100 }, anchor });
    expect(right.x).toBeGreaterThan(0);
    const left = magnetOffset({ pointer: { x: 70, y: 100 }, anchor });
    expect(left.x).toBeLessThan(0);
  });

  it('never exceeds maxPull anywhere in the field', () => {
    for (let dx = -MAGNET_RADIUS; dx <= MAGNET_RADIUS; dx += 3) {
      for (let dy = -MAGNET_RADIUS; dy <= MAGNET_RADIUS; dy += 3) {
        const o = magnetOffset({ pointer: { x: anchor.x + dx, y: anchor.y + dy }, anchor });
        expect(Math.hypot(o.x, o.y)).toBeLessThanOrEqual(MAGNET_MAX_PULL + 1e-9);
      }
    }
  });

  it('never overshoots past the pointer', () => {
    // Overshoot is what turns a magnet into an oscillator: the button jumps
    // past the cursor, the cursor is now on the other side, repeat.
    for (let d = 1; d < MAGNET_RADIUS; d += 1) {
      const o = magnetOffset({ pointer: { x: anchor.x + d, y: anchor.y }, anchor });
      expect(o.x).toBeLessThanOrEqual(d + 1e-9);
    }
  });

  it('grows monotonically as the pointer closes in', () => {
    const at = (d: number) =>
      Math.hypot(...(Object.values(
        magnetOffset({ pointer: { x: anchor.x + d, y: anchor.y }, anchor })
      ) as [number, number]));
    // Sampled inside the region where distance is not yet the binding cap.
    expect(at(120)).toBeLessThan(at(90));
    expect(at(90)).toBeLessThan(at(60));
    expect(at(60)).toBeLessThan(at(30));
  });

  it('stays subtle at mid-range — under two pixels at half the radius', () => {
    const o = magnetOffset({ pointer: { x: anchor.x + MAGNET_RADIUS / 2, y: anchor.y }, anchor });
    expect(Math.hypot(o.x, o.y)).toBeLessThan(2);
  });

  it('is fully disabled by maxPull: 0, which is how reduced-motion is honoured', () => {
    expect(magnetOffset({ pointer: { x: 105, y: 100 }, anchor, maxPull: 0 })).toEqual({
      x: 0,
      y: 0,
    });
  });

  it('is disabled by a zero radius', () => {
    expect(magnetOffset({ pointer: { x: 105, y: 100 }, anchor, radius: 0 })).toEqual({
      x: 0,
      y: 0,
    });
  });

  it('returns zero rather than NaN for non-finite input', () => {
    expect(magnetOffset({ pointer: { x: NaN, y: 100 }, anchor })).toEqual({ x: 0, y: 0 });
  });
});

describe('revealProgress', () => {
  it('is fully out inside the near distance', () => {
    expect(revealProgress(0)).toBe(1);
    expect(revealProgress(REVEAL_NEAR)).toBe(1);
  });

  it('is fully retracted outside the far distance', () => {
    expect(revealProgress(REVEAL_FAR)).toBe(0);
    expect(revealProgress(REVEAL_FAR + 500)).toBe(0);
  });

  it('interpolates in between', () => {
    const mid = revealProgress((REVEAL_NEAR + REVEAL_FAR) / 2);
    expect(mid).toBeGreaterThan(0.45);
    expect(mid).toBeLessThan(0.55);
  });

  it('decreases monotonically with distance', () => {
    let prev = revealProgress(0);
    for (let d = 0; d <= REVEAL_FAR + 20; d += 5) {
      const cur = revealProgress(d);
      expect(cur).toBeLessThanOrEqual(prev + 1e-9);
      prev = cur;
    }
  });

  it('stays within 0..1 for nonsense input', () => {
    expect(revealProgress(NaN)).toBe(0);
    expect(revealProgress(-50)).toBe(1);
  });
});
