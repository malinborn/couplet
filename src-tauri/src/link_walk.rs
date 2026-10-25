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

/// The home folder, an ancestor of it or `/` as a "project" (a loose note in
/// `~`, a repository at `/Users`): its own files only. Walking further would
/// read all of home and raise macOS consent prompts for `~/Documents`,
/// `~/Desktop`, `~/Downloads`.
pub const SHALLOW_LIMITS: WalkLimits = WalkLimits {
    max_depth: 1,
    ..PROJECT_LIMITS
};

/// Home folders macOS guards with a consent prompt (TCC), or that are huge
/// and never a project (`Library`). Never entered by a walk — reading one
/// from a root *inside* it is fine: the user already opened a file there.
const PROTECTED_HOME_DIRS: [&str; 7] = [
    "Documents",
    "Desktop",
    "Downloads",
    "Library",
    "Pictures",
    "Movies",
    "Music",
];

pub const CACHE_TTL: Duration = Duration::from_secs(30);

const LINKABLE: [&str; 5] = ["md", "markdown", "txt", "csv", "tsv"];
const SKIPPED_DIRS: [&str; 7] = [
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    "__pycache__",
    "venv",
];

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

/// A symlink is listed when its name is linkable and it points at a file.
/// The name comes first: the walk never stats a target it would not list (a
/// link into a TCC-protected folder would raise a consent dialog).
fn lists_symlink(name: &str, points_at_file: impl FnOnce() -> bool) -> bool {
    is_linkable(name) && points_at_file()
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
    if root.parent().is_none() || home.is_some_and(|h| h.starts_with(root)) {
        SHALLOW_LIMITS
    } else {
        PROJECT_LIMITS
    }
}

/// The directories a walk never enters (`PROTECTED_HOME_DIRS` under `home`).
/// A root inside one still walks: none of its descendants is one of them.
pub fn protected_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    home.map(|h| PROTECTED_HOME_DIRS.iter().map(|d| h.join(d)).collect())
        .unwrap_or_default()
}

/// Breadth first, so a cut-short walk keeps the files nearest the root. The
/// budget is checked per entry while a directory is read, not per directory:
/// one huge folder cannot overrun it. An unreadable directory is skipped.
pub fn walk_project(root: &Path, limits: WalkLimits, never_enter: &[PathBuf]) -> WalkResult {
    let started = Instant::now();
    let mut files = Vec::new();
    let mut truncated = false;
    let mut queue = VecDeque::from([(root.to_path_buf(), 1usize)]);
    'walk: while let Some((dir, depth)) = queue.pop_front() {
        if started.elapsed() >= limits.budget {
            truncated = true;
            break;
        }
        let Ok(read) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in read {
            if started.elapsed() >= limits.budget {
                truncated = true;
                break 'walk;
            }
            let Ok(entry) = entry else {
                continue;
            };
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if skips_dir(&name) {
                    continue;
                }
                let path = entry.path();
                if never_enter.contains(&path) {
                    continue;
                }
                if depth < limits.max_depth {
                    queue.push_back((path, depth + 1));
                } else {
                    truncated = true;
                }
                continue;
            }
            // A symlink is listed only when it points at a file; a symlinked
            // directory is never entered.
            let listed = if kind.is_symlink() {
                lists_symlink(&name, || {
                    fs::metadata(entry.path()).is_ok_and(|m| m.is_file())
                })
            } else {
                kind.is_file() && is_linkable(&name)
            };
            if !listed {
                continue;
            }
            if files.len() >= limits.max_files {
                truncated = true;
                break 'walk;
            }
            let modified = entry.metadata().ok().and_then(|m| m.modified().ok());
            files.push(WalkedFile {
                path: entry.path(),
                modified,
            });
        }
    }
    // The one ordering the result has: read order is the file system's.
    files.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| a.path.cmp(&b.path))
    });
    WalkResult { files, truncated }
}

/// Walks per root, reused for `CACHE_TTL`. The lock is never held during a
/// walk: two concurrent misses may both walk, and the later one wins.
#[derive(Default)]
pub struct WalkCache {
    entries: Mutex<HashMap<PathBuf, (Instant, WalkResult)>>,
}

