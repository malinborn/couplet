//! Public ids of stash entries, `s<unix ms>-<4 hex>` (e.g. `s1790378408605-3f9a`):
//! short enough to type in `couplet stash get <id>`, sortable by creation.
//! Sixteen bits of salt cannot be unique by themselves — the insert checks the
//! id is free inside its transaction and draws again (`entries::unique_id`).

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) fn new_id() -> String {
    id_at(super::clock::now_ms(), random16())
}

fn id_at(unix_ms: i64, salt: u16) -> String {
    format!("s{unix_ms}-{salt:04x}")
}

/// Sixteen unpredictable bits without a `rand` dependency: std seeds every
/// `RandomState` from the OS once per thread and varies it per instance; the
/// counter, the pid and the clock make two draws in one nanosecond, or in two
/// processes (the app and the CLI), still differ.
pub(crate) fn random16() -> u16 {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    hasher.write_u32(std::process::id());
    hasher.write_u128(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    (hasher.finish() & 0xffff) as u16
}

/// Whether `id` has the shape `new_id` produces. For ids that come from
/// outside (a `stash-changed` request): anything else is not an entry id.
pub(crate) fn is_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix('s') else { return false };
    let Some((ms, hex)) = rest.split_once('-') else { return false };
    !ms.is_empty()
        && ms.bytes().all(|b| b.is_ascii_digit())
        && hex.len() == 4
        && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn an_id_is_the_millisecond_and_four_hex_digits() {
        assert_eq!(id_at(1_790_378_408_605, 0x3f9a), "s1790378408605-3f9a");
        assert_eq!(id_at(5, 0x000b), "s5-000b");
    }

    #[test]
    fn new_ids_have_the_shape() {
        for _ in 0..100 {
            let id = new_id();
            assert!(is_id(&id), "{id}");
        }
    }

    #[test]
    fn the_salt_is_spread_even_within_one_millisecond() {
        let salts: HashSet<u16> = (0..1000).map(|_| random16()).collect();
        assert!(salts.len() >= 900, "only {} distinct salts in 1000", salts.len());
    }
}
