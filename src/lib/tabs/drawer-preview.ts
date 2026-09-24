/**
 * The 2–3 lines of text a drawer card shows (spec §6), as data rather than
 * HTML: a file's content is untrusted text, and the card renders these with
 * Svelte, never with `{@html}`.
 */

export interface InlineSeg {
  text: string;
  code?: boolean;
  bold?: boolean;
  italic?: boolean;
}

export type PreviewKind = 'heading' | 'task' | 'bullet' | 'quote' | 'code' | 'text';

export interface PreviewLine {
  kind: PreviewKind;
  /** Tasks only: checked. */
  done?: boolean;
  segs: InlineSeg[];
}

const INLINE = /\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\([^)]*\)/g;

/** `code` first (its content is literal), then **bold**, *italic*, [text](url) → text. */
export function inlineSegments(s: string): InlineSeg[] {
  const out: InlineSeg[] = [];
  for (const part of s.split(/(`[^`]+`)/g)) {
    if (!part) continue;
    if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) {
      out.push({ text: part.slice(1, -1), code: true });
      continue;
    }
    let last = 0;
    for (const m of part.matchAll(INLINE)) {
      const at = m.index ?? 0;
      if (at > last) out.push({ text: part.slice(last, at) });
      if (m[1] !== undefined) out.push({ text: m[1], bold: true });
      else if (m[2] !== undefined) out.push({ text: m[2], italic: true });
      else out.push({ text: m[3] });
      last = at + m[0].length;
    }
    if (last < part.length) out.push({ text: part.slice(last) });
  }
  return out;
}

/** The first `max` non-empty lines of `md`, classified. Enough for an expanded card. */
export function previewLines(md: string, max = 12): PreviewLine[] {
  const out: PreviewLine[] = [];
  let inCode = false;
  for (const line of md.split(/\r?\n/)) {
    if (out.length >= max) break;
    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (!line.trim()) continue;
    if (inCode) {
      out.push({ kind: 'code', segs: [{ text: line, code: true }] });
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^#{1,6}\s+(.*)/.exec(line))) out.push({ kind: 'heading', segs: [{ text: m[1] }] });
    else if ((m = /^\s*[-*+] \[([ xX])\] (.*)/.exec(line)))
      out.push({ kind: 'task', done: m[1] !== ' ', segs: inlineSegments(m[2]) });
    else if ((m = /^\s*(?:[-*+]|\d+\.) (.*)/.exec(line))) out.push({ kind: 'bullet', segs: inlineSegments(m[1]) });
    else if ((m = /^>\s?(.*)/.exec(line))) out.push({ kind: 'quote', segs: inlineSegments(m[1]) });
    else out.push({ kind: 'text', segs: inlineSegments(line) });
  }
  return out;
}
