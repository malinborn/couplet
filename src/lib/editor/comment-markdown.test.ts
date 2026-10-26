// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderCommentMarkdown, safeHref, COMMENT_MD_CLASS } from './comment-markdown';

function render(text: string, openUrl: (url: string) => void = () => {}): HTMLElement {
  return renderCommentMarkdown(text, document, openUrl);
}

/** Tag names of the root's element children. */
function tags(root: Element): string[] {
  return [...root.children].map((c) => c.tagName.toLowerCase());
}

describe('renderCommentMarkdown — structure', () => {
  it('returns a fresh root with the markdown class', () => {
    const root = render('hi');
    expect(root.className).toBe(COMMENT_MD_CLASS);
    expect(tags(root)).toEqual(['p']);
    expect(root.textContent).toBe('hi');
  });

  it('splits paragraphs on blank lines', () => {
    const root = render('one\n\ntwo');
    expect(tags(root)).toEqual(['p', 'p']);
    expect(root.children[1].textContent).toBe('two');
  });

  it('renders a single line break inside a paragraph as <br> — chat text is written that way', () => {
    const p = render('line one\nline two').children[0];
    expect(p.innerHTML).toBe('line one<br>line two');
  });

  it('renders hard breaks (two spaces, backslash) as <br> too', () => {
    const p = render('a  \nb\\\nc').children[0];
    expect(p.querySelectorAll('br')).toHaveLength(2);
    expect(p.textContent).toBe('abc');
  });

  it('renders emphasis, strong, strikethrough and inline code', () => {
    const p = render('*em* **strong** ~~gone~~ `x < y`').children[0];
    expect(p.querySelector('em')?.textContent).toBe('em');
    expect(p.querySelector('strong')?.textContent).toBe('strong');
    expect(p.querySelector('del')?.textContent).toBe('gone');
    expect(p.querySelector('code')?.textContent).toBe('x < y');
    expect(p.textContent).toBe('em strong gone x < y');
  });

  it('nests inline marks', () => {
    const p = render('**bold *and italic***').children[0];
    expect(p.querySelector('strong em')?.textContent).toBe('and italic');
  });

  it('renders ATX and setext headings small (h4–h6), without their marks', () => {
    const root = render('# Title\n\n### Sub #\n\nSetext\n---');
    expect(tags(root)).toEqual(['h4', 'h5', 'h4']);
    expect(root.children[0].textContent).toBe('Title');
    expect(root.children[1].textContent).toBe('Sub');
    expect(root.children[2].textContent).toBe('Setext');
  });

  it('renders fenced code as <pre><code> with its text verbatim', () => {
    const root = render('```js\nconst a = 1;\n  if (a) {}\n```');
    expect(tags(root)).toEqual(['pre']);
    expect(root.querySelector('pre > code')?.textContent).toBe('const a = 1;\n  if (a) {}');
  });

  it('keeps blank lines inside fenced code', () => {
    expect(render('```\na\n\nb\n```').querySelector('code')?.textContent).toBe('a\n\nb');
  });

  it('renders indented code without its indentation', () => {
    expect(render('    one\n    two').querySelector('pre code')?.textContent).toBe('one\ntwo');
  });

  it('strips a quote\'s markers from code inside it', () => {
    expect(render('> ```\n> a\n>\n> b\n> ```').querySelector('blockquote pre code')?.textContent).toBe(
      'a\n\nb'
    );
  });

  it('renders bullet and ordered lists with nesting', () => {
    const root = render('- a\n  - b\n- c\n\n3. x\n4. y');
    expect(tags(root)).toEqual(['ul', 'ol']);
    const ul = root.children[0];
    expect(ul.querySelectorAll(':scope > li')).toHaveLength(2);
    expect(ul.querySelector('li ul li')?.textContent).toBe('b');
    expect(root.children[1].getAttribute('start')).toBe('3');
  });

  it('renders task markers as static glyphs, never inputs', () => {
    const root = render('- [x] done\n- [ ] todo');
    expect(root.querySelector('input')).toBeNull();
    const items = root.querySelectorAll('li');
    expect(items[0].textContent).toBe('☑ done');
    expect(items[1].textContent).toBe('☐ todo');
  });

  it('renders blockquotes, lazy continuation included, without the > marks', () => {
    const quote = render('> one\n> two\nthree').querySelector('blockquote');
    expect(quote?.textContent).toBe('onetwothree');
    expect(quote?.querySelectorAll('br')).toHaveLength(2);
  });

  it('renders a horizontal rule', () => {
    expect(tags(render('a\n\n***\n\nb'))).toEqual(['p', 'hr', 'p']);
  });

  it('renders a GFM table with header, body, alignment and empty cells', () => {
    const table = render('| a | b |\n|:--|--:|\n| 1 | **2** |\n| 3 |  |').querySelector('table')!;
    expect([...table.querySelectorAll('thead th')].map((c) => c.textContent)).toEqual(['a', 'b']);
    const rows = table.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('td strong')?.textContent).toBe('2');
    expect(rows[1].querySelectorAll('td')).toHaveLength(2);
    expect(table.querySelector('th')?.getAttribute('align')).toBe('left');
    expect(table.querySelectorAll('th')[1].getAttribute('align')).toBe('right');
  });

  it('decodes entities and escapes', () => {
    expect(render('a &amp; b &#x41; \\*not em\\*').textContent).toBe('a & b A *not em*');
  });
});

