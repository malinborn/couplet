import { parseInlineMarkdown } from '../preview/inline-tokens';

/**
 * Turning a selection made inside a rendered table cell back into a range in
 * the markdown source.
 *
 * A table row is drawn by one widget, and each cell's text goes through
 * `parseInlineMarkdown` — so `**and**` occupies eight characters in the file
 * and three on screen. Offsets in the cell's DOM therefore cannot be added to
 * the cell's document position; they have to be mapped through the same token
 * split that produced the DOM.
 *
 * ## What a comment on cell text anchors to
 *
 * The **source** of the selected span, not the visible text. Two reasons, and
 * the first is decisive:
 *
 * - A comment survives reloads by being found again — `anchorPosition` searches
 *   the document for its quote, disambiguated by the `pre=`/`suf=` context
 *   stored with it (#37). A quote that reads `and sweet` while the file says
 *   `**and** sweet` is not in the document at all, so it would come back
 *   orphaned on the very next open.
 * - It is also what live-render already does everywhere else: selecting
 *   rendered bold prose and commenting stores the markers, because the quote is
 *   sliced out of the document.
 *
 * Formatted spans are atomic here: a selection touching any part of `**and**`
 * anchors to all of `**and**`. Half a marker pair is not a thing you can look
 * for later, and "comment on the emphasised word" is the only reading of a
 * partial selection that stays true after a re-anchor.
 */

/** One token's footprint, in both the visible text and the cell's source. */
export interface CellSpan {
  /** Offsets into the cell's rendered text. */
  visFrom: number;
  visTo: number;
  /** Offsets into the cell's source text (`CellInfo.text`). */
  srcFrom: number;
  srcTo: number;
  /**
   * Where the token's *visible* characters start in the source — i.e.
   * `srcFrom` plus the opening marker.
   *
   * The anchor mapping never needs it (it takes formatted tokens whole), but a
   * caret does: clicking between the "i" and the "r" of a bold word has to land
   * between them in the source too, not at the `**` in front of it.
   */
  srcTextFrom: number;
  /**
   * Whole-token anchoring: true for anything with markers, so a selection that
   * clips it still produces a quote the re-anchor search can find.
   */
  atomic: boolean;
}

/** Source characters a token spends on its markers, before and after the text. */
function markerWidths(
  token: ReturnType<typeof parseInlineMarkdown>[number],
  source: string,
  at: number
): { lead: number; trail: number; visible: string } | null {
  switch (token.type) {
    case 'text':
      return { lead: 0, trail: 0, visible: token.value };
    case 'code': {
      // A code span's fence is however many backticks it opened with.
      let ticks = 0;
      while (source[at + ticks] === '`') ticks += 1;
      if (ticks === 0) return null;
      return { lead: ticks, trail: ticks, visible: token.value };
    }
    case 'boldItalic':
      return { lead: 3, trail: 3, visible: token.value };
    case 'bold':
    case 'strike':
      return { lead: 2, trail: 2, visible: token.value };
    case 'italic':
      return { lead: 1, trail: 1, visible: token.value };
    case 'link':
      // `[text](url)`
      return { lead: 1, trail: 3 + token.url.length, visible: token.text };
    default:
      return null;
  }
}

/**
 * Token spans for one cell, or `null` if the text does not reconstruct.
 *
 * `parseInlineMarkdown` emits tokens that tile the whole string — every gap
 * becomes a `text` token — so each token starts where the previous one ended
 * and only its source *length* has to be derived. The reconstruction is
 * verified against the source as it goes: a marker shape this function does not
 * know about makes it give up rather than return an anchor that is quietly off
 * by a few characters.
 */
export function cellSpans(text: string): CellSpan[] | null {
  const spans: CellSpan[] = [];
  let src = 0;
  let vis = 0;

  for (const token of parseInlineMarkdown(text)) {
    const shape = markerWidths(token, text, src);
    if (!shape) return null;
    const { lead, trail, visible } = shape;
    if (text.slice(src + lead, src + lead + visible.length) !== visible) return null;
    const srcTo = src + lead + visible.length + trail;
    spans.push({
      visFrom: vis,
      visTo: vis + visible.length,
      srcFrom: src,
      srcTo,
      srcTextFrom: src + lead,
      atomic: token.type !== 'text',
    });
    src = srcTo;
    vis += visible.length;
  }

  // Every character of the cell must be accounted for, or the offsets past the
  // point of divergence are fiction.
  if (src !== text.length) return null;
  return spans;
}

