//! The note trash (stage 06): delete moves a note's file into
//! `StashPaths::trash_dir`, restore moves it back, purge is the one place
//! that deletes a note's bytes — and only a regular file directly inside that
//! directory. Every move is no-clobber; every move across volumes copies,
//! verifies and only then removes the source.

use std::fs;
use std::io::{ErrorKind, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

const MAX_SUFFIX: u32 = 999;
/// A name taken between `unique_target` and the move is retried this often.
const MOVE_ATTEMPTS: u32 = 5;

#[derive(Debug)]
pub(crate) enum MoveError {
    /// The destination exists. Nothing was changed.
    Exists,
    Other(String),
}

impl From<std::io::Error> for MoveError {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == ErrorKind::AlreadyExists {
            MoveError::Exists
        } else {
            MoveError::Other(e.to_string())
        }
    }
}

impl std::fmt::Display for MoveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MoveError::Exists => write!(f, "destination exists"),
            MoveError::Other(e) => write!(f, "{e}"),
        }
    }
}

fn occupied(path: &Path) -> bool {
    // `symlink_metadata`: a dangling symlink occupies its name too.
    fs::symlink_metadata(path).is_ok()
}

fn split_name(name: &str) -> (&str, Option<&str>) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], Some(&name[i + 1..])),
        _ => (name, None),
    }
}

/// `dir/file_name`, or the first `stem-N.ext` (N = 2…999) that is free on disk
/// and not held by another row (`taken`). Only a hint: the move itself is
/// what refuses a name taken since (`move_into`).
pub(crate) fn unique_target(
    dir: &Path,
    file_name: &str,
    taken: impl Fn(&Path) -> bool,
) -> Result<PathBuf, String> {
    let free = |p: &Path| !occupied(p) && !taken(p);
    let first = dir.join(file_name);
    if free(&first) {
        return Ok(first);
    }
    let (stem, ext) = split_name(file_name);
    for n in 2..=MAX_SUFFIX {
        let candidate = dir.join(match ext {
            Some(e) => format!("{stem}-{n}.{e}"),
            None => format!("{stem}-{n}"),
        });
        if free(&candidate) {
            return Ok(candidate);
        }
    }
    Err(format!("no free name for {file_name} in {}", dir.display()))
}

