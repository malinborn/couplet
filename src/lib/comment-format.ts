/**
 * Pure helpers for the comment layer. The file format is a contract written to
 * by Rust, by agents, and by people editing it by hand, so the parser here is
 * forgiving: a thread it cannot make sense of is skipped and the rest are
 * still returned.
 *
 * Nothing from Tauri or CodeMirror — this module is tested in isolation.
 */

/**
 * `paused` means a human is still typing in this thread: `mdmini watch` skips
 * it, and the marker line carries the moment the pause runs out. See
 * {@link isAwaiting} and `Status` in `src-tauri/src/comments.rs`.
 */
export type CommentStatus = 'open' | 'paused' | 'answered' | 'resolved';

export interface CommentReply {
  author: string;
  at: string;
  text: string;
}

export interface CommentThread {
  id: string;
  status: CommentStatus;
  /** Line number as of the last write — a hint, not the truth. */
  line: number;
  quote: string;
  /**
   * Document text immediately before the quote, as of the moment the thread
   * was created. Absent on threads written by older versions, and on threads
   * a human typed by hand — anchoring degrades, it does not break.
   */
  prefix?: string;
  /** Document text immediately after the quote. See `prefix`. */
  suffix?: string;
  /**
   * Epoch **seconds** at which a `paused` thread stops being paused. Absent on
   * every other status, and on threads written before pausing existed — see
   * {@link isAwaiting} for what a missing deadline means.
   */
  until?: number;
  replies: CommentReply[];
}

/**
 * Seconds of quiet after the last keystroke before a paused thread is handed
 * to the agent.
 *
 * Mirrors `PAUSE_SECS` in `src-tauri/src/comments.rs`: Rust writes the
 * deadline into the file, the card counts down to it, and the two must agree
 * or the countdown would show a number the file does not honour.
 */
export const COMMENT_PAUSE_SECONDS = 20;

/**
 * Is this thread waiting for an agent?
 *
 * The same rule as `awaiting` in `src-tauri/src/comments.rs`, and it has to
 * stay the same: this decides what the card says, that decides who gets woken,
 * and a card claiming "waiting" over a thread no agent will be told about is
 * worse than no card at all.
 *
 * An expired pause counts as waiting. md-mini can be closed — or killed — in
 * the seconds before it would have committed the pause itself, and a thread
 * nobody ever un-pauses is a comment that never arrives.
 */
export function isAwaiting(thread: CommentThread, nowSeconds: number): boolean {
  if (thread.status === 'open') return true;
  if (thread.status !== 'paused') return false;
  return thread.until === undefined || nowSeconds >= thread.until;
}

/**
 * What the card writes next to the box while a pause is running.
 *
 * Seconds, rounded up, so the label reaches "1s" before it disappears rather
 * than sitting on "0s". Written straight into the DOM once a second — never
 * through a rebuild, which would take the caret out of the box being typed in.
 */
export function countdownLabel(msLeft: number): string {
  return `sending in ${Math.max(0, Math.ceil(msLeft / 1000))}s`;
}

const THREAD_MARKER = '<!-- mdmini:c ';

/**
 * The author md-mini writes for the person using it. Mirrors `SELF_AUTHOR` in
 * `src-tauri/src/comments.rs`, and decides which reply the comment box edits
 * in place rather than showing as finished.
 */
export const SELF_AUTHOR = 'You';

/**
 * Splits a thread into the part that is done and the part still being written.
 *
 * A trailing reply by the user is not a sent message — nobody has seen it yet,
 * and it is what the always-editable box holds (#23). Everything before it is
 * finished: either an agent's answer, or a turn the agent has already replied
 * under. Once an answer lands, the user's previous turn moves into `frozen` on
 * its own, which is precisely the "area freezes and a new one appears below"
 * behaviour — no state machine needed, the file says it.
 */
