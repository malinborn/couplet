import {
  resolveTheme,
  loadSelection,
  concreteTheme,
  familyOf,
  halfOf,
  isDarkTheme,
  type ThemeFamily,
  type ThemeHalf,
  type ConcreteTheme,
} from './theme-resolve';
import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n';
import { applyWindowZoom, clampZoom, stepZoom } from './window-zoom';

/**
 * Third mode added alongside the original binary `live-preview | raw`:
 * `live-render` hides markdown syntax permanently (Notion-like). Вышел из
 * беты и стал движком по умолчанию — см. `loadEngineSetting`; `live-preview`
 * остался и выбирается в подменю.
 */
export type EditorEngine = 'raw' | 'live-preview' | 'live-render';

const EDITOR_ENGINES: readonly EditorEngine[] = ['raw', 'live-preview', 'live-render'];

function isEditorEngine(value: unknown): value is EditorEngine {
  return typeof value === 'string' && (EDITOR_ENGINES as readonly string[]).includes(value);
}

function loadSetting<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`md-mini:${key}`);
    return raw !== null ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveSetting(key: string, value: unknown): void {
  localStorage.setItem(`md-mini:${key}`, JSON.stringify(value));
}

export function createThemeStore() {
  // Одно состояние вместо прежней пары «preference + lastFamily»: конкретная
  // тема помнит и семью, и половину, а галочка живёт отдельным ключом.
  const initial = loadSelection(
    loadSetting<unknown>('theme', null),
    loadSetting<unknown>('themeFamily', null),
    loadSetting<unknown>('themeSystem', null)
  );
  let theme = $state<ConcreteTheme>(initial.theme);
  let followSystem = $state(initial.followSystem);
  let systemDark = $state(window.matchMedia('(prefers-color-scheme: dark)').matches);

  const resolved = $derived<ConcreteTheme>(resolveTheme({ theme, followSystem }, systemDark));
  const isDark = $derived(isDarkTheme(resolved));

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    systemDark = e.matches;
  });

  function persist(): void {
    saveSetting('theme', theme);
    saveSetting('themeSystem', followSystem);
  }

  return {
    /** Что человек выбрал; с галочкой «система» может отличаться от `resolved`. */
    get theme() {
      return theme;
    },
    get family() {
      return familyOf(theme);
    },
    get half() {
      return halfOf(theme);
    },
    get followSystem() {
      return followSystem;
    },
    /** Семья меняется, половина остаётся — и с галочкой, и без неё. */
    setFamily(family: ThemeFamily) {
      theme = concreteTheme(family, halfOf(theme));
      persist();
    },
    /**
     * Явно выбранная половина снимает галочку: пользователь только что сказал,
     * какую он хочет, и подчинять её системе прямо следом — значит не сделать
     * то, о чём попросили.
     */
    setHalf(half: ThemeHalf) {
      theme = concreteTheme(familyOf(theme), half);
      followSystem = false;
      persist();
    },
    /**
     * Значение, а не переключение: событие меню приходит в каждое окно, и
     * «переключи» сработало бы столько раз, сколько окон открыто. Снаружи
     * значение приходит из самого пункта меню, который macOS уже переключил.
     *
     * Выключая галочку, забираем себе ту половину, что сейчас на экране:
     * иначе тема прыгнула бы к давно выбранной половине, хотя человек всего
     * лишь перестал следовать системе.
     */
    setFollowSystem(value: boolean) {
      if (!value) theme = resolved;
      followSystem = value;
      persist();
    },
    get resolved() {
      return resolved;
    },
    get isDark() {
      return isDark;
    },
  };
}

/**
 * Reads the persisted engine, migrating the old binary key (`md-mini:mode`,
 * which only ever held `'live-preview'` or `'raw'`) when the new key
 * (`md-mini:engine`) hasn't been written yet — so an existing user's choice
 * survives the three-way split instead of silently resetting to the default.
 */
function loadStoredEngine(): EditorEngine | null {
  const stored = loadSetting<EditorEngine | null>('engine', null);
  if (isEditorEngine(stored)) return stored;
  const legacy = loadSetting<EditorEngine | null>('mode', null);
  return isEditorEngine(legacy) ? legacy : null;
}

