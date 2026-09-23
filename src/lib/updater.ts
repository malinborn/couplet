/**
 * Update checker — compares the running version with the latest GitHub release.
 * Checks 15s after launch and then hourly.
 *
 * Only **one** window polls. Every window used to run its own timer, which meant
 * one request per window per hour for a single answer, and a notice that had to be
 * dismissed separately in each window. The claim and the dismissal are held in
 * Rust (`src-tauri/src/updater.rs`); a find is reported there and broadcast to
 * every window from one place.
 */

import { invoke } from '@tauri-apps/api/core';

const GITHUB_REPO = 'malinborn/mdmini';
const CHECK_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour
const FIRST_CHECK_DELAY = 15_000;

async function getCurrentVersion(): Promise<string> {
  const { getVersion } = await import('@tauri-apps/api/app');
  return getVersion();
}

export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

/** Longest highlight the toast can show without wrapping past two lines. */
const HIGHLIGHT_MAX = 120;

/**
 * One-line summary of what a release brings, pulled from its notes.
 *
 * The toast used to say only "a newer version exists", which answers the wrong
 * question — nobody upgrades because a number changed. The release body's first
 * real line is written for humans, so it is the one worth showing.
 *
 * Markdown headings, list bullets and emphasis are stripped: the toast renders
 * plain text, and raw `### ` or `- **bold**` in it reads as a rendering bug.
 * Returns null rather than a truncated word salad when there is nothing usable.
 */
export function releaseHighlight(body: string | null | undefined): string | null {
  if (!body) return null;

  let firstHeading: string | null = null;

  for (const raw of body.split('\n')) {
    const isHeading = /^\s*#{1,6}\s/.test(raw);
    const line = raw
      .replace(/^\s*#{1,6}\s*/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/[*_`]/g, '')
      .trim();
    if (line.length < 8) continue; // blank, a divider, or a bare word
    if (/^!\[|^\[!\[/.test(line)) continue; // badge or image row

    // Section headings are usually navigation, not news — "What's new" tells
    // the reader nothing. Prefer the prose under them, and fall back to the
    // first heading only if the notes turn out to be headings all the way
    // down, so a terse release still says something.
    if (isHeading) {
      firstHeading ??= line;
      continue;
    }
    return clampHighlight(line);
  }

  return firstHeading ? clampHighlight(firstHeading) : null;
}

function clampHighlight(line: string): string {
  return line.length > HIGHLIGHT_MAX ? `${line.slice(0, HIGHLIGHT_MAX - 1)}…` : line;
}

/** Outcome of a check, for the manual path — the automatic one only ever acts on 'found'. */
export type UpdateCheckResult = 'found' | 'none' | 'error';

async function performCheck(force: boolean): Promise<UpdateCheckResult> {
  try {
    const current = await getCurrentVersion();

    const res = await fetch(CHECK_URL, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });
    if (!res.ok) return 'error';

    const data = await res.json();
    const latest = data.tag_name as string;

    if (!latest) return 'error';
    if (!isNewer(latest, current)) return 'none';

    // Rust decides whether this is worth showing — it remembers dismissals and
    // suppresses the repeat report every subsequent hour. `force` bypasses
    // that suppression: a manual click always gets the toast, even if the
    // same version was already dismissed.
    await invoke('report_update', {
      latest,
      current,
      highlight: releaseHighlight(data.body as string | null),
      force,
    });
    return 'found';
  } catch {
    // Network error, repo not found.
    return 'error';
  }
}

export async function checkForUpdates(): Promise<void> {
  await performCheck(false);
}

/**
 * The "Check for Updates…" menu item (#82). Unlike the polling check above,
 * this one always answers: found (the existing `update` toast, via
 * `report_update`'s `force`), already latest, or the request failed. Callers
 * push the `update-none` / `update-check-failed` toasts themselves for the
 * two outcomes the automatic checker deliberately stays silent on.
 */
export async function checkForUpdatesManually(): Promise<UpdateCheckResult> {
  return performCheck(true);
}

/**
 * Start periodic checks, but only in the window that wins the claim. Returns a
 * stop function; it is a no-op in windows that did not win.
 */
export async function startUpdateChecker(): Promise<() => void> {
  const isChecker = await invoke<boolean>('claim_update_checker').catch(() => false);
  if (!isChecker) return () => {};

  const initialTimer = setTimeout(() => void checkForUpdates(), FIRST_CHECK_DELAY);
  const intervalTimer = setInterval(() => void checkForUpdates(), CHECK_INTERVAL);

  return () => {
    clearTimeout(initialTimer);
    clearInterval(intervalTimer);
  };
}
