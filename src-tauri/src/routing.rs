//! Where a file an agent (or a `-t`/`-b` CLI call) opens lands — spec §5 —
//! and the project every window is bound to (spec §2).

use std::path::Path;

use tauri::{AppHandle, Manager};

use crate::ai_socket::{ListedTab, WindowListing};
use crate::tabs::TabRegistry;

/// The project `path` belongs to, as the absolute path of its root — see
/// `git_info::project_root`. A path that cannot be looked at is its own
/// project: it then matches no window but one bound to that very string.
pub fn project_of(path: &str) -> String {
    crate::git_info::project_root(Path::new(path))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Bind every window that holds a file but has no project yet. The walk up
/// the directories runs outside the registry lock; a window bound (or
/// closed) meanwhile keeps what it has.
pub fn bind_missing_projects(app: &AppHandle) {
    let unbound = {
        let open_files = app.state::<crate::window::OpenFiles>();
        let reg = open_files.0.lock().unwrap();
        reg.unbound_windows()
    };
    if unbound.is_empty() {
        return;
    }
    let found: Vec<(String, String)> = unbound
        .into_iter()
        .map(|(label, path)| (label, project_of(&path)))
        .collect();
    let open_files = app.state::<crate::window::OpenFiles>();
    let mut reg = open_files.0.lock().unwrap();
    for (label, project) in found {
        if reg.window(&label).is_some() {
            reg.bind_project(&label, project);
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    /// This live window takes it.
    Existing(String),
    /// Step 4: a new window, bound to the file's project by its first file.
    NewWindow,
    /// The `window_binding` names no live window (spec §3).
    DeadNumber(u32),
}

/// Spec §5, in order: a dead `binding` is an error; the file already open →
/// its window, even when `binding` names another one (one file is one tab
/// app-wide, and the answer names the window it is really in); a live
/// `binding`; a live window of `file_project`, the most recently focused one
/// (`focus_order`, most recent first; windows never focused in label order);
/// else a new window.
pub fn route(
    reg: &TabRegistry,
    path: &str,
    binding: Option<u32>,
    file_project: &str,
    focus_order: &[String],
    is_live: impl Fn(&str) -> bool,
) -> Route {
    let bound = match binding {
        Some(number) => match reg.live_label_with_number(number, &is_live) {
            Some(label) => Some(label),
            None => return Route::DeadNumber(number),
        },
        None => None,
    };
    if let Some(owner) = reg.label_of(path).filter(|l| is_live(l)) {
        return Route::Existing(owner);
    }
    if let Some(label) = bound {
        return Route::Existing(label);
    }
    let rank = |label: &str| {
        (
            focus_order.iter().position(|l| l == label).unwrap_or(usize::MAX),
            crate::session::label_order(label),
        )
    };
    reg.all_windows()
        .filter(|(label, w)| w.project.as_deref() == Some(file_project) && is_live(label))
        .map(|(label, _)| label.clone())
        .min_by_key(|label| rank(label))
        .map_or(Route::NewWindow, Route::Existing)
}

/// `route` for the live app: projects bound first, the focus order from
/// `FocusTracker`. The tracker's lock is released before the registry's.
pub fn route_now(app: &AppHandle, path: &str, binding: Option<u32>) -> Route {
    bind_missing_projects(app);
    let file_project = project_of(path);
    let order = app.state::<crate::menu_route::FocusTracker>().order();
    let open_files = app.state::<crate::window::OpenFiles>();
    let reg = open_files.0.lock().unwrap();
    route(&reg, path, binding, &file_project, &order, |l| app.get_webview_window(l).is_some())
}

/// Every live window, by number (unnumbered ones last, in label order).
pub fn list_windows(reg: &TabRegistry, focus_order: &[String], is_live: impl Fn(&str) -> bool) -> Vec<WindowListing> {
    let mut out: Vec<(String, WindowListing)> = reg
        .all_windows()
        .filter(|(label, _)| is_live(label))
        .map(|(label, w)| {
            let listing = WindowListing {
                window: w.number,
                project: w.project.as_deref().map(|p| crate::git_info::dir_name(Path::new(p))),
                project_path: w.project.clone(),
                last_focused: focus_order.first() == Some(label),
                tabs: w
                    .tabs
                    .iter()
                    .map(|t| ListedTab { path: t.path.clone(), active: w.active.as_deref() == Some(t.id.as_str()) })
                    .collect(),
            };
            (label.clone(), listing)
        })
        .collect();
    out.sort_by_key(|(label, l)| (l.window.unwrap_or(u32::MAX), crate::session::label_order(label)));
    out.into_iter().map(|(_, l)| l).collect()
}

/// `list_windows` for the live app.
pub fn windows_now(app: &AppHandle) -> Vec<WindowListing> {
    bind_missing_projects(app);
    let order = app.state::<crate::menu_route::FocusTracker>().order();
    let open_files = app.state::<crate::window::OpenFiles>();
    let reg = open_files.0.lock().unwrap();
    list_windows(&reg, &order, |l| app.get_webview_window(l).is_some())
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// The listing as text, one line per window: `#N  project  files`, columns
/// aligned. `max_files` cuts each line's files short with ` …`.
pub fn format_listing(windows: &[WindowListing], max_files: Option<usize>, indent: &str) -> String {
    let number = |w: &WindowListing| w.window.map_or_else(|| "#?".to_string(), |n| format!("#{n}"));
    let project = |w: &WindowListing| w.project.clone().unwrap_or_else(|| "—".to_string());
    let nw = windows.iter().map(|w| number(w).chars().count()).max().unwrap_or(0);
    let pw = windows.iter().map(|w| project(w).chars().count()).max().unwrap_or(0);
    windows
        .iter()
        .map(|w| {
            let names: Vec<String> = w
                .tabs
                .iter()
                .map(|t| t.path.as_deref().map_or_else(|| "Untitled".to_string(), file_name))
                .collect();
            let shown = max_files.map_or(names.len(), |m| m.min(names.len()));
            let mut files = names[..shown].join(", ");
            if shown < names.len() {
                files.push_str(" …");
            }
            format!("{indent}{:<nw$}  {:<pw$}  {files}", number(w), project(w))
                .trim_end()
                .to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Spec §3: a dead number answers with the live windows, three files each.
pub fn dead_number_error(number: u32, windows: &[WindowListing]) -> String {
    if windows.is_empty() {
        return format!("no window #{number}; no windows are open");
    }
    format!("no window #{number}. Open windows:\n{}", format_listing(windows, Some(3), "  "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_outside_any_repository_belongs_to_its_directory() {
        let dir = std::env::temp_dir()
            .join(format!("mdmini-routing-{}", crate::session::new_tab_id()))
            .join("notes");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.md");
        assert_eq!(project_of(file.to_str().unwrap()), dir.to_string_lossy());
    }

    #[test]
    fn a_path_that_cannot_be_looked_at_is_its_own_project() {
        assert_eq!(project_of("relative.md"), "relative.md");
    }

    fn live(_: &str) -> bool {
        true
    }

    /// `(label, #N, project, files)` per window.
    fn reg(windows: &[(&str, u32, Option<&str>, &[&str])]) -> TabRegistry {
        let mut reg = TabRegistry::new();
        for (label, number, project, files) in windows {
            reg.set_number(label, Some(*number));
            if let Some(p) = project {
                reg.bind_project(label, p.to_string());
            }
            for (i, f) in files.iter().enumerate() {
                assert!(reg.add_tab(label, &format!("{label}-{i}"), Some(f.to_string())));
            }
        }
        reg
    }

    fn two_projects() -> TabRegistry {
        reg(&[("main", 3, Some("/p"), &["/p/a.md"]), ("editor-2", 7, Some("/q"), &["/q/b.md"])])
    }

    fn existing(label: &str) -> Route {
        Route::Existing(label.to_string())
    }

    #[test]
    fn step_1_a_binding_to_a_live_window_goes_there() {
        assert_eq!(route(&two_projects(), "/p/new.md", Some(7), "/p", &[], live), existing("editor-2"));
    }

    #[test]
    fn step_1_a_dead_number_is_an_error_even_for_a_file_that_is_open() {
        let reg = two_projects();
        assert_eq!(route(&reg, "/p/a.md", Some(12), "/p", &[], live), Route::DeadNumber(12));
        assert_eq!(
            route(&reg, "/p/new.md", Some(7), "/p", &[], |l| l != "editor-2"),
            Route::DeadNumber(7),
            "a number whose window is gone is dead too"
        );
    }

    #[test]
    fn step_1_a_stale_entry_sharing_the_number_never_shadows_the_live_window() {
        let mut reg = two_projects();
        for i in 0..8 {
            reg.set_number(&format!("gone-{i}"), Some(7));
        }
        assert_eq!(
            route(&reg, "/p/new.md", Some(7), "/p", &[], |l| !l.starts_with("gone-")),
            existing("editor-2")
        );
    }

    #[test]
    fn step_2_a_file_already_open_goes_to_its_tab_and_outranks_a_binding() {
        let reg = two_projects();
        assert_eq!(route(&reg, "/p/a.md", None, "/p", &[], live), existing("main"));
        assert_eq!(
            route(&reg, "/p/a.md", Some(7), "/p", &[], live),
            existing("main"),
            "one file, one tab: #7 is ignored and the answer names #3"
        );
    }

    #[test]
    fn step_3_a_file_of_a_windows_project_opens_there() {
        assert_eq!(route(&two_projects(), "/q/deep/c.md", None, "/q", &[], live), existing("editor-2"));
    }

    #[test]
    fn step_3_of_several_windows_of_the_project_the_most_recently_focused_wins() {
        let reg = reg(&[
            ("main", 3, Some("/p"), &["/p/a.md"]),
            ("editor-4", 5, Some("/p"), &["/p/b.md"]),
            ("editor-9", 8, Some("/p"), &["/p/c.md"]),
        ]);
        let order = |labels: &[&str]| labels.iter().map(|l| l.to_string()).collect::<Vec<_>>();
        assert_eq!(route(&reg, "/p/x.md", None, "/p", &order(&["editor-4", "main"]), live), existing("editor-4"));
        assert_eq!(route(&reg, "/p/x.md", None, "/p", &order(&["editor-9"]), live), existing("editor-9"));
        assert_eq!(
            route(&reg, "/p/x.md", None, "/p", &[], live),
            existing("main"),
            "never focused: main first, then editor-N ascending"
        );
    }

    #[test]
    fn step_3_a_closed_window_of_the_project_is_not_a_candidate() {
        assert_eq!(route(&two_projects(), "/p/new.md", None, "/p", &[], |l| l != "main"), Route::NewWindow);
    }

    #[test]
    fn step_4_a_file_of_no_open_project_gets_a_new_window() {
        assert_eq!(route(&two_projects(), "/z/a.md", None, "/z", &[], live), Route::NewWindow);
    }

    #[test]
    fn a_window_without_a_project_is_never_matched() {
        let mut reg = TabRegistry::new();
        reg.add_tab("main", "u", None);
        reg.set_number("main", Some(1));
        assert_eq!(route(&reg, "/p/a.md", None, "/p", &[], live), Route::NewWindow);
    }

    fn listed(window: u32, project: &str, files: &[Option<&str>]) -> WindowListing {
        WindowListing {
            window: Some(window),
            project: Some(project.to_string()),
            project_path: Some(format!("/r/{project}")),
            last_focused: false,
            tabs: files
                .iter()
                .enumerate()
                .map(|(i, f)| ListedTab { path: f.map(str::to_string), active: i == 0 })
                .collect(),
        }
    }

    fn sample() -> Vec<WindowListing> {
        vec![
            listed(3, "md-mini", &[Some("/r/README.md"), Some("/r/CLAUDE.md"), Some("/r/docs/tabs-design.md"), Some("/r/x.md")]),
            listed(12, "infra", &[Some("/i/deploy-plan.md"), None]),
        ]
    }

    #[test]
    fn the_listing_is_sorted_by_number_and_marks_the_active_tab_and_the_last_window() {
        let reg = reg(&[
            ("main", 12, Some("/r/infra"), &["/i/deploy-plan.md"]),
            ("editor-2", 3, Some("/r/md-mini"), &["/r/README.md", "/r/CLAUDE.md"]),
        ]);
        let got = list_windows(&reg, &["main".to_string()], live);
        assert_eq!(got.iter().map(|w| w.window).collect::<Vec<_>>(), vec![Some(3), Some(12)]);
        assert_eq!(got[0].project.as_deref(), Some("md-mini"));
        assert_eq!(got[0].project_path.as_deref(), Some("/r/md-mini"));
        assert_eq!(got[0].tabs.iter().map(|t| t.active).collect::<Vec<_>>(), vec![true, false]);
        assert_eq!((got[0].last_focused, got[1].last_focused), (false, true));
        assert!(list_windows(&reg, &[], |l| l != "main").iter().all(|w| w.window == Some(3)), "closed windows are left out");
    }

    #[test]
    fn the_text_listing_aligns_columns_and_can_cut_each_line_short() {
        assert_eq!(
            format_listing(&sample(), None, ""),
            "#3   md-mini  README.md, CLAUDE.md, tabs-design.md, x.md\n#12  infra    deploy-plan.md, Untitled"
        );
        assert_eq!(
            format_listing(&sample(), Some(3), "  "),
            "  #3   md-mini  README.md, CLAUDE.md, tabs-design.md …\n  #12  infra    deploy-plan.md, Untitled"
        );
    }

    #[test]
    fn a_dead_number_error_lists_the_live_windows() {
        assert_eq!(
            dead_number_error(9, &sample()),
            "no window #9. Open windows:\n  #3   md-mini  README.md, CLAUDE.md, tabs-design.md …\n  #12  infra    deploy-plan.md, Untitled"
        );
        assert_eq!(dead_number_error(9, &[]), "no window #9; no windows are open");
    }

    #[test]
    fn the_listing_serializes_the_way_agents_read_it() {
        let json = serde_json::to_string(&sample()[1]).unwrap();
        assert_eq!(
            json,
            r#"{"window":12,"project":"infra","project_path":"/r/infra","last_focused":false,"tabs":[{"path":"/i/deploy-plan.md","active":true},{"path":null,"active":false}]}"#
        );
    }
}
