# File Links 02 — The `[[` Picker and `/link` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A human puts a file link in as easily as an agent does: typing `[[` (or choosing `/link`) opens an inline picker — open tabs of every window, the project's markdown files, recent files, the stash, «Choose file…» — and a pick writes plain `[label](relative/path.md)`.

**Architecture:** One Rust command `link_candidates({ docPath })` gathers every candidate in one call (registry snapshot under a short `OpenFiles` lock, a bounded std-only project walk cached 30 s, recent files, stash entries; deduplicated and ordered). On the frontend one CM6 completion source (`createFileLinkSource`, built once per state — stable identity) matches `[[query` before the caret, fetches the candidates once per popup (a `Promise` the first time, then synchronous filtering of the snapshot), and does its own filtering (`filter: false`) with pure helpers (`link-filter.ts`). Pure `link-destination.ts` decides the label and the relative/absolute destination. `/link` is a slash action that inserts `[[]]` and starts the same completion.

**Tech Stack:** TypeScript, CodeMirror 6 (`@codemirror/autocomplete`), Svelte 5, Tauri 2 (Rust std only — no new crate), Vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-10-24-file-links-design.md` — D5, D6, D8 (and D9 strings for this part).

**Depends on:** `2026-10-24-file-links-01-open.md` (all of it). Plan 03 depends on this plan's `link-destination.ts` and `LinkControl.project`.

**Ground rules for every task**

- Work only in `/Users/maximkovalevskij/playground/md-mini/.claude/worktrees/file-links`. Every command below runs from that directory.
- Never `git stash`, `git checkout <file>`, `git reset`, `git rebase`. `git add` explicit paths only.
- Frontend tests: `npx vitest run <path>`; full suite `npx vitest run --dir src`.
- Never `npm run tauri dev` / `npm run tauri build`. Tauri checks: `npm run dev:app -- --features mcp-bridge`.
- Check unfamiliar Tauri 2 / CM6 / Svelte 5 APIs with context7 before using them.
- **CLAUDE.md gotchas that apply here:** a completion source must be a **stable reference** (build it and the `languageData` record once, outside the `.of()` arrow); never `autocompletion({ override })`; lock order — never hold `OpenFiles` while touching the disk or another lock.
- Strict TypeScript, no `any`; ES2020 library only (no `.at()`, `replaceAll`, `??=`).
- Conventional commits, each ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Decisions this plan takes (beyond the spec)

| # | Decision | Why |
|---|---|---|
| Q1 | The project root is the **document's** project (`git_info::project_root(docPath)`: git toplevel, else its folder); only an untitled document falls back to the window's project. | A window keeps the project of its first file forever; a document from another repository opened in it would otherwise get links relative to the wrong root. |
| Q2 | A project root that is the home folder or `/` is walked one level deep. | A loose note in `~` would otherwise walk the whole home folder and trip macOS consent dialogs for `~/Documents`, `~/Desktop`, `~/Downloads` (TCC). Truncation is reported as usual. |
| Q3 | `link_candidates` returns `docPath` normalized by Rust, and destinations are computed from that spelling. | Registry/walk paths are in `path_norm` spelling (`/private/tmp/…`); comparing them with the webview's spelling (`/tmp/…`) would make every link absolute. |
| Q4 | `LinkControl` gains `project(docPath)` returning `{ projectRoot, docPath }` (not the spec's `projectRoot()`), backed by a new `link_project` command. | Same normalization reason as Q3; plan 03's drop needs it without paying for a full candidate walk. |
| Q5 | "Not all project files listed" is the **Project section header** when `truncated` (not a selectable last row). | CM6 has no non-selectable option; a fake option would be reachable with the arrows and do nothing. |
| Q6 | A path destination encodes exactly `%` → `%25` and `#` → `%23`; everything else stays as written (spaces etc. go inside `<…>`). | Without it `a#b.md` would be read back as `a` + fragment `b.md`, and a file literally named `a%20b.md` as `a b.md`. |
| Q7 | Missing files are dropped from **Recent** (one `stat` per entry, ≤ 10). | Recent keeps deleted files; offering them produces dead links. Stash file references are kept as they are. |
| Q8 | The `[[` trigger works only where the markdown language is active and not inside code, an HTML block or a link URL. | A `.py` file, a fenced block or `[x](a[[b)` must not pop a file picker. |
| Q9 | «Choose file…» keeps `[[query]]` in place while the dialog is open and replaces it only if the document is unchanged when the dialog returns; cancel leaves `[[query]]` (like Esc). | The dialog is async; replacing first and losing the text on cancel would be worse. |

## File map

| File | Status | Responsibility |
|---|---|---|
| `src-tauri/src/link_walk.rs` | new | Bounded std walk, skips, limits, 30 s cache |
| `src-tauri/src/links.rs` | modify | `LinkCandidate(s)`, `merge_candidates`, `tab_paths`, `link_candidates`, `link_project` |
| `src-tauri/src/lib.rs` | modify | `mod link_walk;` + two commands |
| `src-tauri/src/ai_socket.rs` | modify | D8 line in `AGENT_SNIPPET` / `MCP_AGENT_SNIPPET` |
| `docs/ai-interface.md` | modify | Same lines in both fenced copies |
| `src/lib/links/types.ts` | modify | Candidate types |
| `src/lib/links/ipc.ts` | modify | `linkCandidates`, `linkProject` |
| `src/lib/links/link-destination.ts` | new | `destinationFor`, `labelFor`, `linkMarkdownFor`, `<…>` encoding |
| `src/lib/links/link-filter.ts` | new | Dedup, scoring, caps, URL option, `displayDir` |
| `src/lib/editor/links/open-link.ts` | modify | `LinkControl` + `candidates`, `project`, `chooseFile` |
| `src/lib/editor/links/fake-link-control.ts` | modify | Defaults for the three new members |
| `src/lib/editor/links/file-link-source.ts` | new | `[[` source (stable), apply, «Choose file…», URL option |
| `src/lib/editor/links/slash-link.ts` | new | `/link` slash action |
| `src/lib/editor/setup.ts` | modify | Install the source and `/link` with a `LinkControl` |
| `src/App.svelte` | modify | The three new control members |
| `locales/*/app.json` | modify | Picker strings |

---

### Task 1: Strings (D9)

**Files:**
- Modify: `locales/{en,ru,de,es,fr,zh}/app.json`
- Test: `src/lib/i18n.test.ts` (existing)

- [x] **Step 1: Insert the keys**

```bash
node --input-type=module <<'EOF'
import fs from 'node:fs';

const ANCHOR = 'editor.links.hint_missing_plain';
const KEYS = {
  en: {
    'editor.links.section_link': 'Link',
    'editor.links.section_tabs': 'Open tabs',
    'editor.links.section_project': 'Project',
    'editor.links.section_project_truncated': 'Project — not all files listed',
    'editor.links.section_recent': 'Recent',
    'editor.links.section_stash': 'Stash',
    'editor.links.section_other': 'Elsewhere',
    'editor.links.choose_file': 'Choose file…',
    'editor.links.link_to': 'Link to {url}',
    'editor.slash_link.action_detail': 'Link to a file',
  },
  ru: {
    'editor.links.section_link': 'Ссылка',
    'editor.links.section_tabs': 'Открытые вкладки',
    'editor.links.section_project': 'Проект',
    'editor.links.section_project_truncated': 'Проект — показаны не все файлы',
    'editor.links.section_recent': 'Недавние',
    'editor.links.section_stash': 'Тайник',
    'editor.links.section_other': 'Другое',
    'editor.links.choose_file': 'Выбрать файл…',
    'editor.links.link_to': 'Ссылка на {url}',
    'editor.slash_link.action_detail': 'Ссылка на файл',
  },
  de: {
    'editor.links.section_link': 'Link',
    'editor.links.section_tabs': 'Offene Tabs',
    'editor.links.section_project': 'Projekt',
    'editor.links.section_project_truncated': 'Projekt — nicht alle Dateien aufgeführt',
    'editor.links.section_recent': 'Zuletzt geöffnet',
    'editor.links.section_stash': 'Stash',
    'editor.links.section_other': 'Weitere',
    'editor.links.choose_file': 'Datei auswählen…',
    'editor.links.link_to': 'Link auf {url}',
    'editor.slash_link.action_detail': 'Link auf eine Datei',
  },
  es: {
    'editor.links.section_link': 'Enlace',
    'editor.links.section_tabs': 'Pestañas abiertas',
    'editor.links.section_project': 'Proyecto',
    'editor.links.section_project_truncated': 'Proyecto — no se muestran todos los archivos',
    'editor.links.section_recent': 'Recientes',
    'editor.links.section_stash': 'Stash',
    'editor.links.section_other': 'Otros',
    'editor.links.choose_file': 'Elegir archivo…',
    'editor.links.link_to': 'Enlace a {url}',
    'editor.slash_link.action_detail': 'Enlace a un archivo',
  },
  fr: {
    'editor.links.section_link': 'Lien',
    'editor.links.section_tabs': 'Onglets ouverts',
    'editor.links.section_project': 'Projet',
    'editor.links.section_project_truncated': 'Projet — tous les fichiers ne sont pas listés',
    'editor.links.section_recent': 'Récents',
    'editor.links.section_stash': 'Stash',
    'editor.links.section_other': 'Autres',
    'editor.links.choose_file': 'Choisir un fichier…',
    'editor.links.link_to': 'Lien vers {url}',
    'editor.slash_link.action_detail': 'Lien vers un fichier',
  },
  zh: {
    'editor.links.section_link': '链接',
    'editor.links.section_tabs': '已打开的标签页',
    'editor.links.section_project': '项目',
    'editor.links.section_project_truncated': '项目 — 未列出全部文件',
    'editor.links.section_recent': '最近',
    'editor.links.section_stash': 'Stash',
    'editor.links.section_other': '其他',
    'editor.links.choose_file': '选择文件…',
    'editor.links.link_to': '链接到 {url}',
    'editor.slash_link.action_detail': '链接到文件',
  },
};

for (const [lang, entries] of Object.entries(KEYS)) {
  const file = `locales/${lang}/app.json`;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const at = lines.findIndex((l) => l.trimStart().startsWith(`"${ANCHOR}":`));
  if (at < 0) throw new Error(`${file}: anchor ${ANCHOR} not found (plan 01 Task 1 first)`);
  const add = Object.entries(entries).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  lines.splice(at + 1, 0, ...add);
  fs.writeFileSync(file, lines.join('\n'));
  JSON.parse(fs.readFileSync(file, 'utf8'));
}
console.log('ok');
EOF
```

