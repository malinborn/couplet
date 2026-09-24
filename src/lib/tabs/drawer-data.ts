import { indexText, type SearchIndex } from './drawer-filter';
import { previewLines, type PreviewLine } from './drawer-preview';
import type { TabMeta } from './tab-model';

/** Rust `git_info::GitInfo`. */
export interface GitInfo {
  project: string;
  branch: string | null;
}

/** One tab's text, digested for the card and the search. */
export interface TabText {
  index: SearchIndex;
  preview: PreviewLine[];
  /** The first non-empty line — the whole preview in Compact (spec §6). */
  first: string;
}

export interface DrawerDataDeps {
  /** Text the controller holds for a tab — live or cached — without I/O (`textOf`). */
  held(tabId: string): string | null;
  read(path: string): Promise<string>;
  gitInfo(paths: string[]): Promise<(GitInfo | null)[]>;
}

function digest(text: string): TabText {
  const index = indexText(text);
  return { index, preview: previewLines(text), first: index.lines[0] ?? '' };
}

/**
 * What the drawer's cards and search read (spec §6: "поиск … по тексту
 * открытых вкладок, фоновые берём с диска"). Refreshed on every opening — a
 * background file may have changed on disk, a branch may have moved — and
 * topped up while open. Reads are async and a late one from an earlier
 * opening is dropped; `onChange` fires whenever something new arrived.
 */
export function createDrawerData(deps: DrawerDataDeps, onChange: () => void) {
  const texts = new Map<string, TabText>();
  /** Tab id → the opening its read belongs to. */
  const inflight = new Map<string, number>();
  const git = new Map<string, GitInfo | null>();
  let generation = 0;

  function load(tab: TabMeta, gen: number): void {
    const held = deps.held(tab.id);
    if (held !== null) {
      texts.set(tab.id, digest(held));
      return;
    }
    if (tab.path === null) {
      texts.set(tab.id, digest(''));
      return;
    }
    inflight.set(tab.id, gen);
    deps.read(tab.path).then(
      (text) => {
        if (inflight.get(tab.id) !== gen) return;
        inflight.delete(tab.id);
        texts.set(tab.id, digest(text));
        onChange();
      },
      () => {
        if (inflight.get(tab.id) !== gen) return;
        inflight.delete(tab.id);
        // Text from an earlier opening would be a file that may no longer exist.
        if (texts.delete(tab.id)) onChange();
      }
    );
  }

  function loadGit(paths: string[]): void {
    if (paths.length === 0) return;
    deps.gitInfo(paths).then(
      (infos) => {
        paths.forEach((p, i) => git.set(p, infos[i] ?? null));
        onChange();
      },
      () => {}
    );
  }

  function prune(tabs: readonly TabMeta[]): void {
    const live = new Set(tabs.map((t) => t.id));
    for (const id of [...texts.keys()]) if (!live.has(id)) texts.delete(id);
    for (const id of [...inflight.keys()]) if (!live.has(id)) inflight.delete(id);
  }

  const filePaths = (tabs: readonly TabMeta[]) =>
    tabs.flatMap((t) => (t.path === null ? [] : [t.path]));

  return {
    /** The drawer opened: everything again. */
    refresh(tabs: readonly TabMeta[]): void {
      const gen = ++generation;
      prune(tabs);
      for (const tab of tabs) load(tab, gen);
      loadGit(filePaths(tabs));
      onChange();
    },
    /** Tabs that arrived while the drawer is open. */
    ensure(tabs: readonly TabMeta[]): void {
      prune(tabs);
      const fresh = tabs.filter((t) => !texts.has(t.id) && !inflight.has(t.id));
      for (const tab of fresh) load(tab, generation);
      loadGit(filePaths(fresh).filter((p) => !git.has(p)));
      if (fresh.length > 0) onChange();
    },
    text: (tabId: string): TabText | null => texts.get(tabId) ?? null,
    /** `undefined`: not answered yet; `null`: could not be resolved. */
    git: (path: string): GitInfo | null | undefined => git.get(path),
  };
}

export type DrawerData = ReturnType<typeof createDrawerData>;
