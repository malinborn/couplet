//! Locale resolution: stored preference -> system locale -> `"en"`.
//!
//! Split from `i18n.rs` on purpose: this module is pure and has nothing to do
//! with catalogs, so it is testable without touching a real OS locale or a
//! real `preferences.json`. The one place that actually reads the system
//! locale (`system_locale`) is a thin, deliberately untested wrapper around
//! `resolve` — `resolve_at_startup` wires the two together.

use crate::i18n::SUPPORTED_LANGUAGES;

/// BCP-47 prefix match against the six supported languages: `de-AT` -> `de`,
/// `zh-Hans-CN` -> `zh`, `pt-BR` -> `None` (no supported language starts with
/// `pt`).
pub fn match_supported(tag: &str) -> Option<&'static str> {
    let primary = tag.split(['-', '_']).next()?.to_lowercase();
    SUPPORTED_LANGUAGES
        .iter()
        .find(|&&supported| supported == primary)
        .copied()
}

/// Stored preference (already an explicit choice — no prefix matching needed,
/// it was written by us) -> system locale (BCP-47, prefix-matched) -> `"en"`.
///
/// Pure and tested directly; `resolve_at_startup` is the only caller that
/// supplies real inputs.
pub fn resolve(stored: Option<&str>, system: Option<&str>) -> &'static str {
    if let Some(s) = stored {
        if let Some(m) = match_supported(s) {
            return m;
        }
    }
    if let Some(sys) = system {
        if let Some(m) = match_supported(sys) {
            return m;
        }
    }
    "en"
}

/// Reads the system locale and resolves it. Called once, at the very start of
/// `setup`, before `menu::build_menu` — the menu's labels come from `t()`,
/// which needs `i18n::init` to have already run with this result.
pub fn resolve_at_startup(stored: Option<String>) -> &'static str {
    resolve(stored.as_deref(), system_locale().as_deref())
}

/// The user's most-preferred UI language, BCP-47 (`"de-AT"`, `"zh-Hans-CN"`,
/// …) — `NSLocale.preferredLanguages`, first element. This is the array
/// `defaults write -g AppleLanguages` edits, which is what the design doc's
/// manual verification step drives.
///
/// Deliberately not covered by a unit test: it talks to the live OS, and
/// `resolve` above is what carries the actual logic and is fully tested with
/// fixed inputs.
#[cfg(target_os = "macos")]
fn system_locale() -> Option<String> {
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSArray, NSAutoreleasePool, NSString};
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        // `+[NSLocale preferredLanguages]` returns an autoreleased `NSArray`,
        // and this runs inside `setup`, before tao has created its own
        // autorelease pool. Without one of our own here, the runtime prints
        // `objc[…]: autoreleased with no pool in place - just leaking` on
        // every launch. `NSAutoreleasePool` has no `Drop` impl in the `cocoa`
        // crate — draining it is an explicit call, not RAII — so the lookup
        // is wrapped in a closure and the pool is drained after it returns,
        // once every byte we need has already been copied into an owned
        // `String` (`to_string_lossy().into_owned()` below).
        let pool = NSAutoreleasePool::new(nil);
        let result = (|| {
            let locale_cls = class!(NSLocale);
            let preferred: id = msg_send![locale_cls, preferredLanguages];
            if preferred.is_null() || NSArray::count(preferred) == 0 {
                return None;
            }
            let first: id = NSArray::objectAtIndex(preferred, 0);
            if first.is_null() {
                return None;
            }
            let utf8 = NSString::UTF8String(first);
            if utf8.is_null() {
                return None;
            }
            Some(std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned())
        })();
        pool.drain();
        result
    }
}

#[cfg(not(target_os = "macos"))]
fn system_locale() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_match() {
        assert_eq!(match_supported("de"), Some("de"));
        assert_eq!(match_supported("zh"), Some("zh"));
    }

    #[test]
    fn bcp47_prefix_match() {
        assert_eq!(match_supported("de-AT"), Some("de"));
        assert_eq!(match_supported("zh-Hans-CN"), Some("zh"));
        assert_eq!(match_supported("en-US"), Some("en"));
        assert_eq!(match_supported("ru_RU"), Some("ru"));
    }

    #[test]
    fn unsupported_locale_matches_nothing() {
        assert_eq!(match_supported("pt-BR"), None);
        assert_eq!(match_supported("ja"), None);
    }

    #[test]
    fn stored_preference_wins_over_system() {
        assert_eq!(resolve(Some("de"), Some("fr-FR")), "de");
    }

    #[test]
    fn no_stored_preference_falls_back_to_system() {
        assert_eq!(resolve(None, Some("fr-FR")), "fr");
        assert_eq!(resolve(None, Some("zh-Hans-CN")), "zh");
    }

    #[test]
    fn unsupported_system_locale_falls_back_to_en() {
        assert_eq!(resolve(None, Some("pt-BR")), "en");
    }

    #[test]
    fn no_stored_preference_and_no_system_locale_falls_back_to_en() {
        assert_eq!(resolve(None, None), "en");
    }

    #[test]
    fn an_invalid_stored_preference_falls_through_to_system_then_en() {
        // Only written by us, so this should never happen in practice, but a
        // stale preference from a future version dropping a language must
        // degrade gracefully rather than panicking or sticking.
        assert_eq!(resolve(Some("xx"), Some("de-AT")), "de");
        assert_eq!(resolve(Some("xx"), None), "en");
    }
}
