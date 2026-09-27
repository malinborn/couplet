//! The stash for agents and the command line — `couplet stash …` and the MCP
//! `stash_*` tools (spec «Агент»). Runs WITHOUT a Tauri context, over its own
//! connection to the same `stash.db` the app uses (WAL + 5 s busy timeout),
//! so it works whether or not couplet is running.
//!
//! An agent never gets the whole stash: search answers snippets, list answers
//! metadata, and only `get` returns text — of one entry, capped.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{clock, entries, Stash, StashPaths};

/// Answer to a write when the app data directory does not exist yet (A12).
pub const NOT_RUN_YET: &str = "couplet has not run on this Mac yet — open it once, then try again";

/// Where one couplet build keeps its stash, resolved without a Tauri context.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StashLocation {
    /// The product's stash paths: `stash.db` in
    /// `~/Library/Application Support/<product>/`, notes in `~/<product>/`.
    pub paths: StashPaths,
    /// The app's command socket, told about writes. `None`: nobody is told.
    pub socket: Option<PathBuf>,
}

impl StashLocation {
    /// `~/Library/Application Support/<product>/`: the directory whose
    /// existence says the app has run on this Mac (plan D4).
    pub fn app_dir(&self) -> &Path {
        self.paths.db_path.parent().unwrap_or(Path::new("/"))
    }
}

/// The location of `product`'s stash under the given bases — pure, so tests
/// can name any base; `location_from_flags` passes the real ones.
pub fn location_for_product(product: &str, data_base: &Path, home: &Path) -> StashLocation {
    let name = crate::paths::dir_name(product);
    StashLocation {
        paths: StashPaths::from_bases(home, &data_base.join(&name), &name),
        socket: Some(crate::ai_socket::socket_path(product)),
    }
}

/// `--product` / `--socket` into a location (plan D3, A12). A socket alone is
/// refused: it names a non-release build, and the stash would silently be
/// the release one's. So is a product `paths::dir_name` would not take as
/// given — it falls back to `couplet`, the release stash, for exactly the
/// names a typo produces — and `.`/`..`, which would put `stash.db` beside
/// the app data folders and the notes in `/Users`. Path arithmetic only:
/// nothing is created or even looked at.
pub fn location_from_flags(
    product: Option<&str>,
    socket: Option<&str>,
) -> Result<StashLocation, String> {
    if socket.is_some() && product.is_none() {
        return Err("--socket names another couplet build: pass --product too (e.g. --product couplet-dev), so the stash is that build's and not the release one".to_string());
    }
    let product = product.unwrap_or(crate::paths::RELEASE_PRODUCT_NAME);
    if crate::paths::dir_name(product) != product || product == "." || product == ".." {
        return Err(format!(
            "invalid --product {product:?}: a product name such as couplet-dev, with no slashes or surrounding spaces"
        ));
    }
    let data = dirs::data_dir().ok_or("cannot determine the application data directory")?;
    let home = dirs::home_dir().ok_or("cannot determine the home folder")?;
    let mut loc = location_for_product(product, &data, &home);
    if let Some(s) = socket {
        loc.socket = Some(PathBuf::from(s));
    }
    Ok(loc)
}

/// The stash for reading, or `None` when it does not exist yet — a read
/// never creates it (A12). `db::open` always creates its file and folder, and
/// opening any other way would skip its pragmas, migration and `stash_fold`,
/// so the file is checked first; once it exists, `db::open`'s creates are
/// no-ops (SQLite may add `-wal`/`-shm` beside it, and a v1 file is
/// migrated). A file removed between the check and the open is recreated
/// empty inside the existing app dir — what a write may do anyway.
fn open_for_read(loc: &StashLocation) -> Result<Option<Stash>, String> {
    if !loc.paths.db_path.is_file() {
        return Ok(None);
    }
    Stash::open(loc.paths.clone())
        .map(Some)
        .map_err(|e| e.to_string())
}

/// The stash for writing. Refused while the app data directory does not
/// exist: one file in a freshly created `couplet/` before the app's first
/// launch makes `migration.rs` skip an installed md-mini's data for good
/// (plan D4). Checked before anything else touches the disk — no note file,
/// no notes folder. `stash.db` itself may be created inside the existing dir.
fn open_for_write(loc: &StashLocation) -> Result<Stash, String> {
    if !loc.app_dir().is_dir() {
        return Err(NOT_RUN_YET.to_string());
    }
    Stash::open(loc.paths.clone()).map_err(|e| e.to_string())
}

