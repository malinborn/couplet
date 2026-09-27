import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEME_FAMILIES, concreteTheme } from '../theme-resolve';

/*
 * Stash stage 04 (D16): the stash drawer's colour is a theme token every
 * theme derives from its link colour, and the tints the mockup mixes are
 * mixed from that token. `theme-tokens.test.ts` already fails a theme that
 * lacks a token `light.css` defines; this pins the derivation itself.
 */

const THEME_DIR = fileURLToPath(new URL('../theme/', import.meta.url));
const STASH_CSS = fileURLToPath(new URL('../../styles/stash.css', import.meta.url));

function blocks(): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(THEME_DIR).filter((n) => n.endsWith('.css'))) {
    const text = readFileSync(join(THEME_DIR, name), 'utf8');
    for (const m of text.matchAll(/:root\[data-theme='([\w-]+)'\]\s*\{([^{}]*)\}/g)) out.set(m[1], m[2]);
  }
  return out;
}

const THEMES = THEME_FAMILIES.flatMap((f) => [concreteTheme(f, 'light'), concreteTheme(f, 'dark')]);

describe('stash colour', () => {
  it.each(THEMES)('%s derives --color-stash from its link colour', (theme) => {
    expect(blocks().get(theme)).toMatch(/--color-stash:\s*var\(--color-link\);/);
  });

  it('the tints are mixed from the token on plain :root', () => {
    const css = readFileSync(STASH_CSS, 'utf8');
    for (const name of ['--stash-tint', '--stash-line', '--stash-soft']) {
      expect(css).toMatch(new RegExp(`${name}:\\s*color-mix\\(in oklab, var\\(--color-stash\\)`));
    }
  });
});
