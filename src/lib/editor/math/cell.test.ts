import { describe, it, expect } from 'vitest';
import { cellHint, verifiedCell } from './cell';

describe('verifiedCell', () => {
  it.each([
    ['338 * 1.3 = 439.4', '439.4'],
    ['1 200 * 3 = 3 600', '3 600'],
    ['1 200 * 3 = 3600', '3600'],
    ['1 200 * 3 = 3 600', '3 600'],
    ['1,5 * 3 = 4,5', '4,5'],
    // Values are compared, not strings: the answer's own style is the human's.
    ['1,5 * 3 = 4.5', '4.5'],
    ['338 * 1.3 = 439.40', '439.40'],
    ['3 600 + 439,4 = 4 039,4', '4 039,4'],
    ['1200 + 10% = 1320', '1320'],
    ['0.1 + 0.2 = 0.3', '0.3'],
    ['10 / 3 = 3.333333333', '3.333333333'],
    ['1234567890123 + 1 = 1234567890124', '1234567890124'],
    ['2 - 4 = -2', '-2'],
    // A cell has no list syntax: a leading `- ` is a unary minus.
    ['- 5 + 3 = -2', '-2'],
    ['338 * 1.3=439.4', '439.4'],
    ['  338 * 1.3 =   439.4  ', '439.4'],
  ])('%j shows %j', (text, answer) => {
    expect(verifiedCell(text)?.answer).toBe(answer);
  });

  it('gives the whole trimmed text as the title', () => {
    expect(verifiedCell('  338 * 1.3 = 439.4 ')).toEqual({
      answer: '439.4',
      title: '338 * 1.3 = 439.4',
    });
  });

  it.each([
    ['a stale answer', '338 * 1.3 = 500'],
    ['an answer rounded by hand', '10 / 3 = 3.33'],
    ['an answer off by a little', '0.1 + 0.2 = 0.30000001'],
    ['no answer', '338 * 1.3 ='],
    ['no answer, trailing spaces', '338 * 1.3 =   '],
    ['no "="', '5 + 3'],
    ['prose before the expression', 'Итого 5 + 3 = 8'],
    ['prose after the answer', '5 + 3 = 8 руб'],
    ['two answers', '5 + 3 = 8 = 8'],
    ['equality', '5 + 3 == 8'],
    ['comparison >=', '5 + 3 >= 8'],
    ['comparison <=', '5 + 3 <= 8'],
    ['comparison !=', '5 + 3 != 8'],
    ['no operator', '5 = 5'],
    ['division by zero', '1 / 0 = 0'],
    ['leading "=" (spreadsheet formula)', '=5+3'],
    ['a space after the minus', '2 - 4 = - 2'],
    ['a plus sign on the answer', '2 + 2 = +4'],
    ['an expression as the answer', '2 + 2 = 2 + 2'],
    ['inline markdown', '**5 + 3** = 8'],
    ['letters', '1 + constructor = 1'],
    ['empty', ''],
    ['only "="', '='],
  ])('refuses %s', (_label, text) => {
    expect(verifiedCell(text)).toBeNull();
  });

  it('refuses an expression over the length limit', () => {
    expect(verifiedCell('1+'.repeat(150) + '1 = 151')).toBeNull();
  });
});

describe('cellHint', () => {
  it.each([
    ['338 * 1.3 =', '439.4'],
    ['338 * 1.3 =   ', '439.4'],
    ['1 200 * 3 =', '3 600'],
    ['1,5 * 3 =', '4,5'],
    ['1200 + 10% =', '1320'],
    ['- 5 + 3 =', '-2'],
    ['  2 + 2 =', '4'],
  ])('%j offers %s', (text, answer) => {
    expect(cellHint(text)).toBe(answer);
  });

  it.each([
    ['an answer already written', '338 * 1.3 = 439.4'],
    ['prose before the expression', 'Итого 5 + 3 ='],
    ['no "="', '5 + 3'],
    ['no operator', '5 ='],
    ['equality', '5 =='],
    ['comparison >=', '5 >='],
    ['division by zero', '1 / 0 ='],
    ['leading "="', '=5+3'],
    ['empty', ''],
    ['a line break in the cell', '2 +\n2 ='],
  ])('refuses %s', (_label, text) => {
    expect(cellHint(text)).toBeNull();
  });

  it('refuses an expression over the length limit', () => {
    expect(cellHint('1+'.repeat(150) + '1 =')).toBeNull();
  });
});