describe('renderCommentMarkdown — links', () => {
  it('renders an inline http link as an <a> opened outside the app', () => {
    const openUrl = vi.fn();
    const a = render('see [the docs](https://example.com/x "Docs")', openUrl).querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/x');
    expect(a.textContent).toBe('the docs');
    expect(a.title).toBe('Docs');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(openUrl).toHaveBeenCalledWith('https://example.com/x');
  });

  it('links autolinks, bare URLs and mail addresses', () => {
    const root = render('<https://a.example> https://b.example www.c.example <me@d.example>');
    expect([...root.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      'https://a.example',
      'https://b.example',
      'http://www.c.example',
      'mailto:me@d.example',
    ]);
  });

  it('never turns a javascript: link into an <a> with that href', () => {
    const root = render('[click](javascript:alert(1)) <javascript:alert(2)>');
    for (const a of root.querySelectorAll('a')) {
      expect(a.getAttribute('href') ?? '').not.toMatch(/javascript/i);
    }
    expect(root.textContent).toContain('[click](javascript:alert(1))');
  });

  it('keeps relative and file links as text', () => {
    const root = render('[x](./x.md) [y](file:///etc/passwd)');
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toBe('[x](./x.md) [y](file:///etc/passwd)');
  });

  it('safeHref allows only http(s) and mailto', () => {
    expect(safeHref('https://x.y')).toBe('https://x.y');
    expect(safeHref('HTTP://x.y')).toBe('HTTP://x.y');
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref(' JavaScript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('vbscript:x')).toBeNull();
    expect(safeHref('/abs/path')).toBeNull();
    expect(safeHref('https://x.y/"onmouseover=')).toBeNull();
  });
});

describe('renderCommentMarkdown — untrusted text stays text', () => {
  it('shows a <script> tag as text and creates no script element', () => {
    const root = render('<script>alert(1)</script>');
    expect(root.querySelector('script')).toBeNull();
    expect(root.textContent).toContain('<script>alert(1)</script>');
  });

  it('shows inline HTML with handlers as text', () => {
    const root = render('look <img src=x onerror="alert(1)"> here');
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toBe('look <img src=x onerror="alert(1)"> here');
    for (const el of root.querySelectorAll('*')) {
      expect(el.getAttributeNames().some((n) => n.startsWith('on'))).toBe(false);
    }
  });

  it('shows an image as its source, never as <img>', () => {
    const root = render('![alt](https://x.example/p.png)');
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toBe('![alt](https://x.example/p.png)');
  });

  it('keeps unclosed or broken markdown as its text', () => {
    expect(render('**not closed').textContent).toBe('**not closed');
    expect(render('```\nunterminated code').querySelector('code')?.textContent).toBe('unterminated code');
    expect(render('[ref][missing]').textContent).toBe('[ref][missing]');
    expect(render('| just | a pipe').textContent).toBe('| just | a pipe');
  });

  it('keeps a link reference definition and an HTML block as text', () => {
    expect(render('[a]: https://x.example').textContent).toBe('[a]: https://x.example');
    expect(render('<div>\nraw\n</div>').textContent).toBe('<div>raw</div>');
  });

  it('renders an empty message as an empty root', () => {
    expect(render('').children).toHaveLength(0);
  });
});
