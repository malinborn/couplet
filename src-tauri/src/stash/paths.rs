//! Where the stash lives (roadmap «Paths»). Every function that touches disk
//! takes a `StashPaths`, so tests point it at a temp directory and never at
//! the real `~/couplet/` or `stash.db`.

use std::path::{Path, PathBuf};

pub(crate) const DB_FILE: &str = "stash.db";
pub(crate) const BACKUPS_DIR: &str = "stash-backups";
pub(crate) const EXPORT_FILE: &str = ".stash-export.json";
pub(crate) const TRASH_DIR: &str = ".trash";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StashPaths {
    /// `~/<product>/` (`~/couplet/`, dev `~/couplet-dev/`): the note files.
    /// Neither created nor looked at until a note or the export needs it, so
    /// opening the stash touches only the app data directory (plan D2).
    pub notes_dir: PathBuf,
    /// `<notes_dir>/.stash-export.json`, the plain metadata snapshot.
    pub export_path: PathBuf,
    /// `<notes_dir>/.trash/` (stage 06): trashed notes, 30 days. Created
    /// only by a delete that has a file to move.
    pub trash_dir: PathBuf,
    /// `<app data>/stash.db`.
    pub db_path: PathBuf,
    /// `<app data>/stash-backups/`.
    pub backups_dir: PathBuf,
}

impl StashPaths {
    /// Pure: names the paths, creates nothing. `home` is the user's home
    /// directory (roadmap A1: not Documents); `product_dir` is
    /// `paths::dir_name(product)` — `couplet` or `couplet-dev`.
    pub fn from_bases(home: &Path, app_data: &Path, product_dir: &str) -> Self {
        let notes_dir = home.join(product_dir);
        Self {
            export_path: notes_dir.join(EXPORT_FILE),
            trash_dir: notes_dir.join(TRASH_DIR),
            notes_dir,
            db_path: app_data.join(DB_FILE),
            backups_dir: app_data.join(BACKUPS_DIR),
        }
    }

    /// The live app's paths. Only after `paths::init` (CLAUDE.md: before it,
    /// `app_data_dir` refuses and the name is unknown).
    pub fn resolve() -> Result<Self, String> {
        let product_dir = crate::paths::current_dir_name().ok_or("paths::init has not run")?;
        let home = dirs::home_dir().ok_or("Cannot determine the home folder")?;
        Ok(Self::from_bases(&home, &crate::paths::app_data_dir()?, product_dir))
    }

    /// The same paths with `notes_dir` replaced (by its normalized spelling,
    /// once it exists) and the export and the trash following it.
    pub(crate) fn with_notes_dir(&self, notes_dir: PathBuf) -> Self {
        Self {
            export_path: notes_dir.join(EXPORT_FILE),
            trash_dir: notes_dir.join(TRASH_DIR),
            notes_dir,
            ..self.clone()
        }
    }
}

/// Whether `path` lies in the notes folder (its `.trash/` and any sub-folder
/// included), component-wise (`Path::starts_with`), so `couplet-dev-other/`
/// is outside. For project binding only: nothing in this folder may bind a
/// window to it. Whether a path *is a note* is stricter (a direct child with a
/// couplet name, `entries::kind_of_new`) and is read from the entry's `kind`.
/// `notes_dir` must be in the `path_norm` spelling — see `notes_dir_spelled`.
pub(crate) fn is_note_path(notes_dir: &Path, path: &str) -> bool {
    Path::new(path).starts_with(notes_dir)
}

/// The notes folder as `path_norm` spells it, comparable with registry paths.
/// Asks the file system: never call it under a lock.
pub(crate) fn notes_dir_spelled(paths: &StashPaths) -> PathBuf {
    crate::path_norm::normalize_path(&paths.notes_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn dev_and_release_keep_notes_in_separate_folders() {
        // Roadmap A1: the notes folder sits in the home root, not Documents.
        let home = Path::new("/Users/u");
        let dev_data = Path::new("/Users/u/Library/Application Support/couplet-dev");
        let dev = StashPaths::from_bases(home, dev_data, &crate::paths::dir_name("couplet-dev"));
        assert_eq!(dev.notes_dir, PathBuf::from("/Users/u/couplet-dev"));
        assert_eq!(dev.export_path, PathBuf::from("/Users/u/couplet-dev/.stash-export.json"));
        assert_eq!(dev.trash_dir, PathBuf::from("/Users/u/couplet-dev/.trash"));
        assert_eq!(dev.db_path, dev_data.join("stash.db"));
        assert_eq!(dev.backups_dir, dev_data.join("stash-backups"));

        let release_data = Path::new("/Users/u/Library/Application Support/couplet");
        let release = StashPaths::from_bases(home, release_data, &crate::paths::dir_name("couplet"));
        assert_eq!(release.notes_dir, PathBuf::from("/Users/u/couplet"));
        assert_eq!(release.export_path, PathBuf::from("/Users/u/couplet/.stash-export.json"));
        assert_eq!(release.trash_dir, PathBuf::from("/Users/u/couplet/.trash"));
        assert_eq!(release.db_path, release_data.join("stash.db"));
        assert_eq!(release.backups_dir, release_data.join("stash-backups"));
        assert_ne!(release.notes_dir, dev.notes_dir);
        assert_ne!(release.export_path, dev.export_path);
        assert_ne!(release.trash_dir, dev.trash_dir);
        assert_ne!(release.db_path, dev.db_path);
        assert_ne!(release.backups_dir, dev.backups_dir);
    }

    #[test]
    fn building_the_paths_touches_nothing() {
        let root = crate::atomic_write::testkit::scratch("stash-paths");
        let _ = StashPaths::from_bases(&root.join("home"), &root.join("data"), "couplet-test");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    }

    #[test]
    fn a_note_path_is_one_inside_the_notes_folder() {
        // Roadmap A1: the notes folder is in the home root.
        let dir = Path::new("/Users/u/couplet-dev");
        assert!(is_note_path(dir, "/Users/u/couplet-dev/2026-09-27-0215-a3f9.md"));
        assert!(is_note_path(dir, "/Users/u/couplet-dev/.trash/x.md"));
        assert!(
            !is_note_path(dir, "/Users/u/couplet-dev-other/x.md"),
            "a sibling with a common prefix is not inside"
        );
        assert!(!is_note_path(dir, "/Users/u/work/plan.md"));
    }

    #[test]
    fn the_notes_folder_is_spelled_as_the_registry_spells_paths() {
        // `/tmp` style symlinks resolve; a folder that does not exist yet keeps
        // its name under its resolved parent (`path_norm::normalize_path`).
        let root = crate::atomic_write::testkit::scratch("stash-notes-spelled");
        let paths = StashPaths::from_bases(&root.join("home"), &root.join("data"), "couplet-test");
        let real = crate::path_norm::normalize_path(&root);
        assert_eq!(notes_dir_spelled(&paths), real.join("home/couplet-test"));
    }

    #[test]
    fn a_new_notes_dir_moves_the_export_and_the_trash_with_it() {
        let paths = StashPaths::from_bases(Path::new("/h"), Path::new("/a"), "couplet");
        let moved = paths.with_notes_dir(PathBuf::from("/private/h/couplet"));
        assert_eq!(moved.notes_dir, PathBuf::from("/private/h/couplet"));
        assert_eq!(moved.export_path, PathBuf::from("/private/h/couplet/.stash-export.json"));
        assert_eq!(moved.trash_dir, PathBuf::from("/private/h/couplet/.trash"));
        assert_eq!(moved.db_path, paths.db_path);
        assert_eq!(moved.backups_dir, paths.backups_dir);
    }
}
