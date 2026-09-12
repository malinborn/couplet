export interface Replacement {
  from: number;
  to: number;
  insert: string;
}

/** Minimal single-span replacement turning oldText into newText, or null if identical. */
export function computeReplacement(oldText: string, newText: string): Replacement | null {
  if (oldText === newText) return null;

  const maxCommon = Math.min(oldText.length, newText.length);

  let prefix = 0;
  while (prefix < maxCommon && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) {
    prefix++;
  }

  let suffix = 0;
  const maxSuffix = maxCommon - prefix;
  while (
    suffix < maxSuffix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix++;
  }

  return {
    from: prefix,
    to: oldText.length - suffix,
    insert: newText.slice(prefix, newText.length - suffix),
  };
}

/** A 1-based, inclusive line range in the *new* text. */
export type LineRange = [number, number];

/**
 * Fraction of a block's lines that must have changed before the block counts
 * as "rewritten wholesale" and is highlighted in full rather than line by line.
 *
 * Chosen from realistic before/after pairs (see `content-diff.test.ts`, the
 * `threshold calibration` block): every point edit measured — a typo, a
 * reworded sentence, one bullet out of several, one table row out of several —
 * lands at or below 0.5, while every wholesale rewrite or fresh insertion
 * lands at 1.0. 0.6 sits in that empty gap, and is the lowest value that still
 * leaves the most adversarial point edit (one line of a two-line paragraph,
 * 0.5) on the line-by-line side.
 */
export const BLOCK_REWRITE_THRESHOLD = 0.6;

/**
 * Above this many DP cells the O(n*m) line LCS is skipped and the whole
 * differing middle is reported as one hunk (i.e. the pre-existing
 * single-span behaviour). 1M cells ≈ 4 MB of Uint32Array.
 */
const LCS_CELL_LIMIT = 1_000_000;

/** Per-new-line "this line is new or changed" flags for the given line arrays. */
function changedLineFlags(oldLines: readonly string[], newLines: readonly string[]): boolean[] {
  const flags = new Array<boolean>(newLines.length).fill(false);

  // Trim identical leading/trailing lines — an AI edit usually touches a tiny
  // fraction of the document, so this is what keeps the LCS below the cap.
  let pre = 0;
  const maxPre = Math.min(oldLines.length, newLines.length);
  while (pre < maxPre && oldLines[pre] === newLines[pre]) pre++;

  let suf = 0;
  const maxSuf = maxPre - pre;
  while (
    suf < maxSuf &&
    oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]
  ) {
    suf++;
  }

  const a = oldLines.slice(pre, oldLines.length - suf);
  const b = newLines.slice(pre, newLines.length - suf);
  if (b.length === 0) return flags;

  if ((a.length + 1) * (b.length + 1) > LCS_CELL_LIMIT) {
    for (let i = 0; i < b.length; i++) flags[pre + i] = true;
    return flags;
  }

  // Classic LCS table over lines; `dp[i][j]` = LCS length of a[i..] / b[j..].
  const w = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + (j + 1)] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      i++; // line removed
    } else {
      flags[pre + j] = true; // line added / rewritten
      j++;
    }
  }
  for (; j < b.length; j++) flags[pre + j] = true;

  return flags;
}

/**
 * Bounds (0-based, inclusive) of the markdown block `idx` belongs to: the
 * maximal run of non-blank lines around it. A blank line is its own block.
 */
function blockBounds(lines: readonly string[], idx: number): [number, number] {
  if (lines[idx].trim() === '') return [idx, idx];
  let start = idx;
  while (start > 0 && lines[start - 1].trim() !== '') start--;
  let end = idx;
  while (end < lines.length - 1 && lines[end + 1].trim() !== '') end++;
  return [start, end];
}

/**
 * Line ranges (1-based, inclusive, in `newText`) an AI edit should highlight.
 *
 * A block whose changed-line share reaches `threshold` counts as created or
 * rewritten wholesale and is reported in full; anything below that is a point
 * edit and only the lines that actually differ are reported. Unlike
 * `computeReplacement` — which deliberately collapses everything between the
 * first and last difference into one span so CM6 gets a single minimal change
 * — this reports each hunk separately, so edits scattered across a document do
 * not light up the untouched text between them.
 *
 * A pure deletion leaves no new line to wash, so it reports no ranges at all;
 * the caller decides what — if anything — to report for it (`App.svelte` falls
 * back to `changedLineRanges` for the JSON response, and highlights nothing).
 */
export function computeChangedLineRanges(
  oldText: string,
  newText: string,
  threshold: number = BLOCK_REWRITE_THRESHOLD
): LineRange[] {
  if (oldText === newText) return [];

  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const changed = changedLineFlags(oldLines, newLines);

  const highlighted = new Array<boolean>(newLines.length).fill(false);
  const blockDone = new Array<boolean>(newLines.length).fill(false);

  for (let i = 0; i < newLines.length; i++) {
    if (!changed[i] || blockDone[i]) continue;
    const [start, end] = blockBounds(newLines, i);
    let count = 0;
    for (let k = start; k <= end; k++) {
      blockDone[k] = true;
      if (changed[k]) count++;
    }
    const wholesale = count / (end - start + 1) >= threshold;
    for (let k = start; k <= end; k++) {
      if (wholesale || changed[k]) highlighted[k] = true;
    }
  }

  const ranges: LineRange[] = [];
  for (let i = 0; i < newLines.length; i++) {
    if (!highlighted[i]) continue;
    const start = i;
    while (i + 1 < newLines.length && highlighted[i + 1]) i++;
    ranges.push([start + 1, i + 1]);
  }

  return ranges;
}
