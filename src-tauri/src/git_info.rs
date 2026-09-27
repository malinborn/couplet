//! Which project and branch a file belongs to — the grey line on a drawer
//! card (spec §6: «имя файла, серым проект/ветка»).
//!
//! Read straight from the repository's files instead of running `git`: a
//! drawer opening over twenty tabs would otherwise spawn twenty processes,
//! and all it needs is the nearest `.git` and one line of `HEAD`. A worktree
//! is its own project (spec §2): its `.git` is a *file* naming
//! `<repo>/.git/worktrees/<name>`, whose `HEAD` is the worktree's branch.
//!
//! The paths come from the webview, so they are untrusted: only absolute
//! paths without `..` are accepted, the upward walk is bounded, and nothing is
//! read but a `.git` file and a `HEAD` — each only when it is a regular file,
//! and never more than [`MAX_READ`] bytes of it (a `HEAD` symlinked to a
//! device or a FIFO would otherwise hang or flood the command).

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GitInfo {
    /// Name of the directory holding `.git`; for a file outside any
    /// repository, the name of its own directory.
    pub project: String,
    /// The checked-out branch; the first 7 characters of the commit when HEAD
    /// is detached; `None` outside a repository.
    pub branch: Option<String>,
}

/// How many directories, starting at the file's own, are searched for `.git`.
const MAX_DEPTH: usize = 64;

/// The most of a `.git` file or a `HEAD` ever read; both are one short line.
const MAX_READ: u64 = 4096;

#[cfg(test)]
thread_local! {
    /// How many times [`read_small`] got as far as `open` on this thread.
    static OPENS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// A regular file's contents, at most [`MAX_READ`] bytes of them. Checked
/// twice: by path before the open, so a symlink to a device node is never
/// opened at all (opening one can have side effects), and again on the open
/// descriptor — opened non-blocking — so a FIFO or device swapped in between
/// the check and the open cannot hang the command.
fn read_small(path: &Path) -> Option<String> {
    use std::os::unix::fs::OpenOptionsExt;
    if !fs::metadata(path).ok()?.is_file() {
        return None;
    }
    #[cfg(test)]
    OPENS.with(|n| n.set(n.get() + 1));
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut text = String::new();
    file.take(MAX_READ + 1).read_to_string(&mut text).ok()?;
    (text.len() as u64 <= MAX_READ).then_some(text)
}

/// The nearest directory at or above `file`'s holding `.git`, and that entry.
fn find_dot_git(file: &Path) -> Option<(PathBuf, PathBuf)> {
    file.parent()?.ancestors().take(MAX_DEPTH).find_map(|dir| {
        let candidate = dir.join(".git");
        fs::metadata(&candidate).is_ok().then(|| (dir.to_path_buf(), candidate))
    })
}

/// The git directory `dot_git` stands for: itself, or the target of a
/// worktree's `gitdir:` line (relative to the worktree when not absolute).
/// Wherever the target points, only its `HEAD` is ever read, through
/// [`read_small`].
fn resolve_git_dir(toplevel: &Path, dot_git: &Path) -> Option<PathBuf> {
    if dot_git.is_dir() {
        return Some(dot_git.to_path_buf());
    }
    let text = read_small(dot_git)?;
    let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    let target = Path::new(target);
    Some(if target.is_absolute() {
        target.to_path_buf()
    } else {
        toplevel.join(target)
    })
}

/// The branch a `HEAD` file names, or a short commit id when detached.
fn branch_from_head(head: &str) -> Option<String> {
    let head = head.trim();
    if let Some(reference) = head.strip_prefix("ref:") {
        let reference = reference.trim();
        let branch = reference.strip_prefix("refs/heads/").unwrap_or(reference);
        return (!branch.is_empty()).then(|| branch.to_string());
    }
    (head.len() >= 7 && head.chars().all(|c| c.is_ascii_hexdigit())).then(|| head[..7].to_string())
}

pub(crate) fn dir_name(dir: &Path) -> String {
    dir.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| dir.to_string_lossy().into_owned())
}

/// Only an absolute path with no `..` is looked at: the webview names it, and
/// a relative one would resolve against the app's working directory.
fn is_acceptable(file: &Path) -> bool {
    file.is_absolute() && !file.components().any(|c| c == Component::ParentDir)
}

