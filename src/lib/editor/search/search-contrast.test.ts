import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEME_FAMILIES, concreteTheme } from '../../theme-resolve';

/*
 * The search colours are readable in every theme — checked, not hoped for.
 *
 * `styles/search.css` mixes its `--search-*` tokens from each theme's own
 * (`--color-glow`, `--bg-base`, `--text-primary`) and overrides them where a
 * theme's accent cannot carry text. This test resolves those declarations the
 * way the browser would for each registered theme — `var()`, `rgb()`,
 * `color-mix(in srgb, …)` with alpha — composites the translucent ones over
 * the page, and holds the result to WCAG 2 contrast:
 *
 * - current match: its text on its solid fill, ≥ 4.5 (body text, AA);
 * - every other match: its text on the translucent fill over the page, and
 *   over a code block's background, ≥ 4.5;
 * - the current match's fill against the selection colour, ≥ 1.5, so a
 *   selection elsewhere never reads as "the current match" (other matches are
 *   told apart from a selection by their underline bar, not their fill).
 *
 * A new theme or a retuned accent that breaks any of these fails here, with
 * the measured ratio in the message, before anyone has to squint at it.
 */

const STYLES = fileURLToPath(new URL('../../../styles/', import.meta.url));
const THEME_DIR = fileURLToPath(new URL('../../theme/', import.meta.url));

type Vars = Map<string, string>;

