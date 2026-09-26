/**
 * The drawer card's «when»: a short relative time for the last moment a tab
 * was looked at or changed, and the exact stamp for its tooltip. Pure — the
 * clock and the language come in as arguments; every rule reads *local*
 * calendar time, so "yesterday" is the user's yesterday.
 */
import { activeLanguage, pluralIn, tIn, type SupportedLanguage } from '../i18n';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function clock(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dayMonth(d: Date): string {
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
}

function fullDate(d: Date): string {
  return `${dayMonth(d)}.${d.getFullYear()}`;
}

/**
 * - under a minute, or in the future (a clock that moved back): «только что»;
 * - under an hour: «N минут назад» — minutes first, even across midnight;
 * - the same calendar day: «N часов назад»;
 * - the calendar day before: «вчера в 23:11»;
 * - the same year: «09.02 в 11:20»;
 * - else «01.01.1970 в 00:00».
 */
export function formatTouched(ts: number, now: number, language: SupportedLanguage = activeLanguage()): string {
  const diff = now - ts;
  if (diff < MINUTE) return tIn(language, 'tabs.card.time.just_now');
  if (diff < HOUR) {
    const minutes = Math.floor(diff / MINUTE);
    return minutes === 1
      ? tIn(language, 'tabs.card.time.minute')
      : pluralIn(language, minutes, 'tabs.card.time.minutes');
  }
  const at = new Date(ts);
  const today = new Date(now);
  if (sameDay(at, today)) {
    const hours = Math.floor(diff / HOUR);
    return hours === 1 ? tIn(language, 'tabs.card.time.hour') : pluralIn(language, hours, 'tabs.card.time.hours');
  }
  // Built from the calendar, not `now - 24h`: a DST day is 23 or 25 hours long.
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(at, yesterday)) return tIn(language, 'tabs.card.time.yesterday', { time: clock(at) });
  const date = at.getFullYear() === today.getFullYear() ? dayMonth(at) : fullDate(at);
  return tIn(language, 'tabs.card.time.date', { date, time: clock(at) });
}

/** The tooltip: «26.09.2026, 14:05». */
export function formatExact(ts: number, language: SupportedLanguage = activeLanguage()): string {
  const at = new Date(ts);
  return tIn(language, 'tabs.card.time.exact', { date: fullDate(at), time: clock(at) });
}
