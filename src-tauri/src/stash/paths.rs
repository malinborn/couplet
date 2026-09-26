//! Where the stash lives (roadmap «Paths»). Every function that touches disk
//! takes a `StashPaths`, so tests point it at a temp directory and never at
//! the real `~/couplet/` or `stash.db`.

use std::path::{Path, PathBuf};

pub(crate) const DB_FILE: &str = "stash.db";
pub(crate) const BACKUPS_DIR: &str = "stash-backups";
pub(crate) const EXPORT_FILE: &str = ".stash-export.json";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StashPaths {
    /// `~/<product>/` (`~/couplet/`, dev `~/couplet-dev/`): the note files.
    /// Neither created nor looked at until a note or the export needs it, so
    /// opening the stash touches only the app data directory (plan D2).
    pub notes_dir: PathBuf,
    /// `<notes_dir>/.stash-export.json`, the plain metadata snapshot.
    pub export_path: PathBuf,
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
    /// once it exists) and the export following it.
    pub(crate) fn with_notes_dir(&self, notes_dir: PathBuf) -> Self {
        Self {
            export_path: notes_dir.join(EXPORT_FILE),
            notes_dir,
            ..self.clone()
        }
    }
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
        assert_eq!(dev.db_path, dev_data.join("stash.db"));
        assert_eq!(dev.backups_dir, dev_data.join("stash-backups"));

        let release_data = Path::new("/Users/u/Library/Application Support/couplet");
        let release = StashPaths::from_bases(home, release_data, &crate::paths::dir_name("couplet"));
        assert_eq!(release.notes_dir, PathBuf::from("/Users/u/couplet"));
        assert_eq!(release.export_path, PathBuf::from("/Users/u/couplet/.stash-export.json"));
        assert_eq!(release.db_path, release_data.join("stash.db"));
        assert_eq!(release.backups_dir, release_data.join("stash-backups"));
        assert_ne!(release.notes_dir, dev.notes_dir);
        assert_ne!(release.export_path, dev.export_path);
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
    fn a_new_notes_dir_moves_the_export_with_it() {
        let paths = StashPaths::from_bases(Path::new("/h"), Path::new("/a"), "couplet");
        let moved = paths.with_notes_dir(PathBuf::from("/private/h/couplet"));
        assert_eq!(moved.notes_dir, PathBuf::from("/private/h/couplet"));
        assert_eq!(moved.export_path, PathBuf::from("/private/h/couplet/.stash-export.json"));
        assert_eq!(moved.db_path, paths.db_path);
        assert_eq!(moved.backups_dir, paths.backups_dir);
    }
}