export function splitThread(thread: CommentThread): {
  frozen: CommentReply[];
  editable: string;
} {
  const last = thread.replies[thread.replies.length - 1];
  if (last && last.author === SELF_AUTHOR) {
    return { frozen: thread.replies.slice(0, -1), editable: last.text };
  }
  return { frozen: thread.replies, editable: '' };
}

/**
 * How much text is kept on each side of the quote.
 *
 * Measured, not guessed: over ~21k anchoring cases built from this repo's own
 * markdown (see the #20 research), 12 characters already resolve 99.4% of the
 * ambiguous ones, 24 gives 99.7%, 32 gives 99.8%, and 48 gives 100%. Past 32
 * the curve is flat while the marker line keeps growing, and that line is read
 * by humans and hand-edited.
 */
export const ANCHOR_CONTEXT = 32;

/**
 * Percent-escaping for a marker attribute value.
 *
 * Marker attributes are `k=v` pairs split on whitespace, so a value that
 * contains a space would be read as two attributes and the rest of it silently
 * dropped. `>` is escaped as well, so no value can ever spell `-->` and cut
 * the comment short. Everything else — Cyrillic included — stays literal:
 * the file is read by people.
 *
 * Mirrored byte-for-byte by `escape_attr` in `src-tauri/src/comments.rs`.
 */
export function escapeAttr(value: string): string {
  return value.replace(/[\s%>]/gu, (ch) => encodeURIComponent(ch));
}

/** Inverse of {@link escapeAttr}. A malformed value is returned unchanged
 * rather than throwing — a hand-edited file must not blank a whole thread. */
export function unescapeAttr(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const STATUSES: readonly string[] = ['open', 'paused', 'answered', 'resolved'];

function parseMarker(
  line: string
): Pick<CommentThread, 'id' | 'status' | 'line' | 'prefix' | 'suffix' | 'until'> | null {
  const inner = line.trim().slice(THREAD_MARKER.length).replace(/-->$/, '').trim();
  let id = '';
  let status: CommentStatus | '' = '';
  let lineNumber = 1;
  let prefix: string | undefined;
  let suffix: string | undefined;
  let until: number | undefined;
  for (const pair of inner.split(/\s+/)) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (key === 'id') id = value;
    else if (key === 'status' && STATUSES.includes(value)) {
      status = value as CommentStatus;
    } else if (key === 'line') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) lineNumber = parsed;
    } else if (key === 'until') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) until = parsed;
    } else if (key === 'pre') prefix = unescapeAttr(value);
    else if (key === 'suf') suffix = unescapeAttr(value);
  }
  if (!id || !status) return null;
  return { id, status, line: lineNumber, prefix, suffix, until };
}

function parseReplyHeader(line: string): { author: string; at: string } | null {
  const match = /^\*\*([^*]+)\*\*\s+·\s+(.+)$/.exec(line);
  if (!match) return null;
  return { author: match[1], at: match[2].trim() };
}

/** Parse the contents of a comment file. */
export function parseComments(text: string): CommentThread[] {
  const threads: CommentThread[] = [];
  let current: CommentThread | null = null;
  let reply: CommentReply | null = null;
  let skipping = false;

  const flushReply = () => {
    if (current && reply) {
      reply.text = reply.text.replace(/\s+$/, '');
      current.replies.push(reply);
    }
    reply = null;
  };

  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith(THREAD_MARKER)) {
      flushReply();
      if (current) threads.push(current);
      const marker = parseMarker(line);
      skipping = marker === null;
      current = marker ? { ...marker, quote: '', replies: [] } : null;
      continue;
    }
    if (skipping || !current) continue;

    if (!reply && line.startsWith('> ')) {
      current.quote = current.quote ? `${current.quote}\n${line.slice(2).trimEnd()}` : line.slice(2).trimEnd();
      continue;
    }

    const header = parseReplyHeader(line);
    if (header) {
      flushReply();
      reply = { ...header, text: '' };
      continue;
    }

    if (reply) {
      if (!line.trim() && !reply.text) continue;
      reply.text = reply.text ? `${reply.text}\n${line}` : line;
    }
  }

  flushReply();
  if (current) threads.push(current);
  return threads;
}