function declarations(body: string): Vars {
  const vars: Vars = new Map();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(m[1], m[2].trim());
  return vars;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Theme id → its token declarations, from `src/lib/theme/*.css`. */
function themeVars(): Map<string, Vars> {
  const out = new Map<string, Vars>();
  for (const name of readdirSync(THEME_DIR).filter((n) => n.endsWith('.css'))) {
    const text = stripComments(readFileSync(join(THEME_DIR, name), 'utf8'));
    for (const m of text.matchAll(/:root\[data-theme='([\w-]+)'\]\s*\{([^{}]*)\}/g)) {
      out.set(m[1], new Map([...(out.get(m[1]) ?? []), ...declarations(m[2])]));
    }
  }
  return out;
}

/** `search.css`: the plain `:root` block, and per-theme overrides (selector lists allowed). */
function searchVars(): { base: Vars; overrides: Map<string, Vars> } {
  const text = stripComments(readFileSync(join(STYLES, 'search.css'), 'utf8'));
  let base: Vars = new Map();
  const overrides = new Map<string, Vars>();
  for (const m of text.matchAll(/((?::root[^{,]*,\s*)*:root[^{,]*)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim());
    const vars = declarations(m[2]);
    for (const sel of selectors) {
      if (sel === ':root') base = new Map([...base, ...vars]);
      const theme = /^:root\[data-theme='([\w-]+)'\]$/.exec(sel)?.[1];
      if (theme) overrides.set(theme, new Map([...(overrides.get(theme) ?? []), ...vars]));
    }
  }
  return { base, overrides };
}

type RGBA = [number, number, number, number];

/** Splits on commas that are not inside parentheses. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/** Replaces every `var(--x)` with its value, recursively. */
function substitute(text: string, lookup: (name: string) => string | undefined): string {
  let out = text;
  for (let guard = 0; guard < 20 && out.includes('var('); guard++) {
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g, (_, name: string, fallback?: string) => {
      const value = lookup(name) ?? fallback?.trim();
      if (value === undefined) throw new Error(`undefined ${name}`);
      return value;
    });
  }
  return out;
}

function parseColor(text: string): RGBA {
  const t = text.trim();
  if (t === 'transparent') return [0, 0, 0, 0];
  if (t.startsWith('#')) {
    let h = t.slice(1);
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    const n = (i: number): number => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const fn = /^([a-z-]+)\((.*)\)$/s.exec(t);
  if (!fn) throw new Error(`cannot parse colour: ${t}`);
  const args = splitTop(fn[2]);
  if (fn[1] === 'rgb' || fn[1] === 'rgba') {
    const [r, g, b, a] = args.map(Number);
    return [r, g, b, a ?? 1];
  }
  if (fn[1] === 'color-mix') {
    if (args[0] !== 'in srgb') throw new Error(`only srgb mixing is evaluated: ${t}`);
    const stop = (s: string): { color: RGBA; pct: number | null } => {
      const m = /^(.*?)\s+(\d+(?:\.\d+)?)%$/s.exec(s);
      return m ? { color: parseColor(m[1]), pct: Number(m[2]) / 100 } : { color: parseColor(s), pct: null };
    };
    const a = stop(args[1]);
    const b = stop(args[2]);
    const pa = a.pct ?? (b.pct !== null ? 1 - b.pct : 0.5);
    const pb = b.pct ?? 1 - pa;
    // CSS Color 5: interpolate premultiplied, then un-premultiply.
    const alpha = a.color[3] * pa + b.color[3] * pb;
    if (alpha === 0) return [0, 0, 0, 0];
    const ch = (i: number): number => (a.color[i] * a.color[3] * pa + b.color[i] * b.color[3] * pb) / alpha;
    return [ch(0), ch(1), ch(2), alpha];
  }
  throw new Error(`unsupported colour function: ${t}`);
}

/** `top` painted over an opaque `under`. */
function over(top: RGBA, under: RGBA): RGBA {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1) as RGBA;
}

function luminance([r, g, b]: RGBA): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: RGBA, b: RGBA): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = THEME_FAMILIES.flatMap((f) => [concreteTheme(f, 'light'), concreteTheme(f, 'dark')]);
const ALL_THEME_VARS = themeVars();
const SEARCH = searchVars();

function palette(theme: string): (token: string) => RGBA {
  const themeTokens = ALL_THEME_VARS.get(theme) ?? new Map<string, string>();
  const overrides = SEARCH.overrides.get(theme) ?? new Map<string, string>();
  const lookup = (name: string): string | undefined => overrides.get(name) ?? SEARCH.base.get(name) ?? themeTokens.get(name);
  return (token) => {
    const raw = lookup(token);
    if (raw === undefined) throw new Error(`${theme}: ${token} is not defined`);
    return parseColor(substitute(raw, lookup));
  };
}

describe('search colour contrast', () => {
  it('reads the declarations it is about to judge', () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(14);
    expect(SEARCH.base.has('--search-current-bg')).toBe(true);
    expect(SEARCH.base.has('--search-match-bg')).toBe(true);
    for (const theme of THEMES) expect(ALL_THEME_VARS.has(theme), theme).toBe(true);
  });

  it('every override names a registered theme', () => {
    for (const theme of SEARCH.overrides.keys()) expect(THEMES, theme).toContain(theme);
  });

  it('evaluates color-mix with alpha the way CSS does', () => {
    expect(parseColor('color-mix(in srgb, rgb(255, 0, 0) 25%, transparent)')).toEqual([255, 0, 0, 0.25]);
    expect(parseColor('color-mix(in srgb, #000 50%, #fff)')).toEqual([127.5, 127.5, 127.5, 1]);
  });

  it.each(THEMES)('%s: the current match text is readable on its fill (≥ 4.5)', (theme) => {
    const c = palette(theme);
    const base = c('--bg-base');
    const fill = over(c('--search-current-bg'), base);
    const text = over(c('--search-current-text'), fill);
    const ratio = contrast(text, fill);
    expect(ratio, `${theme}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEMES)('%s: other matches are readable on the page and in code (≥ 4.5)', (theme) => {
    const c = palette(theme);
    for (const surface of ['--bg-base', '--color-code-bg']) {
      const under = over(c(surface), c('--bg-base'));
      const fill = over(c('--search-match-bg'), under);
      const text = over(c('--search-match-text'), fill);
      const ratio = contrast(text, fill);
      expect(ratio, `${theme} on ${surface}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(THEMES)('%s: the current match does not look like a selection (≥ 1.5)', (theme) => {
    const c = palette(theme);
    const base = c('--bg-base');
    const ratio = contrast(over(c('--search-current-bg'), base), over(c('--color-selection'), base));
    expect(ratio, `${theme}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(1.5);
  });
});
