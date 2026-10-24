import type { LinkCandidate, LinkCandidates, LinkGroup } from './types';
import { isInside, labelFor, relativePath } from './link-destination';
import { basename, dirOf } from './link-target';

/**
 * The picker's own filtering (file-links D5; the completion result says
 * `filter: false`): case-insensitive subsequence over the label and the
 * project-relative path, ranked by group, then match quality, then the
 * source's natural order — which Rust already made the recency order.
 */

export const GROUP_ORDER: readonly LinkGroup[] = ['tab', 'project', 'recent', 'stash'];
/** Empty query: this many per group. */
export const PER_GROUP_EMPTY = 8;
/** A query: at most this many matches overall. */
export const MAX_MATCHES = 50;

export type PickerItem =
  | { kind: 'url'; url: string }
  | { kind: 'candidate'; candidate: LinkCandidate; label: string }
  | { kind: 'choose' };

export function isUrlQuery(query: string): boolean {
  return /^https?:\/\/\S+$/i.test(query.trim());
}

function rank(group: LinkGroup): number {
  return GROUP_ORDER.indexOf(group);
}

/** Each path once, in its highest group (D5), carrying a title any copy had. Order otherwise kept. */
export function dedupByGroup(list: readonly LinkCandidate[]): LinkCandidate[] {
  const best = new Map<string, LinkCandidate>();
  const titles = new Map<string, string>();
  for (const cand of list) {
    if (cand.title && !titles.has(cand.path)) titles.set(cand.path, cand.title);
    const prev = best.get(cand.path);
    if (!prev || rank(cand.group) < rank(prev.group)) best.set(cand.path, cand);
  }
  return list
    .filter((cand) => best.get(cand.path) === cand)
    .map((cand) => ({ ...cand, title: cand.title ?? titles.get(cand.path) ?? null }));
}

const WORD_SPLIT = /[\s\-_./]+/;

function isSubsequence(query: string, text: string): boolean {
  let i = 0;
  for (const ch of text) {
    if (i < query.length && ch === query[i]) i++;
  }
  return i === query.length;
}

/** 3 — the label starts with it; 2 — a word of the label or a path segment does; 1 — subsequence; 0 — no match. */
export function matchQuality(query: string, label: string, relPath: string): number {
  const q = query.trim().toLowerCase();
  if (q === '') return 0;
  const l = label.toLowerCase();
  const p = relPath.toLowerCase();
  if (l.startsWith(q)) return 3;
  const startsWord = (text: string) => text.split(WORD_SPLIT).some((w) => w.startsWith(q));
  if (startsWord(l) || startsWord(p)) return 2;
  const compact = q.replace(/\s+/g, '');
  if (isSubsequence(compact, l) || isSubsequence(compact, p)) return 1;
  return 0;
}

function relPathOf(path: string, root: string | null): string {
  return root && isInside(root, path) ? relativePath(root, path) : path;
}

/** The rows of the popup, top to bottom. «Choose file…» is always last. */
export function pickerItems(data: LinkCandidates, query: string): PickerItem[] {
  const q = query.trim();
  const out: PickerItem[] = [];
  const url = isUrlQuery(q);
  if (url) out.push({ kind: 'url', url: q });
  const list = dedupByGroup(data.candidates).filter((cand) => cand.path !== data.docPath);
  if (q === '') {
    for (const group of GROUP_ORDER) {
      for (const cand of list.filter((x) => x.group === group).slice(0, PER_GROUP_EMPTY)) {
        out.push({ kind: 'candidate', candidate: cand, label: labelFor(cand) });
      }
    }
  } else if (!url) {
    const scored = list
      .map((cand, index) => {
        const label = labelFor(cand);
        return { cand, index, label, quality: matchQuality(q, label, relPathOf(cand.path, data.projectRoot)) };
      })
      .filter((x) => x.quality > 0);
    scored.sort((a, b) => rank(a.cand.group) - rank(b.cand.group) || b.quality - a.quality || a.index - b.index);
    for (const x of scored.slice(0, MAX_MATCHES)) out.push({ kind: 'candidate', candidate: x.cand, label: x.label });
  }
  out.push({ kind: 'choose' });
  return out;
}

/** The grey detail of a row: `project/dir` inside the project, `~/…` or the absolute folder elsewhere. */
export function displayDir(path: string, root: string | null, home: string | null): string {
  const dir = dirOf(path);
  if (root && isInside(root, path)) {
    const rel = relativePath(root, dir);
    return rel === '' ? basename(root) : `${basename(root)}/${rel}`;
  }
  if (home && (dir === home || dir.startsWith(`${home}/`))) return `~${dir.slice(home.length)}`;
  return dir;
}