/// What the caller asked the scope to be.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum ScopeArg {
    /// The repository of the caller's cwd; the whole stash outside git.
    #[default]
    Default,
    All,
    /// A repository name, or — containing `/` — a path inside one.
    Repo(String),
}

/// The scope a call ran with, echoed in every search/list answer so the
/// agent knows its results were filtered (plan D6).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Scope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub all: bool,
}

/// A directory's repository by name — the name a window shows for its
/// project and stage 02 stores in `entries.repo`. The name does not depend
/// on the spelling; the home comparison in `git_toplevel` does, hence the
/// normalization.
pub(crate) fn repo_of_dir(dir: &Path) -> Option<String> {
    let dir = crate::path_norm::normalize_path(dir);
    crate::git_info::git_toplevel(&dir).map(|top| crate::git_info::dir_name(&top))
}

/// The scope of a call made from `cwd` (plan D5). A blank repo name counts
/// as none given: an MCP client may fill an optional string with `""`, and
/// filtering on an empty repo would silently find nothing.
pub fn resolve_scope(arg: &ScopeArg, cwd: &Path) -> Scope {
    let repo = |name: String| Scope {
        repo: Some(name),
        all: false,
    };
    match arg {
        ScopeArg::All => Scope {
            repo: None,
            all: true,
        },
        ScopeArg::Repo(r) if r.contains('/') => {
            let dir = PathBuf::from(crate::resolve_path(r.trim(), cwd.to_str()));
            repo(repo_of_dir(&dir).unwrap_or_else(|| crate::git_info::dir_name(&dir)))
        }
        ScopeArg::Repo(r) => match entries::normalize_repo(Some(r)) {
            Some(name) => repo(name),
            None => resolve_scope(&ScopeArg::Default, cwd),
        },
        ScopeArg::Default => match repo_of_dir(cwd) {
            Some(name) => repo(name),
            None => Scope {
                repo: None,
                all: true,
            },
        },
    }
}

/// `get` without a range returns at most this many lines…
pub const GET_MAX_LINES: usize = 500;
/// …and at most this many bytes (a single longer first line comes back whole).
pub const GET_MAX_BYTES: usize = 64 * 1024;

const DAY_MS: i64 = 86_400_000;
const HOUR_MS: i64 = 3_600_000;

fn offset_at(ms: i64) -> i64 {
    clock::local_offset_secs(ms.div_euclid(1000))
}

/// `2026-09-27T01:55:12+03:00` in the machine's local zone — readable to a
/// model, unlike unix ms, and still unambiguous (plan D7).
pub fn iso_local(ms: i64) -> String {
    let offset = offset_at(ms);
    let local = ms.div_euclid(1000) + offset;
    let (year, month, day) = clock::civil_from_days(local.div_euclid(86_400));
    let secs = local.rem_euclid(86_400);
    let sign = if offset < 0 { '-' } else { '+' };
    let off = offset.abs();
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}{sign}{:02}:{:02}",
        secs / 3600,
        secs % 3600 / 60,
        secs % 60,
        off / 3600,
        off % 3600 / 60
    )
}

/// `--since` / `since`: `today`, `yesterday` (local midnight — the drawer's
/// «сегодня», `clock::local_day_start_ms`), `12h`, `7d`, `YYYY-MM-DD` (local
/// midnight of that date), or unix ms.
pub fn parse_since(s: &str, now_ms: i64) -> Result<i64, String> {
    let bad = || {
        format!("invalid since: {s:?} (expected today, yesterday, 12h, 7d, YYYY-MM-DD or unix ms)")
    };
    let t = s.trim();
    let digits = |x: &str| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit());
    let back = |n: &str, unit: i64| {
        n.parse::<i64>()
            .ok()
            .and_then(|n| n.checked_mul(unit))
            .and_then(|d| now_ms.checked_sub(d))
            .ok_or_else(bad)
    };
    match t {
        "today" => return Ok(clock::local_day_start_ms(now_ms, offset_at(now_ms))),
        "yesterday" => {
            let today = clock::local_day_start_ms(now_ms, offset_at(now_ms));
            return Ok(clock::local_day_start_ms(today - 1, offset_at(today - 1)));
        }
        _ => {}
    }
    if let Some(n) = t.strip_suffix('h').filter(|n| digits(n)) {
        return back(n, HOUR_MS);
    }
    if let Some(n) = t.strip_suffix('d').filter(|n| digits(n)) {
        return back(n, DAY_MS);
    }
    let b = t.as_bytes();
    if t.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && digits(&t[0..4])
        && digits(&t[5..7])
        && digits(&t[8..10])
    {
        let num = |r: std::ops::Range<usize>| t[r].parse::<i32>().map_err(|_| bad());
        return clock::local_midnight(num(0..4)?, num(5..7)?, num(8..10)?).ok_or_else(bad);
    }
    if digits(t) {
        return t.parse().map_err(|_| bad());
    }
    Err(bad())
}

