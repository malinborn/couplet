import type { NumberStyle } from './evaluate';

/**
 * The fraction is rounded so the answer has at most this many significant
 * digits — enough for money, few enough to hide float noise. The integer part
 * is never rounded: `1234567890123 + 1` is `1234567890124`.
 */
export const SIGNIFICANT_DIGITS = 10;
/** At or above this the answer would need an exponent — none is shown. */
export const MAX_ABS = 1e15;
/** Below this (and not zero) the answer would need an exponent — none is shown. */
export const MIN_ABS = 1e-10;

/**
 * The answer as the human would have written it: the integer part exact, the
 * fraction rounded to `SIGNIFICANT_DIGITS` overall, no trailing zeros, the
 * input's decimal separator and thousands spaces. `null` when there is nothing
 * honest to show — ±∞ (division by zero), NaN, or a magnitude that would need
 * exponent notation.
 */
export function formatResult(value: number, style: NumberStyle): string | null {
  if (!Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= MAX_ABS || abs < MIN_ABS) return null;

  const magnitude = Math.floor(Math.log10(abs));
  const decimals = Math.min(20, Math.max(0, SIGNIFICANT_DIGITS - 1 - magnitude));
  let text = abs.toFixed(decimals);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  if (/^0*$/.test(text.replace('.', ''))) return '0';
  // A fraction rounded up can carry the integer part to 1e15 (999999999999999.9).
  if (Number(text) >= MAX_ABS) return null;

  const dot = text.indexOf('.');
  let integer = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? '' : text.slice(dot + 1);
  if (style.thousandsSpace) integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const separator = style.decimalComma ? ',' : '.';
  const sign = value < 0 ? '-' : '';
  return sign + integer + (fraction ? separator + fraction : '');
}
