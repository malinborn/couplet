import { describe, it, expect } from 'vitest';
import { buildBindPrompt } from './ai-bind';
// The component's own text, unprocessed.
import source from './AiBindButton.svelte?raw';

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

/*
 * What replaced the magnet and proximity suites.
 *
 * Those were fifteen careful numeric tests about a behaviour the owner rejected
 * on sight in the real window: the button slid out whenever the cursor merely
 * passed nearby, and leaned toward it. Both are gone, and tests for them would
 * now be asserting a bug. The reveal that replaced them is two CSS
 * pseudo-classes and no JavaScript at all — there is no function left to feed
 * numbers to.
 *
 * So these assertions read the component's source instead, and they are worth
 * exactly what that implies: they cannot tell you the button looks right (a
 * browser does that), only that the *mechanism* has not quietly grown back.
 * That is the failure mode worth catching here — a proximity reveal reads as a
 * feature in a diff, while its symptom only appears when a human moves a real
 * mouse across the top-left corner of a document.
 */
describe('AiBindButton reveal', () => {
  /**
   * The component with every comment removed.
   *
   * Necessary rather than tidy: the component's comments explain at length what
   * the magnet and the proximity reveal used to do and why they went, which is
   * the documentation worth keeping and also exactly the prose that would
   * satisfy a naive search for the words being banned below.
   */
  const code = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  it('reveals on the element itself, not on an approach radius', () => {
    // `--shown: 1` is the reveal. It may be reached by hovering the button or
    // by focusing it, and by nothing else; any third selector here would be an
    // approach rule wearing a different name.
    const rules = [...code.matchAll(/([^{}]*)\{[^{}]*--shown:\s*1/g)].map(([, sel]) => sel.trim());
    expect(rules).toHaveLength(1);
    expect(
      rules[0]
        .split(',')
        .map((s) => s.trim())
        .sort()
    ).toEqual(['.ai-bind-button:focus-visible', '.ai-bind-button:hover']);
  });

  it('tracks no pointer and measures no geometry', () => {
    // Every ingredient the old proximity reveal needed. Reintroducing any one
    // of them is the thing this test exists to notice.
    for (const banned of [
      'pointermove',
      'mousemove',
      'addEventListener',
      'getBoundingClientRect',
      'requestAnimationFrame',
    ]) {
      expect(code).not.toContain(banned);
    }
  });

  it('carries no magnet offset in any form', () => {
    // --mx/--my were the lean toward the cursor, written from JS each frame.
    expect(code).not.toContain('--mx');
    expect(code).not.toContain('--my');
    expect(code).not.toContain('magnetOffset');
    // Nothing is imported from `ai-bind` any more; the prompt is the caller's
    // business and the geometry no longer exists.
    expect(code).not.toMatch(/from '\.\/ai-bind'/);
  });

  it('still honours prefers-reduced-motion', () => {
    // The button must still reveal under reduced motion — it is unusable
    // otherwise — but it arrives instead of travelling.
    expect(code).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition:\s*none/);
  });

  it('tints itself from the per-theme accent token rather than fixed colours', () => {
    // --color-glow is the one token all four themes define. A hex or a named
    // colour in this gradient would look correct in whichever theme it was
    // written against and wrong in the other three.
    expect(code).toMatch(/background-image:\s*linear-gradient\(/);
    const gradients = code.match(/linear-gradient\([\s\S]*?\);/g) ?? [];
    expect(gradients.length).toBeGreaterThan(0);
    for (const gradient of gradients) {
      expect(gradient).toContain('var(--color-glow)');
      expect(gradient).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});