/// A 1-based inclusive line range; `to: None` runs to the last line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LineRange {
    pub from: usize,
    pub to: Option<usize>,
}

/// `A:B`, `A:` or `:B`.
pub fn parse_lines(s: &str) -> Result<LineRange, String> {
    let bad = || format!("invalid line range: {s:?} (expected A:B, A: or :B, 1-based)");
    let (a, b) = s.trim().split_once(':').ok_or_else(bad)?;
    let num = |t: &str| -> Result<Option<usize>, String> {
        if t.is_empty() {
            return Ok(None);
        }
        if !t.bytes().all(|c| c.is_ascii_digit()) {
            return Err(bad());
        }
        t.parse::<usize>().map(Some).map_err(|_| bad())
    };
    let from = num(a)?.unwrap_or(1);
    let to = num(b)?;
    if from == 0 || to == Some(0) || to.is_some_and(|t| t < from) {
        return Err(bad());
    }
    Ok(LineRange { from, to })
}

#[derive(Debug, PartialEq, Eq)]
pub struct Sliced {
    pub text: String,
    /// The lines actually returned; `[0, 0]` for an empty note.
    pub lines: [usize; 2],
    pub total_lines: usize,
    /// Fewer lines than asked for came back (a cap was hit).
    pub truncated: bool,
}

/// The asked-for lines of `text` (all of them by default), within
/// `GET_MAX_LINES` / `GET_MAX_BYTES` (plan D8). Line endings come back `\n`.
pub fn slice_lines(text: &str, range: Option<LineRange>) -> Result<Sliced, String> {
    let all: Vec<&str> = text.lines().collect();
    let total = all.len();
    let range = range.unwrap_or(LineRange { from: 1, to: None });
    if total == 0 && range.from == 1 {
        return Ok(Sliced {
            text: String::new(),
            lines: [0, 0],
            total_lines: 0,
            truncated: false,
        });
    }
    if range.from > total {
        return Err(format!(
            "line {} is past the end of the note ({total} lines)",
            range.from
        ));
    }
    let wanted_to = range.to.unwrap_or(total).min(total);
    let mut out = String::new();
    let mut last = range.from - 1;
    for (i, line) in all[range.from - 1..wanted_to].iter().enumerate() {
        let over_lines = i >= GET_MAX_LINES;
        let over_bytes = !out.is_empty() && out.len() + 1 + line.len() > GET_MAX_BYTES;
        if over_lines || over_bytes {
            break;
        }
        if i > 0 {
            out.push('\n');
        }
        out.push_str(line);
        last = range.from + i;
    }
    Ok(Sliced {
        text: out,
        lines: [range.from, last],
        total_lines: total,
        truncated: last < wanted_to,
    })
}

/// Tags as an agent gives them, in stage 02's one rule set
/// (`entries::normalize_tag`: trim, strip `#`, lower-case, one word, ≤ 64
/// chars), duplicates dropped. Unlike `entries::normalize_tags`, a tag that
/// comes out empty is an error: an agent that sent `#` meant something.
pub fn agent_tags(raw: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for t in raw {
        let tag = entries::normalize_tag(t)?.ok_or_else(|| format!("empty tag: {t:?}"))?;
        if !out.contains(&tag) {
            out.push(tag);
        }
    }
    Ok(out)
}