impl WalkCache {
    pub fn get_or_walk(
        &self,
        root: &Path,
        now: Instant,
        walk: impl FnOnce() -> WalkResult,
    ) -> WalkResult {
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
    let never_enter = protected_dirs(home.as_deref());
    CACHE
        .get_or_init(WalkCache::default)
        .get_or_walk(root, Instant::now(), || {
            walk_project(root, limits, &never_enter)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "couplet-walk-{}-{}",
            tag,
            crate::session::new_tab_id()
        ));
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
            .map(|f| {
                f.path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        v.sort();
        v
    }

    #[test]
    fn lists_markdown_ish_files_and_skips_noise() {
        let root = scratch("skips");
        for rel in [
            "a.md",
            "b.TXT",
            "c.csv",
            "d.tsv",
            "e.markdown",
            "img.png",
            "docs/f.md",
            ".git/g.md",
            "node_modules/h.md",
            "target/i.md",
            ".hidden/j.md",
            "venv/k.md",
        ] {
            touch(&root, rel);
        }
        let r = walk_project(&root, PROJECT_LIMITS, &[]);
        assert_eq!(
            names(&r, &root),
            vec!["a.md", "b.TXT", "c.csv", "d.tsv", "docs/f.md", "e.markdown"]
        );
        assert!(!r.truncated);
    }

    #[test]
    fn the_depth_limit_cuts_and_says_so() {
        let root = scratch("depth");
        touch(&root, "a/x.md");
        touch(&root, "a/b/c.md");
        let r = walk_project(
            &root,
            WalkLimits {
                max_depth: 2,
                ..PROJECT_LIMITS
            },
            &[],
        );
        assert_eq!(names(&r, &root), vec!["a/x.md"]);
        assert!(r.truncated);
    }

    #[test]
    fn the_file_limit_cuts_and_says_so() {
        let root = scratch("files");
        for rel in ["a.md", "b.md", "c.md"] {
            touch(&root, rel);
        }
        let r = walk_project(
            &root,
            WalkLimits {
                max_files: 2,
                ..PROJECT_LIMITS
            },
            &[],
        );
        assert_eq!(r.files.len(), 2);
        assert!(r.truncated);
    }

    #[test]
    fn the_time_budget_cuts_and_says_so() {
        let root = scratch("time");
        touch(&root, "a.md");
        let r = walk_project(
            &root,
            WalkLimits {
                budget: Duration::ZERO,
                ..PROJECT_LIMITS
            },
            &[],
        );
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
        let r = walk_project(&root, PROJECT_LIMITS, &[]);
        assert_eq!(names(&r, &root), vec!["l.md"]);
        assert!(!r.truncated);
    }

    #[test]
    fn a_symlink_with_a_name_never_listed_is_never_followed() {
        let stat_called = std::cell::Cell::new(false);
        let stat = || {
            stat_called.set(true);
            true
        };
        assert!(!lists_symlink("photo.heic", stat));
        assert!(
            !stat_called.get(),
            "the target of a name the walk would not list is not stat'ed"
        );
        assert!(lists_symlink("plan.md", stat));
        assert!(stat_called.get());
        assert!(!lists_symlink("plan.md", || false));
    }

    #[test]
    fn newest_first() {
        let root = scratch("order");
        touch(&root, "old.md");
        touch(&root, "new.md");
        let old = SystemTime::now() - Duration::from_secs(3600);
        fs::File::options()
            .write(true)
            .open(root.join("old.md"))
            .unwrap()
            .set_modified(old)
            .unwrap();
        let r = walk_project(&root, PROJECT_LIMITS, &[]);
        let order: Vec<String> = r
            .files
            .iter()
            .map(|f| f.path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(order, vec!["new.md", "old.md"]);
    }

    #[test]
    fn home_and_the_filesystem_root_are_walked_one_level() {
        let home = Path::new("/Users/me");
        assert_eq!(limits_for(Path::new("/"), Some(home)), SHALLOW_LIMITS);
        assert_eq!(limits_for(home, Some(home)), SHALLOW_LIMITS);
        assert_eq!(
            limits_for(Path::new("/Users/me/proj"), Some(home)),
            PROJECT_LIMITS
        );
    }

    #[test]
    fn a_walk_is_reused_for_thirty_seconds() {
        let cache = WalkCache::default();
        let root = Path::new("/r");
        let t0 = Instant::now();
        let one = WalkResult {
            files: Vec::new(),
            truncated: true,
        };
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

    #[test]
    fn an_ancestor_of_home_is_walked_one_level() {
        let home = Path::new("/Users/me");
        assert_eq!(limits_for(Path::new("/Users"), Some(home)), SHALLOW_LIMITS);
        // Path::starts_with compares components: /Users/meow is no ancestor.
        assert_eq!(
            limits_for(Path::new("/Users/meow"), Some(home)),
            PROJECT_LIMITS
        );
        assert_eq!(limits_for(Path::new("/srv/proj"), None), PROJECT_LIMITS);
    }

    #[test]
    fn the_protected_home_folders_are_listed() {
        let dirs = protected_dirs(Some(Path::new("/Users/me")));
        for name in [
            "Documents",
            "Desktop",
            "Downloads",
            "Library",
            "Pictures",
            "Movies",
            "Music",
        ] {
            assert!(
                dirs.contains(&PathBuf::from("/Users/me").join(name)),
                "{name}"
            );
        }
        assert!(protected_dirs(None).is_empty());
    }

    #[test]
    fn a_protected_home_folder_is_never_entered() {
        let home = scratch("tcc-home");
        touch(&home, "Documents/a.md");
        touch(&home, "Downloads/b.md");
        touch(&home, "notes/c.md");
        let r = walk_project(&home, PROJECT_LIMITS, &protected_dirs(Some(&home)));
        assert_eq!(names(&r, &home), vec!["notes/c.md"]);
        assert!(!r.truncated);
    }

    #[test]
    fn a_root_inside_a_protected_folder_is_walked() {
        let home = scratch("tcc-inside");
        touch(&home, "Documents/proj/a.md");
        touch(&home, "Documents/proj/docs/b.md");
        let root = home.join("Documents/proj");
        let r = walk_project(&root, PROJECT_LIMITS, &protected_dirs(Some(&home)));
        assert_eq!(names(&r, &root), vec!["a.md", "docs/b.md"]);
    }

    #[test]
    fn an_unreadable_directory_is_skipped_without_error() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch("denied");
        touch(&root, "a.md");
        touch(&root, "locked/b.md");
        let locked = root.join("locked");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let r = walk_project(&root, PROJECT_LIMITS, &[]);
        // Put it back first, so a failed assertion still leaves a removable dir.
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(names(&r, &root), vec!["a.md"]);
        assert!(!r.truncated);
    }
}