Expected output: `ok`. (The stash is «Stash» in every non-Russian catalog today — `stash.drawer.title` — so the section follows it.)

- [x] **Step 2: Run the completeness test**

Run: `npx vitest run src/lib/i18n.test.ts`
Expected: PASS.

- [x] **Step 3: Commit**

```bash
git add locales/en/app.json locales/ru/app.json locales/de/app.json locales/es/app.json locales/fr/app.json locales/zh/app.json
git commit -m "feat(links): strings for the file link picker

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Rust — the bounded project walk

**Files:**
- Create: `src-tauri/src/link_walk.rs`
- Modify: `src-tauri/src/lib.rs` (module list)

- [x] **Step 1: Write the module with its failing tests**

```rust
// src-tauri/src/link_walk.rs
//! The project walk behind the link picker (file-links D5): markdown-ish files
//! under a project root. Std only. Bounded in depth, file count and time,
//! never follows a symlinked directory, and cached per root for 30 s.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WalkLimits {
    /// Directory levels read, the root included: 1 reads the root only.
    pub max_depth: usize,
    pub max_files: usize,
    pub budget: Duration,
}

pub const PROJECT_LIMITS: WalkLimits = WalkLimits {
    max_depth: 10,
    max_files: 5_000,
    budget: Duration::from_millis(300),
};

/// The home folder or `/` as a "project" (a loose note in `~`): its own files
/// only. Walking further would read all of home and raise macOS consent
/// prompts for `~/Documents`, `~/Desktop`, `~/Downloads`.
pub const SHALLOW_LIMITS: WalkLimits = WalkLimits {
    max_depth: 1,
    ..PROJECT_LIMITS
};

pub const CACHE_TTL: Duration = Duration::from_secs(30);

const LINKABLE: [&str; 5] = ["md", "markdown", "txt", "csv", "tsv"];
const SKIPPED_DIRS: [&str; 7] = ["node_modules", "target", "dist", "build", "vendor", "__pycache__", "venv"];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WalkedFile {
    pub path: PathBuf,
    pub modified: Option<SystemTime>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WalkResult {
    /// Newest first.
    pub files: Vec<WalkedFile>,
    /// A limit cut the walk short: not every file is listed.
    pub truncated: bool,
}

pub fn is_linkable(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| LINKABLE.iter().any(|l| e.eq_ignore_ascii_case(l)))
}

pub fn skips_dir(name: &str) -> bool {
    name.starts_with('.') || SKIPPED_DIRS.contains(&name)
}

pub fn limits_for(root: &Path, home: Option<&Path>) -> WalkLimits {
    if root.parent().is_none() || home == Some(root) {
        SHALLOW_LIMITS
    } else {
        PROJECT_LIMITS
    }
}

/// Breadth first, so a cut-short walk keeps the files nearest the root.
pub fn walk_project(root: &Path, limits: WalkLimits) -> WalkResult {
    let started = Instant::now();
    let mut files = Vec::new();
    let mut truncated = false;
    let mut queue = VecDeque::from([(root.to_path_buf(), 1usize)]);
    'walk: while let Some((dir, depth)) = queue.pop_front() {
        let Ok(read) = fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<fs::DirEntry> = read.filter_map(Result::ok).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            if started.elapsed() >= limits.budget {
                truncated = true;
                break 'walk;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if skips_dir(&name) {
                    continue;
                }
                if depth < limits.max_depth {
                    queue.push_back((entry.path(), depth + 1));
                } else {
                    truncated = true;
                }
                continue;
            }
            // A symlink is listed only when it points at a file; a symlinked
            // directory is never entered.
            let is_file = if kind.is_symlink() {
                fs::metadata(entry.path()).is_ok_and(|m| m.is_file())
            } else {
                kind.is_file()
            };
            if !is_file || !is_linkable(&name) {
                continue;
            }
            if files.len() >= limits.max_files {
                truncated = true;
                break 'walk;
            }
            let modified = entry.metadata().ok().and_then(|m| m.modified().ok());
            files.push(WalkedFile { path: entry.path(), modified });
        }
    }
    files.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.path.cmp(&b.path)));
    WalkResult { files, truncated }
}

/// Walks per root, reused for `CACHE_TTL`. The lock is never held during a
/// walk: two concurrent misses may both walk, and the later one wins.
#[derive(Default)]
pub struct WalkCache {
    entries: Mutex<HashMap<PathBuf, (Instant, WalkResult)>>,
}

impl WalkCache {
    pub fn get_or_walk(&self, root: &Path, now: Instant, walk: impl FnOnce() -> WalkResult) -> WalkResult {
        {
            let entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            if let Some((at, result)) = entries.get(root) {
                if now.saturating_duration_since(*at) < CACHE_TTL {
                    return result.clone();
                }
            }
        }
        let fresh = walk();
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        entries.retain(|_, (at, _)| now.saturating_duration_since(*at) < CACHE_TTL);
        entries.insert(root.to_path_buf(), (now, fresh.clone()));
        fresh
    }
}

/// The process-wide cached walk of `root` (already in `path_norm` spelling).
pub fn cached_walk(root: &Path) -> WalkResult {
    static CACHE: OnceLock<WalkCache> = OnceLock::new();
    let home = dirs::home_dir().map(|h| crate::path_norm::normalize_path(&h));
    let limits = limits_for(root, home.as_deref());
    CACHE
        .get_or_init(WalkCache::default)
        .get_or_walk(root, Instant::now(), || walk_project(root, limits))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("couplet-walk-{}-{}", tag, crate::session::new_tab_id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(root: &Path, rel: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "x").unwrap();
    }

    fn names(r: &WalkResult, root: &Path) -> Vec<String> {
        let mut v: Vec<String> = r
            .files
            .iter()
            .map(|f| f.path.strip_prefix(root).unwrap().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn lists_markdown_ish_files_and_skips_noise() {
        let root = scratch("skips");
        for rel in [
            "a.md", "b.TXT", "c.csv", "d.tsv", "e.markdown", "img.png", "docs/f.md",
            ".git/g.md", "node_modules/h.md", "target/i.md", ".hidden/j.md", "venv/k.md",
        ] {
            touch(&root, rel);
        }
        let r = walk_project(&root, PROJECT_LIMITS);
        assert_eq!(names(&r, &root), vec!["a.md", "b.TXT", "c.csv", "d.tsv", "docs/f.md", "e.markdown"]);
        assert!(!r.truncated);
    }

    #[test]
    fn the_depth_limit_cuts_and_says_so() {
        let root = scratch("depth");
        touch(&root, "a/x.md");
        touch(&root, "a/b/c.md");
        let r = walk_project(&root, WalkLimits { max_depth: 2, ..PROJECT_LIMITS });
        assert_eq!(names(&r, &root), vec!["a/x.md"]);
        assert!(r.truncated);
    }

    #[test]
    fn the_file_limit_cuts_and_says_so() {
        let root = scratch("files");
        for rel in ["a.md", "b.md", "c.md"] {
            touch(&root, rel);
        }
        let r = walk_project(&root, WalkLimits { max_files: 2, ..PROJECT_LIMITS });
        assert_eq!(r.files.len(), 2);
        assert!(r.truncated);
    }

    #[test]
    fn the_time_budget_cuts_and_says_so() {
        let root = scratch("time");
        touch(&root, "a.md");
        let r = walk_project(&root, WalkLimits { budget: Duration::ZERO, ..PROJECT_LIMITS });
        assert!(r.files.is_empty());
        assert!(r.truncated);
    }

    #[test]
    fn symlinked_directories_are_not_followed_but_a_linked_file_is_listed() {
        let root = scratch("links");
        let other = scratch("links-other");
        touch(&other, "z.md");
        std::os::unix::fs::symlink(&other, root.join("linked-dir")).unwrap();
        std::os::unix::fs::symlink(other.join("z.md"), root.join("l.md")).unwrap();
        let r = walk_project(&root, PROJECT_LIMITS);
        assert_eq!(names(&r, &root), vec!["l.md"]);
        assert!(!r.truncated);
    }

    #[test]
    fn newest_first() {
        let root = scratch("order");
        touch(&root, "old.md");
        touch(&root, "new.md");
        let old = SystemTime::now() - Duration::from_secs(3600);
        fs::File::options().write(true).open(root.join("old.md")).unwrap().set_modified(old).unwrap();
        let r = walk_project(&root, PROJECT_LIMITS);
        let order: Vec<String> = r.files.iter().map(|f| f.path.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(order, vec!["new.md", "old.md"]);
    }

    #[test]
    fn home_and_the_filesystem_root_are_walked_one_level() {
        let home = Path::new("/Users/me");
        assert_eq!(limits_for(Path::new("/"), Some(home)), SHALLOW_LIMITS);
        assert_eq!(limits_for(home, Some(home)), SHALLOW_LIMITS);
        assert_eq!(limits_for(Path::new("/Users/me/proj"), Some(home)), PROJECT_LIMITS);
    }

    #[test]
    fn a_walk_is_reused_for_thirty_seconds() {
        let cache = WalkCache::default();
        let root = Path::new("/r");
        let t0 = Instant::now();
        let one = WalkResult { files: Vec::new(), truncated: true };
        let mut walks = 0;
        cache.get_or_walk(root, t0, || {
            walks += 1;
            one.clone()
        });
        cache.get_or_walk(root, t0 + Duration::from_secs(29), || {
            walks += 1;
            one.clone()
        });
        assert_eq!(walks, 1);
        cache.get_or_walk(root, t0 + Duration::from_secs(31), || {
            walks += 1;
            one.clone()
        });
        assert_eq!(walks, 2);
    }
}
```

- [x] **Step 2: Register the module**

In `src-tauri/src/lib.rs`, in the module list, insert `mod link_walk;` between `mod i18n;` and `mod links;`:

```rust
mod i18n;
mod link_walk;
mod links;
```

- [x] **Step 3: Run the tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml link_walk::tests`
Expected: PASS — 8 tests. (Before Step 2 the module is not compiled and `cargo test` reports `0 tests` for the filter — that is the "failing" state.)

- [x] **Step 4: Commit**

```bash
git add src-tauri/src/link_walk.rs src-tauri/src/lib.rs
git commit -m "feat(links): bounded, cached project walk for the link picker

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Rust — candidates, merge, and the two commands

**Files:**
- Modify: `src-tauri/src/links.rs`
- Modify: `src-tauri/src/lib.rs` (`generate_handler!`)

- [x] **Step 1: Write the failing tests**

Append inside `mod tests` of `src-tauri/src/links.rs`:

```rust
    use crate::tabs::TabRegistry;

    #[test]
    fn tab_paths_lists_this_window_first_then_others_by_number() {
        let mut reg = TabRegistry::new();
        reg.add_tab("main", "t1", Some("/r/a.md".into()));
        reg.add_tab("main", "t2", None);
        reg.set_number("main", Some(1));
        reg.add_tab("editor-2", "t3", Some("/r/b.md".into()));
        reg.set_number("editor-2", Some(2));
        reg.add_tab("editor-3", "t4", Some("/r/c.md".into()));
        reg.set_number("editor-3", Some(3));
        let got = tab_paths(&reg, "editor-2", |label| label != "editor-3");
        assert_eq!(got, vec![("/r/b.md".to_string(), None), ("/r/a.md".to_string(), Some(1))]);
    }

    #[test]
    fn merge_keeps_each_path_once_in_its_highest_group_and_drops_the_document() {
        let got = merge_candidates(
            Some("/r/doc.md"),
            CandidateSources {
                tabs: vec![("/r/doc.md".into(), None), ("/r/a.md".into(), None), ("/r/b.md".into(), Some(2))],
                project: vec!["/r/a.md".into(), "/r/c.md".into()],
                recent: vec!["/r/c.md".into(), "/x/d.md".into()],
                stash: vec![("/n/note.md".into(), Some("Ideas".into())), ("/r/a.md".into(), Some("A title".into()))],
            },
        );
        let summary: Vec<(&str, LinkGroup, Option<&str>, Option<u32>)> = got
            .iter()
            .map(|c| (c.path.as_str(), c.group, c.title.as_deref(), c.window))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("/r/a.md", LinkGroup::Tab, Some("A title"), None),
                ("/r/b.md", LinkGroup::Tab, None, Some(2)),
                ("/r/c.md", LinkGroup::Project, None, None),
                ("/x/d.md", LinkGroup::Recent, None, None),
                ("/n/note.md", LinkGroup::Stash, Some("Ideas"), None),
            ]
        );
    }

    #[test]
    fn a_blank_stash_title_is_no_title() {
        let got = merge_candidates(
            None,
            CandidateSources { stash: vec![("/n/a.md".into(), Some("  ".into()))], ..Default::default() },
        );
        assert_eq!(got[0].title, None);
    }

    #[test]
    fn candidates_serialize_camel_case() {
        let json = serde_json::to_value(LinkCandidates {
            candidates: vec![LinkCandidate { path: "/r/a.md".into(), group: LinkGroup::Project, title: None, window: None }],
            truncated: true,
            project_root: Some("/r".into()),
            doc_path: Some("/r/doc.md".into()),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "candidates": [{ "path": "/r/a.md", "group": "project", "title": null, "window": null }],
                "truncated": true,
                "projectRoot": "/r",
                "docPath": "/r/doc.md"
            })
        );
    }