/// The repository `file` is in: its toplevel directory and what it shows.
fn find_repo(file: &Path) -> Option<(PathBuf, GitInfo)> {
    if !is_acceptable(file) {
        return None;
    }
    let (toplevel, dot_git) = find_dot_git(file)?;
    let branch = resolve_git_dir(&toplevel, &dot_git)
        .and_then(|dir| read_small(&dir.join("HEAD")))
        .and_then(|head| branch_from_head(&head));
    let info = GitInfo { project: dir_name(&toplevel), branch };
    Some((toplevel, info))
}

/// The home folder in `path_norm`'s spelling — the one the stash's paths use.
fn normalized_home() -> Option<&'static Path> {
    static HOME: OnceLock<Option<PathBuf>> = OnceLock::new();
    HOME.get_or_init(|| dirs::home_dir().map(|h| crate::path_norm::normalize_path(&h)))
        .as_deref()
}

/// `git_info` only for a file inside a repository. The stash's repo tag for a
/// file reference is "the git toplevel"; a loose file has none — unlike a
/// drawer card, whose grey line falls back to the file's folder. A toplevel
/// that is the home folder itself (a dotfiles repository) is no repo tag
/// either: every loose file under `~` would carry the login name.
pub fn repo_info(file: &Path) -> Option<GitInfo> {
    repo_info_in(file, normalized_home())
}

/// `repo_info` with the home folder passed in, spelled the way `file` is
/// (the stash passes normalized paths; `repo_info` a normalized home).
fn repo_info_in(file: &Path, home: Option<&Path>) -> Option<GitInfo> {
    let (toplevel, info) = find_repo(file)?;
    (home != Some(toplevel.as_path())).then_some(info)
}

/// The drawer's grey line. Built on `find_repo`, not `repo_info`: a file
/// under a dotfiles home still shows that repository, as it always has.
pub fn git_info(file: &Path) -> Option<GitInfo> {
    if !is_acceptable(file) {
        return None;
    }
    let parent = file.parent().filter(|p| !p.as_os_str().is_empty())?;
    find_repo(file)
        .map(|(_, info)| info)
        .or_else(|| Some(GitInfo { project: dir_name(parent), branch: None }))
}

/// The project `file` belongs to (spec §2): the directory holding the nearest
/// `.git` — for a worktree that is the worktree itself, its own project — or,
/// outside any repository, the file's own directory. `None` for a path
/// `git_info` would not look at either. Nothing is read: `.git` is only
/// stat'ed on the way up.
pub fn project_root(file: &Path) -> Option<PathBuf> {
    if !is_acceptable(file) {
        return None;
    }
    let parent = file.parent().filter(|p| !p.as_os_str().is_empty())?;
    Some(
        find_dot_git(file)
            .map(|(toplevel, _)| toplevel)
            .unwrap_or_else(|| parent.to_path_buf()),
    )
}

/// The repository a *directory* belongs to: the nearest directory at or above
/// `dir` holding `.git` (a worktree's `.git` file counts — it is its own
/// repository). `None` outside git and for a path `git_info` would not look
/// at. Unlike [`project_root`] there is no fallback to the directory itself:
/// the stash scopes an agent by repository, and "the folder I happen to be
/// in" is not one. A toplevel that is the home folder (a dotfiles
/// repository) is none either, as in [`repo_info`]. `dir` must be in
/// `path_norm`'s spelling, like the home it is compared with. Nothing is
/// read, `.git` is only stat'ed.
pub fn git_toplevel(dir: &Path) -> Option<PathBuf> {
    git_toplevel_in(dir, normalized_home())
}

fn git_toplevel_in(dir: &Path, home: Option<&Path>) -> Option<PathBuf> {
    if !is_acceptable(dir) {
        return None;
    }
    dir.ancestors()
        .take(MAX_DEPTH)
        .find(|d| fs::metadata(d.join(".git")).is_ok())
        .filter(|top| home != Some(*top))
        .map(Path::to_path_buf)
}

