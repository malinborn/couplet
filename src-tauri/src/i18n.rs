//! Rust-side i18n catalog: native menu labels and other Rust-rendered strings.
//!
//! Six flat, dot-separated JSON catalogs (`locales/{lang}/native.json`),
//! `include_str!`'d at compile time. The frontend has its own copy of the same
//! six languages (`locales/{lang}/app.json`) for the strings it renders — this
//! module only ever touches the Rust half.
//!
//! No runtime reactivity by design: the design doc's decision is
//! auto-restart-on-change (see `lib.rs::apply_language_change`), so the active
//! language is resolved exactly once at startup (`init`, called before
//! `menu::build_menu`) and never changes for the life of the process.

use std::collections::HashMap;
use std::sync::OnceLock;

/// The six languages md-mini ships. `zh` is Simplified.
pub const SUPPORTED_LANGUAGES: [&str; 6] = ["en", "es", "de", "fr", "ru", "zh"];

const EN_JSON: &str = include_str!("../../locales/en/native.json");
const ES_JSON: &str = include_str!("../../locales/es/native.json");
const DE_JSON: &str = include_str!("../../locales/de/native.json");
const FR_JSON: &str = include_str!("../../locales/fr/native.json");
const RU_JSON: &str = include_str!("../../locales/ru/native.json");
const ZH_JSON: &str = include_str!("../../locales/zh/native.json");

fn raw_for(lang: &str) -> &'static str {
    match lang {
        "es" => ES_JSON,
        "de" => DE_JSON,
        "fr" => FR_JSON,
        "ru" => RU_JSON,
        "zh" => ZH_JSON,
        _ => EN_JSON,
    }
}

fn parse(json: &str) -> HashMap<String, String> {
    // A malformed catalog must never break startup or show an empty menu —
    // fall through to an empty map, which makes every lookup take the `t()`
    // fallback path down to `en`, then to the key itself.
    serde_json::from_str(json).unwrap_or_default()
}

fn en_catalog() -> &'static HashMap<String, String> {
    static EN: OnceLock<HashMap<String, String>> = OnceLock::new();
    EN.get_or_init(|| parse(EN_JSON))
}

static ACTIVE_LANGUAGE: OnceLock<String> = OnceLock::new();

/// Call once, at the very start of `setup`, before `menu::build_menu` — the
/// menu's labels come from `t()`. Later calls are ignored, same discipline as
/// `paths::init`, so the language cannot change under a running app (the only
/// way to change it is `lib.rs::apply_language_change`, which restarts the
/// process).
pub fn init(language: &str) {
    let lang = if SUPPORTED_LANGUAGES.contains(&language) {
        language
    } else {
        "en"
    };
    let _ = ACTIVE_LANGUAGE.set(lang.to_string());
}

/// The resolved language code for this run — what `resolved_language` (the IPC
/// command the frontend calls before mounting) reports.
pub fn active_language() -> &'static str {
    ACTIVE_LANGUAGE.get().map(String::as_str).unwrap_or("en")
}

/// Look up `key` in `lang`'s catalog, falling back to `en`, then to the key
/// itself — never panics, never shows an empty menu item.
///
/// Re-parses the small JSON catalog on every call rather than caching it
/// (besides the `en` fallback, which every call may need). This runs at most a
/// few dozen times, once, while the native menu is being built — not a hot
/// path — and keeping it pure and parameterized by `lang` (rather than reading
/// the process-wide active language internally) is what makes `connect_doc`
/// testable per-language without a second global to juggle.
pub fn t_for(lang: &str, key: &str) -> String {
    if let Some(v) = parse(raw_for(lang)).get(key) {
        return v.clone();
    }
    if lang != "en" {
        if let Some(v) = en_catalog().get(key) {
            return v.clone();
        }
    }
    key.to_string()
}

/// `t_for` against the process-wide active language. What `menu.rs` calls.
pub fn t(key: &str) -> String {
    t_for(active_language(), key)
}

