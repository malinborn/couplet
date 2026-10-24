import { describe, it, expect } from 'vitest';
import {
  basename,
  dirOf,
  isExternalUrl,
  normalizePath,
  resolveLinkTarget,
  splitFragment,
  stripAngle,
} from './link-target';

const DOC = '/Users/me/proj/docs/a.md';
const HOME = '/Users/me';

describe('resolveLinkTarget — the D1 table', () => {
  it('#slug is an anchor', () => {
    expect(resolveLinkTarget('#risks', DOC, HOME)).toEqual({ kind: 'anchor', slug: 'risks' });
  });

  it('a scheme other than file: is external, unchanged', () => {
    expect(resolveLinkTarget('https://x.test/p#s', DOC, HOME)).toEqual({ kind: 'external', url: 'https://x.test/p#s' });
    expect(resolveLinkTarget('mailto:a@b.c', DOC, HOME)).toEqual({ kind: 'external', url: 'mailto:a@b.c' });
  });

  it('file:///abs/path is a file', () => {
    expect(resolveLinkTarget('file:///tmp/x.md', DOC, HOME)).toEqual({ kind: 'file', path: '/tmp/x.md', fragment: null });
    expect(resolveLinkTarget('file://localhost/tmp/x.md', DOC, HOME)).toEqual({ kind: 'file', path: '/tmp/x.md', fragment: null });
  });

  it('/abs/path is a file', () => {
    expect(resolveLinkTarget('/etc/hosts', DOC, HOME)).toEqual({ kind: 'file', path: '/etc/hosts', fragment: null });
  });

  it('~/path expands the home folder', () => {
    expect(resolveLinkTarget('~/notes/b.md', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/notes/b.md', fragment: null });
  });

  it('~/path with no known home is unresolvable', () => {
    expect(resolveLinkTarget('~/b.md', DOC, null)).toEqual({ kind: 'unresolvable', reason: 'no-home' });
  });

  it('anything else is relative to the document folder', () => {
    expect(resolveLinkTarget('plan.md', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/docs/plan.md', fragment: null });
    expect(resolveLinkTarget('./plan.md', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/docs/plan.md', fragment: null });
    expect(resolveLinkTarget('../README.md', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/README.md', fragment: null });
  });

  it('a relative link in an untitled document is unresolvable', () => {
    expect(resolveLinkTarget('plan.md', null, HOME)).toEqual({ kind: 'unresolvable', reason: 'untitled' });
  });

  it('an empty destination is unresolvable', () => {
    expect(resolveLinkTarget('  ', DOC, HOME)).toEqual({ kind: 'unresolvable', reason: 'empty' });
  });
});

describe('resolveLinkTarget — encodings and fragments', () => {
  it('strips <…> and percent-decodes the path', () => {
    expect(resolveLinkTarget('<my plan.md>', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/docs/my plan.md', fragment: null });
    expect(resolveLinkTarget('my%20plan.md', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/docs/my plan.md', fragment: null });
  });

  it('keeps a #fragment after a file path, raw', () => {
    expect(resolveLinkTarget('plan.md#risks', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/docs/plan.md', fragment: 'risks' });
    expect(resolveLinkTarget('plan.md#%D1%80', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/docs/plan.md', fragment: '%D1%80' });
  });

  it('an empty fragment is none', () => {
    expect(resolveLinkTarget('plan.md#', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/docs/plan.md', fragment: null });
  });

  it('%23 and %25 decode back to # and % (the picker writes them, plan 02)', () => {
    expect(resolveLinkTarget('a%23b%25.md', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/docs/a#b%.md', fragment: null });
  });

  it('a malformed escape is kept as written', () => {
    expect(resolveLinkTarget('100%.md', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/docs/100%.md', fragment: null });
  });

  it('honours CommonMark backslash escapes inside <…>', () => {
    expect(resolveLinkTarget('<a\\>b.md>', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/docs/a>b.md', fragment: null });
  });
});

describe('helpers', () => {
  it('splitFragment', () => {
    expect(splitFragment('a.md#x')).toEqual({ path: 'a.md', fragment: 'x' });
    expect(splitFragment('a.md')).toEqual({ path: 'a.md', fragment: null });
  });

  it('stripAngle', () => {
    expect(stripAngle(' <a b> ')).toBe('a b');
    expect(stripAngle('a')).toBe('a');
  });

  it('isExternalUrl', () => {
    expect(isExternalUrl('https://x')).toBe(true);
    expect(isExternalUrl('file:///x')).toBe(false);
    expect(isExternalUrl('plan.md')).toBe(false);
    expect(isExternalUrl('#x')).toBe(false);
  });

  it('normalizePath resolves . and .. and never climbs above /', () => {
    expect(normalizePath('/a/./b/../c//d')).toBe('/a/c/d');
    expect(normalizePath('/../../x')).toBe('/x');
  });

  it('dirOf and basename', () => {
    expect(dirOf('/a/b/c.md')).toBe('/a/b');
    expect(dirOf('/c.md')).toBe('/');
    expect(basename('/a/b/c.md')).toBe('c.md');
    expect(basename('/a/b/')).toBe('b');
  });
});
