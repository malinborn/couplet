/**
 * The "bind this file to an AI agent" button (#29): what it puts on the
 * clipboard.
 *
 * Only the prompt lives here now. This module used to also own the button's
 * motion — a proximity reveal and a cursor magnet, both computed in pure
 * functions precisely because "does it lunge?" is hard to judge by eye. Tried
 * in the real window, the answer was yes: see `AiBindButton.svelte`. The
 * geometry is gone, and with it the reason for this file to know about points
 * and distances at all.
 */

/* ------------------------------------------------------------------ prompt */

/**
 * Ready-to-paste text that connects an agent to one specific document.
 *
 * The feedback behind #29 is not "I could not find the docs", it is "I spent
 * fifteen minutes and never found out that a way exists". So this text has to
 * survive being pasted cold into a chat with an agent that has never heard of
 * couplet: it names the absolute path, says what the verbs are, and asks the
 * agent to speak up rather than guess if the CLI is missing — a silent failure
 * here reads to the user as "couplet lied to me".
 *
 * The path is repeated in full on every line on purpose. Agents copy these
 * lines into shell commands verbatim, and a `<file>` placeholder is exactly
 * the kind of thing that gets run literally.
 */
export function buildBindPrompt(docPath: string): string {
  return [
    `I'm looking at ${docPath} in couplet. Work with me in that document.`,
    ``,
    `- Read it from disk as usual.`,
    `- \`couplet show ${docPath} --line N\` (or \`--find "text"\`) scrolls my`,
    `  window there and pulses the line — point at what you mean instead of`,
    `  quoting it back at me.`,
    `- \`cat new.md | couplet edit ${docPath} --show\` replaces the live buffer.`,
    `  Send the **complete** new document, not a diff — couplet works out what`,
    `  changed and highlights only that.`,
    `- \`couplet ask ${docPath} --question "..." --option A --option B\` asks me`,
    `  inside the document and blocks until I click.`,
    `- \`couplet question ${docPath}\` lists comments I left for you;`,
    `  \`couplet answer ${docPath} --id ID\` (reply on stdin) closes a thread.`,
    ``,
    `If \`couplet\` is not on your PATH, tell me — do not guess an alternative.`,
  ].join('\n');
}

