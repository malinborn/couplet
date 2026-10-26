import { parser as markdownParser, GFM } from '@lezer/markdown';
import { openExternalUrl } from './links/open-link';

/**
 * Markdown in a comment thread's messages, rendered to DOM.
 *
 * Agents answer in markdown — bold, lists, fenced code, links — and shown as
 * `textContent` that read as a wall of asterisks and backticks. This turns a
 * message into a small DOM tree instead.
 *
 * **The text is untrusted.** It comes from an agent, or from a file anyone can
 * edit, so the only DOM API used is `createElement` / `createTextNode` /
 * `setAttribute` with fixed names — never `innerHTML`. Raw HTML in the source
 * is shown as text, an image is shown as its source, and a link becomes an
 * `<a>` only for `http(s):` and `mailto:`; anything else (`javascript:`,
 * `file:`, a relative path) stays as the text it was written as.
 *
 * Anything the walker does not know is rendered as its source text: a
 * construct this version does not draw is better shown raw than dropped.
 *
 * The parser is the editor's own (`@lezer/markdown` with GFM: tables, task
 * lists, strikethrough, autolinks), so a message parses the way it would in a
 * document.
 */

const commentParser = markdownParser.configure(GFM);

type SyntaxNode = ReturnType<typeof commentParser.parse>['topNode'];

/** What the renderer needs from `document` — a parameter so tests can pass their own. */
export type CommentMarkdownDocument = Pick<Document, 'createElement' | 'createTextNode'>;

/** Class on the root the renderer returns. */
export const COMMENT_MD_CLASS = 'cm-ai-comment-md';

/**
 * How deep quotes and lists, and inline marks, may nest before the rest is
 * shown as its source. The walk is recursive, and a message of a few thousand
 * `>` would otherwise blow the stack — taking down not just this card but
 * every card rebuilt with it. Nothing a person writes nests this deep.
 */
export const MAX_NESTING = 24;

const CONTAINERS = new Set(['Blockquote', 'BulletList', 'OrderedList']);
const INLINE_CONTAINERS = new Set(['Emphasis', 'StrongEmphasis', 'Strikethrough', 'Link']);

/** Schemes a link may point at. Everything else renders as text. */
const SAFE_SCHEME = /^(https?:|mailto:)/i;

