import { describe, it, expect, beforeEach } from 'vitest';
import { createEngineStore, createThemeStore } from './stores.svelte';

/**
 * Node's built-in `localStorage` global only persists when the process is
 * started with `--localstorage-file`; under vitest's default node
 * environment its methods are present but silently no-op. Stub a minimal
 * `Storage` here so `createEngineStore`'s real read/write path — not a
 * bypass of it — is what these tests exercise.
 */
function installLocalStorageStub(): void {
  const data = new Map<string, string>();
  const stub: Storage = {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key) {
      return data.has(key) ? data.get(key)! : null;
    },
    key(index) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key) {
      data.delete(key);
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: stub,
    configurable: true,
  });
}

installLocalStorageStub();

describe('createEngineStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('DefaultsToLivePreview_WithBetaOff', () => {
    const store = createEngineStore();
    expect(store.value).toBe('live-preview');
    expect(store.betaInCycle).toBe(false);
  });

  it('Set_SelectsDirectlyAndPersists', () => {
    const store = createEngineStore();
    store.set('live-render');
    expect(store.value).toBe('live-render');
    expect(JSON.parse(localStorage.getItem('md-mini:engine')!)).toBe('live-render');
  });

  describe('cycle() with betaInCycle off (default)', () => {
    it('LivePreview_GoesToRaw', () => {
      const store = createEngineStore();
      store.cycle();
      expect(store.value).toBe('raw');
    });

    it('Raw_GoesToLivePreview', () => {
      const store = createEngineStore();
      store.set('raw');
      store.cycle();
      expect(store.value).toBe('live-preview');
    });

    it('LiveRender_GoesToRaw', () => {
      // live-render is reachable via direct menu selection even while beta is
      // excluded from the Cmd+E cycle. Cmd+E from there means "show me the
      // source", same as from live-preview.
      const store = createEngineStore();
      store.set('live-render');
      store.cycle();
      expect(store.value).toBe('raw');
    });

    it('LiveRender_RoundTripsBackToLiveRender_NotLivePreview', () => {
      // Cmd+E is raw <-> the last rendering engine used. Someone working in
      // the beta must not be silently dropped into live-preview on the way
      // back — that would look like the mode switched itself off.
      const store = createEngineStore();
      store.set('live-render');
      store.cycle();
      store.cycle();
      expect(store.value).toBe('live-render');
    });

    it('RemembersLastNonRawEngine_AcrossInstances', () => {
      const first = createEngineStore();
      first.set('live-render');
      first.cycle();
      expect(first.value).toBe('raw');

      const second = createEngineStore();
      expect(second.value).toBe('raw');
      second.cycle();
      expect(second.value).toBe('live-render');
    });
  });

  describe('cycle() with betaInCycle on', () => {
    it('CyclesThroughAllThreeInOrder', () => {
      const store = createEngineStore();
      store.toggleBetaInCycle();
      expect(store.value).toBe('live-preview');
      store.cycle();
      expect(store.value).toBe('live-render');
      store.cycle();
      expect(store.value).toBe('raw');
      store.cycle();
      expect(store.value).toBe('live-preview');
    });
  });

  it('ToggleBetaInCycle_FlipsAndPersists', () => {
    const store = createEngineStore();
    store.toggleBetaInCycle();
    expect(store.betaInCycle).toBe(true);
    expect(JSON.parse(localStorage.getItem('md-mini:betaInCycle')!)).toBe(true);
    store.toggleBetaInCycle();
    expect(store.betaInCycle).toBe(false);
  });

  it('Persists_AcrossInstances', () => {
    const store = createEngineStore();
    store.set('raw');
    store.toggleBetaInCycle();
    const reloaded = createEngineStore();
    expect(reloaded.value).toBe('raw');
    expect(reloaded.betaInCycle).toBe(true);
  });

  describe('legacy migration from md-mini:mode', () => {
    it('MigratesLegacyRaw_WhenNewKeyAbsent', () => {
      localStorage.setItem('md-mini:mode', JSON.stringify('raw'));
      const store = createEngineStore();
      expect(store.value).toBe('raw');
    });

    it('MigratesLegacyLivePreview_WhenNewKeyAbsent', () => {
      localStorage.setItem('md-mini:mode', JSON.stringify('live-preview'));
      const store = createEngineStore();
      expect(store.value).toBe('live-preview');
    });

    it('NewKeyTakesPrecedence_OverLegacyKey', () => {
      localStorage.setItem('md-mini:mode', JSON.stringify('raw'));
      localStorage.setItem('md-mini:engine', JSON.stringify('live-render'));
      const store = createEngineStore();
      expect(store.value).toBe('live-render');
    });

    it('IgnoresGarbageLegacyValue_FallsBackToDefault', () => {
      localStorage.setItem('md-mini:mode', JSON.stringify('not-a-real-engine'));
      const store = createEngineStore();
      expect(store.value).toBe('live-preview');
    });
  });
});

