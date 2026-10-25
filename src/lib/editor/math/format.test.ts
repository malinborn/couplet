import { describe, it, expect } from 'vitest';
import { formatResult } from './format';
import type { NumberStyle } from './evaluate';

const PLAIN: NumberStyle = { decimalComma: false, thousandsSpace: false };
const COMMA: NumberStyle = { decimalComma: true, thousandsSpace: false };
const SPACES: NumberStyle = { decimalComma: false, thousandsSpace: true };
const BOTH: NumberStyle = { decimalComma: true, thousandsSpace: true };

describe('formatResult', () => {
  it.each([
    [439.40000000000003, '439.4'],
    [0.1 + 0.2, '0.3'],
    [10 / 3, '3.333333333'],
    [42, '42'],
    [-3.5, '-3.5'],
    [-0, '0'],
    [0, '0'],
    [123456789012, '123456789012'],
    [1234567890124, '1234567890124'],
    [999999999999999, '999999999999999'],
    [-123456789012345, '-123456789012345'],
    [12345.678901234, '12345.6789'],
    [0.0001, '0.0001'],
    [1e-7, '0.0000001'],
    [1e-10, '0.0000000001'],
    [2.5e-10, '0.00000000025'],
  ])('%d → %s', (value, expected) => {
    expect(formatResult(value, PLAIN)).toBe(expected);
  });

  it.each([
    [Infinity],
    [-Infinity],
    [NaN],
    [1e15],
    [-1e15],
    [1e-11],
    [999999999999999.9],
  ])('refuses %d', (value) => {
    expect(formatResult(value, PLAIN)).toBeNull();
  });

  it('mirrors a decimal comma', () => {
    expect(formatResult(1.5, COMMA)).toBe('1,5');
  });

  it('mirrors thousands spaces', () => {
    expect(formatResult(125000, SPACES)).toBe('125 000');
    expect(formatResult(999, SPACES)).toBe('999');
    expect(formatResult(1234567.25, SPACES)).toBe('1 234 567.25');
  });

  it('mirrors both', () => {
    expect(formatResult(3001, BOTH)).toBe('3 001');
    expect(formatResult(-1234.5, BOTH)).toBe('-1 234,5');
  });

  it('never groups the fraction', () => {
    expect(formatResult(0.123456, SPACES)).toBe('0.123456');
  });
});
