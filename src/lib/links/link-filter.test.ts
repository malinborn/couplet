import { describe, expect, it } from 'vitest';
import {
  PER_GROUP_EMPTY,
  dedupByGroup,
  displayDir,
  isUrlQuery,
  matchQuality,
  pickerItems,
  type PickerItem,
} from './link-filter';
import type { LinkCandidate, LinkCandidates } from './types';

const c = (path: string, group: LinkCandidate['group'], title: string | null = null, window: number | null = null): LinkCandidate => ({
  path,
  group,
  title,
  window,
});

const data = (candidates: LinkCandidate[], extra: Partial<LinkCandidates> = {}): LinkCandidates => ({
  candidates,
  truncated: false,
  projectRoot: '/r',
  docPath: '/r/doc.md',
  ...extra,
});

const labels = (items: PickerItem[]) =>
  items.map((i) => (i.kind === 'candidate' ? i.label : i.kind === 'url' ? `url:${i.url}` : 'choose'));

describe('dedupByGroup', () => {
  it('keeps a path once, in its highest group, with any title it had', () => {
    const got = dedupByGroup([c('/r/a.md', 'recent'), c('/r/a.md', 'tab'), c('/r/a.md', 'stash', 'Alpha')]);
    expect(got).toEqual([c('/r/a.md', 'tab', 'Alpha')]);
  });
});

describe('matchQuality', () => {
  it('prefix of the name > word start > subsequence > none', () => {
    expect(matchQuality('pla', 'plan', 'docs/plan.md')).toBe(3);
    expect(matchQuality('all', 'github-allowlist', 'docs/github-allowlist.md')).toBe(2);
    expect(matchQuality('docs', 'plan', 'docs/plan.md')).toBe(2);
    expect(matchQuality('gal', 'github-allowlist', 'x.md')).toBe(1);
    expect(matchQuality('my plan', 'my-plan', 'my-plan.md')).toBe(1);
    expect(matchQuality('zzz', 'plan', 'docs/plan.md')).toBe(0);
  });

  it('outside the project the path counts for word starts only', () => {
    expect(matchQuality('pl', 'elsewhere', '/private/tmp/fl/elsewhere.md', false)).toBe(0);
    expect(matchQuality('tmp', 'elsewhere', '/private/tmp/fl/elsewhere.md', false)).toBe(2);
    expect(matchQuality('esw', 'elsewhere', '/private/tmp/fl/elsewhere.md', false)).toBe(1);
  });

  it('is case-insensitive', () => {
    expect(matchQuality('PL', 'plan', 'plan.md')).toBe(3);
  });
});

describe('pickerItems', () => {
  it('empty query: every group in order, at most 8 each, Choose file last', () => {
    const many = Array.from({ length: 12 }, (_, i) => c(`/r/p${i}.md`, 'project'));
    const items = pickerItems(data([c('/r/t.md', 'tab'), ...many, c('/x/r.md', 'recent'), c('/n/s.md', 'stash', 'Stash note')]), '');
    expect(labels(items)).toEqual(['t', ...many.slice(0, PER_GROUP_EMPTY).map((x) => x.path.slice(3, -3)), 'r', 'Stash note', 'choose']);
  });

  it('never offers the document itself', () => {
    expect(labels(pickerItems(data([c('/r/doc.md', 'tab'), c('/r/a.md', 'tab')]), ''))).toEqual(['a', 'choose']);
  });

  it('ranks by group, then match quality, then natural order', () => {
    const items = pickerItems(
      data([c('/r/x-plan.md', 'project'), c('/r/plan.md', 'project'), c('/r/old-plan.md', 'recent'), c('/r/planet.md', 'tab')]),
      'plan'
    );
    expect(labels(items)).toEqual(['planet', 'plan', 'x-plan', 'old-plan', 'choose']);
  });

  it('a file outside the project matches by label or a path segment, never a subsequence of its absolute path', () => {
    const outside = [c('/Users/me/couplet/n1.md', 'stash', 'Ideas board'), c('/private/tmp/other/elsewhere.md', 'tab')];
    expect(labels(pickerItems(data(outside), 'pl'))).toEqual(['choose']);
    expect(labels(pickerItems(data(outside), 'couplet'))).toEqual(['Ideas board', 'choose']);
    expect(labels(pickerItems(data(outside), 'ibd'))).toEqual(['Ideas board', 'choose']);
  });

  it('a URL query offers Link to URL first and Choose file last', () => {
    expect(labels(pickerItems(data([c('/r/a.md', 'tab')]), 'https://x.test/a'))).toEqual(['url:https://x.test/a', 'choose']);
  });

  it('with nothing to offer still offers Choose file', () => {
    expect(labels(pickerItems(data([]), 'zzz'))).toEqual(['choose']);
  });

  it('isUrlQuery', () => {
    expect(isUrlQuery('http://a')).toBe(true);
    expect(isUrlQuery('HTTPS://a/b?c')).toBe(true);
    expect(isUrlQuery('plan')).toBe(false);
    expect(isUrlQuery('https://a b')).toBe(false);
  });
});

describe('displayDir', () => {
  it('names the project for a file inside it', () => {
    expect(displayDir('/r/docs/plan.md', '/r', '/Users/me')).toBe('r/docs');
    expect(displayDir('/r/plan.md', '/r', '/Users/me')).toBe('r');
  });

  it('abbreviates home elsewhere', () => {
    expect(displayDir('/Users/me/couplet/n.md', '/r', '/Users/me')).toBe('~/couplet');
    expect(displayDir('/tmp/x.md', '/r', '/Users/me')).toBe('/tmp');
  });
});
