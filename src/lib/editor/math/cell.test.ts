import { describe, it, expect } from 'vitest';
import { computeCell } from './cell';

describe('computeCell', () => {
  it.each([
    ['338 * 1.3 =', '439.4'],
    ['1 200 * 3 =', '3 600'],
    ['1,5 * 3 =', '4,5'],
    ['1200 + 10% =', '1320'],
    ['3 600 + 439,4 =', '4 039,4'],
    ['2 × 3 =', '6'],
    ['(1 + 2) * 3=', '9'],
    ['338 * 1.3 =   ', '439.4'],
    ['  338 * 1.3 =', '439.4'],
    ['338 * 1.3 = ', '439.4'],
    ['1 200 * 3 =', '3 600'],
  ])('%j → %s', (text, answer) => {
    expect(computeCell(text)?.answer).toBe(answer);
  });

  it('gives the trimmed cell text as the expression for the tooltip', () => {
    expect(computeCell('  338 * 1.3 =  ')).toEqual({ answer: '439.4', expression: '338 * 1.3 =' });
  });

  // A cell has no list syntax, so a leading `- ` is a unary minus, not a bullet.
  it('reads a leading "- " as a unary minus', () => {
    expect(computeCell('- 5 + 3 =')?.answer).toBe('-2');
  });

  it.each([
    ['prose before the expression', 'Итого 5 + 3 ='],
    ['no "="', '5 + 3'],
    ['an answer already written', '5 + 3 = 8'],
    ['no operator', '5 ='],
    ['equality', '5 =='],
    ['comparison >=', '5 >='],
    ['comparison <=', '5 + 1 <='],
    ['comparison !=', '5 + 1 !='],
    ['division by zero', '1 / 0 ='],
    ['leading "=" (spreadsheet formula)', '=5+3'],
    ['leading "=" with a trailing one', '=5+3 ='],
    ['empty', ''],
    ['only "="', '='],
    ['spaces only', '   '],
    ['inline markdown', '**5 + 3** ='],
    ['letters', '1 + constructor ='],
    ['an escaped pipe', '5 \\| 3 ='],
  ])('refuses %s', (_label, text) => {
    expect(computeCell(text)).toBeNull();
  });

  it('refuses an expression over the length limit', () => {
    expect(computeCell('1+'.repeat(150) + '1 =')).toBeNull();
  });
});
