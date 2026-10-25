//! File links (docs/superpowers/specs/2026-10-24-file-links-design.md): what a
//! linked path is on disk, and the link picker's candidates (D5).

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::tabs::TabRegistry;

/// What a path is, as a link router needs to know it (D2): a regular file
/// may open as a document, anything else is shown in Finder, a missing one
/// gets the «Create» toast. Symlinks are followed; a dangling one is `Other`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PathKind {
    File,
    Dir,
    Missing,
    Other,
}

/// `metadata` only — never opens the file, so a FIFO or a dataless iCloud
/// file cannot hang the call. A relative path is refused as missing: the
/// webview always sends an absolute one, and a relative one would resolve
/// against the app's working directory.
pub fn path_kind(path: &Path) -> PathKind {
    if !path.is_absolute() {
        return PathKind::Missing;
    }
    match std::fs::metadata(path) {
        Ok(m) if m.is_file() => PathKind::File,
        Ok(m) if m.is_dir() => PathKind::Dir,
        Ok(_) => PathKind::Other,
        Err(_) if std::fs::symlink_metadata(path).is_ok() => PathKind::Other,
        Err(_) => PathKind::Missing,
    }
}

/// One call answers at most this many paths (the existence check batches the
/// links in the viewport; the router asks for one).
pub const MAX_PATH_KINDS: usize = 256;

#[tauri::command]
pub async fn path_kinds(paths: Vec<String>) -> Result<Vec<PathKind>, String> {
    if paths.len() > MAX_PATH_KINDS {
        return Err(format!("at most {MAX_PATH_KINDS} paths per call"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        paths.iter().map(|p| path_kind(Path::new(p))).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

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
            out.push(LinkCandidate {
                path,
                group,
                title,
                window,
            });
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
pub fn tab_paths(
    reg: &TabRegistry,
    caller: &str,
    is_live: impl Fn(&str) -> bool,
) -> Vec<(String, Option<u32>)> {
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
        Some(doc) => {
            crate::git_info::project_root(Path::new(doc)).map(|p| p.to_string_lossy().into_owned())
        }
        None => crate::tab_commands::project_root_of(app, label),
    };
    LinkProject {
        project_root,
        doc_path,
    }
}

fn recent_paths(app: &AppHandle) -> Vec<String> {
    let Some(recent) = app.try_state::<crate::recent::RecentFiles>() else {
        return Vec::new();
    };
    existing_normalized(
        recent
            .snapshot()
            .files
            .into_iter()
            .map(|f| f.path)
            .collect(),
    )
}

/// Recent files that still exist (Q7: a deleted one would only make a dead
/// link), in `path_norm` spelling so they dedup against tabs and the
/// document. At most ten paths, one `stat` and one canonicalize each, with
/// no lock held.
fn existing_normalized(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| Path::new(p).exists())
        .map(|p| crate::path_norm::normalize_str(&p))
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
        Ok(page) => page
            .entries
            .into_iter()
            .map(|e| (e.path, e.title))
            .collect(),
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
            project: walk
                .files
                .iter()
                .map(|f| f.path.to_string_lossy().into_owned())
                .collect(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "couplet-links-{}-{}",
            tag,
            crate::session::new_tab_id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_regular_file_is_a_file_and_a_folder_is_a_dir() {
        let dir = scratch("kinds");
        fs::write(dir.join("a.md"), "x").unwrap();
        assert_eq!(path_kind(&dir.join("a.md")), PathKind::File);
        assert_eq!(path_kind(&dir), PathKind::Dir);
    }

    #[test]
    fn a_missing_or_relative_path_is_missing() {
        let dir = scratch("missing");
        assert_eq!(path_kind(&dir.join("nope.md")), PathKind::Missing);
        assert_eq!(path_kind(Path::new("relative.md")), PathKind::Missing);
    }

    #[test]
    fn a_symlink_is_followed_and_a_dangling_one_is_other() {
        let dir = scratch("links");
        fs::write(dir.join("real.md"), "x").unwrap();
        std::os::unix::fs::symlink(dir.join("real.md"), dir.join("alias.md")).unwrap();
        std::os::unix::fs::symlink(dir.join("gone.md"), dir.join("dangling.md")).unwrap();
        assert_eq!(path_kind(&dir.join("alias.md")), PathKind::File);
        assert_eq!(path_kind(&dir.join("dangling.md")), PathKind::Other);
    }

    #[test]
    fn kinds_serialize_lowercase() {
        assert_eq!(
            serde_json::to_string(&PathKind::Missing).unwrap(),
            "\"missing\""
        );
    }

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
        assert_eq!(
            got,
            vec![
                ("/r/b.md".to_string(), None),
                ("/r/a.md".to_string(), Some(1))
            ]
        );
    }

    #[test]
    fn merge_keeps_each_path_once_in_its_highest_group_and_drops_the_document() {
        let got = merge_candidates(
            Some("/r/doc.md"),
            CandidateSources {
                tabs: vec![
                    ("/r/doc.md".into(), None),
                    ("/r/a.md".into(), None),
                    ("/r/b.md".into(), Some(2)),
                ],
                project: vec!["/r/a.md".into(), "/r/c.md".into()],
                recent: vec!["/r/c.md".into(), "/x/d.md".into()],
                stash: vec![
                    ("/n/note.md".into(), Some("Ideas".into())),
                    ("/r/a.md".into(), Some("A title".into())),
                ],
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
            CandidateSources {
                stash: vec![("/n/a.md".into(), Some("  ".into()))],
                ..Default::default()
            },
        );
        assert_eq!(got[0].title, None);
    }

    #[test]
    fn candidates_serialize_camel_case() {
        let json = serde_json::to_value(LinkCandidates {
            candidates: vec![LinkCandidate {
                path: "/r/a.md".into(),
                group: LinkGroup::Project,
                title: None,
                window: None,
            }],
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

    #[test]
    fn recent_paths_are_normalized_and_missing_ones_dropped() {
        let dir = scratch("recent");
        fs::write(dir.join("a.md"), "x").unwrap();
        let alias = scratch("recent-alias").join("link");
        std::os::unix::fs::symlink(&dir, &alias).unwrap();
        let got = existing_normalized(vec![
            alias.join("a.md").to_string_lossy().into_owned(),
            dir.join("gone.md").to_string_lossy().into_owned(),
        ]);
        let real = dir.join("a.md").canonicalize().unwrap();
        assert_eq!(got, vec![real.to_string_lossy().into_owned()]);
    }
}
