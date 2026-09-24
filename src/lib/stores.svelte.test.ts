import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  createEngineStore,
  createThemeStore,
  createOcdAlignmentStore,
  createRecentFilesStore,
  createZoomStore,
  type RecentFile,
} from './stores.svelte';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

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

  it('FirstRun_DefaultsToLiveRender', () => {
    const store = createEngineStore();
    expect(store.value).toBe('live-render');
  });

  // Ровно то, о чём просили: Live Render включается и тем, кто его не включал.
  // Разово — иначе вернуться на live-preview было бы невозможно.
  it('MigratesAnExistingLivePreviewUser_Once', () => {
    localStorage.setItem('md-mini:engine', JSON.stringify('live-preview'));
    expect(createEngineStore().value).toBe('live-render');

    // Человек передумал и вернулся — второй запуск это уважает.
    const store = createEngineStore();
    store.set('live-preview');
    expect(createEngineStore().value).toBe('live-preview');
  });

  // raw — это не «другой рендер», а решение смотреть на исходник; выдёргивать
  // оттуда нельзя. Но следующий Cmd+E приводит в Live Render.
  it('LeavesARawUserInRaw_ButAimsCmdEAtLiveRender', () => {
    localStorage.setItem('md-mini:engine', JSON.stringify('raw'));
    localStorage.setItem('md-mini:lastNonRawEngine', JSON.stringify('live-preview'));
    const store = createEngineStore();
    expect(store.value).toBe('raw');
    store.cycle();
    expect(store.value).toBe('live-render');
  });

  it('Set_SelectsDirectlyAndPersists', () => {
    const store = createEngineStore();
    store.set('live-preview');
    expect(store.value).toBe('live-preview');
    expect(JSON.parse(localStorage.getItem('md-mini:engine')!)).toBe('live-preview');
  });

  describe('cycle()', () => {
    // Два движка рендера между собой не переключаются — только исходник и
    // тот, что выбран.
    it('LiveRender_GoesToRawAndBack', () => {
      const store = createEngineStore();
      store.cycle();
      expect(store.value).toBe('raw');
      store.cycle();
      expect(store.value).toBe('live-render');
    });

    it('LivePreview_GoesToRawAndBack_NeverToLiveRender', () => {
      const store = createEngineStore();
      store.set('live-preview');
      store.cycle();
      expect(store.value).toBe('raw');
      store.cycle();
      expect(store.value).toBe('live-preview');
    });

    it('RemembersTheRenderingEngineAcrossARestart', () => {
      const first = createEngineStore();
      first.set('live-preview');
      first.cycle();
      expect(first.value).toBe('raw');
      const second = createEngineStore();
      expect(second.value).toBe('raw');
      second.cycle();
      expect(second.value).toBe('live-preview');
    });
  });

  describe('legacy keys', () => {
    it('ReadsTheOldBinaryModeKey_ThenMigratesToLiveRender', () => {
      localStorage.setItem('md-mini:mode', JSON.stringify('raw'));
      const store = createEngineStore();
      expect(store.value).toBe('raw');
      store.cycle();
      expect(store.value).toBe('live-render');
    });
  });
});

describe('createOcdAlignmentStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('DefaultsToOff', () => {
    expect(createOcdAlignmentStore().enabled).toBe(false);
  });

  // Значение, а не переключение: событие меню приходит в каждое окно, и
  // «переключи» сработало бы столько раз, сколько окон открыто.
  it('SetIsIdempotent_AndPersists', () => {
    const store = createOcdAlignmentStore();
    store.set(true);
    store.set(true);
    expect(store.enabled).toBe(true);
    expect(JSON.parse(localStorage.getItem('md-mini:ocdAlignment')!)).toBe(true);
    expect(createOcdAlignmentStore().enabled).toBe(true);
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
    store.setFollowSystem(true);
    expect(store.followSystem).toBe(true);
    store.setFamily('aurora');
    expect(store.family).toBe('aurora');
    expect(store.followSystem).toBe(true);
  });

  // Галочку выключают, чтобы остановить то, что видно сейчас, а не чтобы
  // тема прыгнула к давно выбранной половине.
  it('TurningTheCheckboxOff_KeepsWhatIsOnScreen', () => {
    installMatchMediaStub(true);
    const store = createThemeStore();
    store.setFamily('blueprint');
    store.setFollowSystem(true);
    expect(store.resolved).toBe('blueprint-dark');
    store.setFollowSystem(false);
    expect(store.resolved).toBe('blueprint-dark');
    expect(store.half).toBe('dark');
  });

  // Событие меню приходит в каждое окно: повтор одного и того же значения
  // обязан быть тем же значением, иначе с двумя окнами галочка «залипает».
  it('SetFollowSystemIsIdempotent', () => {
    installMatchMediaStub(false);
    const store = createThemeStore();
    store.setFollowSystem(true);
    store.setFollowSystem(true);
    expect(store.followSystem).toBe(true);
    store.setFollowSystem(false);
    store.setFollowSystem(false);
    expect(store.followSystem).toBe(false);
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

describe('createZoomStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('FirstRun_IsOneHundredPercent', () => {
    expect(createZoomStore().level).toBe(1);
  });

  it('StepsAndPersists', () => {
    const store = createZoomStore();
    store.zoomIn();
    store.zoomIn();
    expect(store.level).toBe(1.2);
    expect(JSON.parse(localStorage.getItem('md-mini:zoomLevel')!)).toBe(1.2);
    expect(createZoomStore().level).toBe(1.2);
  });

  it('ResetReturnsToOneHundredPercent', () => {
    const store = createZoomStore();
    store.zoomOut();
    store.reset();
    expect(store.level).toBe(1);
  });

  // Настройка приходит из localStorage: там может лежать значение вне границ —
  // от прошлой версии или от чужой руки — и в setZoom оно уйти не должно.
  it('LoadsAnOutOfRangeSettingClamped', () => {
    localStorage.setItem('md-mini:zoomLevel', JSON.stringify(9));
    expect(createZoomStore().level).toBe(2);
  });
});

