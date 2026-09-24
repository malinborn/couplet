import { describe, it, expect } from 'vitest';
import { filterEntries, highlight, hitSnippet, indexText, matchEntry, plainLine } from './drawer-filter';

describe('plainLine', () => {
  it('StripsMarkdownMarkers', () => {
    expect(plainLine('## Heading')).toBe('Heading');
    expect(plainLine('- [x] done **bold**')).toBe('done bold');
    expect(plainLine('> quote `code`')).toBe('quote code');
    expect(plainLine('1. item *em*')).toBe('item em');
    expect(plainLine('* star ~~gone~~')).toBe('star gone');
    expect(plainLine('see [the docs](https://x.y) now')).toBe('see the docs now');
    expect(plainLine('   ')).toBe('');
  });
});

describe('indexText', () => {
  it('KeepsNonEmptyPlainLines_SkippingFenceMarkers', () => {
    const index = indexText('# Title\n\n```js\nconst X = 1;\n```\nText');
    expect(index.lines).toEqual(['Title', 'const X = 1;', 'Text']);
    expect(index.lower).toEqual(['title', 'const x = 1;', 'text']);
  });

  it('LeavesCodeInsideAFenceAsWritten', () => {
    // A `#` comment is not a heading and `a * b` is not emphasis inside a fence.
    const index = indexText('```sh\n# install deps\nexpr 2 * 3\n```\n# Heading');
    expect(index.lines).toEqual(['# install deps', 'expr 2 * 3', 'Heading']);
  });

  it('HandlesWindowsLineEndings', () => {
    const index = indexText('# Title\r\n```\r\ncode\r\n```\r\nText\r\n');
    expect(index.lines).toEqual(['Title', 'code', 'Text']);
  });
});

describe('matchEntry / filterEntries', () => {
  const entries = [
    { id: '1', name: 'deploy-plan.md', index: indexText('# План\nПроверить VPN на edge-2') },
    { id: '2', name: 'vpn-notes.md', index: null },
    { id: '3', name: 'xray-vpn.md', index: indexText('') },
    { id: '4', name: 'README.md', index: indexText('nothing here') },
  ];

  it('RanksNamePrefix_ThenNameSubstring_ThenText', () => {
    expect(filterEntries(entries, 'VPN')).toEqual([
      { id: '2', match: { rank: 0 } },
      { id: '3', match: { rank: 1 } },
      { id: '1', match: { rank: 2, line: 'Проверить VPN на edge-2' } },
    ]);
  });

  it('KeepsTheCurrentOrderWithinARank', () => {
    const same = [
      { id: 'a', name: 'b-note.md', index: null },
      { id: 'b', name: 'a-note.md', index: null },
    ];
    expect(filterEntries(same, 'note').map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('AnEntryWhoseTextIsNotLoadedMatchesByNameOnly', () => {
    expect(matchEntry({ id: 'x', name: 'a.md', index: null }, 'edge')).toBeNull();
  });

  it('AnEmptyQueryMatchesNothing', () => {
    expect(filterEntries(entries, '')).toEqual([]);
  });

  it('FoldsCyrillicCase_InNamesAndText', () => {
    const ru = [
      { id: 'a', name: 'Заметки.md', index: indexText('# Итоги\nОбсудили ПЛАН релиза') },
      { id: 'b', name: 'план-Q3.md', index: null },
      { id: 'c', name: 'Мой План.md', index: null },
    ];
    expect(filterEntries(ru, 'ПЛАН')).toEqual([
      { id: 'b', match: { rank: 0 } },
      { id: 'c', match: { rank: 1 } },
      { id: 'a', match: { rank: 2, line: 'Обсудили ПЛАН релиза' } },
    ]);
    expect(matchEntry(ru[0], 'заМЕТ')).toEqual({ rank: 0 });
  });

  it('DoesNotFoldYoToYe', () => {
    // Same as the mockup: case is folded, letters are not.
    expect(matchEntry({ id: 'x', name: 'ёлка.md', index: null }, 'елка')).toBeNull();
    expect(matchEntry({ id: 'x', name: 'Ёлка.md', index: null }, 'ёл')).toEqual({ rank: 0 });
  });

  it('ReportsTheFirstMatchingLineAsWritten', () => {
    const index = indexText('first vpn line\nsecond VPN line');
    expect(matchEntry({ id: 'x', name: 'a.md', index }, 'Vpn')).toEqual({ rank: 2, line: 'first vpn line' });
  });
});

describe('highlight', () => {
  it('MarksEveryOccurrence_CaseInsensitively', () => {
    expect(highlight('Deploy plan, deploy', 'deploy')).toEqual([
      { text: 'Deploy', hit: true },
      { text: ' plan, ', hit: false },
      { text: 'deploy', hit: true },
    ]);
  });

  it('MarksCyrillic_KeepingTheOriginalCase', () => {
    expect(highlight('Проверить ВПН на впн-шлюзе', 'впн')).toEqual([
      { text: 'Проверить ', hit: false },
      { text: 'ВПН', hit: true },
      { text: ' на ', hit: false },
      { text: 'впн', hit: true },
      { text: '-шлюзе', hit: false },
    ]);
  });

  it('WithoutAHitIsOnePlainSegment', () => {
    expect(highlight('abc', '')).toEqual([{ text: 'abc', hit: false }]);
    expect(highlight('abc', 'x')).toEqual([{ text: 'abc', hit: false }]);
  });

  it('GivesUpWhenLowercasingChangesTheLength', () => {
    // 'İ'.toLowerCase() is two code units: offsets would point at the wrong letters.
    expect(highlight('İstanbul', 'stan')).toEqual([{ text: 'İstanbul', hit: false }]);
  });
});

describe('hitSnippet', () => {
  it('KeepsAShortLine', () => {
    expect(hitSnippet('find the needle here', 'needle')).toBe('find the needle here');
  });

  it('CutsALongLineSoTheHitStaysInView', () => {
    const line = `${'x'.repeat(50)}needle tail`;
    expect(hitSnippet(line, 'NEEDLE')).toBe(`…${'x'.repeat(24)}needle tail`);
  });

  it('NeverStartsTheCutInsideASurrogatePair', () => {
    // The hit is at 46, so the naive cut (46 - 24 = 22) lands on the second
    // half of the ninth emoji.
    const line = `${'x'.repeat(5)}${'😀'.repeat(20)} needle`;
    const out = hitSnippet(line, 'needle');
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('needle')).toBe(true);
    expect(/^…[\uDC00-\uDFFF]/.test(out)).toBe(false);
  });
});