/**
 * Live Render вышел из беты и стал движком по умолчанию — разово и для тех,
 * кто его не включал.
 *
 * Разово: ключ `liveRenderDefault` ставится один раз, и дальше выбор человека
 * снова за ним. Без такого ключа «дефолт» пересиливал бы выбор при каждом
 * запуске, и вернуться на live-preview было бы невозможно.
 *
 * Кто сидит в `raw`, там и остаётся: raw — это не «другой рендер», а решение
 * смотреть на исходник прямо сейчас, и выдёргивать оттуда человека фича про
 * рендер не должна. Но `lastNonRaw` ему тоже переписывается, так что первый же
 * Cmd+E приводит его в Live Render.
 */
function loadEngineSetting(): EditorEngine {
  const stored = loadStoredEngine();
  const migrated = loadSetting<boolean>('liveRenderDefault', false);
  if (!migrated) {
    saveSetting('liveRenderDefault', true);
    saveSetting('lastNonRawEngine', 'live-render');
    if (stored !== 'raw') {
      saveSetting('engine', 'live-render');
      return 'live-render';
    }
  }
  return stored ?? 'live-render';
}

export function createEngineStore() {
  const initial = loadEngineSetting();
  let engine = $state<EditorEngine>(initial);
  // Which rendering engine Cmd+E returns to when leaving `raw`. Persisted so
  // the round trip survives a restart.
  let lastNonRaw = $state<Exclude<EditorEngine, 'raw'>>(
    initial === 'raw'
      ? loadSetting<Exclude<EditorEngine, 'raw'>>('lastNonRawEngine', 'live-render')
      : initial
  );

  function apply(next: EditorEngine): void {
    engine = next;
    saveSetting('engine', engine);
    if (next !== 'raw') {
      lastNonRaw = next;
      saveSetting('lastNonRawEngine', lastNonRaw);
    }
  }

  return {
    get value() {
      return engine;
    },
    /** Direct selection — used by the Editor Engine submenu. */
    set(next: EditorEngine) {
      apply(next);
    },
    /**
     * Cmd+E: `raw` и выбранный движок рендера, и ничего больше.
     *
     * Live Render и Live Preview между собой не переключаются: это два ответа
     * на вопрос «как показывать разметку», и выбирают из них осознанно, в
     * подменю. Cmd+E отвечает на другой вопрос — «показать исходник», — и
     * возвращает ровно туда, откуда ушли.
     */
    cycle() {
      apply(engine === 'raw' ? lastNonRaw : 'raw');
    },
  };
}

/**
 * Идеально центрированный крестик вместо галочки в чекбоксе.
 *
 * Настройка глобальная (одна на приложение), но каждое окно держит свою копию,
 * как и остальные здесь; согласованность обеспечивается тем, что событие меню
 * несёт значение, а не команду «переключи» — см. `toggle_value` в `lib.rs`.
 */
export function createOcdAlignmentStore() {
  let enabled = $state<boolean>(loadSetting('ocdAlignment', false));

  return {
    get enabled() {
      return enabled;
    },
    set(value: boolean) {
      enabled = value;
      saveSetting('ocdAlignment', enabled);
    },
  };
}

export function createLineGlowStore() {
  let enabled = $state<boolean>(loadSetting('lineGlow', false));

  return {
    get enabled() {
      return enabled;
    },
    toggle() {
      enabled = !enabled;
      saveSetting('lineGlow', enabled);
    },
  };
}

/**
 * Масштаб всего окна. Шаг и применение живут в `window-zoom.ts` — здесь только
 * состояние и его сохранение.
 */
export function createZoomStore() {
  // Начальный масштаб читается в локальную переменную, а не из `level`: Svelte
  // справедливо предупреждает, что чтение `$state` вне реактивного контекста
  // берёт только первое значение — здесь именно это и нужно.
  const initial = clampZoom(loadSetting('zoomLevel', 1.0));
  let level = $state<number>(initial);

  // Каждое окно применяет сохранённый масштаб при создании: зум страницы живёт
  // в самом webview, а не в настройке, поэтому новое окно иначе открылось бы на
  // 100%, пока настройка говорит другое.
  applyWindowZoom(initial);

  function set(next: number): void {
    if (next === level) return;
    level = next;
    saveSetting('zoomLevel', level);
    applyWindowZoom(level);
  }

  return {
    get level() {
      return level;
    },
    zoomIn() {
      set(stepZoom(level, 1));
    },
    zoomOut() {
      set(stepZoom(level, -1));
    },
    reset() {
      set(1.0);
    },
  };
}

