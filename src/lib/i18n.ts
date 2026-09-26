/**
 * Plain i18n module — deliberately **not** reactive.
 *
 * The language cannot change while the process is running: switching it in
 * the menu writes `preferences.json`, saves the session and restarts the app
 * (`docs/superpowers/specs/2026-09-21-i18n-design.md`). So the catalog is
 * installed exactly once, during boot (`main.ts`), and `t()`/`plural()` are
 * ordinary synchronous functions reading a module-level variable — no
 * compartment reconfigure, no widget rebuild, safe to call from inside a CM6
 * `WidgetType.toDOM()`.
 *
 * Catalogs are discovered with `import.meta.glob` rather than six static
 * imports, so this module does not hard-fail while a locale's `app.json`
 * does not exist yet (e.g. mid-development, before every language has been
 * translated) — whatever is on disk under `locales/*\/app.json` is picked up
 * automatically, and a missing locale simply falls back to `en` for every key.
 */

export type SupportedLanguage = 'en' | 'es' | 'de' | 'fr' | 'ru' | 'zh';

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = ['en', 'es', 'de', 'fr', 'ru', 'zh'];

const FALLBACK_LANGUAGE: SupportedLanguage = 'en';

type Catalog = Record<string, string>;

export function isSupportedLanguage(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

// Eagerly loaded: there are only ever six tiny JSON files, and the whole
// point of installing the catalog before `mount()` is that nothing renders
// before it is ready — a lazy `import()` here would just move the await.
const localeModules = import.meta.glob('../../locales/*/app.json', { eager: true }) as Record<
  string,
  { default: Catalog }
>;

const catalogs = new Map<SupportedLanguage, Catalog>();
for (const path in localeModules) {
  const match = /\/locales\/([a-z]{2})\/app\.json$/.exec(path);
  if (!match) continue;
  const lang = match[1];
  if (!isSupportedLanguage(lang)) continue;
  catalogs.set(lang, localeModules[path].default);
}

let currentLanguage: SupportedLanguage = FALLBACK_LANGUAGE;

/** Installs the resolved language's catalog. Call exactly once, before `mount()`. */
export function installCatalog(language: SupportedLanguage): void {
  currentLanguage = language;
}

/** The language `installCatalog` set. Exposed for diagnostics, not for reactivity. */
export function activeLanguage(): SupportedLanguage {
  return currentLanguage;
}

function lookup(key: string, language: SupportedLanguage = currentLanguage): string | undefined {
  return catalogs.get(language)?.[key] ?? catalogs.get(FALLBACK_LANGUAGE)?.[key];
}

function interpolate(template: string, params?: Record<string, unknown>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
  );
}

/**
 * Translates `key`, interpolating `{placeholder}` tokens from `params`.
 *
 * Falls back to the `en` catalog when the active language is missing the key
 * (a locale mid-translation, or one that does not exist on disk yet), and to
 * the bare key itself when even `en` does not have it — so a typo'd or
 * not-yet-added key fails loud in the UI instead of throwing.
 */
export function t(key: string, params?: Record<string, unknown>): string {
  return interpolate(lookup(key) ?? key, params);
}

/**
 * `t` in an explicit language rather than the installed one — for pure
 * formatters whose tests pin a language (`tabs/relative-time.ts`) without
 * touching the process-wide catalog.
 */
export function tIn(language: SupportedLanguage, key: string, params?: Record<string, unknown>): string {
  return interpolate(lookup(key, language) ?? key, params);
}

type PluralCategory = 'one' | 'few' | 'many' | 'other';

/**
 * CLDR-ish cardinal plural category for `n`, per language.
 *
 * Only the six supported languages are handled, and only the categories they
 * actually distinguish: en/es/de/fr collapse to one/other, zh has no plural
 * distinction at all, and ru is the three-way one/few/many split with the
 * standard teen exception (11–14 are "many", not "few", even though their
 * last digit is 1–4).
 */
export function pluralCategory(language: SupportedLanguage, n: number): PluralCategory {
  const count = Math.abs(n);

  if (language === 'ru') {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 'one';
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return 'few';
    return 'many';
  }

  if (language === 'zh') return 'other';

  // en / es / de / fr
  return count === 1 ? 'one' : 'other';
}

/**
 * Translates a pluralized key: looks up `${key}.${category}` for the active
 * language's plural category of `count`, with `{count}` (and any extra
 * `params`) interpolated in. Every locale's catalog carries all four
 * suffixes for a pluralized key — even en/es/de/fr/zh, which only ever
 * select one or two of them — so the catalog-completeness check (every
 * locale has exactly `en`'s key set) does not have to special-case plurals.
 */
export function plural(count: number, key: string, params?: Record<string, unknown>): string {
  return pluralIn(currentLanguage, count, key, params);
}

/** `plural` in an explicit language — see `tIn`. */
export function pluralIn(
  language: SupportedLanguage,
  count: number,
  key: string,
  params?: Record<string, unknown>
): string {
  const category = pluralCategory(language, count);
  return tIn(language, `${key}.${category}`, { count, ...params });
}

/**
 * Mirrors the language-resolution priority chain for the one context Rust
 * cannot cover: browser dev (`npm run dev`), where there is no Tauri and so
 * no `preferences.json` and no `sys-locale`. `navigator.language` is a
 * BCP-47 tag (`de-AT`, `zh-Hans-CN`, `pt-BR`); only the primary language
 * subtag is matched, and only against the six supported codes.
 */
export function resolveFromNavigatorLanguage(navigatorLanguage: string | undefined | null): SupportedLanguage {
  if (!navigatorLanguage) return FALLBACK_LANGUAGE;
  const primary = navigatorLanguage.split('-')[0]?.toLowerCase();
  return primary && isSupportedLanguage(primary) ? primary : FALLBACK_LANGUAGE;
}
