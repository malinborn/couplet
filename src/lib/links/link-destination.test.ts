import { describe, expect, it } from 'vitest';
import {
  destinationFor,
  escapeLabel,
  formatPathDestination,
  isInside,
  labelFor,
  linkMarkdownFor,
  relativePath,
  wrapDestination,
} from './link-destination';
import { resolveLinkTarget } from './link-target';

const DOC = '/r/docs/a.md';
const ROOT = '/r';

describe('relativePath and isInside', () => {
  it('relativePath', () => {
    expect(relativePath('/r/docs', '/r/docs/plan.md')).toBe('plan.md');
    expect(relativePath('/r/docs', '/r/notes/b.md')).toBe('../notes/b.md');
    expect(relativePath('/r', '/r')).toBe('');
  });

  it('isInside', () => {
    expect(isInside('/r', '/r/a.md')).toBe(true);
    expect(isInside('/r', '/r')).toBe(true);
    expect(isInside('/r', '/rx/a.md')).toBe(false);
    expect(isInside('/', '/anything')).toBe(true);
  });
});

describe('destinationFor', () => {
  it('is relative inside the project, never with ./', () => {
    expect(destinationFor('/r/docs/plan.md', DOC, ROOT)).toBe('plan.md');
    expect(destinationFor('/r/notes/b.md', DOC, ROOT)).toBe('../notes/b.md');
  });

  it('is absolute outside the project, for an untitled document, or with no root', () => {
    expect(destinationFor('/x/c.md', DOC, ROOT)).toBe('/x/c.md');
    expect(destinationFor('/r/docs/plan.md', null, ROOT)).toBe('/r/docs/plan.md');
    expect(destinationFor('/r/docs/plan.md', DOC, null)).toBe('/r/docs/plan.md');
  });

  it('wraps spaces, parentheses and < in <…>, never percent-encodes them', () => {
    expect(destinationFor('/r/my notes/b.md', DOC, ROOT)).toBe('<../my notes/b.md>');
    expect(destinationFor('/r/docs/a (1).md', DOC, ROOT)).toBe('<a (1).md>');
    expect(destinationFor('/r/docs/a<b.md', DOC, ROOT)).toBe('<a\\<b.md>');
  });

  it('encodes only # and %, so the path reads back unchanged', () => {
    expect(destinationFor('/r/docs/a#b%.md', DOC, ROOT)).toBe('a%23b%25.md');
  });

  it('keeps a backslash that would otherwise read as an escape', () => {
    expect(destinationFor('/r/docs/a\\[b].md', DOC, ROOT)).toBe('a\\\\[b].md');
  });

  it('a relative name that would read as a URL scheme or ~/ gets ./', () => {
    expect(destinationFor('/r/docs/note:draft.md', DOC, ROOT)).toBe('./note:draft.md');
    expect(destinationFor('/r/docs/~/x.md', DOC, ROOT)).toBe('./~/x.md');
    expect(destinationFor('/r/docs/a/b:c.md', DOC, ROOT)).toBe('a/b:c.md');
  });

  it('round-trips through resolveLinkTarget', () => {
    for (const target of [
      '/r/my notes/a#b%(1).md',
      '/r/docs/plan.md',
      '/x/y z.md',
      '/r/q<r>.md',
      '/r/docs/a\\[b].md',
      '/r/docs/note: draft.md',
      '/r/docs/~/x.md',
      '/r/docs/~x.md',
    ]) {
      const dest = destinationFor(target, DOC, ROOT);
      expect(resolveLinkTarget(dest, DOC, null)).toEqual({ kind: 'file', path: target, fragment: null });
    }
  });
});

describe('labels', () => {
  it('labelFor', () => {
    expect(labelFor({ path: '/n/2026-10-24-ab12.md', title: 'Ideas' })).toBe('Ideas');
    expect(labelFor({ path: '/r/plan.md', title: null })).toBe('plan');
    expect(labelFor({ path: '/r/README.markdown', title: null })).toBe('README');
    expect(labelFor({ path: '/r/data.csv', title: null })).toBe('data.csv');
    expect(labelFor({ path: '/r/plan.md', title: '   ' })).toBe('plan');
  });

  it('escapeLabel', () => {
    expect(escapeLabel('a [b] \\c')).toBe('a \\[b\\] \\\\c');
  });

  it('linkMarkdownFor', () => {
    expect(linkMarkdownFor({ path: '/r/docs/plan.md', title: null }, DOC, ROOT)).toBe('[plan](plan.md)');
    expect(linkMarkdownFor({ path: '/n/x.md', title: 'A [draft]' }, DOC, ROOT)).toBe('[A \\[draft\\]](/n/x.md)');
  });
});

describe('formatPathDestination and wrapDestination', () => {
  it('a URL keeps its # and %', () => {
    expect(wrapDestination('https://x.test/a%20b#c')).toBe('https://x.test/a%20b#c');
  });

  it('a path encodes them', () => {
    expect(formatPathDestination('a#b.md')).toBe('a%23b.md');
  });
});
