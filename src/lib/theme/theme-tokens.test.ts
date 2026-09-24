import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEME_FAMILIES, concreteTheme } from '../theme-resolve';

/*
 * The theme contract (src/lib/theme/CLAUDE.md), read straight from the files:
 * every theme defines the whole token set of `light.css`, and nothing in src/
 * reads a `var(--name)` that nobody defines. An undefined name is not an
 * error anywhere else — the declaration is silently dropped — which is how the
 * Find panel, the table toggle, the .env block and the mermaid controls lost
 * their colours without anyone noticing.
 */

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const THEME_DIR = fileURLToPath(new URL('./', import.meta.url));

/**
 * Set from JavaScript while the app runs, so no stylesheet defines them.
 * Each must really be set somewhere (checked below), or the entry is stale.
 */
const RUNTIME_SET = ['--notch-depth', '--tw', '--ts'] as const;

/**
 * Hooks a theme MAY define on top of the full set. Every read of one carries
 * a fallback, so a theme that leaves it out still renders. Some are defined
 * by no theme today (`--heading-grad-5/6`, `--heading-grad-span`).
 */
const OPTIONAL_HOOKS = [
  '--bg-image',
  '--color-caret-top',
  '--color-caret-bottom',
  '--color-task-done',
  '--color-task-done-line',
  '--heading-grad-1',
  '--heading-grad-2',
  '--heading-grad-3',
  '--heading-grad-4',
  '--heading-grad-5',
  '--heading-grad-6',
  '--heading-grad-span',
  '--table-header-grad',
  '--table-header-text',
  '--task-done-grad',
] as const;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__fixtures__' ? [] : walk(path);
    return /\.(css|svelte|ts)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

/** Comments out: a `var(--x)` in prose is not a use. `//` only where it cannot be a URL. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[\s;{}(),])\/\/.*$/gm, '$1');
}

const FILES = walk(SRC).map((path) => ({ path: relative(SRC, path), text: code(readFileSync(path, 'utf8')) }));

const DEFINED = new Set(FILES.flatMap((f) => [...f.text.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])));

interface Use {
  name: string;
  fallback: boolean;
  where: string;
}

const USES: Use[] = FILES.flatMap((f) =>
  [...f.text.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)].map((m) => ({
    name: m[1],
    fallback: m[2] === ',',
    where: `${f.path}:${f.text.slice(0, m.index).split('\n').length}`,
  }))
);

/** `:root[data-theme='x'] { … }` blocks of the theme files, by theme id. */
function themeBlocks(): Map<string, Set<string>> {
  const blocks = new Map<string, Set<string>>();
  for (const name of readdirSync(THEME_DIR).filter((n) => n.endsWith('.css'))) {
    const text = code(readFileSync(join(THEME_DIR, name), 'utf8'));
    for (const m of text.matchAll(/:root\[data-theme='([\w-]+)'\]\s*\{([^{}]*)\}/g)) {
      const tokens = blocks.get(m[1]) ?? new Set<string>();
      for (const t of m[2].matchAll(/(--[\w-]+)\s*:/g)) tokens.add(t[1]);
      blocks.set(m[1], tokens);
    }
  }
  return blocks;
}

const BLOCKS = themeBlocks();
const REFERENCE = BLOCKS.get('light') ?? new Set<string>();
const THEMES = THEME_FAMILIES.flatMap((f) => [concreteTheme(f, 'light'), concreteTheme(f, 'dark')]);

describe('theme tokens', () => {
  it('light.css, the reference, has the token set', () => {
    expect(REFERENCE.size).toBeGreaterThan(30);
  });

  it('every registered theme has a stylesheet block', () => {
    for (const theme of THEMES) expect(BLOCKS.has(theme), theme).toBe(true);
  });

  it.each(THEMES)('%s defines every token light.css defines', (theme) => {
    const tokens = BLOCKS.get(theme) ?? new Set<string>();
    expect([...REFERENCE].filter((t) => !tokens.has(t))).toEqual([]);
  });

  it.each(THEMES)('%s defines nothing beyond the set but declared optional hooks', (theme) => {
    const tokens = BLOCKS.get(theme) ?? new Set<string>();
    const hooks = new Set<string>(OPTIONAL_HOOKS);
    expect([...tokens].filter((t) => !REFERENCE.has(t) && !hooks.has(t))).toEqual([]);
  });

  it('every var(--…) in src/ is defined by some stylesheet, set at runtime, or an optional hook', () => {
    const known = new Set<string>([...DEFINED, ...RUNTIME_SET, ...OPTIONAL_HOOKS]);
    expect(USES.filter((u) => !known.has(u.name)).map((u) => `${u.name} at ${u.where}`)).toEqual([]);
  });

  it('an optional hook is always read with a fallback', () => {
    const hooks = new Set<string>(OPTIONAL_HOOKS);
    expect(USES.filter((u) => hooks.has(u.name) && !u.fallback).map((u) => `${u.name} at ${u.where}`)).toEqual([]);
  });

  it('every runtime-set name is really set from code', () => {
    for (const name of RUNTIME_SET) {
      const escaped = name.replace(/-/g, '\\-');
      const set = new RegExp(`setProperty\\(\\s*['"\`]${escaped}['"\`]|style:${escaped}\\b`);
      expect(
        FILES.some((f) => set.test(f.text)),
        name
      ).toBe(true);
    }
  });

  it('the guard itself sees uses and definitions', () => {
    expect(USES.length).toBeGreaterThan(100);
    expect(DEFINED.has('--text-primary')).toBe(true);
  });
});