/** Context stored with a thread, used to tell repeated quotes apart. */
export interface AnchorContext {
  prefix?: string;
  suffix?: string;
}

/** Offsets at which every line of `doc` starts. Built once per resolve. */
function lineStarts(doc: string): number[] {
  const starts = [0];
  for (let i = 0; i < doc.length; i += 1) if (doc[i] === '\n') starts.push(i + 1);
  return starts;
}

/** 1-based line number of an offset, by binary search over `starts`. */
function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * A quote that repeats thousands of times (a single `|`, a lone word in a big
 * file) must not turn resolving into a document-length scan per thread. Past
 * this many hits the extra candidates cannot change the answer in practice —
 * the right one is almost always near the recorded line, and the ones beyond
 * the cap are strictly further away in document order.
 */
const MAX_CANDIDATES = 2000;

function occurrences(doc: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = doc.indexOf(needle, from);
    if (at < 0) break;
    out.push(at);
    if (out.length >= MAX_CANDIDATES) break;
    from = at + 1;
  }
  return out;
}

/** Length of the longest common suffix of two strings. */
function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1;
  return n;
}

/** Length of the longest common prefix of two strings. */
function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

/**
 * Where to draw a thread.
 *
 * The quote alone does not identify a place: a word, a list item or a heading
 * repeats, and picking the first occurrence from the top of the document lands
 * the card on a duplicate — usually far above — while still reporting a
 * confident match. That was issue #20, and it needs no agent edit to happen:
 * it fires the moment the comment is written.
 *
 * So every occurrence is a candidate, and they are ranked:
 *
 * 1. by how much of the stored surrounding text (`prefix`/`suffix`) the
 *    candidate reproduces — context is what makes a repeated fragment unique;
 * 2. by distance from the recorded `line`, which is both the tie-break and the
 *    whole ranking for threads with no stored context (older sidecars, and
 *    ones written by hand).
 *
 * Measured over ~21k cases generated from this repo's own markdown, with the
 * document then edited the way an agent edits it (block inserted above, block
 * deleted, 60 lines inserted far above, neighbouring lines rewritten, the
 * anchored line duplicated three lines up):
 *
 * | strategy                       | all    | ambiguous quotes only |
 * |--------------------------------|--------|-----------------------|
 * | first occurrence (before)      | 61.5%  | 13.0%                 |
 * | nearest to the recorded line   | 88.8%  | 74.7%                 |
 * | this function, nothing stored  | 88.7%  | 74.6%                 |
 * | this function, context stored  | 100.0% | 100.0%                |
 *
 * If the quote is gone entirely the thread does not disappear — it is marked
 * detached, because drifting away silently is the one outcome it must never
 * have.
 */
export function anchorPosition(
  doc: string,
  quote: string,
  line: number,
  context: AnchorContext = {}
): { pos: number; to: number; orphaned: boolean } {
  // Only the first quote line is matched, so the returned range never crosses
  // a newline — a mark decoration renders that badly.
  const needle = quote.split('\n')[0];
  const hits = needle ? occurrences(doc, needle) : [];

  if (hits.length) {
    let best = hits[0];
    if (hits.length > 1) {
      const starts = lineStarts(doc);
      const prefix = context.prefix ?? '';
      const suffix = context.suffix ?? '';
      let bestScore = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const hit of hits) {
        const before = doc.slice(Math.max(0, hit - prefix.length), hit);
        const after = doc.slice(hit + needle.length, hit + needle.length + suffix.length);
        const score = commonSuffix(prefix, before) + commonPrefix(suffix, after);
        const distance = Math.abs(lineOf(starts, hit) - line);
        if (score > bestScore || (score === bestScore && distance < bestDistance)) {
          best = hit;
          bestScore = score;
          bestDistance = distance;
        }
      }
    }
    // `to` bounds the quoted fragment so the document can mark it — a card
    // that only shows the quote leaves the reader hunting for which words it
    // is about.
    return { pos: best, to: best + needle.length, orphaned: false };
  }

  const lines = doc.split('\n');
  const index = Math.max(0, Math.min(line - 1, lines.length - 1));
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += lines[i].length + 1;
  const clamped = Math.min(pos, doc.length);
  // Detached: there is no fragment to mark, so the range is empty and the
  // card carries the "anchor lost" label instead.
  return { pos: clamped, to: clamped, orphaned: true };
}