/** Length of the text a cell renders on screen, per {@link cellSpans}. */
export function visibleLength(spans: CellSpan[]): number {
  return spans.length === 0 ? 0 : spans[spans.length - 1].visTo;
}

/**
 * Map a range of the cell's source to the rendered text that came from it.
 *
 * The inverse of {@link sourceRangeForVisible}, and it exists for the in-
 * document highlight of a comment (#62). A comment anchors to *source* offsets
 * — that is how it survives a reload — but a table row's source lines are
 * drawn at zero height, so a `Decoration.mark` over them is painted onto
 * nothing at all. The highlight therefore has to be placed inside the widget,
 * on the characters the reader can actually see, and this is the step that says
 * which ones those are.
 *
 * Formatted spans are atomic in this direction too: an anchor that stored
 * `**and**` highlights the whole of "and", and one that stored only a marker
 * still highlights the word rather than nothing.
 *
 * Returns `null` for an empty or out-of-range range, and for a cell whose text
 * does not reconstruct — better no highlight than one a few characters off.
 */
export function visibleRangeForSource(
  text: string,
  srcFrom: number,
  srcTo: number
): { from: number; to: number } | null {
  if (srcTo <= srcFrom) return null;
  const spans = cellSpans(text);
  if (!spans) return null;

  let from = -1;
  let to = -1;
  for (const span of spans) {
    if (span.srcTo <= srcFrom || span.srcFrom >= srcTo) continue;
    const start = span.atomic
      ? span.visFrom
      : span.visFrom + Math.max(srcFrom - span.srcFrom, 0);
    const end = span.atomic
      ? span.visTo
      : span.visFrom + Math.min(srcTo - span.srcFrom, span.visTo - span.visFrom);
    if (from < 0 || start < from) from = start;
    if (end > to) to = end;
  }

  return from < 0 || to <= from ? null : { from, to };
}

/**
 * Map a *caret* — one offset in the rendered cell text — to an offset in the
 * cell's source.
 *
 * Deliberately not the collapsed case of {@link sourceRangeForVisible}: that
 * one takes a formatted token whole, which is right for a comment quote and
 * wrong for a caret. A click between the "i" and the "r" of a bold "жирный"
 * must land between them in `**жирный**` too, so that typing there continues
 * the bold instead of landing in front of the markers (#53).
 *
 * Falls back to the end of the cell for text that does not reconstruct — a
 * caret has to go *somewhere*, and appending is the harmless answer.
 */
export function sourceOffsetForVisibleCaret(text: string, vis: number): number {
  const spans = cellSpans(text);
  if (!spans) return text.length;
  const len = visibleLength(spans);
  const at = Math.max(0, Math.min(vis, len));
  if (spans.length === 0) return 0;
  if (at >= len) return text.length;

  for (const span of spans) {
    // `<=` on the closing edge would resolve the boundary between two tokens to
    // the end of the earlier one, i.e. *after* its closing `**`. Preferring the
    // later token puts the caret before the next token's markers instead, which
    // is what both neighbours draw at that pixel.
    if (at >= span.visFrom && at < span.visTo) {
      return span.srcTextFrom + (at - span.visFrom);
    }
  }
  return text.length;
}

/**
 * Map a range of rendered cell text to a range of the cell's source.
 *
 * Returns `null` for an empty or out-of-range selection. Offsets are relative
 * to the cell in both directions: add `CellInfo.from` to reach the document.
 */
export function sourceRangeForVisible(
  text: string,
  visFrom: number,
  visTo: number
): { from: number; to: number } | null {
  if (visTo <= visFrom) return null;
  const spans = cellSpans(text);
  if (!spans) return null;
  if (visFrom < 0 || visTo > visibleLength(spans)) return null;

  let from = -1;
  let to = -1;
  for (const span of spans) {
    // Touching, not merely abutting: a selection ending exactly where a token
    // begins has not selected any of it.
    if (span.visTo <= visFrom || span.visFrom >= visTo) continue;
    const start = span.atomic
      ? span.srcFrom
      : span.srcFrom + Math.max(visFrom - span.visFrom, 0);
    const end = span.atomic
      ? span.srcTo
      : span.srcFrom + Math.min(visTo - span.visFrom, span.visTo - span.visFrom);
    if (from < 0 || start < from) from = start;
    if (end > to) to = end;
  }

  return from < 0 || to <= from ? null : { from, to };
}
