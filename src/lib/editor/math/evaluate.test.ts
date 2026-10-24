import { describe, it, expect } from 'vitest';
import { evaluate, MAX_EXPRESSION_LENGTH } from './evaluate';

function valueOf(expr: string): number | undefined {
  return evaluate(expr)?.value;
}

describe('evaluate', () => {
  it.each([
    ['338 * 1.3', 439.4],
    ['2 + 3 * 4', 14],
    ['(2 + 3) * 4', 20],
    ['10 / 4', 2.5],
    ['7 - 10', -3],
    ['-(3 + 4) * 2', -14],
    ['2^3^2', 512],
    ['-2^2', -4],
    ['2^-1', 0.5],
    ['3 - -2', 5],
    ['((1))+1', 2],
  ])('%s = %d', (expr, expected) => {
    expect(valueOf(expr)).toBeCloseTo(expected, 9);
  });

  it.each([
    ['1200 + 10%', 1320],
    ['1200 - 10%', 1080],
    ['338 * 15%', 50.7],
    ['50 / 10%', 500],
    ['15%', 0.15],
    ['100 + 10% + 10%', 121],
    ['100 + -10%', 90],
  ])('percent: %s = %d', (expr, expected) => {
    expect(valueOf(expr)).toBeCloseTo(expected, 9);
  });

  it.each([
    ['6 × 7', 42],
    ['6 · 7', 42],
    ['10 ÷ 4', 2.5],
    ['10 − 3', 7],
    ['10 – 3', 7],
  ])('unicode operator: %s = %d', (expr, expected) => {
    expect(valueOf(expr)).toBeCloseTo(expected, 9);
  });

  it('reads a decimal comma and records it', () => {
    const result = evaluate('1,5 * 2');
    expect(result?.value).toBe(3);
    expect(result?.style).toEqual({ decimalComma: true, thousandsSpace: false });
  });

  it('a comma is always decimal: 1,000 is one', () => {
    expect(valueOf('1,000 + 1')).toBe(2);
  });

  it('reads thousands spaces and records them', () => {
    const result = evaluate('1 500 000 / 12');
    expect(result?.value).toBe(125000);
    expect(result?.style).toEqual({ decimalComma: false, thousandsSpace: true });
  });

  it('a space is a separator only before exactly three digits', () => {
    expect(evaluate('15 + 2')?.style.thousandsSpace).toBe(false);
    expect(valueOf('15 + 2')).toBe(17);
    expect(evaluate('1 5000 + 1')).toBeNull();
    expect(evaluate('12 34 + 1')).toBeNull();
  });

  it('mixes thousands spaces and a decimal comma', () => {
    const result = evaluate('1 500,5 * 2');
    expect(result?.value).toBe(3001);
    expect(result?.style).toEqual({ decimalComma: true, thousandsSpace: true });
  });

  it('plain input has a plain style', () => {
    expect(evaluate('2 + 2')?.style).toEqual({ decimalComma: false, thousandsSpace: false });
  });

  it('returns Infinity for division by zero (formatting refuses it)', () => {
    expect(valueOf('1 / 0')).toBe(Infinity);
  });

  it.each([
    [''],
    ['   '],
    ['abc'],
    ['2 + x'],
    ['2 +'],
    ['(2 + 3'],
    ['2 + 3)'],
    ['2 3'],
    ['5'],
    ['-5'],
    ['(5)'],
    ['2 ** 3'],
    ['1e5 + 1'],
    ['.5 + 1'],
    ['5. + 1'],
    ['2 + 3 = 5'],
    ['%'],
    ['2 %% 3'],
  ])('rejects %j', (expr) => {
    expect(evaluate(expr)).toBeNull();
  });

  it('rejects input longer than the limit', () => {
    const long = '1+'.repeat(100) + '1';
    expect(long.length).toBeGreaterThan(MAX_EXPRESSION_LENGTH);
    expect(evaluate(long)).toBeNull();
  });

  it('rejects nesting deeper than the limit, accepts shallow nesting', () => {
    expect(evaluate('('.repeat(40) + '1' + ')'.repeat(40) + '+1')).toBeNull();
    expect(evaluate('-'.repeat(40) + '1+1')).toBeNull();
    expect(valueOf('('.repeat(10) + '1' + ')'.repeat(10) + '+1')).toBe(2);
    // One depth unit per paren level: 30 levels are within MAX_DEPTH (32).
    expect(valueOf('('.repeat(30) + '1' + ')'.repeat(30) + '+1')).toBe(2);
  });
});