```

- [x] **Step 2: Run to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml links::tests`
Expected: FAIL to compile — `cannot find function tab_paths`, `cannot find type CandidateSources`.

- [x] **Step 3: Implement**

In `src-tauri/src/links.rs`, replace the head

```rust
use std::path::Path;

use serde::Serialize;
```

with:

```rust
use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::tabs::TabRegistry;
```

and update the module doc's last sentence to: `//! linked path is on disk, and the link picker's candidates (D5).`

Append (before `#[cfg(test)]`):

```rust
/// A picker group, in display order (D5).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkGroup {
    Tab,
    Project,
    Recent,
    Stash,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkCandidate {
    pub path: String,
    pub group: LinkGroup,
    /// A stash note's title — its label in the picker.
    pub title: Option<String>,
    /// `#N` of the other window holding it as a tab; `None` here or not a tab.
    pub window: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkCandidates {
    pub candidates: Vec<LinkCandidate>,
    /// The project walk hit a limit.
    pub truncated: bool,
    pub project_root: Option<String>,
    /// The document's path in `path_norm` spelling — what destinations are computed from.
    pub doc_path: Option<String>,
}

/// Where a link written into the document at `doc_path` is relative to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkProject {
    pub project_root: Option<String>,
    pub doc_path: Option<String>,
}

#[derive(Debug, Default)]
pub struct CandidateSources {
    /// Path and, for another window's tab, that window's number.
    pub tabs: Vec<(String, Option<u32>)>,
    pub project: Vec<String>,
    pub recent: Vec<String>,
    /// Path and title.
    pub stash: Vec<(String, Option<String>)>,
}

/// Every source in group order, each path once — in its highest group — and
/// never the document itself. A stash title labels the path in any group.
pub fn merge_candidates(doc_path: Option<&str>, sources: CandidateSources) -> Vec<LinkCandidate> {
    let titles: HashMap<String, String> = sources
        .stash
        .iter()
        .filter_map(|(path, title)| {
            title
                .as_ref()
                .filter(|t| !t.trim().is_empty())
                .map(|t| (path.clone(), t.clone()))
        })
        .collect();
    let mut seen: HashSet<String> = HashSet::new();
    if let Some(doc) = doc_path {
        seen.insert(doc.to_string());
    }
    let mut out = Vec::new();
    let mut push = |path: String, group: LinkGroup, window: Option<u32>| {
        if seen.insert(path.clone()) {
            let title = titles.get(&path).cloned();
            out.push(LinkCandidate { path, group, title, window });
        }
    };
    for (path, window) in sources.tabs {
        push(path, LinkGroup::Tab, window);
    }
    for path in sources.project {
        push(path, LinkGroup::Project, None);
    }
    for path in sources.recent {
        push(path, LinkGroup::Recent, None);
    }
    for (path, _) in sources.stash {
        push(path, LinkGroup::Stash, None);
    }
    out
}

/// Another window's tabs while they are sorted: number, label order, paths.
type OtherWindow = (Option<u32>, (u8, u32), Vec<String>);

/// Every tab with a path in every live window: `caller`'s first, in its
/// order, then the others by window number. Read under the registry lock —
/// the caller holds it only for this.
pub fn tab_paths(reg: &TabRegistry, caller: &str, is_live: impl Fn(&str) -> bool) -> Vec<(String, Option<u32>)> {
    let mut own: Vec<(String, Option<u32>)> = Vec::new();
    let mut others: Vec<OtherWindow> = Vec::new();
    for (label, window) in reg.all_windows() {
        if !is_live(label) {
            continue;
        }
        let paths: Vec<String> = window.tabs.iter().filter_map(|t| t.path.clone()).collect();
        if label == caller {
            own = paths.into_iter().map(|p| (p, None)).collect();
        } else {
            others.push((window.number, crate::session::label_order(label), paths));
        }
    }
    others.sort_by_key(|(number, order, _)| (number.unwrap_or(u32::MAX), *order));
    for (number, _, paths) in others {
        own.extend(paths.into_iter().map(|p| (p, number)));
    }
    own
}

/// The stash is read in one page this large (its own clamp).
const STASH_LIMIT: usize = 500;

fn project_for(app: &AppHandle, label: &str, doc_path: Option<String>) -> LinkProject {
    let doc_path = doc_path
        .filter(|p| !p.is_empty())
        .map(|p| crate::path_norm::normalize_str(&p));
    let project_root = match doc_path.as_deref() {
        Some(doc) => crate::git_info::project_root(Path::new(doc)).map(|p| p.to_string_lossy().into_owned()),
        None => crate::tab_commands::project_root_of(app, label),
    };
    LinkProject { project_root, doc_path }
}

fn recent_paths(app: &AppHandle) -> Vec<String> {
    let Some(recent) = app.try_state::<crate::recent::RecentFiles>() else {
        return Vec::new();
    };
    recent
        .snapshot()
        .files
        .into_iter()
        .map(|f| f.path)
        .filter(|p| Path::new(p).exists())
        .collect()
}

fn stash_entries(app: &AppHandle) -> Vec<(String, Option<String>)> {
    let Some(state) = app.try_state::<crate::stash::StashState>() else {
        return Vec::new();
    };
    let query = crate::stash::ListQuery {
        limit: Some(STASH_LIMIT),
        ..Default::default()
    };
    match state.with(|stash| stash.list(&query)) {
        Ok(page) => page.entries.into_iter().map(|e| (e.path, e.title)).collect(),
        Err(err) => {
            eprintln!("link_candidates: stash list failed: {err}");
            Vec::new()
        }
    }
}

/// Runs on the blocking pool. Each source takes its own lock alone and
/// releases it before the next: the registry (no disk access under it), then
/// recent files, then the stash; the walk holds none.
fn collect_candidates(app: &AppHandle, label: &str, doc_path: Option<String>) -> LinkCandidates {
    let project = project_for(app, label, doc_path);
    let tabs = {
        let open_files = app.state::<crate::window::OpenFiles>();
        let reg = open_files.0.lock().unwrap();
        tab_paths(&reg, label, |l| app.get_webview_window(l).is_some())
    };
    let recent = recent_paths(app);
    let stash = stash_entries(app);
    let walk = project
        .project_root
        .as_deref()
        .map(|root| crate::link_walk::cached_walk(Path::new(root)))
        .unwrap_or_default();
    let candidates = merge_candidates(
        project.doc_path.as_deref(),
        CandidateSources {
            tabs,
            project: walk.files.iter().map(|f| f.path.to_string_lossy().into_owned()).collect(),
            recent,
            stash,
        },
    );
    LinkCandidates {
        candidates,
        truncated: walk.truncated,
        project_root: project.project_root,
        doc_path: project.doc_path,
    }
}

