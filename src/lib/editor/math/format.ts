import type { NumberStyle } from './evaluate';

/** Significant digits kept: enough for money, few enough to hide float noise. */
export const SIGNIFICANT_DIGITS = 10;
/** At or above this the answer would need an exponent — none is shown. */
export const MAX_ABS = 1e15;
/** Below this (and not zero) the answer would need an exponent — none is shown. */
export const MIN_ABS = 1e-10;

/**
 * The answer as the human would have written it: rounded to
 * `SIGNIFICANT_DIGITS`, no trailing zeros, the input's decimal separator and
 * thousands spaces. `null` when there is nothing honest to show — ±∞ (division
 * by zero), NaN, or a magnitude that would need exponent notation.
 */
export function formatResult(value: number, style: NumberStyle): string | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Number(value.toPrecision(SIGNIFICANT_DIGITS));
  if (rounded === 0) return '0';
  const abs = Math.abs(rounded);
  if (abs >= MAX_ABS || abs < MIN_ABS) return null;

  const magnitude = Math.floor(Math.log10(abs));
  const decimals = Math.min(20, Math.max(0, SIGNIFICANT_DIGITS - 1 - magnitude));
  let text = abs.toFixed(decimals);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');

  const dot = text.indexOf('.');
  let integer = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? '' : text.slice(dot + 1);
  if (style.thousandsSpace) integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const separator = style.decimalComma ? ',' : '.';
  const sign = rounded < 0 ? '-' : '';
  return sign + integer + (fraction ? separator + fraction : '');
}
