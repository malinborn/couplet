import { syntaxTree } from '@codemirror/language';
import type { EditorState, TransactionSpec } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { linkQueryAt } from '../links/link-query';
import { linkDestinationNode } from '../preview/link-refs';

/**
 * Element inspector — Phase 7 of live-render.
 *
 * Under the `'never'` reveal policy, markdown markers stay hidden and their
 * ranges become atomic (Phase 2), so a link's URL and a fenced code block's
 * language are unreachable by caret. The inspector panel (`inspector.ts`)
 * is the escape hatch; this module is its pure, view-free logic.
 *
 * Note on the checkbox/Link collision flagged during planning: with this
 * project's parser config (`markdownLanguage` base, which already bundles
 * GFM — see `@codemirror/lang-markdown`), `- [x] done` parses as a `Task`
 * node with a `TaskMarker`, NOT as a `Link`. Verified empirically against
 * the exact config in `setup.ts` (see report). So `detectInspectorTarget`
 * needs no special-case exclusion — walking up from a position inside
 * `[x]`/`[ ]` never passes through a `Link` node at all.
 */

export interface Range {
  from: number;
  to: number;
}

export interface LinkTarget {
  kind: 'link';
  from: number;
  to: number;
  text: Range;
  url: Range;
}

export interface FenceTarget {
  kind: 'fence';
  from: number;
  to: number;
  lang: Range;
}

export type InspectorTarget = LinkTarget | FenceTarget;

/** Walk from `node` up through its ancestors looking for a node named `name`. */
function findEnclosing(node: SyntaxNode, name: string): SyntaxNode | null {
  let n: SyntaxNode | null = node;
  while (n) {
    if (n.name === name) return n;
    n = n.parent;
  }
  return null;
}

/**
 * Resolve the innermost node containing `pos` from both sides of the
 * position. A single `resolveInner(pos)` misses one of the two boundary
 * positions of a node (e.g. right after a link's closing `)`, or right
 * before its opening `[`) — trying both sides is what makes boundary
 * positions detect correctly.
 */
function findEnclosingAtPos(state: EditorState, pos: number, name: string): SyntaxNode | null {
  const tree = syntaxTree(state);
  const after = findEnclosing(tree.resolveInner(pos, 1), name);
  if (after) return after;
  return findEnclosing(tree.resolveInner(pos, -1), name);
}

function linkTargetFrom(state: EditorState, node: SyntaxNode): LinkTarget | null {
  const marks = node.getChildren('LinkMark');
  if (marks.length < 2) return null; // malformed — shouldn't happen for a Link node

  const openBracket = marks[0];
  const closeBracket = marks[1];
  // Only an inline link has a URL to edit: `(` right after the text's `]`.
  // `see [1] here`, `[[x]]` and `[a][ref]` are Link nodes too, and for them
  // the last mark is a `]` — a URL range from it would run backwards and
  // `setLinkUrl` would throw `RangeError: Invalid change range`.
  const openParen = marks[2];
  const inline =
    openParen !== undefined &&
    openParen.from === closeBracket.to &&
    state.sliceDoc(openParen.from, openParen.to) === '(';
  if (!inline) return null;
  // The last LinkMark ends the node (`)`), whether or not a title is present.
  const closeParen = marks[marks.length - 1];

  const urlNode = linkDestinationNode(node);
  const url: Range = urlNode
    ? { from: urlNode.from, to: urlNode.to }
    : { from: closeBracket.to + 1, to: closeParen.from };

  return {
    kind: 'link',
    from: node.from,
    to: node.to,
    text: { from: openBracket.to, to: closeBracket.from },
    url,
  };
}

function fenceTargetFrom(node: SyntaxNode): FenceTarget {
  const openFence = node.getChild('CodeMark');
  const info = node.getChild('CodeInfo');
  const lang: Range = info
    ? { from: info.from, to: info.to }
    : { from: openFence ? openFence.to : node.from, to: openFence ? openFence.to : node.from };

  return {
    kind: 'fence',
    from: node.from,
    to: node.to,
    lang,
  };
}

/**
 * Detect the inspectable element (link or fenced code) enclosing `pos`, or
 * `null` if there isn't one. Mermaid is deliberately not covered here —
 * its reveal policy stays `'on-cursor'`, so its source is reachable exactly
 * as in live-preview.
 */
export function detectInspectorTarget(state: EditorState, pos: number): InspectorTarget | null {
  // Lezer reads `[[query]]` as a Link (a shortcut reference). While the
  // caret is in one the `[[` picker owns it; a URL panel would cover the
  // popup (file-links D5).
  const link = linkQueryAt(state, pos) ? null : findEnclosingAtPos(state, pos, 'Link');
  if (link) {
    const target = linkTargetFrom(state, link);
    if (target) return target;
  }

  const fence = findEnclosingAtPos(state, pos, 'FencedCode');
  if (fence) {
    return fenceTargetFrom(fence);
  }

  return null;
}

/** Replace a link's URL, including the empty-URL case (`[text]()`). */
export function setLinkUrl(state: EditorState, target: LinkTarget, url: string): TransactionSpec {
  return {
    changes: { from: target.url.from, to: target.url.to, insert: url },
  };
}

/** Unwrap `[text](url)` down to bare `text`. */
export function removeLink(state: EditorState, target: LinkTarget): TransactionSpec {
  const text = state.doc.sliceString(target.text.from, target.text.to);
  return {
    changes: { from: target.from, to: target.to, insert: text },
  };
}

/**
 * Set, replace, or clear a fenced code block's info string (language).
 * Passing `''` removes it entirely — the info string occupies zero width
 * when absent, so there's nothing left over to clean up.
 */
export function setFenceLang(state: EditorState, target: FenceTarget, lang: string): TransactionSpec {
  return {
    changes: { from: target.lang.from, to: target.lang.to, insert: lang.trim() },
  };
}
