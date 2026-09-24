import { describe, it, expect } from 'vitest';
import { inlineSegments, previewLines } from './drawer-preview';

describe('inlineSegments', () => {
  it('SplitsCodeBoldItalicAndLinks', () => {
    expect(inlineSegments('a `b*c*` **d** *e* [f](http://x) g')).toEqual([
      { text: 'a ' },
      { text: 'b*c*', code: true },
      { text: ' ' },
      { text: 'd', bold: true },
      { text: ' ' },
      { text: 'e', italic: true },
      { text: ' ' },
      { text: 'f' },
      { text: ' g' },
    ]);
  });

  it('KeepsMarkupLikeTextAsPlainText', () => {
    // Previews are data: an HTML tag in a file is text, never markup.
    expect(inlineSegments('<img src=x onerror=alert(1)> **жирный**')).toEqual([
      { text: '<img src=x onerror=alert(1)> ' },
      { text: 'жирный', bold: true },
    ]);
  });
});

describe('previewLines', () => {
  it('ClassifiesLines_SkippingBlanksAndFenceMarkers', () => {
    const md = '# Title\n\n- [x] done\n- [ ] todo\n* item\n1. num\n> quote\n```\ncode line\n```\nplain **b**';
    expect(previewLines(md)).toEqual([
      { kind: 'heading', segs: [{ text: 'Title' }] },
      { kind: 'task', done: true, segs: [{ text: 'done' }] },
      { kind: 'task', done: false, segs: [{ text: 'todo' }] },
      { kind: 'bullet', segs: [{ text: 'item' }] },
      { kind: 'bullet', segs: [{ text: 'num' }] },
      { kind: 'quote', segs: [{ text: 'quote' }] },
      { kind: 'code', segs: [{ text: 'code line', code: true }] },
      { kind: 'text', segs: [{ text: 'plain ' }, { text: 'b', bold: true }] },
    ]);
  });

  it('StopsAtMax', () => {
    expect(previewLines('a\nb\nc', 2)).toHaveLength(2);
  });

  it('IsEmptyForAnEmptyFile', () => {
    expect(previewLines('')).toEqual([]);
  });

  it('HandlesWindowsLineEndings', () => {
    expect(previewLines('# Заголовок\r\n\r\nтекст\r\n')).toEqual([
      { kind: 'heading', segs: [{ text: 'Заголовок' }] },
      { kind: 'text', segs: [{ text: 'текст' }] },
    ]);
  });
});
