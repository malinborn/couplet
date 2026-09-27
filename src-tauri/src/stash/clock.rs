//! Wall clock and the user's local calendar, without `chrono`: note file
//! names (`2026-09-26-0215-…`), "put away today" and backup names are all in
//! the user's local time. The offset comes from the C library's time-zone
//! database (`localtime_r`), the calendar arithmetic from Howard Hinnant's
//! `civil_from_days` (http://howardhinnant.github.io/date_algorithms.html).

use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const DAY_SECS: i64 = 86_400;

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// The last stamp `save_stamp_ms` handed out in this process.
static LAST_SAVE_STAMP: AtomicI64 = AtomicI64::new(0);

/// `now_ms` for the save hook, strictly increasing within the process: two
/// saves in one millisecond, or one after the wall clock stepped back, still
/// come out in the order they were made.
pub(crate) fn save_stamp_ms() -> i64 {
    next_stamp(&LAST_SAVE_STAMP, now_ms())
}

fn next_stamp(last: &AtomicI64, now: i64) -> i64 {
    let mut prev = last.load(Ordering::Relaxed);
    loop {
        let next = now.max(prev.saturating_add(1));
        match last.compare_exchange_weak(prev, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return next,
            Err(seen) => prev = seen,
        }
    }
}

/// Seconds east of UTC in the user's time zone at `unix_secs`. `0` when the C
/// library cannot say — a date off by the zone's offset is not worth failing
/// a note over.
///
/// `time_t` and `c_long` are both `i64` on every target this app builds
/// (aarch64 and x86_64 macOS), so no casts; a 32-bit target would fail to
/// compile here, which is the signal wanted.
pub(crate) fn local_offset_secs(unix_secs: i64) -> i64 {
    let t: libc::time_t = unix_secs;
    // SAFETY: an all-zero `tm` is a valid value (its one pointer field is null).
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: both pointers are valid for the call; `localtime_r` writes only into `tm`.
    let filled = unsafe { !libc::localtime_r(&t, &mut tm).is_null() };
    if filled {
        tm.tm_gmtoff
    } else {
        0
    }
}

/// `(year, month 1–12, day 1–31)` of the proleptic Gregorian calendar for a
/// count of days since 1970-01-01 (negative before it).
pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LocalTime {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
}

pub(crate) fn local_time(unix_ms: i64, offset_secs: i64) -> LocalTime {
    let local = unix_ms.div_euclid(1000) + offset_secs;
    let (year, month, day) = civil_from_days(local.div_euclid(DAY_SECS));
    let secs_of_day = local.rem_euclid(DAY_SECS);
    LocalTime {
        year,
        month,
        day,
        hour: (secs_of_day / 3600) as u32,
        minute: (secs_of_day % 3600 / 60) as u32,
    }
}

/// `YYYY-MM-DD` of `unix_ms` in local time.
pub(crate) fn local_date(unix_ms: i64, offset_secs: i64) -> String {
    let t = local_time(unix_ms, offset_secs);
    format!("{:04}-{:02}-{:02}", t.year, t.month, t.day)
}

/// Unix ms of the local midnight that starts the day containing `now_ms`.
/// Uses one offset for both ends, so on a DST-change day "today" can be off by
/// the shift for one night — accepted (plan D14).
pub(crate) fn local_day_start_ms(now_ms: i64, offset_secs: i64) -> i64 {
    let local = now_ms.div_euclid(1000) + offset_secs;
    (local.div_euclid(DAY_SECS) * DAY_SECS - offset_secs) * 1000
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-09-26 02:15 in Moscow (+03:00) = 2026-09-25 23:15 UTC.
    const T: i64 = 1_790_378_100_000;

    #[test]
    fn now_is_a_plausible_unix_millisecond() {
        assert!(now_ms() > 1_700_000_000_000);
    }

    #[test]
    fn the_local_offset_is_a_real_time_zone() {
        let offset = local_offset_secs(now_ms() / 1000);
        assert!((-14 * 3600..=14 * 3600).contains(&offset), "{offset}");
    }

    #[test]
    fn civil_from_days_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(11_017), (2000, 3, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
        assert_eq!(civil_from_days(20_722), (2026, 9, 26));
    }

    #[test]
    fn local_time_in_three_zones() {
        let at = |y, mo, d, h, mi| LocalTime { year: y, month: mo, day: d, hour: h, minute: mi };
        assert_eq!(local_time(T, 10_800), at(2026, 9, 26, 2, 15));
        assert_eq!(local_time(T, 0), at(2026, 9, 25, 23, 15));
        assert_eq!(local_time(T, -18_000), at(2026, 9, 25, 18, 15));
    }

    #[test]
    fn the_local_day_starts_at_local_midnight() {
        assert_eq!(local_day_start_ms(T, 10_800), 1_790_370_000_000);
        assert_eq!(local_day_start_ms(T, 0), 1_790_294_400_000);
        assert_eq!(local_day_start_ms(T, -18_000), 1_790_312_400_000);
    }

    #[test]
    fn save_stamps_only_move_forward() {
        let last = AtomicI64::new(0);
        assert_eq!(next_stamp(&last, T), T);
        assert_eq!(next_stamp(&last, T), T + 1, "the same millisecond twice");
        assert_eq!(next_stamp(&last, T - 60_000), T + 2, "the clock stepped back");
        assert_eq!(next_stamp(&last, T + 10), T + 10, "the clock caught up");
    }

    #[test]
    fn local_date_is_iso() {
        assert_eq!(local_date(T, 10_800), "2026-09-26");
        assert_eq!(local_date(T, 0), "2026-09-25");
    }
}
