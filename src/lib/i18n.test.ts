import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  t,
  plural,
  pluralCategory,
  installCatalog,
  activeLanguage,
  isSupportedLanguage,
  resolveFromNavigatorLanguage,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from './i18n';

describe('t', () => {
  afterEach(() => {
    installCatalog('en');
  });

  it('LooksUpTheActiveLanguage', () => {
    installCatalog('en');
    expect(t('ui.copy')).toBe('Copy');
  });

  it('InterpolatesNamedPlaceholders', () => {
    installCatalog('en');
    expect(t('toast.update.headline', { latest: '1.4.0' })).toBe('mdmini 1.4.0 available');
  });

  it('LeavesAnUnmatchedPlaceholderTokenAlone', () => {
    installCatalog('en');
    expect(t('toast.update.headline', {})).toBe('mdmini {latest} available');
  });

  it('MissingKey_FallsBackToTheKeyItself', () => {
    installCatalog('en');
    expect(t('nonexistent.key.nobody.wrote')).toBe('nonexistent.key.nobody.wrote');
  });

  it('UnknownLanguage_FallsBackToEnCatalog', () => {
    // A language whose catalog is missing on disk (mid-translation) must not
    // throw, and must still answer with the English text rather than an
    // empty string or the bare key. All six supported languages now ship a
    // catalog, so this exercises an unsupported code instead — the cast
    // stands in for "a language not yet added to SUPPORTED_LANGUAGES".
    installCatalog('xx' as SupportedLanguage);
    expect(t('ui.copy')).toBe('Copy');
  });
});

describe('activeLanguage', () => {
  afterEach(() => {
    installCatalog('en');
  });

  it('ReflectsWhatWasInstalled', () => {
    installCatalog('ru');
    expect(activeLanguage()).toBe('ru');
  });
});

describe('isSupportedLanguage', () => {
  it('AcceptsExactlyTheSixCodes', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(isSupportedLanguage(lang)).toBe(true);
    }
  });

  it('RejectsAnythingElse', () => {
    expect(isSupportedLanguage('pt')).toBe(false);
    expect(isSupportedLanguage('EN')).toBe(false);
    expect(isSupportedLanguage('')).toBe(false);
  });
});

describe('resolveFromNavigatorLanguage', () => {
  it('ExactMatch_ReturnsTheLanguage', () => {
    expect(resolveFromNavigatorLanguage('de')).toBe('de');
    expect(resolveFromNavigatorLanguage('ru')).toBe('ru');
  });

  it('PrefixMatch_StripsTheRegionOrScriptSubtag', () => {
    expect(resolveFromNavigatorLanguage('de-AT')).toBe('de');
    expect(resolveFromNavigatorLanguage('zh-Hans-CN')).toBe('zh');
    expect(resolveFromNavigatorLanguage('FR-fr')).toBe('fr');
  });

  it('UnsupportedLanguage_FallsBackToEn', () => {
    expect(resolveFromNavigatorLanguage('pt-BR')).toBe('en');
    expect(resolveFromNavigatorLanguage('ja')).toBe('en');
  });

  it('MissingLanguage_FallsBackToEn', () => {
    expect(resolveFromNavigatorLanguage(undefined)).toBe('en');
    expect(resolveFromNavigatorLanguage(null)).toBe('en');
    expect(resolveFromNavigatorLanguage('')).toBe('en');
  });
});

describe('pluralCategory', () => {
  it('EnEsDeFr_OnlyDistinguishOneFromOther', () => {
    for (const lang of ['en', 'es', 'de', 'fr'] as const) {
      expect(pluralCategory(lang, 1)).toBe('one');
      expect(pluralCategory(lang, 0)).toBe('other');
      expect(pluralCategory(lang, 2)).toBe('other');
      expect(pluralCategory(lang, 11)).toBe('other');
      expect(pluralCategory(lang, 21)).toBe('other');
    }
  });

  it('Zh_IsAlwaysOther', () => {
    expect(pluralCategory('zh', 0)).toBe('other');
    expect(pluralCategory('zh', 1)).toBe('other');
    expect(pluralCategory('zh', 5)).toBe('other');
    expect(pluralCategory('zh', 100)).toBe('other');
  });

  // 1, 21, 31, ... → one; 2-4, 22-24 → few; 5-20, 25-30 → many; the teen
  // exception is 11-14, which fall through to "many" despite ending in 1-4.
  it('Ru_OneFewMany_WithTheTeenException', () => {
    expect(pluralCategory('ru', 1)).toBe('one');
    expect(pluralCategory('ru', 21)).toBe('one');
    expect(pluralCategory('ru', 101)).toBe('one');

    expect(pluralCategory('ru', 2)).toBe('few');
    expect(pluralCategory('ru', 3)).toBe('few');
    expect(pluralCategory('ru', 4)).toBe('few');
    expect(pluralCategory('ru', 22)).toBe('few');
    expect(pluralCategory('ru', 24)).toBe('few');

    expect(pluralCategory('ru', 5)).toBe('many');
    expect(pluralCategory('ru', 0)).toBe('many');
    expect(pluralCategory('ru', 11)).toBe('many');
    expect(pluralCategory('ru', 12)).toBe('many');
    expect(pluralCategory('ru', 13)).toBe('many');
    expect(pluralCategory('ru', 14)).toBe('many');
    expect(pluralCategory('ru', 20)).toBe('many');
    expect(pluralCategory('ru', 111)).toBe('many'); // teen exception repeats every hundred
  });
});

