//! The one spelling of a file path. `OpenFiles` is keyed by the exact string a
//! window registered (`tabs.rs`), so two spellings of one file — `/tmp/a.md`
//! and `/private/tmp/a.md`, or `/x/../a.md` — would be two tabs, both
//! autosaving the same file. Every entry that takes a path from outside
//! (`resolve_path` for CLI args and pending files, the command socket for
//! agents and MCP) goes through `normalize_path`.

use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

/// `.` and `..` resolved lexically, then symlinks resolved on the longest
/// leading part that exists (`/tmp` → `/private/tmp` on macOS): a file that
/// does not exist yet keeps its name under its resolved directory. A relative
/// path is only cleaned lexically — resolving it against this process's
/// directory is the caller's decision, not this function's.
pub(crate) fn normalize_path(path: &Path) -> PathBuf {
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match clean.components().next_back() {
                Some(Component::Normal(_)) => {
                    clean.pop();
                }
                // `/..` is `/`.
                Some(Component::RootDir) | Some(Component::Prefix(_)) => {}
                _ => clean.push(".."),
            },
            other => clean.push(other.as_os_str()),
        }
    }
    if !clean.is_absolute() {
        return clean;
    }
    let mut missing: Vec<&OsStr> = Vec::new();
    let mut existing = clean.as_path();
    loop {
        if let Ok(real) = existing.canonicalize() {
            let mut out = real;
            out.extend(missing.iter().rev());
            return out;
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                missing.push(name);
                existing = parent;
            }
            _ => return clean.clone(),
        }
    }
}

/// `normalize_path` for a path the registry keys on — a `String` in, a
/// `String` out. Never call it under the `OpenFiles` lock: it asks the file
/// system, which may be a slow network volume.
pub(crate) fn normalize_str(path: &str) -> String {
    normalize_path(Path::new(path)).to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `<tmp>/<unique>/real` and `<tmp>/<unique>/link -> real`.
    fn linked_dirs() -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("mdmini-norm-{}", crate::session::new_tab_id()));
        let real = base.join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = base.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        (real, link)
    }

    #[test]
    fn a_file_reached_through_a_symlinked_directory_has_one_spelling() {
        let (real, link) = linked_dirs();
        std::fs::write(real.join("a.md"), "x").unwrap();
        assert_eq!(normalize_path(&link.join("a.md")), normalize_path(&real.join("a.md")));
        assert_eq!(normalize_path(&link.join("a.md")), real.join("a.md").canonicalize().unwrap());
        let _ = std::fs::remove_dir_all(real.parent().unwrap());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn slash_tmp_and_slash_private_tmp_are_one_file() {
        let name = format!("mdmini-norm-{}.md", crate::session::new_tab_id());
        let file = Path::new("/tmp").join(&name);
        std::fs::write(&file, "x").unwrap();
        let a = normalize_path(&file);
        let b = normalize_path(&Path::new("/private/tmp").join(&name));
        let _ = std::fs::remove_file(&file);
        assert_eq!(a, b);
        assert_eq!(a, Path::new("/private/tmp").join(&name));
    }

    #[test]
    fn dot_and_dot_dot_are_resolved_lexically() {
        assert_eq!(normalize_path(Path::new("/x/../a.md")), PathBuf::from("/a.md"));
        assert_eq!(normalize_path(Path::new("/./nope-a/./b/../c.md")), PathBuf::from("/nope-a/c.md"));
        assert_eq!(normalize_path(Path::new("/../a.md")), PathBuf::from("/a.md"), "`/..` is `/`");
    }

    #[test]
    fn a_file_that_does_not_exist_yet_keeps_its_name_under_its_resolved_directory() {
        let (real, link) = linked_dirs();
        let canon = real.canonicalize().unwrap();
        assert_eq!(normalize_path(&link.join("new.md")), canon.join("new.md"));
        assert_eq!(normalize_path(&link.join("sub/deeper/new.md")), canon.join("sub/deeper/new.md"));
        let _ = std::fs::remove_dir_all(real.parent().unwrap());
    }

    #[test]
    fn a_relative_path_is_only_cleaned() {
        assert_eq!(normalize_path(Path::new("./a/../b.md")), PathBuf::from("b.md"));
        assert_eq!(normalize_path(Path::new("../b.md")), PathBuf::from("../b.md"));
    }

    #[test]
    fn resolve_path_joins_the_directory_and_normalizes() {
        let (real, link) = linked_dirs();
        std::fs::write(real.join("a.md"), "x").unwrap();
        let canon = real.join("a.md").canonicalize().unwrap().to_string_lossy().into_owned();
        assert_eq!(crate::resolve_path("a.md", Some(link.to_str().unwrap())), canon);
        assert_eq!(crate::resolve_path("./x/../a.md", Some(link.to_str().unwrap())), canon);
        assert_eq!(crate::resolve_path(&format!("{}/./a.md", link.display()), None), canon, "absolute paths too");
        let _ = std::fs::remove_dir_all(real.parent().unwrap());
    }
}
