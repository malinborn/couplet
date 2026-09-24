//! Where a file an agent (or a `-t`/`-b` CLI call) opens lands — spec §5 —
//! and the project every window is bound to (spec §2).

use std::path::Path;

use tauri::{AppHandle, Manager};

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
}