fn rename_excl(from: &Path, to: &Path) -> std::io::Result<()> {
    let f = crate::atomic_write::c_path(from).map_err(std::io::Error::other)?;
    let t = crate::atomic_write::c_path(to).map_err(std::io::Error::other)?;
    // SAFETY: both are NUL-terminated C strings that outlive the call.
    let rc = unsafe { libc::renamex_np(f.as_ptr(), t.as_ptr(), libc::RENAME_EXCL) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Move `from` to `to` without ever replacing `to`. Same volume: an atomic
/// exclusive rename (or link + unlink where the volume lacks RENAME_EXCL).
/// Across volumes: `copy_verify_remove`. Never `fs::rename`: on macOS it
/// silently replaces an existing destination.
pub(crate) fn move_no_clobber(from: &Path, to: &Path) -> Result<(), MoveError> {
    match rename_excl(from, to) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(libc::ENOTSUP) => link_then_unlink(from, to),
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => copy_verify_remove(from, to),
        Err(e) => Err(e.into()),
    }
}

/// The fallback where the volume has no RENAME_EXCL: `hard_link` refuses an
/// existing name, and the first name goes only once the second holds the
/// text. An unlink that fails leaves both names (`Other`): the caller treats
/// the move as not done, and nothing is lost.
fn link_then_unlink(from: &Path, to: &Path) -> Result<(), MoveError> {
    match fs::hard_link(from, to) {
        Ok(()) => fs::remove_file(from).map_err(|e| {
            MoveError::Other(format!(
                "{} linked to {} but not unlinked: {e}",
                from.display(),
                to.display()
            ))
        }),
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => copy_verify_remove(from, to),
        Err(e) => Err(e.into()),
    }
}

/// The roadmap's cross-volume rule: a second copy exists, is on disk and
/// matches byte for byte before the first one is removed. A source that will
/// not go leaves both copies (`Other`).
pub(crate) fn copy_verify_remove(from: &Path, to: &Path) -> Result<(), MoveError> {
    let bytes = fs::read(from)?;
    let mode = fs::metadata(from)?.permissions().mode() & 0o7777;
    {
        let mut out = fs::OpenOptions::new().write(true).create_new(true).open(to)?;
        out.write_all(&bytes)?;
        out.set_permissions(fs::Permissions::from_mode(mode))?;
        out.sync_all()?;
    }
    if fs::read(to)? != bytes {
        // Only the copy this call just created is removed; the source is intact.
        let _ = fs::remove_file(to);
        return Err(MoveError::Other(format!("copy to {} did not verify", to.display())));
    }
    fs::remove_file(from).map_err(|e| {
        MoveError::Other(format!(
            "{} copied to {} but not removed: {e}",
            from.display(),
            to.display()
        ))
    })
}

/// Move `from` into `dir` under `file_name` or its first free suffix; a name
/// taken between the check and the move is retried with the next one.
pub(crate) fn move_into(
    dir: &Path,
    file_name: &str,
    from: &Path,
    taken: impl Fn(&Path) -> bool,
) -> Result<PathBuf, String> {
    for _ in 0..MOVE_ATTEMPTS {
        let target = unique_target(dir, file_name, &taken)?;
        match move_no_clobber(from, &target) {
            Ok(()) => return Ok(target),
            Err(MoveError::Exists) => continue,
            Err(e) => return Err(format!("move {} → {}: {e}", from.display(), target.display())),
        }
    }
    Err(format!("could not find a free name for {file_name} in {}", dir.display()))
}

/// The purge guard (D9). `Ok(Some(canonical))`: a regular file directly inside
/// `trash_dir`, itself a real directory — safe to delete. `Ok(None)`: nothing
/// there any more, nothing to delete. `Err`: anything else — never delete it.
pub(crate) fn purgeable_file(trash_dir: &Path, path: &Path) -> Result<Option<PathBuf>, String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    // A symlinked `.trash` would make wherever it points "the trash".
    crate::session::require_real_trash_dir(trash_dir)?;
    if !meta.file_type().is_file() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    let name = path
        .file_name()
        .ok_or_else(|| format!("{} has no file name", path.display()))?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent", path.display()))?;
    let canon_parent =
        fs::canonicalize(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    let canon_trash =
        fs::canonicalize(trash_dir).map_err(|e| format!("{}: {e}", trash_dir.display()))?;
    if canon_parent != canon_trash {
        return Err(format!("{} is outside the note trash", path.display()));
    }
    Ok(Some(canon_parent.join(name)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atomic_write::testkit::scratch;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn never_taken(_: &Path) -> bool {
        false
    }

    /// Makes `dir` read-only for the rest of the test's scope (unlinking in
    /// it fails), and writable again on drop so the scratch dir can be read.
    struct ReadOnly<'a>(&'a Path);

    impl<'a> ReadOnly<'a> {
        fn new(dir: &'a Path) -> Self {
            fs::set_permissions(dir, fs::Permissions::from_mode(0o555)).unwrap();
            Self(dir)
        }
    }

    impl Drop for ReadOnly<'_> {
        fn drop(&mut self) {
            let _ = fs::set_permissions(self.0, fs::Permissions::from_mode(0o755));
        }
    }

    #[test]
    fn unique_target_returns_the_plain_name_when_free() {
        let dir = scratch("trash-uniq-free");
        assert_eq!(unique_target(&dir, "a.md", never_taken).unwrap(), dir.join("a.md"));
    }

    #[test]
    fn unique_target_suffixes_before_the_extension() {
        let dir = scratch("trash-uniq-suffix");
        fs::write(dir.join("a.md"), "1").unwrap();
        assert_eq!(unique_target(&dir, "a.md", never_taken).unwrap(), dir.join("a-2.md"));
        fs::write(dir.join("a-2.md"), "2").unwrap();
        assert_eq!(unique_target(&dir, "a.md", never_taken).unwrap(), dir.join("a-3.md"));
    }

    #[test]
    fn unique_target_handles_names_without_extension_and_dotfiles() {
        let dir = scratch("trash-uniq-noext");
        fs::write(dir.join("notes"), "1").unwrap();
        assert_eq!(unique_target(&dir, "notes", never_taken).unwrap(), dir.join("notes-2"));
        fs::write(dir.join(".mdmini_comments_a.md"), "1").unwrap();
        assert_eq!(
            unique_target(&dir, ".mdmini_comments_a.md", never_taken).unwrap(),
            dir.join(".mdmini_comments_a-2.md")
        );
    }

    #[test]
    fn unique_target_skips_names_another_row_holds() {
        let dir = scratch("trash-uniq-db");
        let taken = dir.join("a.md");
        assert_eq!(
            unique_target(&dir, "a.md", |p| p == taken).unwrap(),
            dir.join("a-2.md")
        );
    }

    #[test]
    fn unique_target_treats_a_dangling_symlink_as_taken() {
        let dir = scratch("trash-uniq-dangling");
        symlink(dir.join("nowhere"), dir.join("a.md")).unwrap();
        assert_eq!(unique_target(&dir, "a.md", never_taken).unwrap(), dir.join("a-2.md"));
    }

    #[test]
    fn move_no_clobber_moves_and_keeps_the_bytes() {
        let dir = scratch("trash-move");
        fs::write(dir.join("a.md"), "тайник\r\nline").unwrap();
        move_no_clobber(&dir.join("a.md"), &dir.join("b.md")).unwrap();
        assert!(!dir.join("a.md").exists());
        assert_eq!(fs::read(dir.join("b.md")).unwrap(), "тайник\r\nline".as_bytes());
    }

    #[test]
    fn move_no_clobber_never_overwrites() {
        let dir = scratch("trash-move-excl");
        fs::write(dir.join("a.md"), "mine").unwrap();
        fs::write(dir.join("b.md"), "theirs").unwrap();
        assert!(matches!(
            move_no_clobber(&dir.join("a.md"), &dir.join("b.md")),
            Err(MoveError::Exists)
        ));
        assert_eq!(fs::read_to_string(dir.join("a.md")).unwrap(), "mine");
        assert_eq!(fs::read_to_string(dir.join("b.md")).unwrap(), "theirs");
    }

    #[test]
    fn move_no_clobber_never_overwrites_a_dangling_symlink() {
        let dir = scratch("trash-move-dangling");
        fs::write(dir.join("a.md"), "mine").unwrap();
        symlink(dir.join("nowhere"), dir.join("b.md")).unwrap();
        assert!(matches!(
            move_no_clobber(&dir.join("a.md"), &dir.join("b.md")),
            Err(MoveError::Exists)
        ));
        assert_eq!(fs::read_to_string(dir.join("a.md")).unwrap(), "mine");
        assert!(fs::symlink_metadata(dir.join("b.md")).unwrap().file_type().is_symlink());
    }

    #[test]
    fn link_fallback_moves_and_never_overwrites() {
        let dir = scratch("trash-link");
        fs::write(dir.join("a.md"), "text").unwrap();
        link_then_unlink(&dir.join("a.md"), &dir.join("b.md")).unwrap();
        assert!(!dir.join("a.md").exists());
        assert_eq!(fs::read_to_string(dir.join("b.md")).unwrap(), "text");

        fs::write(dir.join("c.md"), "mine").unwrap();
        assert!(matches!(
            link_then_unlink(&dir.join("c.md"), &dir.join("b.md")),
            Err(MoveError::Exists)
        ));
        assert_eq!(fs::read_to_string(dir.join("c.md")).unwrap(), "mine");
        assert_eq!(fs::read_to_string(dir.join("b.md")).unwrap(), "text");
    }

    #[test]
    fn link_fallback_has_the_second_name_before_the_first_goes() {
        // The source's folder refuses the unlink: the new name must already
        // hold the text, and the old one must still hold it too.
        let root = scratch("trash-link-order");
        let from_dir = root.join("from");
        let to_dir = root.join("to");
        fs::create_dir_all(&from_dir).unwrap();
        fs::create_dir_all(&to_dir).unwrap();
        fs::write(from_dir.join("a.md"), "text").unwrap();
        let result = {
            let _ro = ReadOnly::new(&from_dir);
            link_then_unlink(&from_dir.join("a.md"), &to_dir.join("a.md"))
        };
        assert!(matches!(result, Err(MoveError::Other(_))), "{result:?}");
        assert_eq!(fs::read_to_string(from_dir.join("a.md")).unwrap(), "text");
        assert_eq!(fs::read_to_string(to_dir.join("a.md")).unwrap(), "text");
    }

    #[test]
    fn copy_fallback_verifies_then_removes_the_source() {
        let dir = scratch("trash-copy");
        fs::write(dir.join("a.md"), "text").unwrap();
        fs::set_permissions(dir.join("a.md"), fs::Permissions::from_mode(0o600)).unwrap();
        copy_verify_remove(&dir.join("a.md"), &dir.join("b.md")).unwrap();
        assert!(!dir.join("a.md").exists());
        assert_eq!(fs::read_to_string(dir.join("b.md")).unwrap(), "text");
        assert_eq!(
            fs::metadata(dir.join("b.md")).unwrap().permissions().mode() & 0o7777,
            0o600
        );
    }

    #[test]
    fn copy_fallback_never_overwrites() {
        let dir = scratch("trash-copy-excl");
        fs::write(dir.join("a.md"), "mine").unwrap();
        fs::write(dir.join("b.md"), "theirs").unwrap();
        assert!(matches!(
            copy_verify_remove(&dir.join("a.md"), &dir.join("b.md")),
            Err(MoveError::Exists)
        ));
        assert_eq!(fs::read_to_string(dir.join("a.md")).unwrap(), "mine");
        assert_eq!(fs::read_to_string(dir.join("b.md")).unwrap(), "theirs");
    }

    #[test]
    fn copy_fallback_has_the_copy_on_disk_before_the_source_goes() {
        let root = scratch("trash-copy-order");
        let from_dir = root.join("from");
        let to_dir = root.join("to");
        fs::create_dir_all(&from_dir).unwrap();
        fs::create_dir_all(&to_dir).unwrap();
        fs::write(from_dir.join("a.md"), "text").unwrap();
        let result = {
            let _ro = ReadOnly::new(&from_dir);
            copy_verify_remove(&from_dir.join("a.md"), &to_dir.join("a.md"))
        };
        assert!(matches!(result, Err(MoveError::Other(_))), "{result:?}");
        assert_eq!(fs::read_to_string(from_dir.join("a.md")).unwrap(), "text");
        assert_eq!(fs::read_to_string(to_dir.join("a.md")).unwrap(), "text");
    }

    #[test]
    fn move_into_retries_past_a_name_taken_after_the_check() {
        let root = scratch("trash-move-into");
        let trash = root.join(".trash");
        fs::create_dir_all(&trash).unwrap();
        fs::write(root.join("a.md"), "note").unwrap();
        fs::write(trash.join("a.md"), "older").unwrap();
        let dest = move_into(&trash, "a.md", &root.join("a.md"), never_taken).unwrap();
        assert_eq!(dest, trash.join("a-2.md"));
        assert_eq!(fs::read_to_string(trash.join("a.md")).unwrap(), "older");
        assert_eq!(fs::read_to_string(&dest).unwrap(), "note");
        assert!(!root.join("a.md").exists());
    }

    #[test]
    fn move_into_skips_a_name_that_appears_between_the_check_and_the_move() {
        // `taken` reports the name free, then something takes it before the
        // move: the exclusive rename refuses, and the next name is used.
        let root = scratch("trash-move-into-race");
        let trash = root.join(".trash");
        fs::create_dir_all(&trash).unwrap();
        fs::write(root.join("a.md"), "note").unwrap();
        let racer = trash.join("a.md");
        let raced = std::cell::Cell::new(false);
        let dest = move_into(&trash, "a.md", &root.join("a.md"), |p| {
            if p == racer && !raced.get() {
                raced.set(true);
                fs::write(&racer, "theirs").unwrap();
                return false;
            }
            false
        })
        .unwrap();
        assert_eq!(dest, trash.join("a-2.md"));
        assert_eq!(fs::read_to_string(&racer).unwrap(), "theirs");
        assert_eq!(fs::read_to_string(&dest).unwrap(), "note");
    }

    #[test]
    fn purgeable_file_accepts_a_regular_file_in_the_trash() {
        let root = scratch("trash-guard-ok");
        let trash = root.join(".trash");
        fs::create_dir_all(&trash).unwrap();
        fs::write(trash.join("a.md"), "x").unwrap();
        let got = purgeable_file(&trash, &trash.join("a.md")).unwrap().unwrap();
        assert_eq!(got.file_name().unwrap(), "a.md");
        assert_eq!(got.parent().unwrap(), fs::canonicalize(&trash).unwrap());
    }

    #[test]
    fn purgeable_file_is_none_for_a_missing_file() {
        let root = scratch("trash-guard-missing");
        let trash = root.join(".trash");
        fs::create_dir_all(&trash).unwrap();
        assert_eq!(purgeable_file(&trash, &trash.join("gone.md")).unwrap(), None);
    }

    #[test]
    fn purgeable_file_refuses_everything_outside_the_trash() {
        let root = scratch("trash-guard-outside");
        let trash = root.join(".trash");
        fs::create_dir_all(&trash).unwrap();
        fs::write(root.join("live.md"), "x").unwrap();
        let elsewhere = scratch("trash-guard-elsewhere");
        fs::write(elsewhere.join("doc.md"), "x").unwrap();
        fs::create_dir_all(trash.join("sub")).unwrap();
        fs::write(trash.join("sub").join("deep.md"), "x").unwrap();

        assert!(purgeable_file(&trash, &root.join("live.md")).is_err());
        assert!(purgeable_file(&trash, &elsewhere.join("doc.md")).is_err());
        assert!(purgeable_file(&trash, &trash.join("..").join("live.md")).is_err());
        assert!(purgeable_file(&trash, &trash.join("sub").join("deep.md")).is_err());
        assert!(purgeable_file(&trash, &trash.join("sub")).is_err());
    }

    #[test]
    fn purgeable_file_refuses_a_symlink_in_the_trash() {
        let root = scratch("trash-guard-symlink");
        let trash = root.join(".trash");
        fs::create_dir_all(&trash).unwrap();
        fs::write(root.join("precious.md"), "keep me").unwrap();
        symlink(root.join("precious.md"), trash.join("a.md")).unwrap();
        assert!(purgeable_file(&trash, &trash.join("a.md")).is_err());
    }

    #[test]
    fn purgeable_file_refuses_a_symlinked_trash_folder() {
        // `.trash` itself a symlink to a real folder: its files are not the
        // trash's, however their canonical parents compare.
        let root = scratch("trash-guard-symlinked-dir");
        let real = root.join("documents");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("a.md"), "keep me").unwrap();
        let trash = root.join(".trash");
        symlink(&real, &trash).unwrap();
        assert!(purgeable_file(&trash, &trash.join("a.md")).is_err());
        assert!(purgeable_file(&trash, &real.join("a.md")).is_err());
    }

    #[test]
    fn purgeable_file_refuses_when_the_trash_dir_does_not_exist() {
        let root = scratch("trash-guard-nodir");
        fs::write(root.join("a.md"), "x").unwrap();
        assert!(purgeable_file(&root.join(".trash"), &root.join("a.md")).is_err());
    }
}
