/**
 * Which `Link` nodes are actually links (#51).
 *
 * `@lezer/markdown` emits a `Link` node for **every** `[` … `]` pair it finds
 * in inline content, whether or not anything makes it a link. `see [1] for
 * details`, `array[0]`, `dict["k"]` and a multi-line `[` … `]` inside pasted
 * JSON all arrive here as `Link`. CommonMark is explicit that they are not:
 * a bracket pair with no `(destination)` is a *shortcut reference* link, and a
 * shortcut reference is only a link when a matching link reference definition
 * exists in the document.
 *
 * Trusting the node name meant `decorateLink` hid both brackets and underlined
 * the text between them, so `see [1] for details` rendered as `see 1 for
 * details` — characters the user typed, gone from the screen. In live-render,
 * where nothing is revealed under the caret, that also moves where the caret
 * lands, which is how a wrong-text edit starts.
 *
 * So: resolve the reference the way CommonMark says to, and decorate only what
 * survives.
 */

import type { Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';

/**
 * CommonMark label matching: strip the outer whitespace, collapse each
 * internal run to one space, and case-fold. That is why a label split across
 * two lines (`[a\nb]`) still matches a definition written `[a b]:`.
 *
 * `toLowerCase` stands in for Unicode case folding — the same approximation
 * every mainstream implementation makes, and it agrees with the spec for every
 * case a markdown note is likely to contain.
 */
export function normalizeLinkLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * A link reference definition: up to three spaces of indent, a bracketed
 * label, a colon. Backslash escapes inside the label are honoured so
 * `[a\]b]:` is one label rather than a truncated one.
 */
const DEFINITION_RE = /^ {0,3}\[((?:[^\]\\\n]|\\.)+)\]:(.*)$/;

/** A line that opens or closes a fenced code block. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

const CACHE = new WeakMap<Text, Set<string>>();

/**
 * Every link label the document defines, normalised.
 *
 * Scanned from the text rather than read off the syntax tree on purpose: the
 * tree is parsed lazily within a time budget, so a definition sitting past the
 * parsed region would be invisible, and a link would flip from rendered to raw
 * depending on how far parsing had got. A line scan always sees the whole
 * document.
 *
 * It does track fenced code blocks, because a definition inside one defines
 * nothing. Indented code blocks need no special handling: a definition may be
 * indented by at most three spaces, so the regex excludes them already.
 *
 * Memoised on the `Text` instance. CodeMirror's document is persistent, so a
 * new instance means the text really did change, and an unchanged document is
 * scanned once no matter how many links ask.
 */
export function linkReferenceLabels(doc: Text): Set<string> {
  const cached = CACHE.get(doc);
  if (cached) return cached;

  const labels = new Set<string>();
  let fence: string | null = null;
  let pendingLabel: string | null = null;

  for (const line of doc.iterLines()) {
    if (fence !== null) {
      // A closing fence is the same character, at least as long, alone on its
      // line. Anything else is still code.
      const close = FENCE_RE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length && !close[2].trim()) {
        fence = null;
      }
      pendingLabel = null;
      continue;
    }

    const open = FENCE_RE.exec(line);
    if (open) {
      fence = open[1];
      pendingLabel = null;
      continue;
    }

    if (pendingLabel !== null) {
      // A definition's destination may sit on the line after the colon.
      if (line.trim()) labels.add(pendingLabel);
      pendingLabel = null;
      // Fall through: this same line may itself start a definition.
    }

    const match = DEFINITION_RE.exec(line);
    if (!match) continue;
    const label = normalizeLinkLabel(match[1]);
    if (!label) continue;
    if (match[2].trim()) labels.add(label);
    else pendingLabel = label;
  }

  CACHE.set(doc, labels);
  return labels;
}

/**
 * True when this `Link` node is a link a reader would recognise as one, and so
 * the only case where its brackets may be hidden.
 *
 * Three shapes qualify, and one does not:
 *
 * - `[text](url)` — an inline link. Recognised by the `(` mark rather than by
 *   a `URL` child, because `Cmd+K` inserts `[text]()` and opens the inspector
 *   for the user to type into: that has no `URL` node yet and must still
 *   render, or the link would flicker back to raw source mid-edit.
 * - `[text][label]` — a full reference. Valid when `label` is defined.
 * - `[text][]` and `[text]` — collapsed and shortcut references. Valid when
 *   `text` itself is defined as a label.
 * - `[anything else]` — not a link. `[1]`, `[x]` in prose, `dict["k"]`, and
 *   every bracket pair inside a pasted JSON array.
 */
export function isRenderedLink(doc: Text, node: SyntaxNode): boolean {
  const marks = node.getChildren('LinkMark');
  if (marks.some((m) => doc.sliceString(m.from, m.to) === '(')) return true;

  const open = marks.find((m) => m.from === node.from);
  // Mirrors decorateLink's own choice of closing mark for the no-URL case.
  const close = marks.find((m) => m.from > node.from);
  if (!open || !close) return false;

  const labelNode = node.getChild('LinkLabel');
  // `[text][]` carries an empty LinkLabel; CommonMark says use the text.
  let label = labelNode ? doc.sliceString(labelNode.from + 1, labelNode.to - 1) : '';
  if (!label.trim()) label = doc.sliceString(open.to, close.from);

  const normalized = normalizeLinkLabel(label);
  if (!normalized) return false;
  return linkReferenceLabels(doc).has(normalized);
}