/**
 * Имя продукта в заголовке окна. Раньше здесь была строка «md-mini», и этим
 * заголовок фронтенда стирал тот, что выставил Rust (`window.rs` собирает его
 * из `productName` конфига) — так что дев-сборка в титлбаре выглядела ровно
 * как установленное приложение, хотя у неё и bundle id, и каталог данных
 * другие. Значение приходит из `getName()`; до ответа стоит имя релиза, оно же
 * остаётся в браузере, где IPC нет.
 */
let productName = $state('md-mini');

export function setProductName(name: string): void {
  if (name) productName = name;
}

export function createFileState() {
  let filePath = $state<string | null>(null);
  let isDirty = $state(false);
  let lastSavedAt = $state<number | null>(null);

  return {
    get filePath() {
      return filePath;
    },
    set filePath(v: string | null) {
      filePath = v;
    },
    get isDirty() {
      return isDirty;
    },
    set isDirty(v: boolean) {
      isDirty = v;
    },
    get lastSavedAt() {
      return lastSavedAt;
    },
    set lastSavedAt(v: number | null) {
      lastSavedAt = v;
    },
    get title() {
      const name = filePath ? filePath.split('/').pop() : t('ui.untitled');
      return `${isDirty ? '\u25cf ' : ''}${t('ui.window_title', { name, product: productName })}`;
    },
  };
}

export interface RecentFile {
  path: string;
  timestamp: number;
}

/**
 * A window's pre-Rust `localStorage` copy is whatever an older build wrote,
 * so it is filtered to entries Rust's `Vec<RecentFile>` will deserialize —
 * one bad entry would otherwise reject the whole import.
 */
function isRecentFile(value: unknown): value is RecentFile {
  if (typeof value !== 'object' || value === null) return false;
  const { path, timestamp } = value as Record<string, unknown>;
  return (
    typeof path === 'string' &&
    path !== '' &&
    typeof timestamp === 'number' &&
    Number.isSafeInteger(timestamp) &&
    timestamp >= 0
  );
}

/**
 * The `md-mini:recentFiles` key is read, never written or removed: it is the
 * one-time import source, and left intact it is also what a rollback to a
 * pre-Rust build would still find.
 */
function loadLegacyRecentFiles(): RecentFile[] {
  const raw = loadSetting<unknown>('recentFiles', []);
  return Array.isArray(raw) ? raw.filter(isRecentFile) : [];
}

/** Rust's list plus the version it was taken at (`recent.rs::RecentSnapshot`).
 * Broadcasts can arrive out of order; a lower version is always older. */
export interface RecentSnapshot {
  version: number;
  files: RecentFile[];
}

export function createRecentFilesStore() {
  // Starts from the old localStorage copy so the panel is non-empty on the
  // very first paint; `init()` (called once from `onMount`) replaces this
  // with the Rust-backed list moments later, one-time-importing this copy
  // if Rust's own store is still empty.
  let files = $state<RecentFile[]>(loadLegacyRecentFiles());
  // Highest Rust version applied so far; -1 until the first snapshot.
  let version = -1;
  // Counts local adds, so an `init()` reply computed before one of them does
  // not erase it — the add's own broadcast is what brings the list up to date.
  let localAdds = 0;

  return {
    get list() {
      return files;
    },
    add(path: string) {
      if (path === '') return;
      // Optimistic insert; Rust stamps its own time and broadcasts the result.
      files = [{ path, timestamp: Date.now() }, ...files.filter((f) => f.path !== path)].slice(0, 10);
      localAdds++;
      invoke('recent_files_add', { path }).catch(() => {});
    },
    /** Applies a `recent-changed` broadcast, unless a snapshot at least as new
     * was already applied — a late event must not roll the window back. */
    setList(snapshot: RecentSnapshot) {
      if (snapshot.version <= version) return;
      version = snapshot.version;
      files = snapshot.files;
    },
    /** Pulls the Rust-backed list, one-time-importing this window's
     * localStorage copy if Rust's own store is still empty. Call once, from
     * `onMount`. Outside Tauri the legacy copy simply stays. */
    async init(): Promise<void> {
      const legacy = files;
      const addsBefore = localAdds;
      let snapshot: RecentSnapshot;
      try {
        snapshot = await invoke<RecentSnapshot>('recent_files_import', { entries: legacy });
      } catch {
        return;
      }
      if (localAdds !== addsBefore || snapshot.version < version) return;
      version = snapshot.version;
      files = snapshot.files;
    },
  };
}
