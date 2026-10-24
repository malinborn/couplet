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
            files.push(WalkedFile {
                path: entry.path(),
                modified,
            });
        }
    }
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
    CACHE
        .get_or_init(WalkCache::default)
        .get_or_walk(root, Instant::now(), || walk_project(root, limits))
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
        let r = walk_project(&root, PROJECT_LIMITS);
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
        fs::File::options()
            .write(true)
            .open(root.join("old.md"))
            .unwrap()
            .set_modified(old)
            .unwrap();
        let r = walk_project(&root, PROJECT_LIMITS);
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
}