describe('createRecentFilesStore', () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  it('AddsToTheFrontAndDedupsByPath', () => {
    const store = createRecentFilesStore();
    store.add('/a.md');
    store.add('/b.md');
    store.add('/a.md');
    expect(store.list.map((f) => f.path)).toEqual(['/a.md', '/b.md']);
  });

  it('CapsAtTen', () => {
    const store = createRecentFilesStore();
    for (let i = 0; i < 12; i++) store.add(`/f${i}.md`);
    expect(store.list).toHaveLength(10);
  });

  it('SetListReplacesLocalStateWholesale', () => {
    const store = createRecentFilesStore();
    store.add('/a.md');
    store.setList([{ path: '/b.md', timestamp: 1 }]);
    expect(store.list).toEqual([{ path: '/b.md', timestamp: 1 }]);
  });

  it('AddCallsRecentFilesAddIpc', () => {
    const store = createRecentFilesStore();
    store.add('/a.md');
    const timestamp = store.list[0].timestamp;
    expect(invokeMock).toHaveBeenCalledWith('recent_files_add', { path: '/a.md', timestamp });
  });

  it('NoLongerWritesLocalStorage', () => {
    const store = createRecentFilesStore();
    store.add('/a.md');
    expect(localStorage.getItem('md-mini:recentFiles')).toBeNull();
  });

  it('InitImportsLegacyListAndAdoptsRustList', async () => {
    const legacy: RecentFile[] = [{ path: '/old.md', timestamp: 1 }];
    const rust: RecentFile[] = [{ path: '/shared.md', timestamp: 9 }];
    localStorage.setItem('md-mini:recentFiles', JSON.stringify(legacy));
    invokeMock.mockImplementation(() => Promise.resolve(rust));
    const store = createRecentFilesStore();
    expect(store.list).toEqual(legacy);
    await store.init();
    expect(invokeMock).toHaveBeenCalledWith('recent_files_import', { entries: legacy });
    expect(store.list).toEqual(rust);
  });

  it('InitDropsMalformedLegacyEntriesBeforeImport', async () => {
    localStorage.setItem(
      'md-mini:recentFiles',
      JSON.stringify([{ path: '/ok.md', timestamp: 2 }, { path: 42 }, null, { path: '/neg.md', timestamp: -1 }])
    );
    invokeMock.mockImplementation(() => Promise.resolve([]));
    await createRecentFilesStore().init();
    expect(invokeMock).toHaveBeenCalledWith('recent_files_import', {
      entries: [{ path: '/ok.md', timestamp: 2 }],
    });
  });

  it('InitKeepsLegacyListWhenIpcFails', async () => {
    const legacy: RecentFile[] = [{ path: '/old.md', timestamp: 1 }];
    localStorage.setItem('md-mini:recentFiles', JSON.stringify(legacy));
    invokeMock.mockImplementation(() => Promise.reject(new Error('no tauri')));
    const store = createRecentFilesStore();
    await store.init();
    expect(store.list).toEqual(legacy);
  });

  // An `add` or a `recent-changed` event that lands while the import is in
  // flight is newer than the import's answer; Rust's own broadcast of that
  // add is what brings this window up to date, not the stale reply.
  it('InitDoesNotOverwriteAChangeMadeWhileImporting', async () => {
    let resolveImport: (v: RecentFile[]) => void = () => {};
    invokeMock.mockImplementation((cmd) =>
      cmd === 'recent_files_import'
        ? new Promise<RecentFile[]>((resolve) => {
            resolveImport = resolve;
          })
        : Promise.resolve()
    );
    const store = createRecentFilesStore();
    const pending = store.init();
    store.setList([{ path: '/fresh.md', timestamp: 5 }]);
    resolveImport([{ path: '/stale.md', timestamp: 1 }]);
    await pending;
    expect(store.list).toEqual([{ path: '/fresh.md', timestamp: 5 }]);
  });
});
