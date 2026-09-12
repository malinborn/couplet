/**
 * The "bind this file to an AI agent" button (#29): what it puts on the
 * clipboard, and how it moves.
 *
 * Both halves are plain, pure TypeScript with no runes and no DOM — the
 * component in `AiBindButton.svelte` is a thin shell over them, because the
 * geometry is exactly the part that is impossible to check by eye ("does it
 * lunge?" is a question about numbers).
 */

/* ------------------------------------------------------------------ prompt */

/**
 * Ready-to-paste text that connects an agent to one specific document.
 *
 * The feedback behind #29 is not "I could not find the docs", it is "I spent
 * fifteen minutes and never found out that a way exists". So this text has to
 * survive being pasted cold into a chat with an agent that has never heard of
 * md-mini: it names the absolute path, says what the verbs are, and asks the
 * agent to speak up rather than guess if the CLI is missing — a silent failure
 * here reads to the user as "md-mini lied to me".
 *
 * The path is repeated in full on every line on purpose. Agents copy these
 * lines into shell commands verbatim, and a `<file>` placeholder is exactly
 * the kind of thing that gets run literally.
 */
export function buildBindPrompt(docPath: string): string {
  return [
    `I'm looking at ${docPath} in md-mini. Work with me in that document.`,
    ``,
    `- Read it from disk as usual.`,
    `- \`mdmini show ${docPath} --line N\` (or \`--find "text"\`) scrolls my`,
    `  window there and pulses the line — point at what you mean instead of`,
    `  quoting it back at me.`,
    `- \`cat new.md | mdmini edit ${docPath} --show\` replaces the live buffer.`,
    `  Send the **complete** new document, not a diff — md-mini works out what`,
    `  changed and highlights only that.`,
    `- \`mdmini ask ${docPath} --question "..." --option A --option B\` asks me`,
    `  inside the document and blocks until I click.`,
    `- \`mdmini question ${docPath}\` lists comments I left for you;`,
    `  \`mdmini answer ${docPath} --id ID\` (reply on stdin) closes a thread.`,
    ``,
    `If \`mdmini\` is not on your PATH, tell me — do not guess an alternative.`,
  ].join('\n');
}

/* ---------------------------------------------------------------- geometry */

export interface Point {
  x: number;
  y: number;
}

/** Beyond this distance from the button, the pointer has no pull at all. */
export const MAGNET_RADIUS = 140;

/**
 * Hard cap on how far the button may leave its resting place, in px.
 *
 * Deliberately small. A button that visibly jumps at the cursor is worse than
 * one that never moves: it costs the user a re-aim, and this app's whole point
 * is that nothing on screen demands attention. Seven pixels is enough to feel
 * like the target got easier to hit and not enough to notice as motion.
 */
export const MAGNET_MAX_PULL = 7;

/**
 * How far the button shifts from its resting place, given where the pointer is.
 *
 * Falloff is quadratic in proximity, so the pull is nearly nothing across most
 * of the radius and only firms up in the last few dozen pixels. Two properties
 * matter and are covered by tests:
 *
 * - the offset never exceeds the pointer distance, so the button cannot
 *   overshoot past the cursor and start oscillating under it;
 * - a pointer exactly on the anchor yields zero, so there is no direction to
 *   jitter along at the moment of the click.
 *
 * Pass `maxPull: 0` for `prefers-reduced-motion` — the caller does exactly that
 * rather than this module knowing about media queries.
 */
export function magnetOffset(args: {
  pointer: Point;
  anchor: Point;
  radius?: number;
  maxPull?: number;
}): Point {
  const { pointer, anchor, radius = MAGNET_RADIUS, maxPull = MAGNET_MAX_PULL } = args;
  if (maxPull <= 0 || radius <= 0) return { x: 0, y: 0 };

  const dx = pointer.x - anchor.x;
  const dy = pointer.y - anchor.y;
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance === 0 || distance >= radius) {
    return { x: 0, y: 0 };
  }

  const proximity = 1 - distance / radius;
  const magnitude = Math.min(maxPull * proximity * proximity, distance);
  return { x: (dx / distance) * magnitude, y: (dy / distance) * magnitude };
}

/** Inside this distance the button is fully out. */
export const REVEAL_NEAR = 48;
/** Outside this distance it is back to just peeking. */
export const REVEAL_FAR = 180;

/**
 * How far out the button should slide, 0 (peeking) to 1 (fully revealed), as a
 * function of the pointer's distance from it.
 *
 * Proximity rather than `:hover` because the button rests mostly off-screen —
 * waiting for a real hover would mean the user has to already know it is there,
 * which is the exact problem #29 is about.
 */
export function revealProgress(
  distance: number,
  near: number = REVEAL_NEAR,
  far: number = REVEAL_FAR
): number {
  if (!Number.isFinite(distance)) return 0;
  if (distance <= near) return 1;
  if (distance >= far) return 0;
  return (far - distance) / (far - near);
}