/**
 * Позволяет тесту сыграть смену системной темы. Настоящий `matchMedia` в node
 * отсутствует вовсе, а подменять сам store незачем: проверять надо ровно
 * связку «ОС сказала → на экране сменилось», потому что чистая арифметика
 * выбора уже покрыта в `theme-resolve.test.ts`.
 */
function installMatchMediaStub(dark: boolean): (value: boolean) => void {
  const listeners: ((e: { matches: boolean }) => void)[] = [];
  let matches = dark;
  Object.defineProperty(globalThis, 'window', {
    value: {
      matchMedia: () => ({
        get matches() {
          return matches;
        },
        addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => {
          listeners.push(fn);
        },
      }),
    },
    configurable: true,
  });
  return (value: boolean) => {
    matches = value;
    for (const fn of listeners) fn({ matches: value });
  };
}

describe('createThemeStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('FirstRun_FollowsSystemInClassic', () => {
    installMatchMediaStub(true);
    const store = createThemeStore();
    expect(store.followSystem).toBe(true);
    expect(store.resolved).toBe('dark');
  });

  // Ровно то, ради чего галочка и делалась: ОС переключилась — половина за ней,
  // семья на месте.
  it('SystemFlips_HalfFollows_FamilyStays', () => {
    installLocalStorageStub();
    localStorage.setItem('md-mini:theme', JSON.stringify('blueprint-light'));
    localStorage.setItem('md-mini:themeSystem', JSON.stringify(true));
    const setSystemDark = installMatchMediaStub(false);
    const store = createThemeStore();
    expect(store.resolved).toBe('blueprint-light');
    setSystemDark(true);
    expect(store.resolved).toBe('blueprint-dark');
    expect(store.family).toBe('blueprint');
  });

  it('WithoutTheCheckbox_SystemIsIgnored', () => {
    const setSystemDark = installMatchMediaStub(false);
    const store = createThemeStore();
    store.setHalf('light');
    expect(store.followSystem).toBe(false);
    setSystemDark(true);
    expect(store.resolved).toBe('light');
  });

  it('SetFamily_KeepsHalfAndTheCheckbox', () => {
    installMatchMediaStub(true);
    const store = createThemeStore();
    store.setHalf('dark');
    store.setFamily('phosphor');
    expect(store.resolved).toBe('phosphor-dark');
    store.toggleFollowSystem();
    expect(store.followSystem).toBe(true);
    store.setFamily('aurora');
    expect(store.family).toBe('aurora');
    expect(store.followSystem).toBe(true);
  });

  it('PersistsBothKeys', () => {
    installMatchMediaStub(false);
    const store = createThemeStore();
    store.setFamily('blueprint');
    expect(JSON.parse(localStorage.getItem('md-mini:theme')!)).toBe('blueprint-light');
    expect(JSON.parse(localStorage.getItem('md-mini:themeSystem')!)).toBe(true);
  });

  // Дефолт старого формата — `'system'` в самом ключе темы; так записано у
  // всех, кто не трогал тему.
  it('MigratesLegacySystemPreference', () => {
    localStorage.setItem('md-mini:theme', JSON.stringify('system'));
    localStorage.setItem('md-mini:themeFamily', JSON.stringify('aurora'));
    installMatchMediaStub(true);
    const store = createThemeStore();
    expect(store.followSystem).toBe(true);
    expect(store.resolved).toBe('aurora-dark');
  });
});
