/**
 * The inline-markdown tokenizer used to render table cells.
 *
 * It lives in its own module for one reason: both `tables.ts` (which builds the
 * DOM from these tokens) and `live-render/cell-anchor.ts` (which maps between
 * the rendered characters and the source they came from) need it, and with the
 * function in `tables.ts` the two files would import each other in a cycle. The
 * mapping is what lets the highlight of a comment anchored inside a cell be
 * drawn on the text rather than on the hidden source line (#62).
 */

export type InlineToken =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'boldItalic'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'strike'; value: string }
  | { type: 'link'; text: string; url: string };

/**
 * Parse a cell's text into inline markdown tokens.
 *
 * Supported: code, bold+italic, bold, italic, strikethrough, links `[text](url)`.
 * Order matters — longer patterns are matched first to avoid emphasis swallowing link
 * brackets. Unmatched text becomes `text` tokens.
 */
export function parseInlineMarkdown(text: string): InlineToken[] {
  if (!text) return [];

  // Order: code | link | ***bi*** | **b** | *i* | ~~s~~. Link before emphasis so the
  // square brackets don't get treated as italic-eligible text.
  const inlineRegex = /(`+)(.*?)\1|\[([^\]\n]+)\]\(([^)\s]+)\)|(\*\*\*|___)(.*?)\5|(\*\*|__)(.*?)\7|(\*|_)(.*?)\9|(~~)(.*?)\11/g;

  const tokens: InlineToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }

    if (match[1] !== undefined) {
      tokens.push({ type: 'code', value: match[2] });
    } else if (match[3] !== undefined) {
      tokens.push({ type: 'link', text: match[3], url: match[4] });
    } else if (match[5] !== undefined) {
      tokens.push({ type: 'boldItalic', value: match[6] });
    } else if (match[7] !== undefined) {
      tokens.push({ type: 'bold', value: match[8] });
    } else if (match[9] !== undefined) {
      tokens.push({ type: 'italic', value: match[10] });
    } else if (match[11] !== undefined) {
      tokens.push({ type: 'strike', value: match[12] });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    tokens.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return tokens;
}
