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

/**
 * Third mode added alongside the original binary `live-preview | raw`:
 * `live-render` hides markdown syntax permanently (Notion-like), gated
 * behind `betaInCycle` so it never surfaces to a user who hasn't opted in.
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
    toggleFollowSystem() {
      followSystem = !followSystem;
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
function loadEngineSetting(): EditorEngine {
  const stored = loadSetting<EditorEngine | null>('engine', null);
  if (isEditorEngine(stored)) return stored;
  const legacy = loadSetting<EditorEngine | null>('mode', null);
  return isEditorEngine(legacy) ? legacy : 'live-preview';
}

export function createEngineStore() {
  const initial = loadEngineSetting();
  let engine = $state<EditorEngine>(initial);
  // Default false: the beta must never turn itself on for anyone who hasn't
  // explicitly opted in via the View menu.
  let betaInCycle = $state<boolean>(loadSetting('betaInCycle', false));
  // Which rendering engine Cmd+E returns to when leaving `raw`. Persisted so
  // the round trip survives a restart.
  let lastNonRaw = $state<Exclude<EditorEngine, 'raw'>>(
    initial === 'raw'
      ? loadSetting<Exclude<EditorEngine, 'raw'>>('lastNonRawEngine', 'live-preview')
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
    get betaInCycle() {
      return betaInCycle;
    },
    /** Direct selection — used by the Editor Engine submenu. */
    set(next: EditorEngine) {
      apply(next);
    },
    /** Cmd+E. With the beta excluded from the cycle (the default) this is
     * `raw <-> the last rendering engine used` — for anyone on live-preview
     * that is exactly the binary toggle they have today, and for someone
     * working in live-render it returns them to live-render rather than
     * silently dropping them into live-preview. Opting the beta into the
     * cycle via `toggleBetaInCycle()` makes it a three-way rotation. */
    cycle() {
      if (betaInCycle) {
        apply(
          engine === 'live-preview' ? 'live-render' : engine === 'live-render' ? 'raw' : 'live-preview'
        );
      } else {
        apply(engine === 'raw' ? lastNonRaw : 'raw');
      }
    },
    toggleBetaInCycle() {
      betaInCycle = !betaInCycle;
      saveSetting('betaInCycle', betaInCycle);
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

export function createZoomStore() {
  let level = $state<number>(loadSetting('zoomLevel', 1.0));

  return {
    get level() {
      return level;
    },
    zoomIn() {
      if (level < 2.0) {
        level = Math.round((level + 0.1) * 10) / 10;
        saveSetting('zoomLevel', level);
      }
    },
    zoomOut() {
      if (level > 0.8) {
        level = Math.round((level - 0.1) * 10) / 10;
        saveSetting('zoomLevel', level);
      }
    },
    reset() {
      level = 1.0;
      saveSetting('zoomLevel', level);
    },
  };
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
      const name = filePath ? filePath.split('/').pop() : 'Untitled';
      return `${isDirty ? '\u25cf ' : ''}${name} \u2014 md-mini`;
    },
  };
}

export interface RecentFile {
  path: string;
  timestamp: number;
}

export function createRecentFilesStore() {
  let files = $state<RecentFile[]>(loadSetting('recentFiles', []));

  return {
    get list() {
      return files;
    },
    add(path: string) {
      files = [
        { path, timestamp: Date.now() },
        ...files.filter((f) => f.path !== path),
      ].slice(0, 10);
      saveSetting('recentFiles', files);
    },
  };
}
