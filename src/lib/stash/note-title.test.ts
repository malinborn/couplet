import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { afterFirstLine, isBlankText, noteTitle } from './note-title';

const FIXTURE = fileURLToPath(new URL('../../../src-tauri/tests/fixtures/note-titles.json', import.meta.url));
const cases = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { text: string; title: string | null }[];

describe('noteTitle', () => {
  it('reads the fixture Rust reads', () => {
    // Pinned exactly, like `title_of_matches_the_shared_fixture` in notes.rs:
    // a case lost from the file must fail in both suites.
    expect(cases.length).toBe(48);
  });

  it.each(cases)('gives Rust title_of’s answer for %j', ({ text, title }) => {
    expect(noteTitle(text)).toBe(title);
  });
});

describe('isBlankText', () => {
  it('is true for nothing and for whitespace only', () => {
    expect(isBlankText('')).toBe(true);
    expect(isBlankText(' \n\t\n ')).toBe(true);
    expect(isBlankText(' a ')).toBe(false);
    expect(isBlankText('/')).toBe(false);
  });
});

describe('afterFirstLine', () => {
  it('is the body under the first non-blank line', () => {
    expect(afterFirstLine('\n\n# Title\nbody\nmore')).toBe('body\nmore');
    expect(afterFirstLine('only')).toBe('');
    expect(afterFirstLine('  \n ')).toBe('');
  });
});
