//! File links (docs/superpowers/specs/2026-10-24-file-links-design.md): what a
//! linked path is on disk. Plan 02 adds the picker's candidates here.

use std::path::Path;

use serde::Serialize;

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
}