/// The `[[` picker's candidates for the calling window's document (D5).
#[tauri::command]
pub async fn link_candidates(
    app: AppHandle,
    window: tauri::WebviewWindow,
    doc_path: Option<String>,
) -> Result<LinkCandidates, String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || collect_candidates(&app, &label, doc_path))
        .await
        .map_err(|e| e.to_string())
}

/// The project a link written into `doc_path` is relative to (D6), without
/// the walk — for a dropped link (plan 03).
#[tauri::command]
pub async fn link_project(
    app: AppHandle,
    window: tauri::WebviewWindow,
    doc_path: Option<String>,
) -> Result<LinkProject, String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || project_for(&app, &label, doc_path))
        .await
        .map_err(|e| e.to_string())
}
```

In `src-tauri/src/lib.rs` `generate_handler!`, after `links::path_kinds,` add:

```rust
            links::link_candidates,
            links::link_project,
```

- [x] **Step 4: Run the tests and the linters**

Run: `cargo test --manifest-path src-tauri/Cargo.toml links::tests`
Expected: PASS — 8 tests (4 from plan 01, 4 new).

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml`
Expected: no new warnings.

- [x] **Step 5: Commit**

```bash
git add src-tauri/src/links.rs src-tauri/src/lib.rs
git commit -m "feat(links): link_candidates and link_project commands

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Frontend types and IPC

**Files:**
- Modify: `src/lib/links/types.ts`
- Modify: `src/lib/links/ipc.ts`
- Test: `src/lib/links/ipc.test.ts` (append)

- [x] **Step 1: Write the failing test**

Append to `src/lib/links/ipc.test.ts`:

```ts
import { linkCandidates, linkProject } from './ipc';