/// Plural category for `n` in `lang`.
///
/// en/es/de/fr: `one` (n == 1) / `other`. ru: `one`/`few`/`many` — teens
/// (n % 100 in 11..=19) are always `many` regardless of the last digit, which
/// is what makes this not reducible to a mod-10 check. zh: always `other`, it
/// has no grammatical plural.
pub fn plural_category(lang: &str, n: u64) -> &'static str {
    match lang {
        "ru" => {
            let rem100 = n % 100;
            let rem10 = n % 10;
            if rem100 / 10 == 1 {
                // 11-19, 111-119, ... — the teen exception.
                "many"
            } else if rem10 == 1 {
                "one"
            } else if (2..=4).contains(&rem10) {
                "few"
            } else {
                "many"
            }
        }
        "zh" => "other",
        _ => {
            if n == 1 {
                "one"
            } else {
                "other"
            }
        }
    }
}

/// `t_for(lang, "{key_prefix}.{category}")` with `{n}` substituted by the
/// actual count. Every locale defines all four suffixes
/// (`.one`/`.few`/`.many`/`.other`) even where the language does not
/// distinguish them, so this never has to fall back mid-lookup and the
/// catalog-completeness test can compare one key set across all six files.
pub fn t_plural_for(lang: &str, key_prefix: &str, n: u64) -> String {
    let category = plural_category(lang, n);
    t_for(lang, &format!("{key_prefix}.{category}")).replace("{n}", &n.to_string())
}

/// `t_plural_for` against the process-wide active language.
pub fn t_plural(key_prefix: &str, n: u64) -> String {
    t_plural_for(active_language(), key_prefix, n)
}

// -- IPC --