/// At most `max` characters, with `…` when cut.
pub fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atomic_write::testkit::scratch;
    use std::fs;

    /// Stage 07 is written against these signatures (plan Task 1, mapped onto
    /// the real stage 02–06 API by the reconcile). A mismatch fails to compile
    /// here, in one place.
    #[test]
    fn the_stage_api_is_what_stage_07_assumes() {
        use crate::stash::entries::{self, PutAwayPlan};
        use crate::stash::trash::Deleted;
        use crate::stash::{
            db, search, ListQuery, ListResult, ListSort, PutAway, PutAwayResult, Stash, StashEntry,
            StashKind, StashPaths, Tagged,
        };
        use rusqlite::Connection;

        let _: fn(&Path, &Path, &str) -> StashPaths = StashPaths::from_bases;
        let _: fn(StashPaths) -> Result<Stash, db::OpenError> = Stash::open;
        let _: fn(&mut Stash, &str, Option<&str>, i64, i64) -> Result<StashEntry, String> =
            Stash::create_note;
        let _: fn(&PutAway, &Path, i64) -> Result<PutAwayPlan, String> = entries::plan_put_away;
        let _: fn(&mut Stash, PutAwayPlan, i64) -> Result<Vec<PutAwayResult>, String> =
            Stash::put_away_probed;
        let _: fn(&Stash, &ListQuery) -> Result<ListResult, String> = Stash::list;
        let _: fn(&Stash, &str) -> Result<StashEntry, String> = Stash::get;
        let _: fn(&mut Stash, &str, &[String], &[String]) -> Result<Tagged, String> = Stash::tag;
        let _: fn(&mut Stash, &str, i64) -> Result<Deleted, String> = Stash::delete_entry;
        let _: fn(&mut Stash, i64, i64) = Stash::after_write;
        let _: fn(&str) -> Result<Option<String>, String> = entries::normalize_tag;
        let _: fn(Option<&str>) -> Option<String> = entries::normalize_repo;
        let _: fn(&Path) -> Result<std::fs::File, String> = entries::open_readable_now;
        let _: fn(&tauri::AppHandle, &str, Option<Vec<String>>) = crate::stash::emit_changed;
        // `select_page`'s draft type is not nameable outside `search::run`.
        let _ = |c: &Connection, a: &search::SearchArgs| {
            search::select_page(c, a).map(|d| d.into_page())
        };

        // The fields stage 07 reads: a missing or retyped one fails here.
        fn fields(
            p: &StashPaths,
            e: &StashEntry,
            l: &ListResult,
            s: &search::SearchPage,
            r: &PutAwayResult,
            t: &Tagged,
        ) {
            let _: (&PathBuf, &PathBuf) = (&p.db_path, &p.notes_dir);
            let _: (
                &String,
                StashKind,
                &String,
                &Option<String>,
                &Option<String>,
                &Option<String>,
                &Vec<String>,
            ) = (
                &e.id, e.kind, &e.path, &e.title, &e.repo, &e.branch, &e.tags,
            );
            let _: (i64, Option<i64>, Option<i64>) = (e.modified_at, e.stashed_at, e.deleted_at);
            let _: (&Vec<StashEntry>, usize, &Option<String>) =
                (&l.entries, l.total, &l.next_cursor);
            let _: (usize, &Option<String>) = (s.total, &s.next_cursor);
            let _: Vec<(&StashEntry, &String)> =
                s.hits.iter().map(|h| (&h.entry, &h.snippet)).collect();
            let _: (&StashEntry, bool) = (&r.entry, r.created);
            let _: (&StashEntry, bool) = (&t.entry, t.changed);
        }
        let _ = fields;
        let _ = ListQuery {
            repo: None,
            tag: None,
            kind: Some(StashKind::Note),
            sort: ListSort::Changed,
            deleted: false,
            since: None,
            limit: Some(1),
            cursor: None,
        };
        let _ = search::SearchArgs {
            query: String::new(),
            repo: None,
            tag: None,
            kind: Some(StashKind::File),
            deleted: false,
            limit: Some(1),
            cursor: None,
        };
        let _ = PutAway {
            paths: vec![],
            caret: None,
            top_line: None,
            tags: vec![],
            project: None,
        };
        let _: Option<StashKind> = StashKind::parse("note");
    }

    /// `<scratch>/<name>/` with a `.git` dir and a `sub/`.
    fn temp_repo(name: &str) -> PathBuf {
        let root = scratch("stash-cli-repo").join(name);
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();
        root
    }

    fn outside_git() -> PathBuf {
        scratch("stash-cli-nogit")
    }

    #[test]
    fn the_default_scope_is_the_repository_of_the_cwd() {
        let repo = temp_repo("alpha");
        let scope = resolve_scope(&ScopeArg::Default, &repo.join("sub"));
        assert_eq!(
            scope,
            Scope {
                repo: Some("alpha".to_string()),
                all: false
            }
        );
    }

    #[test]
    fn outside_git_the_default_scope_is_everything() {
        assert_eq!(
            resolve_scope(&ScopeArg::Default, &outside_git()),
            Scope {
                repo: None,
                all: true
            }
        );
    }

    #[test]
    fn all_and_a_named_repo_override_the_cwd() {
        let cwd = temp_repo("alpha").join("sub");
        assert_eq!(
            resolve_scope(&ScopeArg::All, &cwd),
            Scope {
                repo: None,
                all: true
            }
        );
        assert_eq!(
            resolve_scope(&ScopeArg::Repo("beta".to_string()), &cwd),
            Scope {
                repo: Some("beta".to_string()),
                all: false
            }
        );
        assert_eq!(
            resolve_scope(&ScopeArg::Repo(" beta ".to_string()), &cwd)
                .repo
                .as_deref(),
            Some("beta"),
            "a name meets the stored column in its one spelling"
        );
    }

    #[test]
    fn a_blank_repo_is_the_default_scope() {
        // An MCP client may fill an optional string with "".
        let cwd = temp_repo("alpha").join("sub");
        assert_eq!(
            resolve_scope(&ScopeArg::Repo("  ".to_string()), &cwd),
            resolve_scope(&ScopeArg::Default, &cwd)
        );
    }

    #[test]
    fn a_repo_given_as_a_path_is_named_by_its_toplevel() {
        let alpha = temp_repo("alpha");
        let beta = alpha.parent().unwrap().join("beta");
        fs::create_dir_all(beta.join(".git")).unwrap();
        fs::create_dir_all(beta.join("docs")).unwrap();
        let scope = resolve_scope(
            &ScopeArg::Repo("../../beta/docs".to_string()),
            &alpha.join("sub"),
        );
        assert_eq!(scope.repo.as_deref(), Some("beta"));
        let loose = alpha.parent().unwrap().join("loose");
        fs::create_dir_all(&loose).unwrap();
        let scope = resolve_scope(
            &ScopeArg::Repo("../../loose".to_string()),
            &alpha.join("sub"),
        );
        assert_eq!(
            scope.repo.as_deref(),
            Some("loose"),
            "outside git: the directory's name"
        );
    }

    #[test]
    fn the_scope_serializes_compactly() {
        let repo = Scope {
            repo: Some("couplet".to_string()),
            all: false,
        };
        assert_eq!(
            serde_json::to_string(&repo).unwrap(),
            r#"{"repo":"couplet"}"#
        );
        assert_eq!(
            serde_json::to_string(&Scope {
                repo: None,
                all: true
            })
            .unwrap(),
            r#"{"all":true}"#
        );
    }

    /// A location under a scratch dir, laid out like `testkit::paths_in`.
    /// `app_ran`: the app data dir exists, as it does once couplet has run.
    fn temp_location(tag: &str, app_ran: bool) -> StashLocation {
        let root = scratch(&format!("stash-cli-{tag}"));
        let loc = StashLocation {
            paths: crate::stash::testkit::paths_in(&root),
            socket: None,
        };
        if app_ran {
            fs::create_dir_all(loc.app_dir()).unwrap();
        }
        loc
    }

    #[test]
    fn a_product_names_the_app_dir_the_notes_dir_and_the_socket() {
        let loc = location_for_product("couplet-dev", Path::new("/D"), Path::new("/H"));
        assert_eq!(loc.paths.db_path, PathBuf::from("/D/couplet-dev/stash.db"));
        assert_eq!(loc.app_dir(), Path::new("/D/couplet-dev"));
        assert_eq!(loc.paths.notes_dir, PathBuf::from("/H/couplet-dev"));
        assert_eq!(loc.paths.trash_dir, PathBuf::from("/H/couplet-dev/.trash"));
        assert_eq!(loc.socket, Some(PathBuf::from("/tmp/couplet_dev_cmd.sock")));
        let release = location_for_product(
            crate::paths::RELEASE_PRODUCT_NAME,
            Path::new("/D"),
            Path::new("/H"),
        );
        assert_eq!(release.paths.db_path, PathBuf::from("/D/couplet/stash.db"));
        assert_eq!(release.socket, Some(PathBuf::from("/tmp/couplet_cmd.sock")));
    }

    #[test]
    fn a_socket_without_a_product_is_refused() {
        let err = location_from_flags(None, Some("/tmp/couplet_dev_cmd.sock")).unwrap_err();
        assert!(err.contains("--product"), "{err}");
    }

    #[test]
    fn a_product_the_directory_rule_would_rewrite_is_refused() {
        // `paths::dir_name` maps each of these to `couplet` — the release stash.
        for bad in [
            "",
            " ",
            "../x",
            "a/b",
            "a\\b",
            " couplet-dev",
            "couplet-dev ",
            ".",
            "..",
        ] {
            let err = location_from_flags(Some(bad), None).unwrap_err();
            assert!(err.contains("--product"), "{bad:?}: {err}");
        }
    }

    #[test]
    fn a_socket_with_a_product_overrides_only_the_socket() {
        // Pure path arithmetic over dirs::data_dir() / home_dir(): nothing is created.
        let loc = location_from_flags(Some("couplet-dev"), Some("/tmp/x.sock")).unwrap();
        assert_eq!(loc.socket, Some(PathBuf::from("/tmp/x.sock")));
        assert!(
            loc.app_dir().ends_with("couplet-dev"),
            "{:?}",
            loc.app_dir()
        );
        assert!(
            loc.paths.notes_dir.ends_with("couplet-dev"),
            "{:?}",
            loc.paths.notes_dir
        );
        assert_eq!(
            loc.paths.notes_dir.parent(),
            dirs::home_dir().as_deref(),
            "notes live in the home folder (roadmap A1)"
        );
        let release = location_from_flags(None, None).unwrap();
        assert!(release
            .app_dir()
            .ends_with(crate::paths::RELEASE_PRODUCT_NAME));
    }

    #[test]
    fn reading_a_stash_that_does_not_exist_creates_nothing() {
        let loc = temp_location("read-missing", false);
        assert!(open_for_read(&loc).unwrap().is_none());
        assert!(!loc.app_dir().exists());
        assert!(!loc.paths.notes_dir.exists());
    }

    #[test]
    fn reading_before_the_first_write_does_not_create_the_database() {
        let loc = temp_location("read-no-db", true);
        assert!(open_for_read(&loc).unwrap().is_none());
        assert!(!loc.paths.db_path.exists());
        assert!(!loc.paths.notes_dir.exists());
    }

    #[test]
    fn writing_before_the_app_ever_ran_is_refused_and_creates_nothing() {
        let loc = temp_location("write-early", false);
        assert_eq!(open_for_write(&loc).err().as_deref(), Some(NOT_RUN_YET));
        assert!(!loc.app_dir().exists());
        assert!(!loc.paths.notes_dir.exists());
    }

    #[test]
    fn writing_after_the_app_ran_opens_the_database() {
        let loc = temp_location("write", true);
        drop(open_for_write(&loc).unwrap());
        assert!(loc.paths.db_path.is_file());
        assert!(
            !loc.paths.notes_dir.exists(),
            "opening touches the app dir only"
        );
        assert!(open_for_read(&loc).unwrap().is_some());
    }

    #[test]
    fn local_iso_times_have_a_date_a_time_and_an_offset() {
        let s = iso_local(1_790_378_408_605);
        assert_eq!(s.len(), 25, "{s}");
        assert_eq!(
            (
                &s[4..5],
                &s[7..8],
                &s[10..11],
                &s[13..14],
                &s[16..17],
                &s[22..23]
            ),
            ("-", "-", "T", ":", ":", ":"),
            "{s}"
        );
        assert!(matches!(&s[19..20], "+" | "-"), "{s}");
    }

    #[test]
    fn a_date_since_is_local_midnight() {
        let ms = parse_since("2026-09-27", 0).unwrap();
        assert!(
            iso_local(ms).starts_with("2026-09-27T00:00:00"),
            "{}",
            iso_local(ms)
        );
    }

    #[test]
    fn relative_and_named_sinces() {
        let now = 1_790_378_408_605;
        assert_eq!(parse_since("12h", now).unwrap(), now - 12 * 3_600_000);
        assert_eq!(parse_since("7d", now).unwrap(), now - 7 * 86_400_000);
        assert_eq!(parse_since(" 7d ", now).unwrap(), now - 7 * 86_400_000);
        assert_eq!(
            parse_since("1790000000000", now).unwrap(),
            1_790_000_000_000
        );
        let today = parse_since("today", now).unwrap();
        let yesterday = parse_since("yesterday", now).unwrap();
        assert!(today <= now && now - today < 25 * 3_600_000);
        // 23–25 h: a DST change may sit between the two midnights.
        assert!((23 * 3_600_000..=25 * 3_600_000).contains(&(today - yesterday)));
        assert!(
            iso_local(today).contains("T00:00:00"),
            "{}",
            iso_local(today)
        );
    }

    #[test]
    fn a_bad_since_is_an_error() {
        for bad in [
            "soon",
            "-3h",
            "2026-13-01",
            "2026-02-32",
            "2026-02-31",
            "",
            "h",
            "99999999999999999h",
        ] {
            assert!(parse_since(bad, 0).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn line_ranges_parse_one_based_and_inclusive() {
        assert_eq!(
            parse_lines("120:180").unwrap(),
            LineRange {
                from: 120,
                to: Some(180)
            }
        );
        assert_eq!(
            parse_lines("501:").unwrap(),
            LineRange {
                from: 501,
                to: None
            }
        );
        assert_eq!(
            parse_lines(":40").unwrap(),
            LineRange {
                from: 1,
                to: Some(40)
            }
        );
        for bad in ["0:5", "5:4", "5", "a:b", "1:0", "+1:3"] {
            assert!(parse_lines(bad).is_err(), "{bad:?}");
        }
    }

    fn numbered(n: usize) -> String {
        (1..=n)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn a_short_note_comes_back_whole() {
        let s = slice_lines("a\r\nb\nc", None).unwrap();
        assert_eq!(
            s,
            Sliced {
                text: "a\nb\nc".to_string(),
                lines: [1, 3],
                total_lines: 3,
                truncated: false
            }
        );
        assert_eq!(
            slice_lines("", None).unwrap(),
            Sliced {
                text: String::new(),
                lines: [0, 0],
                total_lines: 0,
                truncated: false
            }
        );
    }

    #[test]
    fn a_long_note_stops_at_the_line_cap() {
        let s = slice_lines(&numbered(1200), None).unwrap();
        assert_eq!(
            (s.lines, s.total_lines, s.truncated),
            ([1, GET_MAX_LINES], 1200, true)
        );
        assert_eq!(s.text.lines().count(), GET_MAX_LINES);
    }

    #[test]
    fn a_range_is_honoured_and_an_open_end_runs_to_the_last_line() {
        let text = numbered(1200);
        let s = slice_lines(
            &text,
            Some(LineRange {
                from: 501,
                to: Some(1000),
            }),
        )
        .unwrap();
        assert_eq!((s.lines, s.truncated), ([501, 1000], false));
        assert!(s.text.starts_with("line 501\n"));
        let tail = slice_lines(
            &text,
            Some(LineRange {
                from: 1190,
                to: None,
            }),
        )
        .unwrap();
        assert_eq!((tail.lines, tail.truncated), ([1190, 1200], false));
        let err = slice_lines(
            &text,
            Some(LineRange {
                from: 1300,
                to: None,
            }),
        )
        .unwrap_err();
        assert!(err.contains("past the end"), "{err}");
    }

    #[test]
    fn a_note_of_long_lines_stops_at_the_byte_cap() {
        let text = vec!["x".repeat(1000); 300].join("\n");
        let s = slice_lines(&text, None).unwrap();
        assert!(s.truncated);
        assert!(s.text.len() <= GET_MAX_BYTES);
        assert!(s.lines[1] < 300);
        let huge = "y".repeat(GET_MAX_BYTES * 2);
        let one = slice_lines(&huge, None).unwrap();
        assert_eq!(
            (one.text.len(), one.truncated),
            (GET_MAX_BYTES * 2, false),
            "one line comes back whole"
        );
    }

    #[test]
    fn tags_are_normalised_one_word_each() {
        let raw = ["#Infra", " infra ", "HDMI"].map(String::from);
        assert_eq!(
            agent_tags(&raw).unwrap(),
            vec!["infra".to_string(), "hdmi".to_string()]
        );
        assert!(agent_tags(&["two words".to_string()]).is_err());
        assert!(agent_tags(&["#".to_string()]).is_err());
        assert!(agent_tags(&[" ".to_string()]).is_err());
    }

    #[test]
    fn clipping_counts_characters_not_bytes() {
        assert_eq!(clip("тайник", 10), "тайник");
        assert_eq!(clip("тайник", 6), "тайник");
        assert_eq!(clip("тайник", 3), "тай…");
    }
}
