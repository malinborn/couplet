//! Window numbers `#N` (spec §3).
//!
//! A new window gets the lowest number in 1..=99 no live window holds, so the
//! numbers stay small and a closed window's number is the next one handed out.
//! A stale `couplet -t N` may therefore reach a new window that took `N` — an
//! accepted trade (spec §3). A restored window keeps its number (`pick_restored`).
//!
//! Nothing is persisted: the choice depends only on the live windows. An older
//! build's `window-counter.json` is left where it is and never read.

use std::collections::HashSet;

pub const MAX_NUMBER: u32 = 99;

/// The lowest number nobody in `live` holds. `None` only when all 99 are in use.
pub fn lowest_free(live: &HashSet<u32>) -> Option<u32> {
    (1..=MAX_NUMBER).find(|n| !live.contains(n))
}

/// A restored window's own number, if it is valid and nobody holds it now.
pub fn pick_restored(preferred: Option<u32>, live: &HashSet<u32>) -> Option<u32> {
    preferred.filter(|n| is_valid(*n) && !live.contains(n))
}

pub fn is_valid(n: u32) -> bool {
    (1..=MAX_NUMBER).contains(&n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live(ns: &[u32]) -> HashSet<u32> {
        ns.iter().copied().collect()
    }

    #[test]
    fn the_first_window_is_one() {
        assert_eq!(lowest_free(&live(&[])), Some(1));
    }

    #[test]
    fn the_lowest_gap_is_taken() {
        assert_eq!(lowest_free(&live(&[1, 2, 4])), Some(3));
        assert_eq!(lowest_free(&live(&[2, 3])), Some(1));
    }

    #[test]
    fn a_closed_windows_number_is_handed_out_next() {
        // #1 open, #2 opened, #1 closed: the next window is #1, the one after #3.
        let mut numbers = live(&[1]);
        numbers.insert(lowest_free(&numbers).unwrap());
        assert_eq!(numbers, live(&[1, 2]));
        numbers.remove(&1);
        let next = lowest_free(&numbers).unwrap();
        assert_eq!(next, 1);
        numbers.insert(next);
        assert_eq!(lowest_free(&numbers), Some(3));
    }

    #[test]
    fn all_ninety_nine_live_gives_no_number() {
        let all: Vec<u32> = (1..=MAX_NUMBER).collect();
        assert_eq!(lowest_free(&live(&all)), None);
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
    fn validity_is_one_to_ninety_nine() {
        assert!(!is_valid(0));
        assert!(is_valid(1));
        assert!(is_valid(99));
        assert!(!is_valid(100));
    }
}
