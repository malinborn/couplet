import { describe, expect, it } from 'vitest';
import { formatExact, formatTouched } from './relative-time';

/** Local wall-clock time: the rules read the user's calendar, so the tests do too, in any TZ. */
function at(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

const NOW = at(2026, 9, 26, 14, 5);
const min = (n: number) => NOW - n * 60_000;
const hrs = (n: number) => NOW - n * 3_600_000;

describe('formatTouched (ru)', () => {
  const ru = (ts: number, now = NOW) => formatTouched(ts, now, 'ru');

  it('UnderAMinute_IsJustNow', () => {
    expect(ru(NOW)).toBe('только что');
    expect(ru(NOW - 59_999)).toBe('только что');
  });

  it('InTheFuture_IsJustNow', () => {
    expect(ru(NOW + 5_000)).toBe('только что');
    expect(ru(NOW + 3 * 86_400_000)).toBe('только что');
  });

  it('OneMinute_HasNoNumber', () => {
    expect(ru(min(1))).toBe('минуту назад');
    expect(ru(NOW - 119_999)).toBe('минуту назад');
  });

  it('Minutes_UseAllThreeRussianForms', () => {
    expect(ru(min(2))).toBe('2 минуты назад');
    expect(ru(min(4))).toBe('4 минуты назад');
    expect(ru(min(5))).toBe('5 минут назад');
    expect(ru(min(21))).toBe('21 минуту назад');
    expect(ru(min(22))).toBe('22 минуты назад');
    expect(ru(min(25))).toBe('25 минут назад');
    expect(ru(min(59))).toBe('59 минут назад');
  });

  it('Minutes_TeensAreMany', () => {
    for (const n of [11, 12, 13, 14]) expect(ru(min(n))).toBe(`${n} минут назад`);
  });

  it('OneHour_HasNoNumber', () => {
    expect(ru(hrs(1))).toBe('час назад');
    expect(ru(min(119))).toBe('час назад');
  });

  it('Hours_SameDay_UseAllThreeRussianForms', () => {
    const late = at(2026, 9, 26, 23, 30);
    expect(ru(hrs(2))).toBe('2 часа назад');
    expect(ru(hrs(4))).toBe('4 часа назад');
    expect(ru(hrs(5))).toBe('5 часов назад');
    expect(ru(hrs(11))).toBe('11 часов назад');
    expect(ru(at(2026, 9, 26, 2, 0), late)).toBe('21 час назад');
    expect(ru(at(2026, 9, 26, 1, 0), late)).toBe('22 часа назад');
  });

  it('JustAfterMidnight_MinutesWinOverYesterday', () => {
    expect(ru(at(2026, 9, 25, 23, 58), at(2026, 9, 26, 0, 3))).toBe('5 минут назад');
  });

  it('AnHourOrMoreAcrossMidnight_IsYesterday', () => {
    expect(ru(at(2026, 9, 25, 23, 11), at(2026, 9, 26, 0, 30))).toBe('вчера в 23:11');
    expect(ru(at(2026, 9, 25, 0, 0))).toBe('вчера в 00:00');
  });

  it('EarlierThisYear_IsDayMonth', () => {
    expect(ru(at(2026, 2, 9, 11, 20))).toBe('09.02 в 11:20');
    expect(ru(at(2026, 9, 24, 23, 59))).toBe('24.09 в 23:59');
    expect(ru(at(2026, 1, 1, 0, 0))).toBe('01.01 в 00:00');
  });

  it('AnotherYear_HasTheYear', () => {
    expect(ru(at(1970, 1, 1, 0, 0))).toBe('01.01.1970 в 00:00');
    expect(ru(at(2025, 12, 31, 23, 11))).toBe('31.12.2025 в 23:11');
  });

  it('YesterdayAcrossNewYear_IsStillYesterday', () => {
    expect(ru(at(2025, 12, 31, 20, 0), at(2026, 1, 1, 9, 0))).toBe('вчера в 20:00');
  });

  it('YesterdayAcrossAMonth_IsStillYesterday', () => {
    expect(ru(at(2026, 2, 28, 10, 0), at(2026, 3, 1, 9, 0))).toBe('вчера в 10:00');
  });
});

describe('formatTouched (en)', () => {
  const en = (ts: number, now = NOW) => formatTouched(ts, now, 'en');

  it('FollowsTheSameRules', () => {
    expect(en(NOW)).toBe('just now');
    expect(en(min(1))).toBe('1 minute ago');
    expect(en(min(5))).toBe('5 minutes ago');
    expect(en(min(21))).toBe('21 minutes ago');
    expect(en(hrs(1))).toBe('1 hour ago');
    expect(en(hrs(5))).toBe('5 hours ago');
    expect(en(at(2026, 9, 25, 23, 11), at(2026, 9, 26, 0, 30))).toBe('yesterday at 23:11');
    expect(en(at(2026, 2, 9, 11, 20))).toBe('09.02 at 11:20');
    expect(en(at(1970, 1, 1, 0, 0))).toBe('01.01.1970 at 00:00');
  });
});

describe('formatExact', () => {
  it('IsTheFullLocalStamp', () => {
    expect(formatExact(NOW, 'ru')).toBe('26.09.2026, 14:05');
    expect(formatExact(at(1970, 1, 1, 0, 0), 'en')).toBe('01.01.1970, 00:00');
  });
});