/// The currently active language code (one of `SUPPORTED_LANGUAGES`). Called
/// by the frontend before it mounts, so it loads the matching `app.json`
/// without a flash of English first.
#[tauri::command]
pub async fn resolved_language() -> Result<String, String> {
    Ok(active_language().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_to_en_then_to_the_key_itself() {
        assert_eq!(t_for("es", "menu.file.title"), "Archivo");
        // Every real key exists everywhere (see the completeness test below),
        // so probe with one that deliberately does not to exercise both rungs
        // of the fallback.
        assert_eq!(t_for("es", "no.such.key"), "no.such.key");
    }

    #[test]
    fn plural_categories_en_es_de_fr_are_one_and_other() {
        for lang in ["en", "es", "de", "fr"] {
            assert_eq!(plural_category(lang, 1), "one", "{lang}");
            assert_eq!(plural_category(lang, 0), "other", "{lang}");
            assert_eq!(plural_category(lang, 2), "other", "{lang}");
            assert_eq!(plural_category(lang, 5), "other", "{lang}");
            assert_eq!(plural_category(lang, 21), "other", "{lang}");
        }
    }

    #[test]
    fn plural_categories_ru_one_few_many() {
        assert_eq!(plural_category("ru", 1), "one");
        assert_eq!(plural_category("ru", 21), "one");
        assert_eq!(plural_category("ru", 101), "one");
        assert_eq!(plural_category("ru", 2), "few");
        assert_eq!(plural_category("ru", 3), "few");
        assert_eq!(plural_category("ru", 4), "few");
        assert_eq!(plural_category("ru", 24), "few");
        assert_eq!(plural_category("ru", 5), "many");
        assert_eq!(plural_category("ru", 0), "many");
        assert_eq!(plural_category("ru", 11), "many", "teens are many, not one");
        assert_eq!(plural_category("ru", 12), "many");
        assert_eq!(plural_category("ru", 14), "many");
        assert_eq!(plural_category("ru", 111), "many", "111 is a teen-shaped hundred");
    }

    #[test]
    fn plural_category_zh_is_always_other() {
        for n in [0, 1, 2, 5, 11, 100] {
            assert_eq!(plural_category("zh", n), "other");
        }
    }

    #[test]
    fn reopen_session_plural_substitutes_n() {
        assert_eq!(
            t_plural_for("en", "menu.file.reopen_session", 1),
            "Reopen 1 Window from Last Session"
        );
        assert_eq!(
            t_plural_for("en", "menu.file.reopen_session", 3),
            "Reopen 3 Windows from Last Session"
        );
    }

    #[test]
    fn reopen_session_plural_ru_uses_the_right_category_text() {
        assert_eq!(
            t_plural_for("ru", "menu.file.reopen_session", 1),
            "Восстановить 1 окно из прошлой сессии"
        );
        assert_eq!(
            t_plural_for("ru", "menu.file.reopen_session", 2),
            "Восстановить 2 окна из прошлой сессии"
        );
        assert_eq!(
            t_plural_for("ru", "menu.file.reopen_session", 5),
            "Восстановить 5 окон из прошлой сессии"
        );
        assert_eq!(
            t_plural_for("ru", "menu.file.reopen_session", 11),
            "Восстановить 11 окон из прошлой сессии"
        );
    }

    /// Six files by ~50 keys drift silently without this. Every locale must
    /// carry exactly the key set `en` does — no more, no fewer — or a missing
    /// key would show up live as raw dot-separated text in a menu, and an
    /// unused extra key would be dead weight nobody notices.
    #[test]
    fn every_locale_has_the_same_key_set_as_en() {
        use std::collections::BTreeSet;
        let en_keys: BTreeSet<_> = parse(EN_JSON).into_keys().collect();
        for lang in SUPPORTED_LANGUAGES {
            if lang == "en" {
                continue;
            }
            let keys: BTreeSet<_> = parse(raw_for(lang)).into_keys().collect();
            let missing: Vec<_> = en_keys.difference(&keys).collect();
            let extra: Vec<_> = keys.difference(&en_keys).collect();
            assert!(
                missing.is_empty() && extra.is_empty(),
                "{lang}/native.json key set differs from en: missing {:?}, extra {:?}",
                missing,
                extra
            );
        }
    }

    /// Rust substitutes `{n}` (`t_plural_for`, above); the frontend's
    /// `plural()` (`src/lib/i18n.ts`) substitutes `{count}`. Each runtime is
    /// internally consistent and the two catalogs (`native.json` vs.
    /// `app.json`) are disjoint today, so nothing is actually broken by the
    /// mismatch — but a translator working both files will eventually put
    /// `{count}` into a `native.json` plural value, and Rust would render
    /// the literal text `{count}` into a menu item with nothing to catch it.
    /// This pins the Rust-side half of the invariant: every value that is
    /// part of a plural family (all four of `.one`/`.few`/`.many`/`.other`
    /// exist for its key prefix — the shape `every_locale_has_the_same_key_set_as_en`
    /// above already relies on) must contain the placeholder Rust actually
    /// substitutes.
    #[test]
    fn every_pluralized_value_in_every_native_json_contains_the_n_placeholder() {
        use std::collections::BTreeSet;
        const SUFFIXES: [&str; 4] = ["one", "few", "many", "other"];

        for lang in SUPPORTED_LANGUAGES {
            let catalog = parse(raw_for(lang));
            let keys: BTreeSet<&String> = catalog.keys().collect();

            let mut prefixes = BTreeSet::new();
            for key in &keys {
                for suffix in SUFFIXES {
                    if let Some(prefix) = key.strip_suffix(&format!(".{suffix}")) {
                        prefixes.insert(prefix.to_string());
                    }
                }
            }

            for prefix in prefixes {
                let is_plural_family = SUFFIXES
                    .iter()
                    .all(|s| keys.contains(&format!("{prefix}.{s}")));
                if !is_plural_family {
                    continue; // a coincidental ".one"-shaped key, not an actual plural family
                }
                for suffix in SUFFIXES {
                    let full_key = format!("{prefix}.{suffix}");
                    let value = &catalog[&full_key];
                    assert!(
                        value.contains("{n}"),
                        "{lang}/native.json: {full_key} is a pluralized value missing the \
                         {{n}} placeholder Rust substitutes: {value:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn init_rejects_an_unsupported_language() {
        // Exercised indirectly: `init` itself uses a `OnceLock`, so it can only
        // be set once per test binary. What's tested here is the pure mapping
        // `init` applies before storing, mirrored locally.
        fn normalize(language: &str) -> &str {
            if SUPPORTED_LANGUAGES.contains(&language) {
                language
            } else {
                "en"
            }
        }
        assert_eq!(normalize("pt"), "en");
        assert_eq!(normalize("de"), "de");
    }
}