/**
 * The `href` for a link destination, or `null` when it must not become one.
 *
 * Exported for tests. `www.` (a GFM bare autolink) gets `http://` like GFM
 * says; a bare address (`<a@b.c>`) gets `mailto:`.
 */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (!url || /[\s<>"]/.test(url)) return null;
  let candidate = url;
  if (/^www\./i.test(url)) candidate = `http://${url}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && /^[^@/]+@[^@/]+\.[^@/]+$/.test(url)) {
    candidate = `mailto:${url}`;
  }
  if (!SAFE_SCHEME.test(candidate)) return null;
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return null;
  } catch {
    return null;
  }
  return candidate;
}

/** The handful of named entities people actually type; numeric ones are decoded too. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  copy: '©',
};

function decodeEntity(source: string): string {
  const body = source.slice(1, -1);
  if (body.startsWith('#')) {
    const hex = body[1] === 'x' || body[1] === 'X';
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (Number.isFinite(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)) {
      return String.fromCodePoint(code);
    }
    return source;
  }
  return NAMED_ENTITIES[body] ?? source;
}

function children(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) out.push(child);
  return out;
}

const MARKS = new Set([
  'EmphasisMark',
  'StrikethroughMark',
  'CodeMark',
  'LinkMark',
  'HeaderMark',
  'QuoteMark',
  'ListMark',
  'TaskMarker',
  'TableDelimiter',
]);

class Renderer {
  constructor(
    private readonly src: string,
    private readonly doc: CommentMarkdownDocument,
    private readonly openUrl: (url: string) => void
  ) {}

  private el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string
  ): HTMLElementTagNameMap[K] {
    const element = this.doc.createElement(tag);
    if (className) element.className = className;
    return element;
  }

  private text(parent: HTMLElement, value: string): void {
    if (value) parent.appendChild(this.doc.createTextNode(value));
  }

  private slice(from: number, to: number): string {
    return this.src.slice(from, to);
  }

  // --- blocks -------------------------------------------------------------

  /** Render the block children of a container (document, quote, list item). */
  blocks(node: SyntaxNode, parent: HTMLElement): void {
    let pos = node.from;
    for (const child of children(node)) {
      this.stray(pos, child.from, parent);
      pos = child.to;
      if (child.name === 'QuoteMark' || child.name === 'ListMark') continue;
      this.block(child, parent);
    }
    this.stray(pos, node.to, parent);
  }

  /** Text between blocks that no node claimed. Whitespace only, in practice —
   * but if not, it is shown rather than lost. */
  private stray(from: number, to: number, parent: HTMLElement): void {
    const value = this.slice(from, to).replace(/^[\s>]+|\s+$/g, '');
    if (!value) return;
    const p = this.el('p');
    this.text(p, value);
    parent.appendChild(p);
  }

  /** Quotes and lists open right now, around the block being rendered. */
  private depth = 0;
  /** Inline marks open right now, around the text being rendered. */
  private inlineDepth = 0;

  private block(node: SyntaxNode, parent: HTMLElement): void {
    if (!CONTAINERS.has(node.name)) return this.blockInner(node, parent);
    if (this.depth >= MAX_NESTING) return this.raw(node, parent);
    this.depth += 1;
    try {
      this.blockInner(node, parent);
    } finally {
      this.depth -= 1;
    }
  }

  /** A block shown exactly as written. */
  private raw(node: SyntaxNode, parent: HTMLElement): void {
    const p = this.el('p', 'cm-ai-comment-md-raw');
    this.lines(this.slice(node.from, node.to), p);
    parent.appendChild(p);
  }

  private blockInner(node: SyntaxNode, parent: HTMLElement): void {
    const name = node.name;
    if (name === 'Paragraph') {
      const p = this.el('p');
      this.inline(node, node.from, node.to, p);
      parent.appendChild(p);
      return;
    }
    const atx = /^ATXHeading([1-6])$/.exec(name);
    const setext = /^SetextHeading([12])$/.exec(name);
    if (atx || setext) {
      this.heading(node, Number((atx ?? setext)![1]), parent);
      return;
    }
    switch (name) {
      case 'Blockquote': {
        const quote = this.el('blockquote');
        this.blocks(node, quote);
        parent.appendChild(quote);
        return;
      }
      case 'BulletList':
      case 'OrderedList': {
        const list = this.el(name === 'BulletList' ? 'ul' : 'ol');
        if (name === 'OrderedList') {
          const mark = node.firstChild?.getChild('ListMark');
          const start = mark ? Number.parseInt(this.slice(mark.from, mark.to), 10) : 1;
          if (Number.isFinite(start) && start !== 1) list.setAttribute('start', String(start));
        }
        for (const item of children(node)) {
          if (item.name !== 'ListItem') continue;
          const li = this.el('li');
          this.blocks(item, li);
          list.appendChild(li);
        }
        parent.appendChild(list);
        return;
      }
      case 'Task': {
        const p = this.el('p', 'cm-ai-comment-md-task');
        const marker = node.getChild('TaskMarker');
        const done = marker ? /\[[xX]\]/.test(this.slice(marker.from, marker.to)) : false;
        // A glyph, not an <input>: the card is a record of what was written,
        // and a checkbox that toggles nothing would be a lie.
        const box = this.el('span', 'cm-ai-comment-md-check');
        box.setAttribute('aria-hidden', 'true');
        this.text(box, done ? '☑' : '☐');
        p.appendChild(box);
        this.text(p, ' ');
        this.inline(node, marker ? marker.to : node.from, node.to, p);
        parent.appendChild(p);
        return;
      }
      case 'FencedCode':
      case 'CodeBlock': {
        const pre = this.el('pre');
        const code = this.el('code');
        this.text(code, this.codeText(node));
        pre.appendChild(code);
        parent.appendChild(pre);
        return;
      }
      case 'HorizontalRule':
        parent.appendChild(this.el('hr'));
        return;
      case 'Table':
        parent.appendChild(this.table(node));
        return;
      default:
        // HTML blocks, link reference definitions, comments, anything new:
        // shown as written, never interpreted, never dropped.
        this.raw(node, parent);
    }
  }

  private heading(node: SyntaxNode, level: number, parent: HTMLElement): void {
    // Small on purpose — a card is not a document: every level maps onto
    // h4–h6, and the CSS keeps those close to body size.
    const tag = level <= 2 ? 'h4' : level === 3 ? 'h5' : 'h6';
    const h = this.el(tag);
    const atx = node.name.startsWith('ATX');
    let from = node.from;
    let to = node.to;
    node.getChildren('HeaderMark').forEach((mark, i) => {
      if (atx && i === 0) from = mark.to; // the opening `#`s
      else to = Math.min(to, mark.from); // closing `#`s, or a setext underline
    });
    while (to > from && /\s/.test(this.src[to - 1])) to -= 1;
    this.inline(node, from, to, h);
    parent.appendChild(h);
  }

  /**
   * The text of a code block: its `CodeText` pieces, with the line breaks of
   * whatever lies between them (a quote's `>`, a list's indentation, blank
   * lines) kept and the container markup itself dropped.
   */
  private codeText(node: SyntaxNode): string {
    let out = '';
    let last = -1;
    for (const child of children(node)) {
      if (child.name !== 'CodeText') continue;
      // Only container markup and blank lines lie between two pieces, so the
      // gap's line breaks are exactly the ones the code has there.
      if (last >= 0) out += '\n'.repeat((this.slice(last, child.from).match(/\n/g) ?? []).length);
      out += this.slice(child.from, child.to);
      last = child.to;
    }
    return out.replace(/\n$/, '');
  }

  private table(node: SyntaxNode): HTMLElement {
    const table = this.el('table');
    const rows = children(node).filter((c) => c.name === 'TableHeader' || c.name === 'TableRow');
    const delimiter = children(node).find((c) => c.name === 'TableDelimiter');
    const aligns = delimiter
      ? this.slice(delimiter.from, delimiter.to)
          .replace(/^\s*\|/, '')
          .replace(/\|\s*$/, '')
          .split('|')
          .map((cell) => {
            const c = cell.trim();
            if (c.startsWith(':') && c.endsWith(':')) return 'center';
            if (c.endsWith(':')) return 'right';
            if (c.startsWith(':')) return 'left';
            return '';
          })
      : [];
    const header = rows.find((r) => r.name === 'TableHeader');
    const width = header ? this.cells(header).length : 0;
    let body: HTMLElement | null = null;
    for (const row of rows) {
      const isHead = row.name === 'TableHeader';
      const tr = this.el('tr');
      const cells = this.cells(row);
      const count = Math.max(width, cells.length);
      for (let i = 0; i < count; i += 1) {
        const cell = this.el(isHead ? 'th' : 'td');
        if (aligns[i]) cell.setAttribute('align', aligns[i]);
        const source = cells[i];
        if (source) this.inline(source, source.from, source.to, cell);
        tr.appendChild(cell);
      }
      if (isHead) {
        const thead = this.el('thead');
        thead.appendChild(tr);
        table.appendChild(thead);
      } else {
        if (!body) {
          body = this.el('tbody');
          table.appendChild(body);
        }
        body.appendChild(tr);
      }
    }
    return table;
  }

  /** A row's cells in column order; an empty cell has no node, so it is `null`. */
  private cells(row: SyntaxNode): Array<SyntaxNode | null> {
    const out: Array<SyntaxNode | null> = [];
    let afterDelimiter = false;
    let seenAny = false;
    for (const child of children(row)) {
      if (child.name === 'TableDelimiter') {
        if (afterDelimiter && seenAny) out.push(null);
        afterDelimiter = true;
        seenAny = true;
      } else if (child.name === 'TableCell') {
        out.push(child);
        afterDelimiter = false;
        seenAny = true;
      }
    }
    return out;
  }

  // --- inline -------------------------------------------------------------

  /** Whether the next text starts a fresh visual line (its indentation goes). */
  private lineStart = true;

  /** Inline content of `node` between `from` and `to`. */
  inline(node: SyntaxNode, from: number, to: number, parent: HTMLElement): void {
    this.lineStart = true;
    this.inlineRange(node, from, to, parent);
  }

  private inlineRange(node: SyntaxNode, from: number, to: number, parent: HTMLElement): void {
    let pos = from;
    for (const child of children(node)) {
      if (child.to <= from || child.from >= to) continue;
      if (child.from > pos) this.flow(this.slice(pos, child.from), parent);
      this.inlineNode(child, parent);
      pos = Math.max(pos, child.to);
    }
    if (pos < to) this.flow(this.slice(pos, to), parent);
  }

  /**
   * Running text. A single line break inside a paragraph is a line break here
   * — chat text is written that way, and folding it into a space would run
   * two thoughts together. A continuation line's indentation (a list item's,
   * a quote's) is layout, not text, and goes.
   */
  private flow(value: string, parent: HTMLElement): void {
    const lines = value.split('\n');
    lines.forEach((line, i) => {
      let piece = line;
      if (i < lines.length - 1) piece = piece.replace(/[ \t]+$/, '');
      if (i > 0) {
        parent.appendChild(this.el('br'));
        this.lineStart = true;
      }
      if (this.lineStart) piece = piece.replace(/^[ \t]+/, '');
      if (piece) {
        this.text(parent, piece);
        this.lineStart = false;
      }
    });
  }

  /** Source text with its line breaks kept, nothing interpreted. */
  private lines(value: string, parent: HTMLElement): void {
    value.split('\n').forEach((line, i) => {
      if (i > 0) parent.appendChild(this.el('br'));
      this.text(parent, line);
    });
  }

  private wrap(tag: 'em' | 'strong' | 'del', node: SyntaxNode, parent: HTMLElement): void {
    const element = this.el(tag);
    this.inlineRange(node, node.from, node.to, element);
    parent.appendChild(element);
    this.lineStart = false;
  }

  private inlineNode(node: SyntaxNode, parent: HTMLElement): void {
    if (!INLINE_CONTAINERS.has(node.name)) return this.inlineLeaf(node, parent);
    if (this.inlineDepth >= MAX_NESTING) {
      this.flow(this.slice(node.from, node.to), parent);
      return;
    }
    this.inlineDepth += 1;
    try {
      this.inlineLeaf(node, parent);
    } finally {
      this.inlineDepth -= 1;
    }
  }

  private inlineLeaf(node: SyntaxNode, parent: HTMLElement): void {
    switch (node.name) {
      case 'Emphasis':
        return this.wrap('em', node, parent);
      case 'StrongEmphasis':
        return this.wrap('strong', node, parent);
      case 'Strikethrough':
        return this.wrap('del', node, parent);
      case 'InlineCode': {
        const marks = node.getChildren('CodeMark');
        const from = marks[0]?.to ?? node.from;
        const to = marks.length > 1 ? marks[marks.length - 1].from : node.to;
        let value = this.slice(from, to).replace(/\n/g, ' ');
        if (/^ .*[^ ].* $/.test(value)) value = value.slice(1, -1);
        const code = this.el('code');
        this.text(code, value);
        parent.appendChild(code);
        this.lineStart = false;
        return;
      }
      case 'HardBreak':
        parent.appendChild(this.el('br'));
        this.lineStart = true;
        return;
      case 'Escape':
        this.text(parent, this.slice(node.from + 1, node.to));
        this.lineStart = false;
        return;
      case 'Entity':
        this.text(parent, decodeEntity(this.slice(node.from, node.to)));
        this.lineStart = false;
        return;
      case 'Link':
        return this.link(node, parent);
      case 'Autolink': {
        const url = node.getChild('URL');
        const raw = url ? this.slice(url.from, url.to) : '';
        this.anchorOrText(raw, raw, node, parent);
        return;
      }
      case 'URL': {
        // A bare GFM autolink, straight in the text.
        const raw = this.slice(node.from, node.to);
        this.anchorOrText(raw, raw, node, parent);
        return;
      }
      default:
        if (MARKS.has(node.name)) return; // a continuation line's `>`, say
        // Images, raw HTML, anything unknown: the source, as text.
        this.flow(this.slice(node.from, node.to), parent);
    }
  }

  private link(node: SyntaxNode, parent: HTMLElement): void {
    const marks = node.getChildren('LinkMark');
    const url = node.getChild('URL');
    const open = marks[0];
    const close = marks[1];
    const href = url ? safeHref(this.slice(url.from, url.to)) : null;
    if (!open || !close || !href) {
      // `javascript:`, a relative path, a reference link: shown as written.
      this.flow(this.slice(node.from, node.to), parent);
      return;
    }
    const a = this.anchor(href);
    const title = node.getChild('LinkTitle');
    if (title) a.title = this.slice(title.from + 1, title.to - 1);
    this.inlineRange(node, open.to, close.from, a);
    if (!a.firstChild) this.text(a, href);
    parent.appendChild(a);
    this.lineStart = false;
  }

  private anchorOrText(raw: string, label: string, node: SyntaxNode, parent: HTMLElement): void {
    const href = safeHref(raw);
    if (!href) {
      this.flow(this.slice(node.from, node.to), parent);
      return;
    }
    const a = this.anchor(href);
    this.text(a, label);
    parent.appendChild(a);
    this.lineStart = false;
  }

  private anchor(href: string): HTMLAnchorElement {
    const a = this.el('a', 'cm-ai-comment-md-link');
    a.setAttribute('href', href);
    a.setAttribute('rel', 'noopener noreferrer');
    a.title = href;
    // The card's text is a nested editing host (it has to be, for selection),
    // where a click on a link does nothing by itself — and if it did, it
    // would navigate the webview. Opened outside the app, like every link.
    a.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openUrl(href);
    });
    return a;
  }
}

/**
 * Render a thread message's markdown into a fresh `<div class="cm-ai-comment-md">`.
 *
 * `openUrl` is what a click on a link does — the app's external opener by
 * default, injectable for tests.
 */
export function renderCommentMarkdown(
  text: string,
  doc: CommentMarkdownDocument = document,
  openUrl: (url: string) => void = (url) => void openExternalUrl(url)
): HTMLElement {
  const root = doc.createElement('div');
  root.className = COMMENT_MD_CLASS;
  const tree = commentParser.parse(text);
  new Renderer(text, doc, openUrl).blocks(tree.topNode, root);
  return root;
}
