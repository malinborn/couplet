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
  /** Tab id → the opening in which its read failed; retried on the next one. */
  const failed = new Map<string, number>();
  const git = new Map<string, GitInfo | null>();
  /** Path → the gitInfo request whose answer it waits for; only that one may land. */
  const gitAsked = new Map<string, number>();
  let generation = 0;
  let gitSeq = 0;

  function load(tab: TabMeta, gen: number): void {
    // Any text set here supersedes a read still in flight for this tab.
    inflight.delete(tab.id);
    failed.delete(tab.id);
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
        failed.set(tab.id, gen);
        // Text from an earlier opening would be a file that may no longer exist.
        if (texts.delete(tab.id)) onChange();
      }
    );
  }

  function loadGit(paths: string[]): void {
    if (paths.length === 0) return;
    const seq = ++gitSeq;
    for (const p of paths) gitAsked.set(p, seq);
    deps.gitInfo(paths).then(
      (infos) => {
        let changed = false;
        paths.forEach((p, i) => {
          if (gitAsked.get(p) !== seq) return;
          git.set(p, infos[i] ?? null);
          changed = true;
        });
        if (changed) onChange();
      },
      () => {
        let changed = false;
        for (const p of paths) {
          if (gitAsked.get(p) !== seq || git.has(p)) continue;
          git.set(p, null);
          changed = true;
        }
        if (changed) onChange();
      }
    );
  }

  const filePaths = (tabs: readonly TabMeta[]) =>
    tabs.flatMap((t) => (t.path === null ? [] : [t.path]));

  function prune(tabs: readonly TabMeta[]): void {
    const live = new Set(tabs.map((t) => t.id));
    for (const byId of [texts, inflight, failed]) {
      for (const id of [...byId.keys()]) if (!live.has(id)) byId.delete(id);
    }
    const paths = new Set(filePaths(tabs));
    for (const byPath of [git, gitAsked]) {
      for (const p of [...byPath.keys()]) if (!paths.has(p)) byPath.delete(p);
    }
  }

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
      const fresh = tabs.filter(
        (t) => !texts.has(t.id) && !inflight.has(t.id) && failed.get(t.id) !== generation
      );
      for (const tab of fresh) load(tab, generation);
      // Every live path, not just fresh tabs': Save As moves a known tab to a new one.
      loadGit(filePaths(tabs).filter((p) => !gitAsked.has(p)));
      if (fresh.length > 0) onChange();
    },
    text: (tabId: string): TabText | null => texts.get(tabId) ?? null,
    /** `undefined`: not answered yet; `null`: could not be resolved. */
    git: (path: string): GitInfo | null | undefined => git.get(path),
  };
}

export type DrawerData = ReturnType<typeof createDrawerData>;