/**
 * Context to store with a new thread: the text on each side of the fragment
 * being commented on, clipped to {@link ANCHOR_CONTEXT}.
 */
export function anchorContextAt(doc: string, from: number, to: number): AnchorContext {
  return {
    prefix: doc.slice(Math.max(0, from - ANCHOR_CONTEXT), from),
    suffix: doc.slice(to, to + ANCHOR_CONTEXT),
  };
}

/** Comment-file path for a document — the same rule as in Rust. */
export function sidecarPath(docPath: string): string {
  const slash = docPath.lastIndexOf('/');
  const dir = slash < 0 ? '' : docPath.slice(0, slash + 1);
  const name = slash < 0 ? docPath : docPath.slice(slash + 1);
  return `${dir}.mdmini_comments_${name}`;
}

/**
 * Short label for the fragment a thread is about, for the card header.
 *
 * Up to 30 characters is shown whole — eliding a short quote costs more than
 * it saves. Longer ones keep their first and last 15 characters, because both
 * ends carry information: the start says where the fragment begins, the end
 * disambiguates it from a neighbour that starts the same way.
 *
 * Newlines collapse to spaces: a header is one line, and a multi-line quote
 * would otherwise break the card layout.
 */
export function quotePreview(quote: string): string {
  const flat = quote.replace(/\s+/g, ' ').trim();
  if (flat.length <= 30) return flat;
  return `${flat.slice(0, 15)}…${flat.slice(-15)}`;
}

/** Directory a document lives in, for scoping the watch command. */
export function documentDir(docPath: string): string {
  const slash = docPath.lastIndexOf('/');
  return slash <= 0 ? '/' : docPath.slice(0, slash);
}

/**
 * Ready-to-paste text that gets an agent watching this document's comments.
 *
 * Nothing in the app can arm a watch by itself — the agent has to run it, in
 * its own session, and there is no way for the editor to reach into that. So
 * the discoverable surface is a command the user hands over, and it has to
 * explain the one flag that silently breaks everything if omitted.
 */
export function buildWatchPrompt(docPath: string): string {
  const dir = documentDir(docPath);
  return [
    `Watch for my comments under ${dir} and answer them.`,
    ``,
    `If you can react to an event stream (Claude Code: the Monitor tool):`,
    `Monitor({command: "mdmini watch ${dir}", description: "new mdmini comments", persistent: true})`,
    `persistent: true is not optional — without it the monitor dies after five`,
    `minutes and its silence is indistinguishable from "no comments".`,
    ``,
    `If you cannot, check \`mdmini question ${dir}\` at natural points: before`,
    `asking me something in chat, and before reporting that you are done.`,
    ``,
    `To answer: \`mdmini answer <file> --id <id>\` with the text on stdin. If a`,
    `comment asks for a change rather than an answer, make it with`,
    `\`mdmini edit\`, then close the thread with an answer.`,
  ].join('\n');
}

/**
 * Text behind the "send to agent" button: pasted into a chat with any agent,
 * including ones that have neither MCP nor a way of being woken.
 */
export function buildHandoffPrompt(docPath: string, id: string): string {
  return [
    `There is an open comment ${id} on ${docPath}, in ${sidecarPath(docPath)}.`,
    `Read the thread and answer it: append a reply under it and set status to answered.`,
    `If it asks for a change to the document itself, make the change, then answer in the thread.`,
    `With md-mini over MCP: the question and answer tools. From a shell: mdmini answer ${docPath} --id ${id} (text on stdin).`,
  ].join('\n');
}