describe('plural', () => {
  afterEach(() => {
    installCatalog('en');
  });

  it('En_PicksOneVsOther', () => {
    installCatalog('en');
    expect(plural(1, 'toast.session.windows')).toBe('1 window from your last session');
    expect(plural(3, 'toast.session.windows')).toBe('3 windows from your last session');
  });

  it('InterpolatesCountAutomatically_EvenWithoutExtraParams', () => {
    installCatalog('en');
    expect(plural(5, 'toast.session.windows')).toContain('5');
  });
});

describe('locales/*/app.json completeness', () => {
  const localesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'locales');
  const enKeys = Object.keys(
    JSON.parse(readFileSync(join(localesDir, 'en', 'app.json'), 'utf-8')) as Record<string, string>
  ).sort();

  it('EnCatalog_HasNoDuplicateOrEmptyKeys', () => {
    expect(enKeys.length).toBeGreaterThan(0);
    expect(new Set(enKeys).size).toBe(enKeys.length);
  });

  // Every other language is optional at any given moment (translations land
  // independently), but whichever ones exist on disk must carry exactly en's
  // key set — including all four plural suffixes — or a key silently falls
  // back to English forever in that locale.
  for (const lang of SUPPORTED_LANGUAGES) {
    if (lang === 'en') continue;
    const path = join(localesDir, lang, 'app.json');
    if (!existsSync(path)) continue;

    it(`${lang}_HasExactlyTheEnKeySet`, () => {
      const keys = Object.keys(JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string>).sort();
      expect(keys).toEqual(enKeys);
    });
  }

  it('OnlyAppJsonFilesFoundAreForSupportedLanguages', () => {
    const entries = readdirSync(localesDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const entry of entries) {
      if (!existsSync(join(localesDir, entry.name, 'app.json'))) continue;
      expect(isSupportedLanguage(entry.name)).toBe(true);
    }
  });

  // The nine keys below are rendered with `{@html t(...)}` in ToastStack.svelte
  // (never `t(...)` alone) — see the comments at each `{@html}` site there.
  // That is a deliberate choice (one message per toast, not a `<strong>` half
  // plus a translated tail, so languages that don't put the emphasis where
  // English does still read grammatically) and it turns each catalog value
  // into code: an unbalanced or unexpected tag breaks layout silently, and the
  // day any of these keys grows a `{param}`, an untrusted interpolated value
  // landing in one becomes an XSS sink. None of the nine take a param today —
  // this test is what has to keep noticing that, since nothing else does.
  const HTML_KEYS = [
    'toast.ai_nudge.message',
    'toast.themes_nudge.message',
    'toast.json_offer.message',
    'toast.ai_bind_copied.saved',
    'toast.ai_bind_copied.unsaved',
    'toast.ai_watch_copied.saved',
    'toast.ai_watch_copied.unsaved',
    'toast.ai_first_use.message',
    'toast.ai_first_use.more',
  ];

  // Only these exact tags are permitted in an `{@html}` catalog value — a bare
  // `<strong>`/`</strong>`, or a `<span>` carrying exactly this one class.
  // Anything else (an attribute, a different tag, a different class) is
  // rejected rather than pattern-matched loosely, since the point is to catch
  // a translator's typo or a future author reaching for a new tag here.
  const ALLOWED_TAGS = new Set(['<strong>', '</strong>', '<span class="md-toast-dim">', '</span>']);

  function extractTags(value: string): string[] {
    return value.match(/<[^>]*>/g) ?? [];
  }

  function assertTagsAreBalanced(value: string, tags: string[]): void {
    const stack: string[] = [];
    for (const tag of tags) {
      if (tag.startsWith('</')) {
        const name = tag.slice(2, -1);
        const top = stack.pop();
        expect(top, `unbalanced </${name}> in ${JSON.stringify(value)}`).toBe(name);
      } else {
        const name = tag.slice(1).split(/[\s>]/)[0];
        stack.push(name);
      }
    }
    expect(stack, `unclosed tag(s) in ${JSON.stringify(value)}`).toEqual([]);
  }

  for (const lang of SUPPORTED_LANGUAGES) {
    const path = join(localesDir, lang, 'app.json');
    if (!existsSync(path)) continue;
    const catalog = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string>;

    it(`${lang}_HtmlToastKeysOnlyUseTheAllowlistedTagsAndAreBalanced`, () => {
      for (const key of HTML_KEYS) {
        const value = catalog[key];
        if (value === undefined) continue; // completeness is checked separately above
        const tags = extractTags(value);
        for (const tag of tags) {
          expect(ALLOWED_TAGS.has(tag), `disallowed tag ${tag} in ${lang}/${key}: ${JSON.stringify(value)}`).toBe(
            true
          );
        }
        assertTagsAreBalanced(value, tags);
      }
    });
  }
});