describe('picker ipc', () => {
  it('linkCandidates passes the document path', async () => {
    await linkCandidates('/r/a.md');
    expect(invoke).toHaveBeenCalledWith('link_candidates', { docPath: '/r/a.md' });
  });

  it('linkProject passes null for an untitled document', async () => {
    await linkProject(null);
    expect(invoke).toHaveBeenCalledWith('link_project', { docPath: null });
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/links/ipc.test.ts`
Expected: FAIL — `linkCandidates is not a function` / missing export.

- [x] **Step 3: Implement**

Append to `src/lib/links/types.ts`:

```ts
/** A picker group, in display order — `LinkGroup` in `src-tauri/src/links.rs`. */
export type LinkGroup = 'tab' | 'project' | 'recent' | 'stash';

export interface LinkCandidate {
  path: string;
  group: LinkGroup;
  /** A stash note's title — its label. */
  title: string | null;
  /** `#N` of another window holding it as a tab; `null` here or not a tab. */
  window: number | null;
}

/** `link_candidates`' answer. */
export interface LinkCandidates {
  candidates: LinkCandidate[];
  /** The project walk hit a limit: not every project file is listed. */
  truncated: boolean;
  projectRoot: string | null;
  /** The document's path as Rust spells it (`path_norm`) — destinations are computed from it. */
  docPath: string | null;
}

/** `link_project`' answer: what a link written into a document is relative to. */
export interface LinkProject {
  projectRoot: string | null;
  docPath: string | null;
}
```

Append to `src/lib/links/ipc.ts` (and extend the type import to `import type { LinkCandidates, LinkProject, PathKind } from './types';`):

```ts
/** Picker candidates for the document at `docPath` (`null`: untitled). Rejects when the IPC fails. */
export function linkCandidates(docPath: string | null): Promise<LinkCandidates> {
  return invoke<LinkCandidates>('link_candidates', { docPath });
}

/** The project root and normalized document path a new link is relative to. */
export function linkProject(docPath: string | null): Promise<LinkProject> {
  return invoke<LinkProject>('link_project', { docPath });
}
```

- [x] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/links/ipc.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/lib/links/types.ts src/lib/links/ipc.ts src/lib/links/ipc.test.ts
git commit -m "feat(links): picker candidate types and ipc

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: What gets inserted (D6)

**Files:**
- Create: `src/lib/links/link-destination.ts`
- Test: `src/lib/links/link-destination.test.ts`

- [x] **Step 1: Write the failing tests**

```ts
// src/lib/links/link-destination.test.ts
import { describe, expect, it } from 'vitest';
import {
  destinationFor,
  escapeLabel,
  formatPathDestination,
  isInside,
  labelFor,
  linkMarkdownFor,
  relativePath,
  wrapDestination,
} from './link-destination';
import { resolveLinkTarget } from './link-target';

const DOC = '/r/docs/a.md';
const ROOT = '/r';

describe('relativePath and isInside', () => {
  it('relativePath', () => {
    expect(relativePath('/r/docs', '/r/docs/plan.md')).toBe('plan.md');
    expect(relativePath('/r/docs', '/r/notes/b.md')).toBe('../notes/b.md');
    expect(relativePath('/r', '/r')).toBe('');
  });

  it('isInside', () => {
    expect(isInside('/r', '/r/a.md')).toBe(true);
    expect(isInside('/r', '/r')).toBe(true);
    expect(isInside('/r', '/rx/a.md')).toBe(false);
    expect(isInside('/', '/anything')).toBe(true);
  });
});

describe('destinationFor', () => {
  it('is relative inside the project, never with ./', () => {
    expect(destinationFor('/r/docs/plan.md', DOC, ROOT)).toBe('plan.md');
    expect(destinationFor('/r/notes/b.md', DOC, ROOT)).toBe('../notes/b.md');
  });

  it('is absolute outside the project, for an untitled document, or with no root', () => {
    expect(destinationFor('/x/c.md', DOC, ROOT)).toBe('/x/c.md');
    expect(destinationFor('/r/docs/plan.md', null, ROOT)).toBe('/r/docs/plan.md');
    expect(destinationFor('/r/docs/plan.md', DOC, null)).toBe('/r/docs/plan.md');
  });

  it('wraps spaces, parentheses and < in <…>, never percent-encodes them', () => {
    expect(destinationFor('/r/my notes/b.md', DOC, ROOT)).toBe('<../my notes/b.md>');
    expect(destinationFor('/r/docs/a (1).md', DOC, ROOT)).toBe('<a (1).md>');
    expect(destinationFor('/r/docs/a<b.md', DOC, ROOT)).toBe('<a\\<b.md>');
  });

  it('encodes only # and %, so the path reads back unchanged', () => {
    expect(destinationFor('/r/docs/a#b%.md', DOC, ROOT)).toBe('a%23b%25.md');
  });

  it('round-trips through resolveLinkTarget', () => {
    for (const target of ['/r/my notes/a#b%(1).md', '/r/docs/plan.md', '/x/y z.md', '/r/q<r>.md']) {
      const dest = destinationFor(target, DOC, ROOT);
      expect(resolveLinkTarget(dest, DOC, null)).toEqual({ kind: 'file', path: target, fragment: null });
    }
  });
});

describe('labels', () => {
  it('labelFor', () => {
    expect(labelFor({ path: '/n/2026-10-24-ab12.md', title: 'Ideas' })).toBe('Ideas');
    expect(labelFor({ path: '/r/plan.md', title: null })).toBe('plan');
    expect(labelFor({ path: '/r/README.markdown', title: null })).toBe('README');
    expect(labelFor({ path: '/r/data.csv', title: null })).toBe('data.csv');
    expect(labelFor({ path: '/r/plan.md', title: '   ' })).toBe('plan');
  });

  it('escapeLabel', () => {
    expect(escapeLabel('a [b] \\c')).toBe('a \\[b\\] \\\\c');
  });

  it('linkMarkdownFor', () => {
    expect(linkMarkdownFor({ path: '/r/docs/plan.md', title: null }, DOC, ROOT)).toBe('[plan](plan.md)');
    expect(linkMarkdownFor({ path: '/n/x.md', title: 'A [draft]' }, DOC, ROOT)).toBe('[A \\[draft\\]](/n/x.md)');
  });
});

describe('formatPathDestination and wrapDestination', () => {
  it('a URL keeps its # and %', () => {
    expect(wrapDestination('https://x.test/a%20b#c')).toBe('https://x.test/a%20b#c');
  });

  it('a path encodes them', () => {
    expect(formatPathDestination('a#b.md')).toBe('a%23b.md');
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/links/link-destination.test.ts`
Expected: FAIL — `Failed to resolve import "./link-destination"`.

- [x] **Step 3: Implement**

```ts
// src/lib/links/link-destination.ts
import { basename, dirOf, normalizePath } from './link-target';

/**
 * What a picked or dropped file becomes in the document (file-links D6):
 * plain CommonMark `[label](destination)`, readable by GitHub, agents and
 * every other editor.
 */

export function isInside(root: string, path: string): boolean {
  const r = normalizePath(root);
  const p = normalizePath(path);
  return r === '/' || p === r || p.startsWith(`${r}/`);
}

/** `to` relative to the directory `fromDir`; `''` for the directory itself. */
export function relativePath(fromDir: string, to: string): string {
  const a = normalizePath(fromDir).split('/').filter(Boolean);
  const b = normalizePath(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

const NEEDS_ANGLE = /[\s()<>]/;

/** CommonMark's `<…>` form when the destination has spaces, parentheses or `<`; `<`/`>` inside are escaped. */
export function wrapDestination(dest: string): string {
  return NEEDS_ANGLE.test(dest) ? `<${dest.replace(/[<>]/g, (c) => `\\${c}`)}>` : dest;
}

/**
 * A file path as a destination. Only `%` and `#` are encoded: `#` would start
 * a fragment and `%` an escape when the link is read back
 * (`resolveLinkTarget`). Everything else stays readable.
 */
export function formatPathDestination(path: string): string {
  return wrapDestination(path.replace(/%/g, '%25').replace(/#/g, '%23'));
}

/**
 * Relative to the document's folder when the document has a path and the
 * target is inside the same project root (Rust's `project_root`: the git
 * toplevel, or the document's folder outside git); absolute otherwise.
 * `./` is never written; `../` is.
 */
export function destinationFor(target: string, docPath: string | null, projectRoot: string | null): string {
  if (docPath && projectRoot && isInside(projectRoot, docPath) && isInside(projectRoot, target)) {
    return formatPathDestination(relativePath(dirOf(docPath), target));
  }
  return formatPathDestination(normalizePath(target));
}

/** A stash note's title; a markdown file's name without `.md`/`.markdown`; any other file's full name. */
export function labelFor(item: { path: string; title: string | null }): string {
  const title = item.title?.trim();
  if (title) return title;
  const name = basename(item.path);
  return name.replace(/\.(md|markdown)$/i, '');
}

/** Brackets and backslashes in a label are escaped, so the label cannot end the link early. */
export function escapeLabel(label: string): string {
  return label.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

export function linkMarkdownFor(
  item: { path: string; title: string | null },
  docPath: string | null,
  projectRoot: string | null
): string {
  return `[${escapeLabel(labelFor(item))}](${destinationFor(item.path, docPath, projectRoot)})`;
}
```

- [x] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/links/link-destination.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/lib/links/link-destination.ts src/lib/links/link-destination.test.ts
git commit -m "feat(links): label and relative destination for an inserted link

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Filtering and ranking (D5)

**Files:**
- Create: `src/lib/links/link-filter.ts`
- Test: `src/lib/links/link-filter.test.ts`

- [x] **Step 1: Write the failing tests**

```ts
// src/lib/links/link-filter.test.ts
import { describe, expect, it } from 'vitest';
import {
  PER_GROUP_EMPTY,
  dedupByGroup,
  displayDir,
  isUrlQuery,
  matchQuality,
  pickerItems,
  type PickerItem,
} from './link-filter';
import type { LinkCandidate, LinkCandidates } from './types';

const c = (path: string, group: LinkCandidate['group'], title: string | null = null, window: number | null = null): LinkCandidate => ({
  path,
  group,
  title,
  window,
});

const data = (candidates: LinkCandidate[], extra: Partial<LinkCandidates> = {}): LinkCandidates => ({
  candidates,
  truncated: false,
  projectRoot: '/r',
  docPath: '/r/doc.md',
  ...extra,
});

const labels = (items: PickerItem[]) =>
  items.map((i) => (i.kind === 'candidate' ? i.label : i.kind === 'url' ? `url:${i.url}` : 'choose'));

describe('dedupByGroup', () => {
  it('keeps a path once, in its highest group, with any title it had', () => {
    const got = dedupByGroup([c('/r/a.md', 'recent'), c('/r/a.md', 'tab'), c('/r/a.md', 'stash', 'Alpha')]);
    expect(got).toEqual([c('/r/a.md', 'tab', 'Alpha')]);
  });
});

describe('matchQuality', () => {
  it('prefix of the name > word start > subsequence > none', () => {
    expect(matchQuality('pla', 'plan', 'docs/plan.md')).toBe(3);
    expect(matchQuality('all', 'github-allowlist', 'docs/github-allowlist.md')).toBe(2);
    expect(matchQuality('docs', 'plan', 'docs/plan.md')).toBe(2);
    expect(matchQuality('gal', 'github-allowlist', 'x.md')).toBe(1);
    expect(matchQuality('my plan', 'my-plan', 'my-plan.md')).toBe(1);
    expect(matchQuality('zzz', 'plan', 'docs/plan.md')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(matchQuality('PL', 'plan', 'plan.md')).toBe(3);
  });
});

describe('pickerItems', () => {
  it('empty query: every group in order, at most 8 each, Choose file last', () => {
    const many = Array.from({ length: 12 }, (_, i) => c(`/r/p${i}.md`, 'project'));
    const items = pickerItems(data([c('/r/t.md', 'tab'), ...many, c('/x/r.md', 'recent'), c('/n/s.md', 'stash', 'Stash note')]), '');
    expect(labels(items)).toEqual(['t', ...many.slice(0, PER_GROUP_EMPTY).map((x) => x.path.slice(3, -3)), 'r', 'Stash note', 'choose']);
  });

  it('never offers the document itself', () => {
    expect(labels(pickerItems(data([c('/r/doc.md', 'tab'), c('/r/a.md', 'tab')]), ''))).toEqual(['a', 'choose']);
  });

  it('ranks by group, then match quality, then natural order', () => {
    const items = pickerItems(
      data([c('/r/x-plan.md', 'project'), c('/r/plan.md', 'project'), c('/r/old-plan.md', 'recent'), c('/r/planet.md', 'tab')]),
      'plan'
    );
    expect(labels(items)).toEqual(['planet', 'plan', 'x-plan', 'old-plan', 'choose']);
  });

  it('a URL query offers Link to URL first and Choose file last', () => {
    expect(labels(pickerItems(data([c('/r/a.md', 'tab')]), 'https://x.test/a'))).toEqual(['url:https://x.test/a', 'choose']);
  });

  it('with nothing to offer still offers Choose file', () => {
    expect(labels(pickerItems(data([]), 'zzz'))).toEqual(['choose']);
  });

  it('isUrlQuery', () => {
    expect(isUrlQuery('http://a')).toBe(true);
    expect(isUrlQuery('HTTPS://a/b?c')).toBe(true);
    expect(isUrlQuery('plan')).toBe(false);
    expect(isUrlQuery('https://a b')).toBe(false);
  });
});

describe('displayDir', () => {
  it('names the project for a file inside it', () => {
    expect(displayDir('/r/docs/plan.md', '/r', '/Users/me')).toBe('r/docs');
    expect(displayDir('/r/plan.md', '/r', '/Users/me')).toBe('r');
  });

  it('abbreviates home elsewhere', () => {
    expect(displayDir('/Users/me/couplet/n.md', '/r', '/Users/me')).toBe('~/couplet');
    expect(displayDir('/tmp/x.md', '/r', '/Users/me')).toBe('/tmp');
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/links/link-filter.test.ts`
Expected: FAIL — `Failed to resolve import "./link-filter"`.

- [x] **Step 3: Implement**

```ts
// src/lib/links/link-filter.ts
import type { LinkCandidate, LinkCandidates, LinkGroup } from './types';
import { isInside, labelFor, relativePath } from './link-destination';
import { basename, dirOf } from './link-target';

/**
 * The picker's own filtering (file-links D5; the completion result says
 * `filter: false`): case-insensitive subsequence over the label and the
 * project-relative path, ranked by group, then match quality, then the
 * source's natural order — which Rust already made the recency order.
 */

export const GROUP_ORDER: readonly LinkGroup[] = ['tab', 'project', 'recent', 'stash'];
/** Empty query: this many per group. */
export const PER_GROUP_EMPTY = 8;
/** A query: at most this many matches overall. */
export const MAX_MATCHES = 50;

export type PickerItem =
  | { kind: 'url'; url: string }
  | { kind: 'candidate'; candidate: LinkCandidate; label: string }
  | { kind: 'choose' };

export function isUrlQuery(query: string): boolean {
  return /^https?:\/\/\S+$/i.test(query.trim());
}

function rank(group: LinkGroup): number {
  return GROUP_ORDER.indexOf(group);
}

/** Each path once, in its highest group (D5), carrying a title any copy had. Order otherwise kept. */
export function dedupByGroup(list: readonly LinkCandidate[]): LinkCandidate[] {
  const best = new Map<string, LinkCandidate>();
  const titles = new Map<string, string>();
  for (const cand of list) {
    if (cand.title && !titles.has(cand.path)) titles.set(cand.path, cand.title);
    const prev = best.get(cand.path);
    if (!prev || rank(cand.group) < rank(prev.group)) best.set(cand.path, cand);
  }
  return list
    .filter((cand) => best.get(cand.path) === cand)
    .map((cand) => ({ ...cand, title: cand.title ?? titles.get(cand.path) ?? null }));
}

const WORD_SPLIT = /[\s\-_./]+/;

function isSubsequence(query: string, text: string): boolean {
  let i = 0;
  for (const ch of text) {
    if (i < query.length && ch === query[i]) i++;
  }
  return i === query.length;
}

/** 3 — the label starts with it; 2 — a word of the label or a path segment does; 1 — subsequence; 0 — no match. */
export function matchQuality(query: string, label: string, relPath: string): number {
  const q = query.trim().toLowerCase();
  if (q === '') return 0;
  const l = label.toLowerCase();
  const p = relPath.toLowerCase();
  if (l.startsWith(q)) return 3;
  const startsWord = (text: string) => text.split(WORD_SPLIT).some((w) => w.startsWith(q));
  if (startsWord(l) || startsWord(p)) return 2;
  const compact = q.replace(/\s+/g, '');
  if (isSubsequence(compact, l) || isSubsequence(compact, p)) return 1;
  return 0;
}

function relPathOf(path: string, root: string | null): string {
  return root && isInside(root, path) ? relativePath(root, path) : path;
}

/** The rows of the popup, top to bottom. «Choose file…» is always last. */
export function pickerItems(data: LinkCandidates, query: string): PickerItem[] {
  const q = query.trim();
  const out: PickerItem[] = [];
  const url = isUrlQuery(q);
  if (url) out.push({ kind: 'url', url: q });
  const list = dedupByGroup(data.candidates).filter((cand) => cand.path !== data.docPath);
  if (q === '') {
    for (const group of GROUP_ORDER) {
      for (const cand of list.filter((x) => x.group === group).slice(0, PER_GROUP_EMPTY)) {
        out.push({ kind: 'candidate', candidate: cand, label: labelFor(cand) });
      }
    }
  } else if (!url) {
    const scored = list
      .map((cand, index) => {
        const label = labelFor(cand);
        return { cand, index, label, quality: matchQuality(q, label, relPathOf(cand.path, data.projectRoot)) };
      })
      .filter((x) => x.quality > 0);
    scored.sort((a, b) => rank(a.cand.group) - rank(b.cand.group) || b.quality - a.quality || a.index - b.index);
    for (const x of scored.slice(0, MAX_MATCHES)) out.push({ kind: 'candidate', candidate: x.cand, label: x.label });
  }
  out.push({ kind: 'choose' });
  return out;
}

/** The grey detail of a row: `project/dir` inside the project, `~/…` or the absolute folder elsewhere. */
export function displayDir(path: string, root: string | null, home: string | null): string {
  const dir = dirOf(path);
  if (root && isInside(root, path)) {
    const rel = relativePath(root, dir);
    return rel === '' ? basename(root) : `${basename(root)}/${rel}`;
  }
  if (home && (dir === home || dir.startsWith(`${home}/`))) return `~${dir.slice(home.length)}`;
  return dir;
}
```

- [x] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/links/link-filter.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/lib/links/link-filter.ts src/lib/links/link-filter.test.ts
git commit -m "feat(links): picker filtering, ranking and caps

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Extend `LinkControl` (the plan 02 extension) and wire the app

This is the only change to the interface plan 01 defined. After it, `LinkControl` has nine members; plan 03 adds none.

**Files:**
- Modify: `src/lib/editor/links/open-link.ts` (interface)
- Modify: `src/lib/editor/links/fake-link-control.ts`
- Modify: `src/App.svelte` (imports, `linkControl`)

- [x] **Step 1: Extend the interface**

In `src/lib/editor/links/open-link.ts`, extend the type import:

```ts
import type { LinkCandidates, LinkProject, PathKind } from '../../links/types';
```

(replacing `import type { PathKind } from '../../links/types';`), replace the doc-comment line

```ts
 * Plan 02 adds `candidates`, `project` and `chooseFile` for the picker.
```

with

```ts
 * The last three members serve the `[[` picker and drops (plans 02, 03).
```

and add after `unresolvable(url: string): void;`:

```ts
  /** Picker candidates for the document at `docPath` (`null`: untitled) — `link_candidates`. Rejects when the IPC fails. */
  candidates(docPath: string | null): Promise<LinkCandidates>;
  /** What a link written into `docPath` is relative to — `link_project` (a dropped link, plan 03). */
  project(docPath: string | null): Promise<LinkProject>;
  /** The system open dialog (`FILE_FILTERS`); `null` when cancelled. */
  chooseFile(): Promise<string | null>;
```

- [x] **Step 2: Extend the fake**

In `src/lib/editor/links/fake-link-control.ts`, inside `base` after `unresolvable`, add:

```ts
    candidates: async (docPath) => {
      calls.push(`candidates:${docPath ?? ''}`);
      return { candidates: [], truncated: false, projectRoot: null, docPath };
    },
    project: async (docPath) => {
      calls.push(`project:${docPath ?? ''}`);
      return { projectRoot: null, docPath };
    },
    chooseFile: async () => {
      calls.push('chooseFile');
      return null;
    },
```

- [x] **Step 3: Extend the app's control**

In `src/App.svelte`, replace

```ts
  import { pathKinds, revealInFinder } from './lib/links/ipc';
```

with

```ts
  import { linkCandidates, linkProject, pathKinds, revealInFinder } from './lib/links/ipc';
```

and inside `const linkControl: LinkControl = { … }`, after the `unresolvable` member add:

```ts
    candidates: (docPath) => linkCandidates(docPath),
    project: (docPath) => linkProject(docPath),
    chooseFile: () => showOpenDialog(),
```

(`showOpenDialog` is already imported from `./lib/tauri/commands`.)

- [x] **Step 4: Type check and tests**

Run: `npm run check`
Expected: 0 errors.

Run: `npx vitest run src/lib/editor/links`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/lib/editor/links/open-link.ts src/lib/editor/links/fake-link-control.ts src/App.svelte
git commit -m "feat(links): LinkControl gains candidates, project and chooseFile

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The `[[` completion source (D5, D6)

**Files:**
- Create: `src/lib/editor/links/file-link-source.ts`
- Test: `src/lib/editor/links/file-link-source.test.ts`

- [x] **Step 1: Write the failing tests**

```ts
// src/lib/editor/links/file-link-source.test.ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  CompletionContext,
  autocompletion,
  closeCompletion,
  completionStatus,
  startCompletion,
  type Completion,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { markdownExtension } from '../markdown-language';
import { documentPathField, setDocumentPath } from '../json-fence';
import { fakeLinkControl } from './fake-link-control';
import { createFileLinkSource, linkQueryAt } from './file-link-source';
import type { LinkCandidates } from '../../links/types';
import type { LinkControl } from './open-link';

const DATA: LinkCandidates = {
  candidates: [
    { path: '/r/docs/plan.md', group: 'tab', title: null, window: null },
    { path: '/r/notes/ideas.md', group: 'project', title: null, window: null },
    { path: '/n/2026-10-24-ab12.md', group: 'stash', title: 'Ideas board', window: null },
  ],
  truncated: false,
  projectRoot: '/r',
  docPath: '/r/docs/a.md',
};

function setup(doc: string, pos: number, overrides: Partial<LinkControl> = {}, data: LinkCandidates = DATA) {
  const candidates = vi.fn(async () => data);
  const control = fakeLinkControl({ candidates, ...overrides });
  const { source, extension } = createFileLinkSource(control);
  let state = EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [markdownExtension(), documentPathField, extension],
  });
  state = state.update({ effects: setDocumentPath.of('/r/docs/a.md') }).state;
  return { control, candidates, source, state, extension };
}

const sectionName = (o: Completion) => (typeof o.section === 'object' ? o.section.name : o.section);
const apply = (view: EditorView, option: Completion, from: number, to: number) =>
  (option.apply as (v: EditorView, c: Completion, f: number, t: number) => void)(view, option, from, to);

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
  vi.useRealTimers();
});

describe('linkQueryAt', () => {
  const query = (doc: string, pos = doc.length) => {
    const { state } = setup(doc, pos);
    return linkQueryAt(state, pos);
  };

  it('matches [[query before the caret and swallows an auto-closed ]]', () => {
    expect(query('see [[pl]]', 8)).toEqual({ from: 4, to: 10, query: 'pl' });
  });

  it('without ]] ends at the caret', () => {
    expect(query('see [[pl')).toEqual({ from: 4, to: 8, query: 'pl' });
  });

  it('an empty query right after [[', () => {
    expect(query('[[]]', 2)).toEqual({ from: 0, to: 4, query: '' });
  });

  it('not inside inline code, a fenced block or a link URL', () => {
    expect(query('`[[x`', 4)).toBeNull();
    const fence = '`'.repeat(3);
    expect(query(`${fence}\n[[q\n${fence}`, 7)).toBeNull();
    expect(query('[a](x[[q)', 8)).toBeNull();
  });

  it('nothing without [[', () => {
    expect(query('[pl')).toBeNull();
  });
});

describe('the source', () => {
  it('fetches once per popup: a Promise first, then synchronous answers from the snapshot', async () => {
    const { source, state, candidates } = setup('see [[pl]]', 8);
    const first = source(new CompletionContext(state, 8, false));
    expect(first).toBeInstanceOf(Promise);
    const result = (await first) as CompletionResult;
    expect(result.from).toBe(4);
    expect(result.to).toBe(10);
    expect(result.filter).toBe(false);
    expect(result.options.map((o) => o.label)).toEqual(['plan', 'Choose file…']);
    const second = source(new CompletionContext(state, 8, false));
    expect(second).not.toBeInstanceOf(Promise);
    expect(candidates).toHaveBeenCalledTimes(1);
    expect(candidates).toHaveBeenCalledWith('/r/docs/a.md');
  });

  it('an empty query lists the groups in sections; a cut-short walk says so in its header', async () => {
    const { source, state } = setup('[[', 2, {}, { ...DATA, truncated: true });
    const r = (await source(new CompletionContext(state, 2, false))) as CompletionResult;
    expect(r.options.map((o) => o.label)).toEqual(['plan', 'ideas', 'Ideas board', 'Choose file…']);
    expect(r.options.map(sectionName)).toEqual(['Open tabs', 'Project — not all files listed', 'Stash', 'Elsewhere']);
    expect(r.options.map((o) => o.detail)).toEqual(['r/docs', 'r/notes', '/n', undefined]);
  });

  it('another window’s tab names the window', async () => {
    const data: LinkCandidates = { ...DATA, candidates: [{ path: '/r/docs/b.md', group: 'tab', title: null, window: 3 }] };
    const { source, state } = setup('[[', 2, {}, data);
    const r = (await source(new CompletionContext(state, 2, false))) as CompletionResult;
    expect(r.options[0].detail).toBe('#3 · r/docs');
  });

  it('a failed fetch still offers Choose file', async () => {
    const { source, state } = setup('[[x', 3, { candidates: () => Promise.reject(new Error('down')) });
    const r = (await source(new CompletionContext(state, 3, false))) as CompletionResult;
    expect(r.options.map((o) => o.label)).toEqual(['Choose file…']);
  });

  it('is the same function on every languageData lookup (CLAUDE.md: stable completion source)', () => {
    const { source, state } = setup('[[', 2);
    const a = state.languageDataAt<CompletionSource>('autocomplete', 2);
    const b = state.languageDataAt<CompletionSource>('autocomplete', 2);
    expect(a).toContain(source);
    expect(b.length).toBe(a.length);
    a.forEach((fn, i) => expect(b[i]).toBe(fn));
  });

  it('forgets the snapshot when the popup closes', async () => {
    vi.useFakeTimers();
    const candidates = vi.fn(async () => DATA);
    const { source, extension } = createFileLinkSource(fakeLinkControl({ candidates }));
    view = new EditorView({
      state: EditorState.create({
        doc: '[[',
        selection: { anchor: 2 },
        extensions: [markdownExtension(), documentPathField, autocompletion(), extension],
      }),
    });
    await source(new CompletionContext(view.state, 2, false));
    startCompletion(view);
    expect(completionStatus(view.state)).not.toBeNull();
    closeCompletion(view);
    expect(completionStatus(view.state)).toBeNull();
    const again = source(new CompletionContext(view.state, 2, false));
    expect(again).toBeInstanceOf(Promise);
    await again;
    expect(candidates).toHaveBeenCalledTimes(2);
  });
});

describe('applying a pick', () => {
  it('replaces [[q]] with a markdown link relative to the document', async () => {
    const { source, state } = setup('see [[pl]] end', 8);
    view = new EditorView({ state });
    const r = (await source(new CompletionContext(view.state, 8, false))) as CompletionResult;
    apply(view, r.options[0], r.from, r.to ?? 8);
    expect(view.state.doc.toString()).toBe('see [plan](plan.md) end');
    expect(view.state.selection.main.head).toBe(19);
  });

  it('a stash note is labelled by its title', async () => {
    const { source, state } = setup('[[ideas b]]', 9);
    view = new EditorView({ state });
    const r = (await source(new CompletionContext(view.state, 9, false))) as CompletionResult;
    const note = r.options.find((o) => o.label === 'Ideas board')!;
    apply(view, note, r.from, r.to ?? 9);
    expect(view.state.doc.toString()).toBe('[Ideas board](/n/2026-10-24-ab12.md)');
  });

  it('a URL query offers Link to URL first', async () => {
    const { source, state } = setup('[[https://x.test/a]]', 18);
    view = new EditorView({ state });
    const r = (await source(new CompletionContext(view.state, 18, false))) as CompletionResult;
    expect(r.options[0].label).toBe('Link to https://x.test/a');
    apply(view, r.options[0], r.from, r.to ?? 18);
    expect(view.state.doc.toString()).toBe('[https://x.test/a](https://x.test/a)');
  });

  it('Choose file keeps [[q]] until the dialog answers, then replaces it', async () => {
    let answer: (path: string | null) => void = () => {};
    const chooseFile = () => new Promise<string | null>((resolve) => (answer = resolve));
    const { source, state } = setup('[[x]]', 3, { chooseFile });
    view = new EditorView({ state });
    const r = (await source(new CompletionContext(view.state, 3, false))) as CompletionResult;
    const choose = r.options[r.options.length - 1];
    apply(view, choose, r.from, r.to ?? 3);
    expect(view.state.doc.toString()).toBe('[[x]]');
    answer('/r/notes/new idea.md');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.state.doc.toString()).toBe('[new idea](<../notes/new idea.md>)');
  });

  it('a cancelled dialog leaves [[q]] as typed', async () => {
    const { source, state } = setup('[[x]]', 3, { chooseFile: async () => null });
    view = new EditorView({ state });
    const r = (await source(new CompletionContext(view.state, 3, false))) as CompletionResult;
    apply(view, r.options[r.options.length - 1], r.from, r.to ?? 3);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.state.doc.toString()).toBe('[[x]]');
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/editor/links/file-link-source.test.ts`
Expected: FAIL — `Failed to resolve import "./file-link-source"`.

- [x] **Step 3: Implement**

```ts
// src/lib/editor/links/file-link-source.ts
import {
  closeCompletion,
  completionStatus,
  insertCompletionText,
  pickedCompletion,
  type Completion,
  type CompletionResult,
  type CompletionSection,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { markdownLanguage } from '@codemirror/lang-markdown';
import type { SyntaxNode } from '@lezer/common';
import { documentPathField } from '../json-fence';
import type { LinkControl } from './open-link';
import { escapeLabel, linkMarkdownFor, wrapDestination } from '../../links/link-destination';
import { displayDir, pickerItems, type PickerItem } from '../../links/link-filter';
import type { LinkCandidates } from '../../links/types';
import { t } from '../../i18n';

/** `[[` and what follows it on the line, up to the caret — no bracket, no line break. */
const TRIGGER = /\[\[([^[\]\n]*)$/;

/** Where a `[[` is text, not a picker (Q8). */
const NO_PICKER = new Set([
  'InlineCode',
  'CodeText',
  'FencedCode',
  'CodeBlock',
  'HTMLBlock',
  'HTMLTag',
  'CommentBlock',
  'Comment',
  'URL',
  'Autolink',
]);

export interface LinkQuery {
  /** Start of `[[`. */
  from: number;
  /** The caret, or past a trailing `]]` (`closeBrackets` turns `[[` into `[[|]]`). */
  to: number;
  query: string;
}

export function linkQueryAt(state: EditorState, pos: number): LinkQuery | null {
  const line = state.doc.lineAt(pos);
  const match = TRIGGER.exec(state.sliceDoc(line.from, pos));
  if (!match) return null;
  const from = pos - match[0].length;
  if (!markdownLanguage.isActiveAt(state, from, 1)) return null;
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(from, 1); node; node = node.parent) {
    if (NO_PICKER.has(node.name)) return null;
  }
  const to = state.sliceDoc(pos, pos + 2) === ']]' ? pos + 2 : pos;
  return { from, to, query: match[1] };
}

interface Sections {
  link: CompletionSection;
  tab: CompletionSection;
  project: CompletionSection;
  projectTruncated: CompletionSection;
  recent: CompletionSection;
  stash: CompletionSection;
  other: CompletionSection;
}

let sections: Sections | null = null;

/** Built on first use, not at import: the catalog is installed after modules load. */
function sectionsNow(): Sections {
  if (!sections) {
    sections = {
      link: { name: t('editor.links.section_link'), rank: 0 },
      tab: { name: t('editor.links.section_tabs'), rank: 1 },
      project: { name: t('editor.links.section_project'), rank: 2 },
      projectTruncated: { name: t('editor.links.section_project_truncated'), rank: 2 },
      recent: { name: t('editor.links.section_recent'), rank: 3 },
      stash: { name: t('editor.links.section_stash'), rank: 4 },
      other: { name: t('editor.links.section_other'), rank: 5 },
    };
  }
  return sections;
}

function insertLink(view: EditorView, completion: Completion, from: number, to: number, text: string): void {
  view.dispatch({ ...insertCompletionText(view.state, text, from, to), annotations: pickedCompletion.of(completion) });
}

/** Q9: `[[query]]` stays while the dialog is open; replaced only if nothing changed meanwhile. */
function chooseAndInsert(view: EditorView, control: LinkControl, data: LinkCandidates, from: number, to: number): void {
  const doc = view.state.doc;
  closeCompletion(view);
  control
    .chooseFile()
    .then((path) => {
      if (!path || view.state.doc !== doc) return;
      const text = linkMarkdownFor({ path, title: null }, data.docPath, data.projectRoot);
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        userEvent: 'input.complete',
        scrollIntoView: true,
      });
      view.focus();
    })
    .catch((err: unknown) => console.error('Choose file failed:', err));
}

function optionFor(control: LinkControl, data: LinkCandidates, item: PickerItem, home: string | null): Completion {
  const s = sectionsNow();
  switch (item.kind) {
    case 'url':
      return {
        label: t('editor.links.link_to', { url: item.url }),
        type: 'link-url',
        section: s.link,
        apply: (view, completion, from, to) =>
          insertLink(view, completion, from, to, `[${escapeLabel(item.url)}](${wrapDestination(item.url)})`),
      };
    case 'choose':
      return {
        label: t('editor.links.choose_file'),
        type: 'link-choose',
        section: s.other,
        apply: (view, _completion, from, to) => chooseAndInsert(view, control, data, from, to),
      };
    case 'candidate': {
      const cand = item.candidate;
      const section = cand.group === 'project' && data.truncated ? s.projectTruncated : s[cand.group];
      const dir = displayDir(cand.path, data.projectRoot, home);
      return {
        label: item.label,
        detail: cand.window !== null ? `#${cand.window} · ${dir}` : dir,
        type: 'link-file',
        section,
        apply: (view, completion, from, to) =>
          insertLink(view, completion, from, to, linkMarkdownFor(cand, data.docPath, data.projectRoot)),
      };
    }
  }
}

function resultFor(control: LinkControl, data: LinkCandidates, q: LinkQuery): CompletionResult {
  const home = control.home();
  return {
    from: q.from,
    to: q.to,
    filter: false,
    options: pickerItems(data, q.query).map((item) => optionFor(control, data, item, home)),
  };
}

export interface FileLinkSource {
  /** Exposed for tests; the editor gets it only through `extension`. */
  source: CompletionSource;
  extension: Extension;
}

/**
 * The one picker behind `[[` and `/link` (file-links D5).
 *
 * Built ONCE per editor state by `createExtensions` — the source and the
 * `languageData` record are created here, outside the `.of()` arrow, because
 * CM6 calls that arrow on every lookup and compares the providers by
 * identity; a fresh closure per lookup leaves the popup `pending` forever
 * (CLAUDE.md, "A completion source must be a STABLE reference").
 *
 * Candidates are fetched when the popup opens and kept for the life of that
 * popup: the first query returns a Promise, every later keystroke filters the
 * snapshot synchronously. The snapshot is dropped when the completion closes
 * (pick, Esc, caret leaving `[[`), so the next popup sees fresh tabs.
 */
export function createFileLinkSource(control: LinkControl): FileLinkSource {
  let session = 0;
  let snapshot: LinkCandidates | null = null;
  let inflight: Promise<LinkCandidates> | null = null;

  function candidates(docPath: string | null): Promise<LinkCandidates> {
    if (inflight) return inflight;
    const mine = session;
    inflight = control
      .candidates(docPath)
      .catch((err: unknown): LinkCandidates => {
        console.error('link_candidates failed:', err);
        return { candidates: [], truncated: false, projectRoot: null, docPath };
      })
      .then((data) => {
        if (session === mine) {
          snapshot = data;
          inflight = null;
        }
        return data;
      });
    return inflight;
  }

  const source: CompletionSource = (context) => {
    const q = linkQueryAt(context.state, context.pos);
    if (!q) return null;
    if (snapshot) return resultFor(control, snapshot, q);
    const docPath = context.state.field(documentPathField, false) ?? null;
    return candidates(docPath).then((data) => resultFor(control, data, q));
  };

  const data = [{ autocomplete: source }];
  const extension: Extension = [
    EditorState.languageData.of(() => data),
    EditorView.updateListener.of((update) => {
      if (completionStatus(update.startState) !== null && completionStatus(update.state) === null) {
        session++;
        snapshot = null;
        inflight = null;
      }
    }),
  ];
  return { source, extension };
}
```

- [x] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/editor/links/file-link-source.test.ts`
Expected: PASS.

- [x] **Step 5: Type check**

Run: `npm run check`
Expected: 0 errors.

- [x] **Step 6: Commit**

```bash
git add src/lib/editor/links/file-link-source.ts src/lib/editor/links/file-link-source.test.ts
git commit -m "feat(links): [[ file link picker as one stable completion source

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `/link` and installing the picker

**Files:**
- Create: `src/lib/editor/links/slash-link.ts`
- Modify: `src/lib/editor/setup.ts`
- Test: `src/lib/editor/links/slash-link.test.ts`

- [x] **Step 1: Write the failing tests**

```ts
// src/lib/editor/links/slash-link.test.ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  CompletionContext,
  autocompletion,
  completionStatus,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { markdownExtension } from '../markdown-language';
import { slashCommands } from '../slash-commands';
import { createDocumentState } from '../state-factory';
import { fakeLinkControl } from './fake-link-control';
import { createFileLinkSource } from './file-link-source';
import { linkAction } from './slash-link';

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
  vi.useRealTimers();
});

describe('/link', () => {
  it('is offered by the slash menu', () => {
    const state = EditorState.create({ doc: '/li', extensions: [slashCommands([linkAction()])] });
    const source = state.languageDataAt<CompletionSource>('autocomplete', 3)[0];
    const result = source(new CompletionContext(state, 3, true)) as CompletionResult;
    expect(result.options.find((o) => o.label === '/link')?.detail).toBe('Link to a file');
  });

  it('inserts [[]] with the caret inside and opens the picker', () => {
    vi.useFakeTimers();
    // The picker's own source is installed, so starting a completion has a
    // source to be pending on.
    view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [markdownExtension(), autocompletion(), createFileLinkSource(fakeLinkControl()).extension],
      }),
    });
    linkAction().run(view);
    expect(view.state.doc.toString()).toBe('[[]]');
    expect(view.state.selection.main.head).toBe(2);
    expect(completionStatus(view.state)).not.toBeNull();
  });

  it('is installed, with the [[ picker, only together with a LinkControl', () => {
    const withControl = createDocumentState('[[', 2, [], { linkControl: fakeLinkControl() });
    const without = createDocumentState('[[', 2, []);
    expect(withControl.languageDataAt('autocomplete', 2).length).toBeGreaterThan(
      without.languageDataAt('autocomplete', 2).length
    );
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/editor/links/slash-link.test.ts`
Expected: FAIL — `Failed to resolve import "./slash-link"`.

- [x] **Step 3: Implement the action**

```ts
// src/lib/editor/links/slash-link.ts
import { startCompletion } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { SlashAction } from '../slash-actions';
import { t } from '../../i18n';

/**
 * Insert `[[]]` at the caret, caret inside, and open the `[[` picker — the
 * same completion source, no second picker machinery (file-links D5).
 */
export function openLinkPicker(view: EditorView): void {
  const pos = view.state.selection.main.head;
  view.dispatch({ changes: { from: pos, insert: '[[]]' }, selection: { anchor: pos + 2 }, userEvent: 'input' });
  startCompletion(view);
}

/**
 * `/link` in the slash menu (line start, like every slash command). The
 * generic action apply in `slash-commands.ts` deletes the typed `/link`
 * before `run`.
 */
export function linkAction(): SlashAction {
  return {
    id: 'link',
    label: '/link',
    detail: t('editor.slash_link.action_detail'),
    run: (view) => openLinkPicker(view),
  };
}
```

- [x] **Step 4: Install both in `setup.ts`**

Add imports after `import { linkExistence } from './links/link-existence';`:

```ts
import { createFileLinkSource } from './links/file-link-source';
import { linkAction } from './links/slash-link';
```

Replace the `actions` array:

```ts
  const actions: SlashAction[] = [
    ...(themeControl ? [themeAction(themeControl), toneAction(themeControl)] : []),
    ...(stashControl ? [stashAction(stashControl)] : []),
  ];
```

with:

```ts
  const actions: SlashAction[] = [
    ...(themeControl ? [themeAction(themeControl), toneAction(themeControl)] : []),
    ...(stashControl ? [stashAction(stashControl)] : []),
    ...(linkControl ? [linkAction()] : []),
  ];
```

Right after the line `slashCommands(actions),` add:

```ts
    // `[[` file picker (file-links D5). One source per state, built here once.
    ...(linkControl ? [createFileLinkSource(linkControl).extension] : []),
```

- [x] **Step 5: Run the tests**

Run: `npx vitest run src/lib/editor/links src/lib/editor/slash-commands.test.ts src/lib/editor/state-factory.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: 0 errors.

- [x] **Step 6: Commit**

```bash
git add src/lib/editor/links/slash-link.ts src/lib/editor/links/slash-link.test.ts src/lib/editor/setup.ts
git commit -m "feat(links): /link slash action and the [[ picker in the editor

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Tell agents (D8)

**Files:**
- Modify: `src-tauri/src/ai_socket.rs` (`AGENT_SNIPPET` ~1932, `MCP_AGENT_SNIPPET` ~2006)
- Modify: `docs/ai-interface.md` (~407, ~440)
- Test: `ai_socket::tests::the_docs_carry_both_snippets_verbatim` and `onboarding::tests::connect_doc_carries_both_snippets_verbatim` (existing)

- [x] **Step 1: Make the docs change first (the sync test then fails)**

In `docs/ai-interface.md`, replace the line

```markdown
- `couplet ls` — the open windows: number, project, tabs (`--json` for machine-readable output). `couplet close <file>` — close a tab you opened and no longer need.
```

with

```markdown
- `couplet ls` — the open windows: number, project, tabs (`--json` for machine-readable output). `couplet close <file>` — close a tab you opened and no longer need.
- When a document refers to another file, write a relative markdown link — `[plan](docs/plan.md)`, relative to the document you write in. couplet opens it on ⌘-click (`plan.md#risks` jumps to that heading).
```

and the line

```markdown
- Close what you opened and no longer need with `close` — hygiene, not isolation.
```

with

```markdown
- Close what you opened and no longer need with `close` — hygiene, not isolation.
- When a document refers to another file, write a relative markdown link — `[plan](docs/plan.md)`, relative to that document. couplet opens it on ⌘-click (`plan.md#risks` jumps to that heading).
```

- [x] **Step 2: Run the sync test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml the_docs_carry_both_snippets_verbatim`
Expected: FAIL — `docs/ai-interface.md is out of sync with AGENT_SNIPPET`.

- [x] **Step 3: Make the same change in the constants**

In `src-tauri/src/ai_socket.rs`, inside `AGENT_SNIPPET`, after the line

```
- `couplet ls` — the open windows: number, project, tabs (`--json` for machine-readable output). `couplet close <file>` — close a tab you opened and no longer need.
```

add the line

```
- When a document refers to another file, write a relative markdown link — `[plan](docs/plan.md)`, relative to the document you write in. couplet opens it on ⌘-click (`plan.md#risks` jumps to that heading).
```

Inside `MCP_AGENT_SNIPPET`, after the line

```
- Close what you opened and no longer need with `close` — hygiene, not isolation.
```

add the line

```
- When a document refers to another file, write a relative markdown link — `[plan](docs/plan.md)`, relative to that document. couplet opens it on ⌘-click (`plan.md#risks` jumps to that heading).
```

- [x] **Step 4: Run the snippet tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml snippet`
Expected: PASS — includes `the_docs_carry_both_snippets_verbatim`, `connect_doc_carries_both_snippets_verbatim`, and the MCP-snippet "no CLI syntax" check.

- [x] **Step 5: Commit**

```bash
git add src-tauri/src/ai_socket.rs docs/ai-interface.md
git commit -m "docs(links): tell agents to write relative markdown links

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Verification

**Files:** none changed (fix-forward commits only if a check fails).

- [x] **Step 1: Frontend**

Run: `npx vitest run --dir src`
Expected: all green.

Run: `npm run check`
Expected: 0 errors, no new warnings.

Run: `npx vite build --config vite.config.site.ts --outDir /tmp/couplet-site-check --emptyOutDir`
Expected: `✓ built`; `git status --short docs/` prints nothing.

- [x] **Step 2: Rust**

Run: `cd src-tauri && cargo test`
Expected: all green.

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml`
Expected: no new warnings.

Run: `npm run check:x86`
Expected: `Finished`.

- [x] **Step 3: Live check**

```bash
lsof -ti:1420 | xargs kill -9 2>/dev/null; npm run dev:app -- --features mcp-bridge \
  --config '{"app":{"windows":[{"title":"file-links 02 · local"}]}}'
```

Use the `/tmp/fl` folder from plan 01 (a git repo with `index.md`, `docs/plan.md`); add `mkdir -p /tmp/fl/node_modules/x && echo x > /tmp/fl/node_modules/x/skip.md`. Open `index.md` and `docs/plan.md` in window #1, any file from another folder in window #2; put one note in the stash (⌃T on an untitled tab with text).

- [x] In `index.md`, on a new line type `[[` → `[[]]` with a popup: «Open tabs» (`plan`), the other window's tab with `#2 · …`, «Project» files (no `skip.md`), «Recent», «Stash» (the note by its title), «Choose file…» last.
- [x] Type `pl` → `plan` first; Enter → `[plan](docs/plan.md)`; ⌘-click it opens the tab.
- [x] `[[` then Esc → `[[]]` stays as text.
- [x] `[[https://example.com` → first row «Link to https://example.com»; Enter → `[https://example.com](https://example.com)`.
- [ ] «Choose file…» → the system dialog; pick `/tmp/fl/docs/plan.md` → `[plan](docs/plan.md)`; cancel → `[[…]]` unchanged. — *not driven live (an agent must not block on a native dialog): the option is there; insert, cancel and the `/tmp` → `/private/tmp` spelling are unit-tested.*
- [x] `/link` at line start → `[[]]` and the popup.
- [x] Inside a fenced code block and inside `` `inline code` `` typing `[[` opens nothing; in a `.py` tab nothing.
- [x] An untitled tab: a pick writes an absolute path.
- [x] Drop 6 000 empty `.md` files into `/tmp/fl/many/` (`for i in $(seq 6000); do : > /tmp/fl/many/f$i.md; done`), wait 30 s (cache), `[[` → the Project header reads «Project — not all files listed» and the popup appears without a visible stall.
- [x] `couplet agent | grep "relative markdown link"` (with the dev binary: `<target>/debug/md-mini ai agent` — the bare binary has no `agent` verb and opens a file named `agent`) prints the new line.

- [x] **Step 4: Commit any fixes**

If a live check needed a fix, commit it with explicit paths (`fix(links): …` + the `Co-Authored-By` line). Otherwise nothing to commit.
