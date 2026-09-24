//! Window numbers `#N` (spec §3).
//!
//! Ascending from 1, wrapping after 99, skipping numbers a live window holds.
//! The counter is persisted so that a number is not handed out again right
//! away — an agent that remembered `7` must not land in somebody's new
//! window 7 a minute later. A restored window keeps its number (`pick_restored`).

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

pub const MAX_NUMBER: u32 = 99;

/// The number after `last`, wrapping 99 → 1 and skipping `live`. `None` only
/// when all 99 are in use.
pub fn next_number(last: u32, live: &HashSet<u32>) -> Option<u32> {
    (1..=MAX_NUMBER)
        .map(|step| (last % MAX_NUMBER + step - 1) % MAX_NUMBER + 1)
        .find(|n| !live.contains(n))
}

/// A restored window's own number, if it is valid and nobody holds it now.
pub fn pick_restored(preferred: Option<u32>, live: &HashSet<u32>) -> Option<u32> {
    preferred.filter(|n| (1..=MAX_NUMBER).contains(n) && !live.contains(n))
}

#[derive(Serialize, Deserialize)]
struct Counter {
    last: u32,
}

pub fn parse_counter(data: &str) -> u32 {
    serde_json::from_str::<Counter>(data)
        .map(|c| c.last)
        .unwrap_or(0)
}

fn counter_file() -> Result<PathBuf, String> {
    Ok(crate::paths::app_data_dir()?.join("window-counter.json"))
}

/// Same tmp+rename shape as `recent.rs` — the app's own data dir.
fn persist(last: u32) {
    let result = counter_file().and_then(|path| {
        let tmp = path.with_extension("json.tmp");
        let data = serde_json::to_string(&Counter { last })
            .map_err(|e| format!("serialize: {}", e))?;
        fs::write(&tmp, data).map_err(|e| format!("write: {}", e))?;
        fs::rename(&tmp, &path).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("rename: {}", e)
        })
    });
    if let Err(e) = result {
        // In-memory numbering stays correct for this run; only the
        // don't-reuse-right-away guarantee across a restart is lost.
        eprintln!("Window counter: {}", e);
    }
}

/// The last number handed out, shared by every window-creating path.
pub struct WindowNumbers {
    last: Mutex<u32>,
}

impl WindowNumbers {
    /// Call after `paths::init`, or a dev build would read the release counter.
    pub fn load() -> Self {
        let last = counter_file()
            .ok()
            .and_then(|p| fs::read_to_string(p).ok())
            .map(|d| parse_counter(&d))
            .unwrap_or(0);
        Self::from_last(last)
    }

    pub fn from_last(last: u32) -> Self {
        Self {
            last: Mutex::new(last),
        }
    }

    /// In memory only — called under the `OpenFiles` lock, so no disk I/O
    /// here. `save` once that lock is released.
    pub fn allocate(&self, live: &HashSet<u32>) -> Option<u32> {
        let mut last = self.last.lock().unwrap();
        let n = next_number(*last, live)?;
        *last = n;
        Some(n)
    }

    /// Write the current counter. Under this lock, so two saves racing each
    /// other cannot leave an older value on disk after a newer one.
    pub fn save(&self) {
        let last = self.last.lock().unwrap();
        persist(*last);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live(ns: &[u32]) -> HashSet<u32> {
        ns.iter().copied().collect()
    }

    #[test]
    fn numbers_start_at_one_and_ascend() {
        assert_eq!(next_number(0, &live(&[])), Some(1));
        assert_eq!(next_number(6, &live(&[])), Some(7));
    }

    #[test]
    fn live_numbers_are_skipped() {
        assert_eq!(next_number(6, &live(&[7, 8])), Some(9));
    }

    #[test]
    fn after_ninety_nine_the_count_wraps_to_one() {
        assert_eq!(next_number(99, &live(&[])), Some(1));
        assert_eq!(next_number(98, &live(&[99, 1, 2])), Some(3));
    }

    #[test]
    fn a_number_freed_a_moment_ago_is_not_reused_while_others_are_free() {
        // #7 just closed (no longer live), the counter is at 7: the next window
        // is #8, not #7 again.
        assert_eq!(next_number(7, &live(&[3])), Some(8));
    }

    #[test]
    fn a_corrupt_counter_above_the_range_still_lands_in_range() {
        // 250 behaves as 250 % 99 = 52, whose successor is 53.
        assert_eq!(next_number(250, &live(&[])), Some(53));
    }

    #[test]
    fn all_ninety_nine_live_gives_no_number() {
        let all: Vec<u32> = (1..=MAX_NUMBER).collect();
        assert_eq!(next_number(5, &live(&all)), None);
    }

    #[test]
    fn a_restored_window_keeps_its_number_when_it_is_free() {
        assert_eq!(pick_restored(Some(7), &live(&[3])), Some(7));
        assert_eq!(pick_restored(Some(7), &live(&[7])), None);
        assert_eq!(pick_restored(Some(0), &live(&[])), None);
        assert_eq!(pick_restored(Some(100), &live(&[])), None);
        assert_eq!(pick_restored(None, &live(&[])), None);
    }

    #[test]
    fn allocate_advances_the_counter_in_memory() {
        let numbers = WindowNumbers::from_last(6);
        assert_eq!(numbers.allocate(&live(&[7])), Some(8));
        assert_eq!(numbers.allocate(&live(&[])), Some(9), "the counter moved past 8");
    }

    #[test]
    fn the_counter_file_parses_and_tolerates_garbage() {
        assert_eq!(parse_counter(r#"{"last":42}"#), 42);
        assert_eq!(parse_counter("not json"), 0);
        assert_eq!(parse_counter(""), 0);
    }
}