/// IPC: `git_info` for each path, in order. Never fails as a whole — a path
/// that cannot be resolved answers `null` in its place. The walk is plain
/// blocking filesystem calls, so it runs on the blocking pool: a file on a
/// hung network mount would otherwise stall an async worker with it.
#[tauri::command]
pub async fn tab_git_info(paths: Vec<String>) -> Result<Vec<Option<GitInfo>>, String> {
    tauri::async_runtime::spawn_blocking(move || paths.iter().map(|p| git_info(Path::new(p))).collect())
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "couplet-git-info-{}-{}",
            tag,
            crate::session::new_tab_id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_file_in_a_repository_reports_its_toplevel_and_branch() {
        let root = scratch("repo").join("couplet");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("docs/deep")).unwrap();
        fs::write(root.join(".git/HEAD"), "ref: refs/heads/feat/tabs\n").unwrap();
        assert_eq!(
            git_info(&root.join("docs/deep/plan.md")),
            Some(GitInfo { project: "couplet".into(), branch: Some("feat/tabs".into()) })
        );
    }

    #[test]
    fn the_nearest_repository_wins_over_an_enclosing_one() {
        let outer = scratch("nested").join("outer");
        let inner = outer.join("vendor/inner");
        fs::create_dir_all(outer.join(".git")).unwrap();
        fs::create_dir_all(inner.join(".git")).unwrap();
        fs::write(outer.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::write(inner.join(".git/HEAD"), "ref: refs/heads/dev\n").unwrap();
        assert_eq!(
            git_info(&inner.join("a.md")),
            Some(GitInfo { project: "inner".into(), branch: Some("dev".into()) })
        );
    }

    #[test]
    fn a_detached_head_reports_a_short_commit() {
        let root = scratch("detached").join("repo");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/HEAD"), "19e672a0123456789abcdef0123456789abcdef0\n").unwrap();
        assert_eq!(
            git_info(&root.join("a.md")),
            Some(GitInfo { project: "repo".into(), branch: Some("19e672a".into()) })
        );
    }

    #[test]
    fn a_worktree_is_its_own_project_with_its_own_branch() {
        let base = scratch("wt");
        let gitdir = base.join("couplet/.git/worktrees/tabs-impl");
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(base.join("couplet/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::write(gitdir.join("HEAD"), "ref: refs/heads/feat/tabs\n").unwrap();
        let wt = base.join("tabs-impl");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        assert_eq!(
            git_info(&wt.join("README.md")),
            Some(GitInfo { project: "tabs-impl".into(), branch: Some("feat/tabs".into()) })
        );
    }

    #[test]
    fn a_relative_gitdir_is_resolved_against_the_worktree() {
        let base = scratch("rel");
        let gitdir = base.join("repo/.git/worktrees/x");
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(gitdir.join("HEAD"), "ref: refs/heads/topic\n").unwrap();
        let wt = base.join("x");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), "gitdir: ../repo/.git/worktrees/x\n").unwrap();
        assert_eq!(git_info(&wt.join("a.md")).and_then(|i| i.branch).as_deref(), Some("topic"));
    }

    #[test]
    fn a_broken_worktree_link_still_names_the_project() {
        let wt = scratch("broken").join("orphan");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), "gitdir: /nonexistent/.git/worktrees/orphan\n").unwrap();
        assert_eq!(
            git_info(&wt.join("a.md")),
            Some(GitInfo { project: "orphan".into(), branch: None })
        );
    }

    #[test]
    fn head_contents_name_a_branch_or_a_short_commit() {
        assert_eq!(branch_from_head("ref: refs/heads/main\n").as_deref(), Some("main"));
        assert_eq!(
            branch_from_head("0123456789abcdef0123456789abcdef01234567\n").as_deref(),
            Some("0123456")
        );
        assert_eq!(branch_from_head("ref: refs/remotes/origin/x").as_deref(), Some("refs/remotes/origin/x"));
        assert_eq!(branch_from_head("garbage"), None);
        assert_eq!(branch_from_head("ref:   "), None);
    }

    #[test]
    fn a_file_outside_any_repository_reports_its_directory() {
        let dir = scratch("plain").join("notes");
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(
            git_info(&dir.join("a.md")),
            Some(GitInfo { project: "notes".into(), branch: None })
        );
    }

    #[test]
    fn an_unusable_path_answers_nothing() {
        assert_eq!(git_info(Path::new("")), None);
        assert_eq!(git_info(Path::new("relative/a.md")), None);
        assert_eq!(git_info(Path::new("/tmp/../etc/a.md")), None);
    }

    #[test]
    fn a_head_that_is_not_a_regular_file_is_never_read() {
        let root = scratch("device").join("repo");
        fs::create_dir_all(root.join(".git")).unwrap();
        std::os::unix::fs::symlink("/dev/zero", root.join(".git/HEAD")).unwrap();
        assert_eq!(
            git_info(&root.join("a.md")),
            Some(GitInfo { project: "repo".into(), branch: None })
        );
    }

    #[test]
    fn a_symlink_to_a_device_is_never_opened() {
        let dir = scratch("devnull");
        let link = dir.join("HEAD");
        std::os::unix::fs::symlink("/dev/null", &link).unwrap();
        let before = OPENS.with(|n| n.get());
        assert_eq!(read_small(&link), None);
        assert_eq!(OPENS.with(|n| n.get()), before, "a device must be refused before open");
    }

    #[test]
    fn a_regular_file_is_still_read() {
        let file = scratch("regular").join("HEAD");
        fs::write(&file, "ref: refs/heads/main\n").unwrap();
        assert_eq!(read_small(&file).as_deref(), Some("ref: refs/heads/main\n"));
    }

    #[test]
    fn the_command_answers_every_path_in_order() {
        let dir = scratch("cmd").join("notes");
        fs::create_dir_all(&dir).unwrap();
        let paths = vec![dir.join("a.md").to_string_lossy().into_owned(), "relative.md".to_string()];
        let answer = tauri::async_runtime::block_on(tab_git_info(paths)).unwrap();
        assert_eq!(answer, vec![Some(GitInfo { project: "notes".into(), branch: None }), None]);
    }

    #[test]
    fn a_fifo_head_does_not_hang_the_command() {
        let root = scratch("fifo").join("repo");
        fs::create_dir_all(root.join(".git")).unwrap();
        let fifo = std::ffi::CString::new(root.join(".git/HEAD").to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert_eq!(git_info(&root.join("a.md")).and_then(|i| i.branch), None);
    }

    #[test]
    fn an_oversized_head_is_ignored() {
        let root = scratch("huge").join("repo");
        fs::create_dir_all(root.join(".git")).unwrap();
        let head = format!("ref: refs/heads/{}\n", "x".repeat(MAX_READ as usize));
        fs::write(root.join(".git/HEAD"), head).unwrap();
        assert_eq!(git_info(&root.join("a.md")).and_then(|i| i.branch), None);
    }

    #[test]
    fn the_upward_walk_is_bounded() {
        let mut deep = scratch("deep");
        fs::create_dir_all(deep.join(".git")).unwrap();
        fs::write(deep.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        for _ in 0..MAX_DEPTH {
            deep.push("d");
        }
        fs::create_dir_all(&deep).unwrap();
        assert_eq!(
            git_info(&deep.join("a.md")),
            Some(GitInfo { project: "d".into(), branch: None })
        );
    }

    #[test]
    fn it_serializes_the_way_the_drawer_reads_it() {
        let info = GitInfo { project: "infra".into(), branch: None };
        assert_eq!(serde_json::to_string(&info).unwrap(), r#"{"project":"infra","branch":null}"#);
    }

    #[test]
    fn the_project_root_is_the_repository_toplevel() {
        let root = scratch("proot").join("couplet");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("docs/deep")).unwrap();
        assert_eq!(project_root(&root.join("docs/deep/a.md")), Some(root));
    }

    #[test]
    fn a_worktree_is_its_own_project_root() {
        let wt = scratch("proot-wt").join("tabs-impl");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), "gitdir: /nowhere/.git/worktrees/tabs-impl\n").unwrap();
        assert_eq!(project_root(&wt.join("README.md")), Some(wt));
    }

    #[test]
    fn outside_git_the_project_root_is_the_files_directory() {
        let dir = scratch("proot-plain").join("notes");
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(project_root(&dir.join("a.md")), Some(dir));
        assert_eq!(project_root(Path::new("relative.md")), None);
        assert_eq!(project_root(Path::new("/tmp/../etc/a.md")), None);
    }

    #[test]
    fn repo_info_is_the_toplevel_inside_a_repository() {
        let root = scratch("repo-info").join("couplet");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/HEAD"), "ref: refs/heads/feat/stash\n").unwrap();
        assert_eq!(
            repo_info(&root.join("docs/plan.md")),
            Some(GitInfo { project: "couplet".into(), branch: Some("feat/stash".into()) })
        );
    }

    #[test]
    fn a_dotfiles_repository_in_home_is_not_a_repo_tag() {
        // `~/.git` (a bare-dotfiles setup) would otherwise tag every loose
        // file under the home folder with the user's login name.
        let home = scratch("repo-info-home").join("u");
        fs::create_dir_all(home.join(".git")).unwrap();
        fs::write(home.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        let loose = home.join("Downloads/a.md");
        assert_eq!(repo_info_in(&loose, Some(&home)), None);
        assert_eq!(repo_info_in(&home.join("a.md"), Some(&home)), None);
        assert_eq!(
            repo_info_in(&loose, None),
            Some(GitInfo { project: "u".into(), branch: Some("main".into()) }),
            "only the home folder itself is ignored"
        );

        let proj = home.join("src/proj");
        fs::create_dir_all(proj.join(".git")).unwrap();
        fs::write(proj.join(".git/HEAD"), "ref: refs/heads/dev\n").unwrap();
        assert_eq!(
            repo_info_in(&proj.join("a.md"), Some(&home)),
            Some(GitInfo { project: "proj".into(), branch: Some("dev".into()) }),
            "a real repository inside home still is one"
        );

        assert_eq!(
            git_info(&loose),
            Some(GitInfo { project: "u".into(), branch: Some("main".into()) }),
            "the drawer's grey line is unchanged"
        );
    }

    #[test]
    fn repo_info_is_none_outside_a_repository_where_git_info_falls_back() {
        let dir = scratch("repo-info-none").join("loose");
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(repo_info(&dir.join("a.md")), None, "no repo tag for a loose file");
        assert_eq!(
            git_info(&dir.join("a.md")),
            Some(GitInfo { project: "loose".into(), branch: None }),
            "the drawer's grey line is unchanged"
        );
    }

    #[test]
    fn the_git_toplevel_of_a_directory_is_found_from_itself_and_below() {
        let root = scratch("toplevel").join("couplet");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("src/deep")).unwrap();
        assert_eq!(git_toplevel(&root), Some(root.clone()));
        assert_eq!(git_toplevel(&root.join("src/deep")), Some(root));
    }

    #[test]
    fn a_worktree_directory_is_its_own_toplevel() {
        let wt = scratch("toplevel-wt").join("feature");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), "gitdir: /nowhere/.git/worktrees/feature\n").unwrap();
        assert_eq!(git_toplevel(&wt), Some(wt));
    }

    #[test]
    fn outside_git_a_directory_has_no_toplevel() {
        assert_eq!(git_toplevel(&scratch("toplevel-none")), None);
        assert_eq!(git_toplevel(Path::new("relative/dir")), None);
        assert_eq!(git_toplevel(Path::new("/tmp/../etc")), None);
    }

    #[test]
    fn a_dotfiles_repository_in_home_is_no_toplevel() {
        // Every agent working somewhere under `~` outside a project would
        // otherwise be scoped to the login name — a repo no file reference
        // stores (`repo_info_in`), so its search would find nothing.
        let home = scratch("toplevel-home").join("u");
        fs::create_dir_all(home.join(".git")).unwrap();
        fs::create_dir_all(home.join("Downloads")).unwrap();
        assert_eq!(git_toplevel_in(&home.join("Downloads"), Some(&home)), None);
        assert_eq!(git_toplevel_in(&home, Some(&home)), None);
        assert_eq!(git_toplevel_in(&home.join("Downloads"), None), Some(home.clone()));

        let proj = home.join("src/proj");
        fs::create_dir_all(proj.join(".git")).unwrap();
        assert_eq!(
            git_toplevel_in(&proj, Some(&home)),
            Some(proj),
            "a real repository inside home still is one"
        );
    }
}
