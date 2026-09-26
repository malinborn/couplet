import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `.cm-md-task-done` paints a ticked task through one code path in every theme:
 * `--color-strikethrough` as the flat `background-color`, `--task-done-grad` as
 * an optional `background-image` on top of it (see `styles/editor.css`).
 *
 * That leaves two things a stylesheet edit can quietly break, neither of which
 * any rendering test would catch — a wrong gradient still renders.
 */

const THEMES = [
  'light',
  'dark',
  'aurora-light',
  'aurora-dark',
  'autumn-light',
  'autumn-dark',
  'odyssey-light',
  'odyssey-dark',
] as const;
const GRADIENT = [
  'aurora-light',
  'aurora-dark',
  'autumn-light',
  'autumn-dark',
  'odyssey-light',
  'odyssey-dark',
] as const;
/** Themes that also burn `~~strikethrough~~` (see the two-hook note in editor.css). */
const STRIKE_GRADIENT = ['odyssey-light', 'odyssey-dark'] as const;

/** Families that keep both halves in one `<family>.css`, one block per half. */
const SHARED_FILE = new Set(['autumn', 'odyssey']);

function css(theme: string): string {
  const family = theme.replace(/-(light|dark)$/, '');
  if (!SHARED_FILE.has(family)) {
    return readFileSync(fileURLToPath(new URL(`./${theme}.css`, import.meta.url)), 'utf8');
  }
  const file = readFileSync(fileURLToPath(new URL(`./${family}.css`, import.meta.url)), 'utf8');
  const block = file.match(new RegExp(`\\[data-theme='${theme}'\\]\\s*\\{([^}]*)\\}`));
  if (!block) throw new Error(`${family}.css has no block for ${theme}`);
  return block[1];
}

function variable(theme: string, name: string): string | null {
  const match = css(theme).match(new RegExp(`--${name}:\\s*([^;]+);`));
  return match ? match[1].trim() : null;
}

/** The colour of a gradient's last stop, e.g. `…, #9192b3 100%)` → `#9192b3`. */
function lastStop(gradient: string): string | null {
  const stops = gradient.match(/#[0-9a-fA-F]{3,8}/g);
  return stops ? stops[stops.length - 1] : null;
}

describe('the ticked-task gradient', () => {
  it.each(THEMES)('%s declares the flat tone it falls back to', (theme) => {
    expect(variable(theme, 'color-strikethrough')).toMatch(/^#[0-9a-fA-F]{3,8}$/);
  });

  // The gradient is sized to the item, so its last stop is the colour every
  // ticked item ends on — and the one a strict theme paints flat throughout.
  // Letting it drift makes the two themes disagree about what "done" looks
  // like at the end of a line, which no rendering test would call a failure.
  //
  // The flat tone is `--color-task-done` where a theme separates a done task
  // from a correction, and `--color-strikethrough` where it does not — the
  // same fallback chain `editor.css` resolves.
  it.each(GRADIENT)('%s ends its gradient on the flat tone', (theme) => {
    const grad = variable(theme, 'task-done-grad');
    expect(grad, `${theme} declares --task-done-grad`).not.toBeNull();
    const flat = variable(theme, 'color-task-done') ?? variable(theme, 'color-strikethrough');
    expect(lastStop(grad as string)).toBe(flat);
  });

  // Declaring it in a strict theme is how it would get a gradient by accident:
  // the CSS has no theme selector, it just resolves the var.
  it('is never declared by a strict theme', () => {
    expect(variable('light', 'task-done-grad')).toBeNull();
    expect(variable('dark', 'task-done-grad')).toBeNull();
  });
});

describe('the strikethrough gradient', () => {
  // Same contract as the task sweep: the last stop is the flat tone every
  // struck span ends on. And the gradient is only visible behind a transparent
  // fill, so a theme declaring one without the other shows nothing new.
  it.each(STRIKE_GRADIENT)('%s ends on --color-strikethrough and opens the fill', (theme) => {
    const grad = variable(theme, 'strikethrough-grad');
    expect(grad, `${theme} declares --strikethrough-grad`).not.toBeNull();
    expect(lastStop(grad as string)).toBe(variable(theme, 'color-strikethrough'));
    expect(variable(theme, 'strikethrough-fill')).toBe('transparent');
  });

  // The fill hook falls back to currentColor, which is what keeps every other
  // theme's struck text (and its bold/italic children) exactly as it was.
  it('is never declared by a strict theme', () => {
    for (const theme of ['light', 'dark']) {
      expect(variable(theme, 'strikethrough-grad')).toBeNull();
      expect(variable(theme, 'strikethrough-fill')).toBeNull();
    }
  });
});
