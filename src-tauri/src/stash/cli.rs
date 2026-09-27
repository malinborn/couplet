//! The stash for agents and the command line — `couplet stash …` and the MCP
//! `stash_*` tools (spec «Агент»). Runs WITHOUT a Tauri context, over its own
//! connection to the same `stash.db` the app uses (WAL + 5 s busy timeout),
//! so it works whether or not couplet is running.
//!
//! An agent never gets the whole stash: search answers snippets, list answers
//! metadata, and only `get` returns text — of one entry, capped.

use std::io::{BufRead, BufReader, IsTerminal, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    clock, entries, ListQuery, ListSort, PutAway, PutAwayResult, Stash, StashEntry, StashKind,
    StashPaths,
};

/// The clock every operation's `Ctx.now_ms` is read from — for the MCP
/// adapter, which cannot reach the private `clock` module.
pub(crate) use super::clock::now_ms;

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

/// A `--product` name taken as given: one `paths::dir_name` would rewrite
/// falls back to `couplet`, the release stash, for exactly the names a typo
/// produces, and `.`/`..` would put `stash.db` beside the app data folders
/// and the notes in `/Users`.
pub fn check_product(product: &str) -> Result<(), String> {
    if crate::paths::dir_name(product) != product || product == "." || product == ".." {
        return Err(format!(
            "invalid --product {product:?}: a product name such as couplet-dev, with no slashes or surrounding spaces"
        ));
    }
    Ok(())
}

/// `--product` / `--socket` into a location (plan D3, A12). A socket alone is
/// refused: it names a non-release build, and the stash would silently be
/// the release one's. So is a product `check_product` refuses. Path arithmetic only:
/// nothing is created or even looked at.
pub fn location_from_flags(
    product: Option<&str>,
    socket: Option<&str>,
) -> Result<StashLocation, String> {
    if socket.is_some() && product.is_none() {
        return Err("--socket names another couplet build: pass --product too (e.g. --product couplet-dev), so the stash is that build's and not the release one".to_string());
    }
    let product = product.unwrap_or(crate::paths::RELEASE_PRODUCT_NAME);
    check_product(product)?;
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
    toplevel_of(dir).map(|top| crate::git_info::dir_name(&top))
}

/// The repository toplevel of `dir`, in its one spelling.
fn toplevel_of(dir: &Path) -> Option<PathBuf> {
    crate::git_info::git_toplevel(&crate::path_norm::normalize_path(dir))
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

pub const SEARCH_DEFAULT_LIMIT: usize = 10;
pub const SEARCH_MAX_LIMIT: usize = 50;
pub const LIST_DEFAULT_LIMIT: usize = 20;
pub const LIST_MAX_LIMIT: usize = 100;
/// A backstop over stage 05's ~200-character snippets.
const SNIPPET_MAX_CHARS: usize = 240;

/// One entry as an agent sees it: metadata only (plan D7, A12) — never the
/// IPC `StashEntry`, whose `preview` is text. `repo` is the stored one, the
/// column the scope filtered on. No branch: it would cost a `.git` walk per
/// file hit, and the stored repo is what the scope means.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentEntry {
    pub id: String,
    pub kind: StashKind,
    pub title: Option<String>,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stashed_at: Option<String>,
    pub modified_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentHit {
    #[serde(flatten)]
    pub entry: AgentEntry,
    pub snippet: String,
}

/// The one answer shape of every stash verb — the CLI's `--json` line and
/// the MCP tool result text. Every field but `ok` is skipped when absent.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct StashAnswer {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<Scope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hits: Option<Vec<AgentHit>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<AgentEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<AgentEntry>,
    /// `add`: false when the path was already in the stash (dedup).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<[usize; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_lines: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    /// Absent on the last page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl StashAnswer {
    pub fn error(msg: impl Into<String>) -> Self {
        StashAnswer {
            ok: false,
            error: Some(msg.into()),
            ..Default::default()
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Filter {
    pub tag: Option<String>,
    pub kind: Option<StashKind>,
    pub scope: ScopeArg,
}

/// `search`'s arguments — named apart from stage 05's `search::SearchArgs`,
/// which this turns into.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentSearchArgs {
    pub query: String,
    pub filter: Filter,
    pub limit: Option<usize>,
    /// The previous page's `next_cursor`: an offset — paging re-runs the
    /// search, so an entry changed between pages may be skipped or repeated
    /// (stage 05 M10).
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ListArgs {
    pub filter: Filter,
    /// See `parse_since`.
    pub since: Option<String>,
    pub sort: Option<ListSort>,
    pub limit: Option<usize>,
    /// The previous page's `next_cursor` (a keyset: stable under writes).
    pub cursor: Option<String>,
}

/// Everything an operation needs besides its arguments.
pub struct Ctx<'a> {
    pub loc: &'a StashLocation,
    /// The caller's working directory: the default scope, and the base of a
    /// relative `add --path`.
    pub cwd: &'a Path,
    pub now_ms: i64,
}

fn agent_entry(e: &StashEntry) -> AgentEntry {
    AgentEntry {
        id: e.id.clone(),
        kind: e.kind,
        title: e.title.clone(),
        path: e.path.clone(),
        repo: e.repo.clone(),
        tags: e.tags.clone(),
        stashed_at: e.stashed_at.map(iso_local),
        modified_at: iso_local(e.modified_at),
    }
}

fn clamp_limit(asked: Option<usize>, default: usize, max: usize) -> usize {
    asked.unwrap_or(default).clamp(1, max)
}

/// The one optional tag of a search/list filter, normalised; `#` alone is an
/// error rather than a filter nothing matches.
fn filter_tag(tag: &Option<String>) -> Result<Option<String>, String> {
    match tag {
        Some(t) => agent_tags(std::slice::from_ref(t)).map(|mut v| v.pop()),
        None => Ok(None),
    }
}

/// Zero results inside a repo scope: say so, or the agent tells the human
/// "nothing exists" (plan D6).
fn scope_hint(scope: &Scope, total: usize) -> Option<String> {
    match (&scope.repo, total) {
        (Some(repo), 0) => Some(format!(
            "nothing in repo {repo}; widen with --all (MCP: all: true)"
        )),
        _ => None,
    }
}

/// The answer of a read when `stash.db` does not exist yet.
fn empty_page(scope: Scope, hits: bool) -> StashAnswer {
    StashAnswer {
        ok: true,
        scope: Some(scope),
        total: Some(0),
        hits: hits.then(Vec::new),
        entries: (!hits).then(Vec::new),
        hint: Some("the stash is empty".to_string()),
        ..Default::default()
    }
}

/// Best matches with a snippet each — never full text (spec «Агент»). The
/// repo filter is SQL on the stored column (stage 05 M8); no `Enrich` (it
/// would read every hit's text).
pub fn search(ctx: &Ctx, args: &AgentSearchArgs) -> StashAnswer {
    // A query of quotes and spaces parses to no terms and would list the
    // whole stash by freshness.
    if args
        .query
        .trim_matches(|c: char| c == '"' || c.is_whitespace())
        .is_empty()
    {
        return StashAnswer::error("search needs a query (browse with list)");
    }
    let tag = match filter_tag(&args.filter.tag) {
        Ok(t) => t,
        Err(e) => return StashAnswer::error(e),
    };
    let scope = resolve_scope(&args.filter.scope, ctx.cwd);
    let stash = match open_for_read(ctx.loc) {
        Ok(Some(s)) => s,
        Ok(None) => return empty_page(scope, true),
        Err(e) => return StashAnswer::error(e),
    };
    let query = super::search::SearchArgs {
        query: args.query.clone(),
        repo: scope.repo.clone(),
        tag,
        kind: args.filter.kind,
        deleted: false,
        limit: Some(clamp_limit(
            args.limit,
            SEARCH_DEFAULT_LIMIT,
            SEARCH_MAX_LIMIT,
        )),
        cursor: args.cursor.clone(),
    };
    match super::search::select_page(&stash.conn, &query).map(|d| d.into_page()) {
        Ok(page) => StashAnswer {
            ok: true,
            hint: scope_hint(&scope, page.total),
            scope: Some(scope),
            total: Some(page.total),
            hits: Some(
                page.hits
                    .iter()
                    .map(|h| AgentHit {
                        entry: agent_entry(&h.entry),
                        snippet: clip(&h.snippet, SNIPPET_MAX_CHARS),
                    })
                    .collect(),
            ),
            next_cursor: page.next_cursor,
            ..Default::default()
        },
        Err(e) => StashAnswer::error(e),
    }
}

/// Metadata only, never text; the trash is never listed (A8).
pub fn list(ctx: &Ctx, args: &ListArgs) -> StashAnswer {
    let tag = match filter_tag(&args.filter.tag) {
        Ok(t) => t,
        Err(e) => return StashAnswer::error(e),
    };
    let since = match args
        .since
        .as_deref()
        .map(|s| parse_since(s, ctx.now_ms))
        .transpose()
    {
        Ok(s) => s,
        Err(e) => return StashAnswer::error(e),
    };
    let scope = resolve_scope(&args.filter.scope, ctx.cwd);
    let stash = match open_for_read(ctx.loc) {
        Ok(Some(s)) => s,
        Ok(None) => return empty_page(scope, false),
        Err(e) => return StashAnswer::error(e),
    };
    let query = ListQuery {
        repo: scope.repo.clone(),
        tag,
        kind: args.filter.kind,
        sort: args.sort.unwrap_or_default(),
        deleted: false,
        since,
        limit: Some(clamp_limit(args.limit, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT)),
        cursor: args.cursor.clone(),
    };
    match stash.list(&query) {
        Ok(page) => StashAnswer {
            ok: true,
            hint: scope_hint(&scope, page.total),
            scope: Some(scope),
            total: Some(page.total),
            entries: Some(page.entries.iter().map(agent_entry).collect()),
            next_cursor: page.next_cursor,
            ..Default::default()
        },
        Err(e) => StashAnswer::error(e),
    }
}

/// The text of one note (capped, plan D8), or a file entry's path (D9).
/// Touches nothing: an agent reading is not the human opening (D10).
pub fn get(ctx: &Ctx, id: &str, lines: Option<LineRange>) -> StashAnswer {
    let stash = match open_for_read(ctx.loc) {
        Ok(Some(s)) => s,
        Ok(None) => return StashAnswer::error(format!("no stash entry {id}")),
        Err(e) => return StashAnswer::error(e),
    };
    let entry = match stash.get(id) {
        Ok(e) => e,
        Err(e) => return StashAnswer::error(e),
    };
    if entry.deleted_at.is_some() {
        return StashAnswer::error(format!("stash entry {id} is in the trash"));
    }
    let mut answer = StashAnswer {
        ok: true,
        entry: Some(agent_entry(&entry)),
        ..Default::default()
    };
    if entry.kind == StashKind::File {
        if lines.is_some() {
            return StashAnswer::error(format!(
                "{id} is a file reference: read {} directly",
                entry.path
            ));
        }
        answer.hint = Some(format!("a file reference: read {} directly", entry.path));
        return answer;
    }
    let text = match read_note(Path::new(&entry.path)) {
        Ok(t) => t,
        Err(e) => {
            return StashAnswer::error(format!("cannot read the note file {}: {e}", entry.path))
        }
    };
    match slice_lines(&text, lines) {
        Ok(s) => {
            if s.truncated {
                answer.hint = Some(format!(
                    "showing lines {}–{} of {}; the rest with lines {}:",
                    s.lines[0],
                    s.lines[1],
                    s.total_lines,
                    s.lines[1] + 1
                ));
            }
            answer.text = Some(s.text);
            answer.lines = Some(s.lines);
            answer.total_lines = Some(s.total_lines);
            answer.truncated = Some(s.truncated);
            answer
        }
        Err(e) => StashAnswer::error(e),
    }
}

/// A note's text through `open_readable_now`: a FIFO or a dataless iCloud
/// file swapped in at the note's path fails at once instead of hanging.
fn read_note(path: &Path) -> Result<String, String> {
    let mut text = String::new();
    entries::open_readable_now(path)?
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    Ok(text)
}

/// The reason every CLI/MCP write gives a running app (roadmap A6).
const NOTIFY_REASON: &str = "external";
/// For each of the connect's write and read: an app that hangs costs the
/// caller at most this, twice.
const NOTIFY_TIMEOUT: Duration = Duration::from_millis(500);

/// Tell a running couplet the stash changed under it, so its drawers reload
/// and pulse `ids` (plan D12). Best effort by design: the write is already on
/// disk, and an app that is not running reads the database fresh when it
/// starts — there is nobody to tell and nothing to report. Never launches the
/// app; a socket nobody listens on fails the connect at once.
pub fn notify(loc: &StashLocation, ids: Vec<String>) {
    let Some(socket) = &loc.socket else { return };
    let Ok(mut stream) = UnixStream::connect(socket) else {
        return;
    };
    let _ = stream.set_write_timeout(Some(NOTIFY_TIMEOUT));
    let _ = stream.set_read_timeout(Some(NOTIFY_TIMEOUT));
    let request = crate::ai_socket::AiRequest::StashChanged {
        v: 1,
        reason: NOTIFY_REASON.to_string(),
        ids: Some(ids),
    };
    let Ok(mut line) = serde_json::to_string(&request) else {
        return;
    };
    line.push('\n');
    if stream.write_all(line.as_bytes()).is_err() {
        return;
    }
    // Wait for the one answer line so the app's reply does not meet a closed
    // socket; what it says does not matter.
    let mut answer = String::new();
    let _ = BufReader::new(stream).read_line(&mut answer);
}

/// The one result of a single-path put-away.
fn first_result(results: Vec<PutAwayResult>, what: &str) -> Result<PutAwayResult, String> {
    results
        .into_iter()
        .next()
        .ok_or_else(|| format!("nothing was put away for {what}"))
}

/// Puts one path away: the disk half, then the SQL half (stage 02's one code
/// path; this process holds no lock another thread could wait on).
fn put_away_one(stash: &mut Stash, req: &PutAway, now: i64) -> Result<PutAwayResult, String> {
    let notes_dir = super::notes_dir_spelled(&stash.paths);
    let plan = entries::plan_put_away(req, &notes_dir, now)?;
    first_result(stash.put_away_probed(plan, now)?, &req.paths.join(", "))
}

/// A write landed: the export and daily backup (as after every app write),
/// then the running app is told.
fn after_write(ctx: &Ctx, stash: &mut Stash, id: &str) {
    stash.after_write(ctx.now_ms, offset_at(ctx.now_ms));
    notify(ctx.loc, vec![id.to_string()]);
}

/// A new note from text, put away at once — «отложено только что» (plan
/// D11) — in the repository of the caller's cwd. Blank text and bad tags are
/// refused before anything is opened or created.
pub fn add_note(ctx: &Ctx, text: &str, tags: &[String]) -> StashAnswer {
    if text.trim().is_empty() {
        return StashAnswer::error("refusing to add an empty note");
    }
    let tags = match agent_tags(tags) {
        Ok(t) => t,
        Err(e) => return StashAnswer::error(e),
    };
    let mut stash = match open_for_write(ctx.loc) {
        Ok(s) => s,
        Err(e) => return StashAnswer::error(e),
    };
    let repo = repo_of_dir(ctx.cwd);
    let note = match stash.create_note(text, repo.as_deref(), ctx.now_ms, offset_at(ctx.now_ms)) {
        Ok(n) => n,
        Err(e) => return StashAnswer::error(e),
    };
    let req = PutAway {
        paths: vec![note.path.clone()],
        tags,
        ..Default::default()
    };
    // The note already has its row, so this is stage 02's dedup update:
    // `stashed_at = now` and the tags. It reports `created: false`; the
    // answer knows better.
    let put = put_away_one(&mut stash, &req, ctx.now_ms);
    // Written either way: the note exists even if putting it away failed.
    after_write(ctx, &mut stash, &note.id);
    match put {
        Ok(r) => StashAnswer {
            ok: true,
            entry: Some(agent_entry(&r.entry)),
            created: Some(true),
            ..Default::default()
        },
        // The note is in the stash (not put away, as if open in a tab); say
        // where, so the text is never out of reach.
        Err(e) => StashAnswer::error(format!(
            "note {} ({}) was created but could not be put away: {e}",
            note.id, note.path
        )),
    }
}

/// A reference to an existing regular file; the file itself is never
/// touched. A relative path is the caller's cwd's. A file outside any
/// repository takes the cwd's repository, as it takes a window's project
/// (roadmap A3). Adding a path already in the stash answers `created: false`.
pub fn add_path(ctx: &Ctx, path: &str, tags: &[String]) -> StashAnswer {
    let tags = match agent_tags(tags) {
        Ok(t) => t,
        Err(e) => return StashAnswer::error(e),
    };
    let abs = crate::resolve_path(path, ctx.cwd.to_str());
    match std::fs::metadata(&abs) {
        Ok(m) if m.is_file() => {}
        Ok(_) => return StashAnswer::error(format!("not a file: {abs}")),
        Err(_) => return StashAnswer::error(format!("file does not exist: {abs}")),
    }
    let mut stash = match open_for_write(ctx.loc) {
        Ok(s) => s,
        Err(e) => return StashAnswer::error(e),
    };
    let req = PutAway {
        paths: vec![abs],
        tags,
        project: toplevel_of(ctx.cwd).map(|top| top.to_string_lossy().into_owned()),
        ..Default::default()
    };
    match put_away_one(&mut stash, &req, ctx.now_ms) {
        Ok(r) => {
            after_write(ctx, &mut stash, &r.entry.id);
            StashAnswer {
                ok: true,
                entry: Some(agent_entry(&r.entry)),
                created: Some(r.created),
                ..Default::default()
            }
        }
        Err(e) => StashAnswer::error(e),
    }
}

/// Adds then removes tags. A call that leaves the tag set as it was writes
/// nothing and tells nobody; a trashed entry is out of an agent's reach (A8).
pub fn tag(ctx: &Ctx, id: &str, add: &[String], remove: &[String]) -> StashAnswer {
    if add.is_empty() && remove.is_empty() {
        return StashAnswer::error("tag needs something to add or remove");
    }
    let (add, remove) = match (agent_tags(add), agent_tags(remove)) {
        (Ok(a), Ok(r)) => (a, r),
        (Err(e), _) | (_, Err(e)) => return StashAnswer::error(e),
    };
    let mut stash = match open_for_write(ctx.loc) {
        Ok(s) => s,
        Err(e) => return StashAnswer::error(e),
    };
    // `Stash::tag` refuses a trashed entry too; this says it in `get`'s words.
    match stash.get(id) {
        Ok(e) if e.deleted_at.is_some() => {
            return StashAnswer::error(format!("stash entry {id} is in the trash"))
        }
        Ok(_) => {}
        Err(e) => return StashAnswer::error(e),
    }
    match stash.tag(id, &add, &remove) {
        Ok(tagged) => {
            if tagged.changed {
                after_write(ctx, &mut stash, id);
            }
            StashAnswer {
                ok: true,
                entry: Some(agent_entry(&tagged.entry)),
                ..Default::default()
            }
        }
        Err(e) => StashAnswer::error(e),
    }
}

pub const STASH_USAGE: &str = "usage: couplet stash search <query> [--tag T] [--repo R | --all] [--kind note|file] [--limit N] [--cursor C] [--json]
       couplet stash list [--tag T] [--repo R | --all] [--kind note|file] [--since S] [--sort changed|opened|kind] [--limit N] [--cursor C] [--json]
       couplet stash get <id> [--lines A:B] [--json]
       couplet stash add [--tag T ...] [--json] < text
       couplet stash add --path <file> [--tag T ...] [--json]
       couplet stash tag <id> [--add T ...] [--remove T ...] [--json]
  every verb: [--product NAME] [--socket PATH]   (a dev build: --product couplet-dev; --socket needs --product)";

#[derive(Debug, PartialEq, Eq)]
pub enum StashVerb {
    Search(AgentSearchArgs),
    List(ListArgs),
    Get {
        id: String,
        lines: Option<LineRange>,
    },
    /// `path: None` — the note's text comes from stdin.
    Add {
        tags: Vec<String>,
        path: Option<String>,
    },
    Tag {
        id: String,
        add: Vec<String>,
        remove: Vec<String>,
    },
}

/// `couplet stash …` parsed.
#[derive(Debug, PartialEq, Eq)]
pub struct StashCli {
    pub verb: StashVerb,
    pub json: bool,
    pub product: Option<String>,
    pub socket: Option<String>,
}

pub(crate) fn parse_kind(s: &str) -> Result<StashKind, String> {
    StashKind::parse(s).ok_or_else(|| format!("invalid kind: {s} (note or file)"))
}

pub(crate) fn parse_sort(s: &str) -> Result<ListSort, String> {
    match s {
        "changed" => Ok(ListSort::Changed),
        "opened" => Ok(ListSort::Opened),
        "kind" => Ok(ListSort::Kind),
        other => Err(format!("invalid sort: {other} (changed, opened or kind)")),
    }
}

/// A positive number, digits only (`+3` parses as a `usize` but is no count
/// anyone meant). Clamped later by the operation, never refused for size.
fn parse_limit(s: &str) -> Result<usize, String> {
    match s.parse::<usize>() {
        Ok(n) if n >= 1 && s.bytes().all(|b| b.is_ascii_digit()) => Ok(n),
        _ => Err(format!("invalid limit: {s} (a positive number)")),
    }
}

/// The value after `flag`.
fn value(iter: &mut std::slice::Iter<'_, String>, flag: &str) -> Result<String, String> {
    iter.next()
        .cloned()
        .ok_or_else(|| format!("{flag} requires a value"))
}

/// Everything after `couplet stash` (i.e. after `ai stash` in the binary).
/// A flag belongs to the verbs it makes sense for; anywhere else it is an
/// error, never silently ignored.
pub fn parse_stash_args(args: &[String]) -> Result<StashCli, String> {
    let mut iter = args.iter();
    let verb = iter.next().ok_or_else(|| STASH_USAGE.to_string())?.clone();
    let v = verb.as_str();
    let filtered = matches!(v, "search" | "list");

    let (mut json, mut product, mut socket) = (false, None, None);
    let mut positional: Vec<String> = Vec::new();
    let mut filter = Filter::default();
    let (mut limit, mut cursor, mut since, mut sort, mut lines, mut path) =
        (None, None, None, None, None, None);
    let (mut tags, mut add, mut remove) = (Vec::new(), Vec::new(), Vec::new());
    let (mut repo_given, mut all_given) = (false, false);

    while let Some(arg) = iter.next() {
        let flag = arg.as_str();
        match flag {
            "--json" => json = true,
            "--product" => product = Some(value(&mut iter, flag)?),
            "--socket" => socket = Some(value(&mut iter, flag)?),
            "--tag" if v == "add" => tags.push(value(&mut iter, flag)?),
            "--tag" if filtered => filter.tag = Some(value(&mut iter, flag)?),
            "--repo" if filtered => {
                filter.scope = ScopeArg::Repo(value(&mut iter, flag)?);
                repo_given = true;
            }
            "--all" if filtered => {
                filter.scope = ScopeArg::All;
                all_given = true;
            }
            "--kind" if filtered => filter.kind = Some(parse_kind(&value(&mut iter, flag)?)?),
            "--limit" if filtered => limit = Some(parse_limit(&value(&mut iter, flag)?)?),
            "--cursor" if filtered => cursor = Some(value(&mut iter, flag)?),
            "--since" if v == "list" => since = Some(value(&mut iter, flag)?),
            "--sort" if v == "list" => sort = Some(parse_sort(&value(&mut iter, flag)?)?),
            "--lines" if v == "get" => lines = Some(parse_lines(&value(&mut iter, flag)?)?),
            "--path" if v == "add" => path = Some(value(&mut iter, flag)?),
            "--add" if v == "tag" => add.push(value(&mut iter, flag)?),
            "--remove" if v == "tag" => remove.push(value(&mut iter, flag)?),
            other if other.starts_with("--") => {
                return Err(format!("unknown flag for stash {verb}: {other}"))
            }
            _ => positional.push(arg.clone()),
        }
    }
    if repo_given && all_given {
        return Err("--repo and --all are mutually exclusive".to_string());
    }
    let no_positional = |p: &[String]| match p.first() {
        Some(extra) => Err(format!(
            "stash {verb} takes no argument: unexpected {extra}"
        )),
        None => Ok(()),
    };
    let one_id = |p: Vec<String>| match p.as_slice() {
        [id] => Ok(id.clone()),
        [] => Err(format!("stash {verb} needs an entry id")),
        _ => Err(format!("stash {verb} takes one entry id")),
    };
    let verb = match v {
        "search" => {
            if positional.is_empty() {
                return Err("stash search needs a query".to_string());
            }
            StashVerb::Search(AgentSearchArgs {
                query: positional.join(" "),
                filter,
                limit,
                cursor,
            })
        }
        "list" => {
            no_positional(&positional)?;
            StashVerb::List(ListArgs {
                filter,
                since,
                sort,
                limit,
                cursor,
            })
        }
        "get" => StashVerb::Get {
            id: one_id(positional)?,
            lines,
        },
        "add" => {
            no_positional(&positional)?;
            StashVerb::Add { tags, path }
        }
        "tag" => {
            let id = one_id(positional)?;
            if add.is_empty() && remove.is_empty() {
                return Err("stash tag needs --add or --remove".to_string());
            }
            StashVerb::Tag { id, add, remove }
        }
        other => return Err(format!("unknown stash command: {other}\n{STASH_USAGE}")),
    };
    Ok(StashCli {
        verb,
        json,
        product,
        socket,
    })
}

/// One parsed verb, run. `stdin_text` is the text of a note to add.
pub fn execute(ctx: &Ctx, verb: &StashVerb, stdin_text: Option<&str>) -> StashAnswer {
    match verb {
        StashVerb::Search(args) => search(ctx, args),
        StashVerb::List(args) => list(ctx, args),
        StashVerb::Get { id, lines } => get(ctx, id, *lines),
        StashVerb::Add {
            tags,
            path: Some(path),
        } => add_path(ctx, path, tags),
        StashVerb::Add { tags, path: None } => add_note(ctx, stdin_text.unwrap_or(""), tags),
        StashVerb::Tag { id, add, remove } => tag(ctx, id, add, remove),
    }
}

/// `2026-09-27T01:55:12+03:00` → `2026-09-27 01:55`.
fn short_time(iso: &str) -> String {
    iso.get(..16)
        .map(|s| s.replacen('T', " ", 1))
        .unwrap_or_else(|| iso.to_string())
}

fn entry_line(e: &AgentEntry) -> String {
    let mut line = format!(
        "{}  {}  {}",
        e.id,
        e.kind.as_str(),
        e.title.as_deref().unwrap_or("(untitled)")
    );
    for t in &e.tags {
        line.push_str(&format!("  #{t}"));
    }
    if let Some(r) = &e.repo {
        line.push_str(&format!("  [{r}]"));
    }
    if let Some(s) = &e.stashed_at {
        line.push_str(&format!("  {}", short_time(s)));
    }
    line
}

/// Search/list as text: a row per entry (a hit adds its snippet on one
/// indented line), then `N of TOTAL in <scope>` with the next page's cursor,
/// then the hint.
fn render_rows(a: &StashAnswer) -> String {
    let mut out = Vec::new();
    for h in a.hits.iter().flatten() {
        out.push(entry_line(&h.entry));
        out.push(format!("    {}", h.snippet.replace('\n', " ")));
    }
    for e in a.entries.iter().flatten() {
        out.push(entry_line(e));
    }
    let shown = a
        .hits
        .as_ref()
        .map(Vec::len)
        .or_else(|| a.entries.as_ref().map(Vec::len))
        .unwrap_or(0);
    let scope = match &a.scope {
        Some(Scope { repo: Some(r), .. }) => format!(" in repo {r}"),
        _ => " in the whole stash".to_string(),
    };
    let mut footer = format!("{shown} of {}{scope}", a.total.unwrap_or(0));
    if let Some(c) = &a.next_cursor {
        footer.push_str(&format!(" · next page: --cursor {c}"));
    }
    out.push(footer);
    out.extend(a.hint.clone());
    out.join("\n")
}

/// `(stdout, stderr)` for one answer (plan D13). JSON: the answer, one line,
/// even on failure — exactly the MCP tool result text. Text: rows for
/// search/list, the raw note for get (so `couplet stash get ID > file`
/// works; the "more lines" hint goes to stderr), one row for add/tag; an
/// error is words on stderr and nothing on stdout.
pub fn render(answer: &StashAnswer, verb: &StashVerb, json: bool) -> (String, String) {
    if json {
        let line = serde_json::to_string(answer).unwrap_or_else(|_| {
            r#"{"ok":false,"error":"failed to encode the answer"}"#.to_string()
        });
        return (line, String::new());
    }
    if !answer.ok {
        return (
            String::new(),
            format!("couplet: {}", answer.error.as_deref().unwrap_or("failed")),
        );
    }
    let hint_err = || {
        answer
            .hint
            .as_ref()
            .map(|h| format!("couplet: {h}"))
            .unwrap_or_default()
    };
    match verb {
        StashVerb::Search(_) | StashVerb::List(_) => (render_rows(answer), String::new()),
        StashVerb::Get { .. } => match (&answer.text, &answer.entry) {
            (Some(text), _) => (text.clone(), hint_err()),
            (None, Some(e)) => (e.path.clone(), hint_err()),
            (None, None) => (String::new(), String::new()),
        },
        StashVerb::Add { .. } | StashVerb::Tag { .. } => {
            let mut line = answer.entry.as_ref().map(entry_line).unwrap_or_default();
            if answer.created == Some(false) {
                line.push_str("  (already in the stash)");
            }
            (line, String::new())
        }
    }
}

fn print(out: &str, err: &str) {
    if !out.is_empty() {
        println!("{out}");
    }
    if !err.is_empty() {
        eprintln!("{err}");
    }
}

/// `couplet stash …` — reached as `couplet ai stash …` (plan D13). `args` is
/// everything after `stash`. Returns the exit code: 0 ok, 1 rejected
/// (`ok:false`, including "couplet has not run on this Mac yet"), 2 usage
/// error, no text on stdin, or bad location flags. Never launches the app.
pub fn run(args: &[String]) -> i32 {
    let cli = match parse_stash_args(args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    let fail = |msg: &str| {
        let (out, err) = render(&StashAnswer::error(msg), &cli.verb, cli.json);
        print(&out, &err);
        2
    };
    let loc = match location_from_flags(cli.product.as_deref(), cli.socket.as_deref()) {
        Ok(l) => l,
        Err(e) => return fail(&e),
    };
    let stdin_text = if matches!(cli.verb, StashVerb::Add { path: None, .. }) {
        // A terminal would wait for text nobody knows to type.
        if std::io::stdin().is_terminal() {
            return fail("pipe the note's text on stdin (or add a file with --path)");
        }
        let mut buf = String::new();
        if std::io::stdin().read_to_string(&mut buf).is_err() {
            return fail("failed to read stdin (the note must be UTF-8 text)");
        }
        if buf.trim().is_empty() {
            return fail("refusing to add an empty note (pipe its text on stdin)");
        }
        Some(buf)
    } else {
        None
    };
    let cwd = match std::env::current_dir() {
        Ok(d) => d,
        Err(e) => return fail(&format!("cannot read the current directory: {e}")),
    };
    let ctx = Ctx {
        loc: &loc,
        cwd: &cwd,
        now_ms: clock::now_ms(),
    };
    let answer = execute(&ctx, &cli.verb, stdin_text.as_deref());
    let (out, err) = render(&answer, &cli.verb, cli.json);
    print(&out, &err);
    if answer.ok {
        0
    } else {
        1
    }
}

/// An optional string argument of an MCP call. Blank counts as absent: a
/// client may fill every optional string with `""`, and that means "no
/// filter", not an empty tag or a clash with `all`.
fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
}

/// The strings of an array argument; anything else in it is ignored. A lone
/// string is taken as a one-element array rather than dropped: a tag given
/// as `"infra"` must not silently become no tag.
pub fn string_array(v: &Value, key: &str) -> Vec<String> {
    match v.get(key) {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        Some(Value::String(s)) => vec![s.clone()],
        _ => Vec::new(),
    }
}

/// `tag`, `kind`, `repo` / `all` — the same rules as the CLI's flags.
fn filter_from_json(v: &Value) -> Result<Filter, String> {
    let all = v.get("all").and_then(Value::as_bool).unwrap_or(false);
    let scope = match (all, str_field(v, "repo")) {
        (true, Some(_)) => return Err("repo and all are mutually exclusive".to_string()),
        (true, None) => ScopeArg::All,
        (false, Some(r)) => ScopeArg::Repo(r),
        (false, None) => ScopeArg::Default,
    };
    let kind = str_field(v, "kind").map(|k| parse_kind(&k)).transpose()?;
    Ok(Filter {
        tag: str_field(v, "tag"),
        kind,
        scope,
    })
}

/// A positive integer, or absent. Clamped later by the operation, never
/// refused for size.
fn limit_from_json(v: &Value) -> Result<Option<usize>, String> {
    match v.get("limit") {
        None | Some(Value::Null) => Ok(None),
        Some(l) => l
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .filter(|n| *n >= 1)
            .map(Some)
            .ok_or_else(|| "limit must be a positive integer".to_string()),
    }
}

/// `stash_search`'s arguments. An error is a malformed call (JSON-RPC
/// `-32602`); a blank query is `search`'s own refusal, a tool error.
pub fn search_args_from_json(v: &Value) -> Result<AgentSearchArgs, String> {
    let query = v
        .get("query")
        .and_then(Value::as_str)
        .ok_or("stash_search requires query (a string)")?
        .to_string();
    Ok(AgentSearchArgs {
        query,
        filter: filter_from_json(v)?,
        limit: limit_from_json(v)?,
        cursor: str_field(v, "cursor"),
    })
}

/// `stash_list`'s arguments. `since` may be a number (unix ms) as well as
/// text; `parse_since` reads both from its text.
pub fn list_args_from_json(v: &Value) -> Result<ListArgs, String> {
    let since = match v.get("since") {
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => str_field(v, "since"),
    };
    let sort = str_field(v, "sort").map(|s| parse_sort(&s)).transpose()?;
    Ok(ListArgs {
        filter: filter_from_json(v)?,
        since,
        sort,
        limit: limit_from_json(v)?,
        cursor: str_field(v, "cursor"),
    })
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

        /// Every stash call answers its error as text.
        type R<T> = Result<T, String>;
        let _: fn(&Path, &Path, &str) -> StashPaths = StashPaths::from_bases;
        let _: fn(StashPaths) -> Result<Stash, db::OpenError> = Stash::open;
        let _: fn(&mut Stash, &str, Option<&str>, i64, i64) -> R<StashEntry> = Stash::create_note;
        let _: fn(&PutAway, &Path, i64) -> R<PutAwayPlan> = entries::plan_put_away;
        let _: fn(&mut Stash, PutAwayPlan, i64) -> R<Vec<PutAwayResult>> = Stash::put_away_probed;
        let _: fn(&Stash, &ListQuery) -> R<ListResult> = Stash::list;
        let _: fn(&Stash, &str) -> R<StashEntry> = Stash::get;
        let _: fn(&mut Stash, &str, &[String], &[String]) -> R<Tagged> = Stash::tag;
        let _: fn(&mut Stash, &str, i64) -> R<Deleted> = Stash::delete_entry;
        let _: fn(&mut Stash, i64, i64) = Stash::after_write;
        let _: fn(&str) -> R<Option<String>> = entries::normalize_tag;
        let _: fn(Option<&str>) -> Option<String> = entries::normalize_repo;
        let _: fn(&Path) -> R<std::fs::File> = entries::open_readable_now;
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
            let _: (&String, StashKind, &String) = (&e.id, e.kind, &e.path);
            let _: (&Option<String>, &Option<String>, &Option<String>) =
                (&e.title, &e.repo, &e.branch);
            let _: &Vec<String> = &e.tags;
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

    fn ctx<'a>(loc: &'a StashLocation, cwd: &'a Path) -> Ctx<'a> {
        Ctx {
            loc,
            cwd,
            now_ms: clock::now_ms(),
        }
    }

    /// A put-away note, seeded through the stage 02 API directly, on the real
    /// clock (`list --since 1d` is measured against it).
    fn seed(loc: &StashLocation, text: &str, repo: Option<&str>, tags: &[&str]) -> String {
        let now = clock::now_ms();
        let mut s = Stash::open(loc.paths.clone()).unwrap();
        let e = s.create_note(text, repo, now, offset_at(now)).unwrap();
        let req = crate::stash::PutAway {
            paths: vec![e.path.clone()],
            tags: tags.iter().map(|t| t.to_string()).collect(),
            ..Default::default()
        };
        s.put_away(&req, now).unwrap();
        e.id
    }

    fn stored(loc: &StashLocation, id: &str) -> crate::stash::StashEntry {
        Stash::open(loc.paths.clone()).unwrap().get(id).unwrap()
    }

    fn all() -> Filter {
        Filter {
            scope: ScopeArg::All,
            ..Default::default()
        }
    }

    fn search_all(query: &str) -> AgentSearchArgs {
        AgentSearchArgs {
            query: query.to_string(),
            filter: all(),
            ..Default::default()
        }
    }

    #[test]
    fn the_search_answer_has_this_exact_shape() {
        let answer = StashAnswer {
            ok: true,
            scope: Some(Scope {
                repo: Some("couplet".to_string()),
                all: false,
            }),
            total: Some(1),
            hits: Some(vec![AgentHit {
                entry: AgentEntry {
                    id: "s1-a".to_string(),
                    kind: crate::stash::StashKind::Note,
                    title: Some("HDMI".to_string()),
                    path: "/n/a.md".to_string(),
                    repo: Some("couplet".to_string()),
                    tags: vec!["infra".to_string()],
                    stashed_at: Some("2026-09-27T01:55:00+03:00".to_string()),
                    modified_at: "2026-09-27T01:50:00+03:00".to_string(),
                },
                snippet: "…HDMI через адаптер…".to_string(),
            }]),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_string(&answer).unwrap(),
            r#"{"ok":true,"scope":{"repo":"couplet"},"total":1,"hits":[{"id":"s1-a","kind":"note","title":"HDMI","path":"/n/a.md","repo":"couplet","tags":["infra"],"stashed_at":"2026-09-27T01:55:00+03:00","modified_at":"2026-09-27T01:50:00+03:00","snippet":"…HDMI через адаптер…"}]}"#
        );
        let back: StashAnswer =
            serde_json::from_str(&serde_json::to_string(&answer).unwrap()).unwrap();
        assert_eq!(back, answer);
    }

    #[test]
    fn search_returns_a_snippet_never_the_full_text() {
        let loc = temp_location("snippet", true);
        let text = format!(
            "# Сеть\n\n{}\nмаршрутизатор в переговорке\n{}ХВОСТ-НЕ-ДОЛЖЕН-УЙТИ",
            "а".repeat(1500),
            "б".repeat(1500)
        );
        seed(&loc, &text, None, &[]);
        let cwd = outside_git();
        let answer = search(&ctx(&loc, &cwd), &search_all("маршрутизатор"));
        assert!(answer.ok, "{answer:?}");
        let hits = answer.hits.as_ref().unwrap();
        assert_eq!(hits.len(), 1);
        assert!(
            hits[0].snippet.contains("маршрутизатор"),
            "{}",
            hits[0].snippet
        );
        assert!(hits[0].snippet.chars().count() <= SNIPPET_MAX_CHARS + 1);
        let json = serde_json::to_string(&answer).unwrap();
        for forbidden in [
            "ХВОСТ-НЕ-ДОЛЖЕН-УЙТИ",
            "\"preview\"",
            "\"text\"",
            "\"caret\"",
            "\"ranges\"",
            "\"score\"",
        ] {
            assert!(!json.contains(forbidden), "{forbidden} leaked: {json}");
        }
    }

    #[test]
    fn a_blank_query_is_refused() {
        let loc = temp_location("blank", true);
        let cwd = outside_git();
        for q in ["", "   ", "\"\"", " \" \" "] {
            let answer = search(&ctx(&loc, &cwd), &search_all(q));
            assert!(!answer.ok, "{q:?}: {answer:?}");
            assert!(
                answer.error.as_deref().unwrap().contains("list"),
                "{answer:?}"
            );
        }
    }

    #[test]
    fn search_defaults_to_the_repository_of_the_cwd() {
        let loc = temp_location("scope", true);
        let repo = temp_repo("alpha");
        seed(&loc, "# роутер альфа", Some("alpha"), &[]);
        seed(&loc, "# роутер бета", Some("beta"), &[]);
        let cwd = repo.join("sub");
        let args = AgentSearchArgs {
            query: "роутер".to_string(),
            ..Default::default()
        };
        let here = search(&ctx(&loc, &cwd), &args);
        assert_eq!(
            (here.total, here.scope.clone()),
            (
                Some(1),
                Some(Scope {
                    repo: Some("alpha".to_string()),
                    all: false
                })
            )
        );
        assert_eq!(here.hits.unwrap()[0].entry.repo.as_deref(), Some("alpha"));
        let everywhere = search(&ctx(&loc, &cwd), &search_all("роутер"));
        assert_eq!(
            (everywhere.total, everywhere.scope),
            (
                Some(2),
                Some(Scope {
                    repo: None,
                    all: true
                })
            )
        );
    }

    #[test]
    fn nothing_in_the_default_repository_hints_at_all() {
        let loc = temp_location("hint", true);
        seed(&loc, "# роутер бета", Some("beta"), &[]);
        let cwd = temp_repo("alpha");
        let args = AgentSearchArgs {
            query: "роутер".to_string(),
            ..Default::default()
        };
        let answer = search(&ctx(&loc, &cwd), &args);
        assert_eq!(answer.total, Some(0));
        assert!(
            answer.hint.as_deref().unwrap_or("").contains("--all"),
            "{answer:?}"
        );
        let everywhere = search(&ctx(&loc, &cwd), &search_all("роутер"));
        assert_eq!((everywhere.total, everywhere.hint), (Some(1), None));
    }

    #[test]
    fn search_pages_through_every_hit_once() {
        let loc = temp_location("search-pages", true);
        for i in 0..12 {
            seed(&loc, &format!("# роутер {i}"), None, &[]);
        }
        let cwd = outside_git();
        let mut seen = std::collections::HashSet::new();
        let mut args = AgentSearchArgs {
            limit: Some(5),
            ..search_all("роутер")
        };
        let mut pages = Vec::new();
        loop {
            let page = search(&ctx(&loc, &cwd), &args);
            assert_eq!(page.total, Some(12), "{page:?}");
            let hits = page.hits.unwrap();
            pages.push(hits.len());
            for h in hits {
                assert!(seen.insert(h.entry.id.clone()), "duplicate {}", h.entry.id);
            }
            match page.next_cursor {
                Some(c) => args.cursor = Some(c),
                None => break,
            }
        }
        assert_eq!((pages, seen.len()), (vec![5, 5, 2], 12));
        let capped = search(
            &ctx(&loc, &cwd),
            &AgentSearchArgs {
                limit: Some(1000),
                ..search_all("роутер")
            },
        );
        assert_eq!(
            capped.hits.map(|h| h.len()),
            Some(12),
            "clamped to {SEARCH_MAX_LIMIT}, not refused"
        );
        let default = search(&ctx(&loc, &cwd), &search_all("роутер"));
        assert_eq!(default.hits.map(|h| h.len()), Some(SEARCH_DEFAULT_LIMIT));
    }

    #[test]
    fn list_is_metadata_only_and_pages() {
        let loc = temp_location("list-pages", true);
        for i in 0..25 {
            seed(
                &loc,
                &format!("# запись {i}\n\nтекст-который-не-нужен"),
                None,
                &["infra"],
            );
        }
        let cwd = outside_git();
        let first = list(
            &ctx(&loc, &cwd),
            &ListArgs {
                filter: all(),
                limit: Some(10),
                ..Default::default()
            },
        );
        assert_eq!(
            (first.total, first.entries.as_ref().map(Vec::len)),
            (Some(25), Some(10))
        );
        let json = serde_json::to_string(&first).unwrap();
        for forbidden in [
            "текст-который-не-нужен",
            "\"preview\"",
            "\"snippet\"",
            "\"text\"",
        ] {
            assert!(!json.contains(forbidden), "{forbidden} leaked: {json}");
        }
        assert!(first.entries.as_ref().unwrap()[0].stashed_at.is_some());
        let second = list(
            &ctx(&loc, &cwd),
            &ListArgs {
                filter: all(),
                limit: Some(10),
                cursor: first.next_cursor.clone(),
                ..Default::default()
            },
        );
        let third = list(
            &ctx(&loc, &cwd),
            &ListArgs {
                filter: all(),
                limit: Some(10),
                cursor: second.next_cursor.clone(),
                ..Default::default()
            },
        );
        assert_eq!(third.entries.as_ref().map(Vec::len), Some(5));
        assert!(third.next_cursor.is_none());
        let default = list(
            &ctx(&loc, &cwd),
            &ListArgs {
                filter: all(),
                ..Default::default()
            },
        );
        assert_eq!(default.entries.map(|e| e.len()), Some(LIST_DEFAULT_LIMIT));
    }

    #[test]
    fn list_since_and_tag_filter() {
        let loc = temp_location("list-since", true);
        seed(&loc, "# a", None, &["infra"]);
        seed(&loc, "# b", None, &[]);
        let cwd = outside_git();
        let recent = list(
            &ctx(&loc, &cwd),
            &ListArgs {
                filter: all(),
                since: Some("1d".to_string()),
                ..Default::default()
            },
        );
        assert_eq!(recent.total, Some(2));
        let future = list(
            &ctx(&loc, &cwd),
            &ListArgs {
                filter: all(),
                since: Some((clock::now_ms() + 3_600_000).to_string()),
                ..Default::default()
            },
        );
        assert_eq!(future.total, Some(0));
        let tagged = list(
            &ctx(&loc, &cwd),
            &ListArgs {
                filter: Filter {
                    tag: Some("#INFRA".to_string()),
                    ..all()
                },
                ..Default::default()
            },
        );
        assert_eq!(tagged.total, Some(1));
        let bad = list(
            &ctx(&loc, &cwd),
            &ListArgs {
                since: Some("soon".to_string()),
                ..Default::default()
            },
        );
        assert!(!bad.ok);
        let empty_tag = list(
            &ctx(&loc, &cwd),
            &ListArgs {
                filter: Filter {
                    tag: Some("#".to_string()),
                    ..all()
                },
                ..Default::default()
            },
        );
        assert!(!empty_tag.ok, "{empty_tag:?}");
    }

    #[test]
    fn reading_a_stash_that_does_not_exist_is_an_empty_page() {
        let loc = temp_location("empty", false);
        let cwd = outside_git();
        let answer = list(&ctx(&loc, &cwd), &ListArgs::default());
        assert_eq!(
            (answer.ok, answer.total, answer.hint.as_deref()),
            (true, Some(0), Some("the stash is empty"))
        );
        assert_eq!(answer.entries, Some(vec![]));
        let found = search(&ctx(&loc, &cwd), &search_all("x"));
        assert_eq!(
            (found.ok, found.total, found.hits),
            (true, Some(0), Some(vec![]))
        );
        assert_eq!(
            found.scope,
            Some(Scope {
                repo: None,
                all: true
            })
        );
        assert!(!get(&ctx(&loc, &cwd), "s1-a", None).ok);
        assert!(!loc.app_dir().exists());
        assert!(!loc.paths.notes_dir.exists());
    }

    #[test]
    fn get_returns_one_note_and_caps_a_long_one() {
        let loc = temp_location("get", true);
        let short = seed(&loc, "# Заметка\n\nтекст", None, &[]);
        let long = seed(&loc, &numbered(1200), None, &[]);
        let cwd = outside_git();
        let one = get(&ctx(&loc, &cwd), &short, None);
        assert_eq!(
            (one.text.as_deref(), one.truncated),
            (Some("# Заметка\n\nтекст"), Some(false))
        );
        assert_eq!(one.entry.as_ref().unwrap().id, short);
        assert_eq!(one.hint, None);
        let capped = get(&ctx(&loc, &cwd), &long, None);
        assert_eq!(
            (capped.lines, capped.total_lines, capped.truncated),
            (Some([1, 500]), Some(1200), Some(true))
        );
        assert!(
            capped.hint.as_deref().unwrap().contains("501:"),
            "{capped:?}"
        );
        let range = get(
            &ctx(&loc, &cwd),
            &long,
            Some(LineRange {
                from: 501,
                to: Some(510),
            }),
        );
        assert_eq!(range.text.as_deref().map(|t| t.lines().count()), Some(10));
        assert!(range.text.unwrap().starts_with("line 501\n"));
        assert!(
            !get(
                &ctx(&loc, &cwd),
                &long,
                Some(LineRange {
                    from: 5000,
                    to: None
                })
            )
            .ok
        );
    }

    #[test]
    fn get_of_a_file_entry_gives_its_path_not_its_text() {
        let loc = temp_location("get-file", true);
        let doc = outside_git().join("doc.md");
        fs::write(&doc, "file body").unwrap();
        let abs = crate::resolve_path(doc.to_str().unwrap(), None);
        let mut s = Stash::open(loc.paths.clone()).unwrap();
        let req = crate::stash::PutAway {
            paths: vec![abs.clone()],
            ..Default::default()
        };
        let id = s.put_away(&req, clock::now_ms()).unwrap()[0]
            .entry
            .id
            .clone();
        let cwd = outside_git();
        let answer = get(&ctx(&loc, &cwd), &id, None);
        assert!(answer.ok && answer.text.is_none(), "{answer:?}");
        assert!(answer.hint.as_deref().unwrap().contains(&abs), "{answer:?}");
        assert!(!serde_json::to_string(&answer)
            .unwrap()
            .contains("file body"));
        assert_eq!(answer.entry.unwrap().path, abs);
        assert!(!get(&ctx(&loc, &cwd), &id, Some(LineRange { from: 1, to: None })).ok);
    }

    #[test]
    fn get_of_an_unknown_or_trashed_entry_is_an_error() {
        let loc = temp_location("get-missing", true);
        let id = seed(&loc, "# в корзину", None, &[]);
        let cwd = outside_git();
        let unknown = get(&ctx(&loc, &cwd), "s0-none", None);
        assert!(!unknown.ok && unknown.error.as_deref().unwrap().contains("s0-none"));
        Stash::open(loc.paths.clone())
            .unwrap()
            .delete_entry(&id, clock::now_ms())
            .unwrap();
        let trashed = get(&ctx(&loc, &cwd), &id, None);
        assert!(!trashed.ok);
        assert!(
            trashed.error.as_deref().unwrap().contains("trash"),
            "{trashed:?}"
        );
        let listed = list(
            &ctx(&loc, &cwd),
            &ListArgs {
                filter: all(),
                ..Default::default()
            },
        );
        assert_eq!(
            listed.total,
            Some(0),
            "the trash is never listed to an agent"
        );
        let found = search(&ctx(&loc, &cwd), &search_all("корзину"));
        assert_eq!(found.total, Some(0), "nor found");
    }

    #[test]
    fn reads_touch_nothing() {
        let loc = temp_location("reads-touch-nothing", true);
        let id = seed(&loc, "# Не трогать\n\nтекст", None, &["infra"]);
        let before = stored(&loc, &id);
        let cwd = outside_git();
        assert!(search(&ctx(&loc, &cwd), &search_all("трогать")).ok);
        assert!(
            list(
                &ctx(&loc, &cwd),
                &ListArgs {
                    filter: all(),
                    ..Default::default()
                }
            )
            .ok
        );
        assert!(get(&ctx(&loc, &cwd), &id, None).ok);
        let after = stored(&loc, &id);
        assert_eq!(after, before);
        assert_eq!(
            after.opened_at, None,
            "an agent reading is not the human opening"
        );
    }

    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    static SOCK_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Under `/tmp`, not temp_dir(): a Unix socket path must fit in 104 bytes.
    fn unique_socket() -> PathBuf {
        let n = SOCK_COUNTER.fetch_add(1, Ordering::SeqCst);
        PathBuf::from(format!("/tmp/couplet-sn-{}-{n}.sock", std::process::id()))
    }

    /// Accepts one connection, reports its request line, answers `{"ok":true}`.
    fn spawn_fake_socket() -> (PathBuf, mpsc::Receiver<String>) {
        let path = unique_socket();
        let _ = fs::remove_file(&path);
        let listener = UnixListener::bind(&path).expect("bind fake socket");
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                let _ = reader.read_line(&mut line);
                let _ = tx.send(line.trim().to_string());
                let mut writer = stream;
                let _ = writer.write_all(b"{\"ok\":true}\n");
            }
        });
        (path, rx)
    }

    #[test]
    fn add_puts_away_a_new_note_tagged_with_the_cwd_repository() {
        let loc = temp_location("add", true);
        let cwd = temp_repo("alpha").join("sub");
        let answer = add_note(
            &ctx(&loc, &cwd),
            "# HDMI\n\nчерез адаптер",
            &["#Infra".to_string()],
        );
        assert!(answer.ok, "{answer:?}");
        let entry = answer.entry.unwrap();
        assert_eq!(
            (entry.repo.as_deref(), entry.tags.clone(), answer.created),
            (Some("alpha"), vec!["infra".to_string()], Some(true))
        );
        assert!(entry.stashed_at.is_some(), "«отложено только что»");
        let notes = crate::path_norm::normalize_path(&loc.paths.notes_dir);
        assert!(Path::new(&entry.path).starts_with(&notes), "{}", entry.path);
        assert_eq!(
            fs::read_to_string(&entry.path).unwrap(),
            "# HDMI\n\nчерез адаптер"
        );
        assert!(
            loc.paths.export_path.is_file(),
            "a write refreshes the export"
        );
        let found = search(
            &ctx(&loc, &cwd),
            &AgentSearchArgs {
                query: "адаптер".to_string(),
                ..Default::default()
            },
        );
        assert_eq!(found.total, Some(1));
    }

    #[test]
    fn an_empty_note_is_refused_before_anything_is_created() {
        let loc = temp_location("add-empty", true);
        let cwd = outside_git();
        assert!(!add_note(&ctx(&loc, &cwd), "  \n\t", &[]).ok);
        assert!(
            !add_note(&ctx(&loc, &cwd), "текст", &["#".to_string()]).ok,
            "a bad tag too"
        );
        assert!(!loc.paths.notes_dir.exists());
        assert!(!loc.paths.db_path.exists());
    }

    #[test]
    fn adding_before_the_app_ever_ran_is_refused_and_creates_nothing() {
        let loc = temp_location("add-early", false);
        let cwd = outside_git();
        let answer = add_note(&ctx(&loc, &cwd), "текст", &[]);
        assert_eq!(answer.error.as_deref(), Some(NOT_RUN_YET));
        fs::write(cwd.join("plan.md"), "# план").unwrap();
        let path = add_path(&ctx(&loc, &cwd), "plan.md", &[]);
        assert_eq!(path.error.as_deref(), Some(NOT_RUN_YET));
        assert!(!loc.app_dir().exists() && !loc.paths.notes_dir.exists());
    }

    #[test]
    fn adding_a_path_references_the_file_once() {
        let loc = temp_location("add-path", true);
        let cwd = outside_git();
        fs::write(cwd.join("plan.md"), "# план").unwrap();
        let first = add_path(&ctx(&loc, &cwd), "plan.md", &[]);
        let again = add_path(
            &ctx(&loc, &cwd),
            &cwd.join("plan.md").to_string_lossy(),
            &["infra".to_string()],
        );
        assert_eq!(
            (first.created, again.created),
            (Some(true), Some(false)),
            "{first:?} {again:?}"
        );
        let (a, b) = (first.entry.unwrap(), again.entry.unwrap());
        assert_eq!((a.id.clone(), a.kind), (b.id.clone(), StashKind::File));
        assert_eq!(b.tags, vec!["infra".to_string()]);
        assert_eq!(
            fs::read_to_string(cwd.join("plan.md")).unwrap(),
            "# план",
            "the user's file is never changed"
        );
    }

    #[test]
    fn a_loose_file_takes_the_repository_of_the_cwd() {
        let loc = temp_location("add-path-repo", true);
        let loose = outside_git().join("loose.md");
        fs::write(&loose, "# вне репо").unwrap();
        let cwd = temp_repo("alpha").join("sub");
        let answer = add_path(&ctx(&loc, &cwd), loose.to_str().unwrap(), &[]);
        assert_eq!(
            answer.entry.unwrap().repo.as_deref(),
            Some("alpha"),
            "like a window's project (A3)"
        );
        let outside = temp_location("add-path-norepo", true);
        let nowhere = add_path(&ctx(&outside, &outside_git()), loose.to_str().unwrap(), &[]);
        assert_eq!(nowhere.entry.unwrap().repo, None);
    }

    #[test]
    fn adding_a_missing_file_or_a_directory_is_an_error() {
        let loc = temp_location("add-bad", true);
        let cwd = outside_git();
        assert!(add_path(&ctx(&loc, &cwd), "nope.md", &[])
            .error
            .unwrap()
            .contains("does not exist"));
        assert!(add_path(&ctx(&loc, &cwd), cwd.to_str().unwrap(), &[])
            .error
            .unwrap()
            .contains("not a file"));
        assert!(
            !loc.paths.db_path.exists(),
            "refused before the database is opened"
        );
    }

    #[test]
    fn adding_a_trashed_note_is_an_error() {
        // A trashed note keeps its row at its path inside `.trash/` (A8).
        let loc = temp_location("add-trashed", true);
        let id = seed(&loc, "# в корзину", None, &[]);
        Stash::open(loc.paths.clone())
            .unwrap()
            .delete_entry(&id, clock::now_ms())
            .unwrap();
        let trashed = stored(&loc, &id).path;
        let cwd = outside_git();
        let again = add_path(&ctx(&loc, &cwd), &trashed, &[]);
        assert!(
            again.error.as_deref().unwrap_or("").contains("trash"),
            "{again:?}"
        );
        assert!(stored(&loc, &id).deleted_at.is_some(), "still in the trash");
    }

    #[test]
    fn a_removed_file_reference_can_be_added_again() {
        // A file reference is unlinked, not trashed: its file is the user's.
        let loc = temp_location("add-removed", true);
        let cwd = outside_git();
        fs::write(cwd.join("old.md"), "# старое").unwrap();
        let id = add_path(&ctx(&loc, &cwd), "old.md", &[]).entry.unwrap().id;
        Stash::open(loc.paths.clone())
            .unwrap()
            .delete_entry(&id, clock::now_ms())
            .unwrap();
        let again = add_path(&ctx(&loc, &cwd), "old.md", &[]);
        assert_eq!(again.created, Some(true), "{again:?}");
        assert_ne!(again.entry.unwrap().id, id);
    }

    #[test]
    fn tag_adds_and_removes() {
        let loc = temp_location("tag", true);
        let id = seed(&loc, "# a", None, &["old"]);
        let cwd = outside_git();
        let answer = tag(
            &ctx(&loc, &cwd),
            &id,
            &["#New".to_string()],
            &["old".to_string()],
        );
        assert_eq!(answer.entry.unwrap().tags, vec!["new".to_string()]);
        assert!(!tag(&ctx(&loc, &cwd), &id, &[], &[]).ok);
        assert!(tag(&ctx(&loc, &cwd), "s0-none", &["x".to_string()], &[])
            .error
            .unwrap()
            .contains("s0-none"));
        Stash::open(loc.paths.clone())
            .unwrap()
            .delete_entry(&id, clock::now_ms())
            .unwrap();
        let trashed = tag(&ctx(&loc, &cwd), &id, &["x".to_string()], &[]);
        assert_eq!(
            trashed.error,
            Some(format!("stash entry {id} is in the trash"))
        );
    }

    #[test]
    fn a_write_waits_for_a_busy_database_instead_of_failing() {
        let loc = temp_location("busy", true);
        let holder = crate::stash::db::open(&loc.paths.db_path).unwrap();
        holder.execute_batch("BEGIN IMMEDIATE").unwrap();
        let loc2 = loc.clone();
        let writer = std::thread::spawn(move || {
            let cwd = outside_git();
            add_note(&ctx(&loc2, &cwd), "под нагрузкой", &[])
        });
        std::thread::sleep(Duration::from_millis(300));
        holder.execute_batch("COMMIT").unwrap();
        let answer = writer.join().unwrap();
        assert!(answer.ok, "{answer:?}");
    }

    #[test]
    fn a_write_tells_the_running_app() {
        let (socket, rx) = spawn_fake_socket();
        let mut loc = temp_location("notify", true);
        loc.socket = Some(socket.clone());
        let cwd = outside_git();
        let answer = add_note(&ctx(&loc, &cwd), "текст", &[]);
        assert!(answer.ok, "{answer:?}");
        let line = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let _ = fs::remove_file(&socket);
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            (v["cmd"].as_str(), v["reason"].as_str(), v["v"].as_u64()),
            (Some("stash-changed"), Some("external"), Some(1))
        );
        assert_eq!(v["ids"], serde_json::json!([answer.entry.unwrap().id]));
    }

    #[test]
    fn a_tag_that_changes_nothing_tells_nobody() {
        let loc = temp_location("notify-tag", true);
        let id = seed(&loc, "# a", None, &["infra"]);
        let (socket, rx) = spawn_fake_socket();
        let loc = StashLocation {
            socket: Some(socket.clone()),
            ..loc
        };
        let cwd = outside_git();
        let answer = tag(&ctx(&loc, &cwd), &id, &["infra".to_string()], &[]);
        assert_eq!(
            answer.entry.map(|e| e.tags),
            Some(vec!["infra".to_string()])
        );
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
        assert!(tag(&ctx(&loc, &cwd), &id, &["later".to_string()], &[]).ok);
        let line = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let _ = fs::remove_file(&socket);
        assert!(line.contains("\"stash-changed\""), "{line}");
    }

    #[test]
    fn no_running_app_is_not_an_error_and_costs_nothing() {
        let mut loc = temp_location("notify-none", true);
        loc.socket = Some(unique_socket()); // nobody listens there
        let cwd = outside_git();
        let started = Instant::now();
        assert!(add_note(&ctx(&loc, &cwd), "текст", &[]).ok);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn an_app_that_never_answers_costs_at_most_the_timeout() {
        // Accepts and then says nothing: the notify gives up after its own
        // read timeout, and the write it reports has already landed.
        let path = unique_socket();
        let _ = fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();
        let held = std::thread::spawn(move || listener.accept().map(|(s, _)| s));
        let loc = StashLocation {
            socket: Some(path.clone()),
            ..temp_location("notify-mute", true)
        };
        let cwd = outside_git();
        let started = Instant::now();
        assert!(add_note(&ctx(&loc, &cwd), "текст", &[]).ok);
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{:?}",
            started.elapsed()
        );
        drop(held.join());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn reads_never_tell_the_app() {
        let (socket, rx) = spawn_fake_socket();
        let mut loc = temp_location("notify-read", true);
        let id = seed(&loc, "# a", None, &[]);
        loc.socket = Some(socket.clone());
        let cwd = outside_git();
        search(&ctx(&loc, &cwd), &search_all("a"));
        list(&ctx(&loc, &cwd), &ListArgs::default());
        get(&ctx(&loc, &cwd), &id, None);
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
        let _ = fs::remove_file(&socket);
    }

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn search_joins_its_words_and_reads_its_filters() {
        let cli = parse_stash_args(&argv(&[
            "search",
            "HDMI",
            "переговорка",
            "--tag",
            "infra",
            "--kind",
            "note",
            "--limit",
            "5",
            "--cursor",
            "c1",
            "--json",
        ]))
        .unwrap();
        assert!(cli.json);
        assert_eq!(
            cli.verb,
            StashVerb::Search(AgentSearchArgs {
                query: "HDMI переговорка".to_string(),
                filter: Filter {
                    tag: Some("infra".to_string()),
                    kind: Some(StashKind::Note),
                    scope: ScopeArg::Default
                },
                limit: Some(5),
                cursor: Some("c1".to_string()),
            })
        );
    }

    #[test]
    fn search_needs_a_query_and_repo_excludes_all() {
        assert!(parse_stash_args(&argv(&["search"]))
            .unwrap_err()
            .contains("query"));
        assert!(
            parse_stash_args(&argv(&["search", "x", "--repo", "a", "--all"]))
                .unwrap_err()
                .contains("mutually exclusive")
        );
        let all = parse_stash_args(&argv(&["search", "x", "--all"])).unwrap();
        assert!(matches!(
            all.verb,
            StashVerb::Search(AgentSearchArgs {
                filter: Filter {
                    scope: ScopeArg::All,
                    ..
                },
                ..
            })
        ));
    }

    #[test]
    fn list_reads_since_sort_and_repo() {
        let cli = parse_stash_args(&argv(&[
            "list",
            "--since",
            "yesterday",
            "--sort",
            "opened",
            "--repo",
            "couplet",
        ]))
        .unwrap();
        assert_eq!(
            cli.verb,
            StashVerb::List(ListArgs {
                filter: Filter {
                    scope: ScopeArg::Repo("couplet".to_string()),
                    ..Default::default()
                },
                since: Some("yesterday".to_string()),
                sort: Some(ListSort::Opened),
                ..Default::default()
            })
        );
        assert!(parse_stash_args(&argv(&["list", "extra"])).is_err());
        assert!(parse_stash_args(&argv(&["list", "--sort", "size"])).is_err());
        assert!(parse_stash_args(&argv(&["list", "--kind", "folder"])).is_err());
        for bad in ["0", "-1", "+3", "x", ""] {
            assert!(
                parse_stash_args(&argv(&["list", "--limit", bad])).is_err(),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn get_takes_one_id_and_a_line_range() {
        let cli = parse_stash_args(&argv(&["get", "s1-a", "--lines", "10:20"])).unwrap();
        assert_eq!(
            cli.verb,
            StashVerb::Get {
                id: "s1-a".to_string(),
                lines: Some(LineRange {
                    from: 10,
                    to: Some(20)
                })
            }
        );
        assert!(parse_stash_args(&argv(&["get"])).is_err());
        assert!(parse_stash_args(&argv(&["get", "a", "b"])).is_err());
        assert!(parse_stash_args(&argv(&["get", "a", "--lines", "5"])).is_err());
    }

    #[test]
    fn add_takes_repeated_tags_and_an_optional_path() {
        let cli = parse_stash_args(&argv(&["add", "--tag", "a", "--tag", "b"])).unwrap();
        assert_eq!(
            cli.verb,
            StashVerb::Add {
                tags: vec!["a".to_string(), "b".to_string()],
                path: None
            }
        );
        let path = parse_stash_args(&argv(&["add", "--path", "x.md"])).unwrap();
        assert_eq!(
            path.verb,
            StashVerb::Add {
                tags: vec![],
                path: Some("x.md".to_string())
            }
        );
        assert!(parse_stash_args(&argv(&["add", "loose"])).is_err());
    }

    #[test]
    fn tag_needs_an_id_and_something_to_change() {
        let cli = parse_stash_args(&argv(&[
            "tag", "s1-a", "--add", "x", "--remove", "y", "--add", "z",
        ]))
        .unwrap();
        assert_eq!(
            cli.verb,
            StashVerb::Tag {
                id: "s1-a".to_string(),
                add: vec!["x".to_string(), "z".to_string()],
                remove: vec!["y".to_string()]
            }
        );
        assert!(parse_stash_args(&argv(&["tag", "s1-a"])).is_err());
        assert!(parse_stash_args(&argv(&["tag", "--add", "x"])).is_err());
    }

    #[test]
    fn a_flag_of_another_verb_is_unknown_here() {
        let err = parse_stash_args(&argv(&["get", "s1-a", "--since", "1d"])).unwrap_err();
        assert!(err.contains("unknown flag for stash get: --since"), "{err}");
        assert!(parse_stash_args(&argv(&["search", "x", "--path", "p"])).is_err());
        assert!(parse_stash_args(&argv(&["search", "x", "--since", "1d"])).is_err());
        assert!(parse_stash_args(&argv(&["add", "--all"])).is_err());
    }

    #[test]
    fn every_verb_takes_product_and_socket() {
        let cli = parse_stash_args(&argv(&[
            "list",
            "--product",
            "couplet-dev",
            "--socket",
            "/tmp/s.sock",
        ]))
        .unwrap();
        assert_eq!(
            (cli.product.as_deref(), cli.socket.as_deref()),
            (Some("couplet-dev"), Some("/tmp/s.sock"))
        );
        for verb in [
            &["search", "x"][..],
            &["get", "s1-a"],
            &["add"],
            &["tag", "s1-a", "--add", "x"],
        ] {
            let mut args = argv(verb);
            args.extend(argv(&["--product", "couplet-dev"]));
            assert_eq!(
                parse_stash_args(&args).unwrap().product.as_deref(),
                Some("couplet-dev"),
                "{verb:?}"
            );
        }
        assert!(parse_stash_args(&argv(&["list", "--product"]))
            .unwrap_err()
            .contains("requires a value"));
    }

    #[test]
    fn an_unknown_verb_prints_the_usage() {
        let err = parse_stash_args(&argv(&["dump"])).unwrap_err();
        assert!(
            err.contains("unknown stash command: dump") && err.contains("couplet stash search"),
            "{err}"
        );
        assert!(parse_stash_args(&[])
            .unwrap_err()
            .contains("couplet stash search"));
    }

    fn sample_entry() -> AgentEntry {
        AgentEntry {
            id: "s1-a".to_string(),
            kind: StashKind::Note,
            title: Some("HDMI в переговорке".to_string()),
            path: "/Users/me/couplet/2026-09-27-0155-a3f9.md".to_string(),
            repo: Some("couplet".to_string()),
            tags: vec!["infra".to_string()],
            stashed_at: Some("2026-09-27T01:55:12+03:00".to_string()),
            modified_at: "2026-09-27T01:50:00+03:00".to_string(),
        }
    }

    fn search_verb() -> StashVerb {
        StashVerb::Search(AgentSearchArgs {
            query: "hdmi".to_string(),
            ..Default::default()
        })
    }

    #[test]
    fn json_is_exactly_one_line_on_stdout() {
        let answer = StashAnswer {
            ok: true,
            text: Some("a\nb".to_string()),
            ..Default::default()
        };
        let (out, err) = render(
            &answer,
            &StashVerb::Get {
                id: "x".to_string(),
                lines: None,
            },
            true,
        );
        assert_eq!((out.lines().count(), err.as_str()), (1, ""));
        assert_eq!(
            serde_json::from_str::<StashAnswer>(&out).unwrap(),
            answer,
            "exactly the answer: the MCP tool result text"
        );
        let failed = render(
            &StashAnswer::error("no stash entry x"),
            &search_verb(),
            true,
        );
        assert_eq!(
            failed,
            (
                r#"{"ok":false,"error":"no stash entry x"}"#.to_string(),
                String::new()
            )
        );
    }

    #[test]
    fn without_json_an_error_is_words_on_stderr_only() {
        let (out, err) = render(
            &StashAnswer::error("no stash entry x"),
            &search_verb(),
            false,
        );
        assert_eq!(
            (out.as_str(), err.as_str()),
            ("", "couplet: no stash entry x")
        );
    }

    #[test]
    fn search_text_is_one_row_per_hit_with_its_snippet_and_a_footer() {
        let answer = StashAnswer {
            ok: true,
            scope: Some(Scope {
                repo: Some("couplet".to_string()),
                all: false,
            }),
            total: Some(7),
            hits: Some(vec![AgentHit {
                entry: sample_entry(),
                snippet: "…HDMI\nчерез адаптер…".to_string(),
            }]),
            next_cursor: Some("c2".to_string()),
            ..Default::default()
        };
        let (out, _) = render(&answer, &search_verb(), false);
        assert_eq!(
            out,
            "s1-a  note  HDMI в переговорке  #infra  [couplet]  2026-09-27 01:55\n    …HDMI через адаптер…\n1 of 7 in repo couplet · next page: --cursor c2"
        );
    }

    #[test]
    fn an_empty_list_says_why() {
        let answer = StashAnswer {
            ok: true,
            scope: Some(Scope {
                repo: None,
                all: true,
            }),
            total: Some(0),
            entries: Some(vec![]),
            hint: Some("the stash is empty".to_string()),
            ..Default::default()
        };
        let (out, err) = render(&answer, &StashVerb::List(ListArgs::default()), false);
        assert_eq!(
            (out.as_str(), err.as_str()),
            ("0 of 0 in the whole stash\nthe stash is empty", "")
        );
    }

    #[test]
    fn get_text_prints_the_note_raw_and_the_rest_hint_on_stderr() {
        let answer = StashAnswer {
            ok: true,
            entry: Some(sample_entry()),
            text: Some("# HDMI\n\nтекст".to_string()),
            hint: Some("showing lines 1–500 of 1200; the rest with lines 501:".to_string()),
            ..Default::default()
        };
        let (out, err) = render(
            &answer,
            &StashVerb::Get {
                id: "s1-a".to_string(),
                lines: None,
            },
            false,
        );
        assert_eq!(
            (out.as_str(), err.as_str()),
            (
                "# HDMI\n\nтекст",
                "couplet: showing lines 1–500 of 1200; the rest with lines 501:"
            )
        );
    }

    #[test]
    fn a_repeated_add_says_it_was_already_there() {
        let answer = StashAnswer {
            ok: true,
            entry: Some(sample_entry()),
            created: Some(false),
            ..Default::default()
        };
        let (out, _) = render(
            &answer,
            &StashVerb::Add {
                tags: vec![],
                path: Some("x".to_string()),
            },
            false,
        );
        assert!(out.ends_with("(already in the stash)"), "{out}");
    }

    #[test]
    fn execute_routes_each_verb_to_its_operation() {
        let loc = temp_location("execute", true);
        let cwd = outside_git();
        let added = execute(
            &ctx(&loc, &cwd),
            &StashVerb::Add {
                tags: vec![],
                path: None,
            },
            Some("# из stdin"),
        );
        let id = added.entry.unwrap().id;
        let got = execute(
            &ctx(&loc, &cwd),
            &StashVerb::Get {
                id: id.clone(),
                lines: None,
            },
            None,
        );
        assert_eq!(got.text.as_deref(), Some("# из stdin"));
        let tagged = execute(
            &ctx(&loc, &cwd),
            &StashVerb::Tag {
                id: id.clone(),
                add: vec!["x".to_string()],
                remove: vec![],
            },
            None,
        );
        assert_eq!(tagged.entry.map(|e| e.tags), Some(vec!["x".to_string()]));
        let listed = execute(
            &ctx(&loc, &cwd),
            &StashVerb::List(ListArgs::default()),
            None,
        );
        assert_eq!(listed.total, Some(1));
        let found = execute(
            &ctx(&loc, &cwd),
            &StashVerb::Search(search_all("stdin")),
            None,
        );
        assert_eq!(found.total, Some(1));
    }

    #[test]
    fn the_command_line_fails_before_any_disk_access_on_bad_input() {
        // Usage errors and bad location flags: exit 2, read before stdin or
        // disk (the process cwd and real stash are never reached).
        assert_eq!(run(&argv(&[])), 2);
        assert_eq!(run(&argv(&["dump"])), 2);
        assert_eq!(run(&argv(&["list", "--socket", "/tmp/nobody.sock"])), 2);
        assert_eq!(run(&argv(&["list", "--product", "../x", "--json"])), 2);
    }

    #[test]
    fn mcp_search_arguments_read_like_the_cli_flags() {
        let args = search_args_from_json(&serde_json::json!({
            "query": "hdmi", "tag": "infra", "kind": "note", "all": true, "limit": 5, "cursor": "c1"
        }))
        .unwrap();
        assert_eq!(
            args,
            AgentSearchArgs {
                query: "hdmi".to_string(),
                filter: Filter {
                    tag: Some("infra".to_string()),
                    kind: Some(StashKind::Note),
                    scope: ScopeArg::All,
                },
                limit: Some(5),
                cursor: Some("c1".to_string()),
            }
        );
        assert!(search_args_from_json(&serde_json::json!({})).is_err());
        assert!(search_args_from_json(&serde_json::json!({"query": 3})).is_err());
        assert!(
            search_args_from_json(&serde_json::json!({"query": "x", "repo": "a", "all": true}))
                .is_err()
        );
        assert!(search_args_from_json(&serde_json::json!({"query": "x", "limit": 0})).is_err());
        assert!(search_args_from_json(&serde_json::json!({"query": "x", "limit": "5"})).is_err());
        assert!(search_args_from_json(&serde_json::json!({"query": "x", "kind": "dir"})).is_err());
    }

    #[test]
    fn mcp_blank_optional_strings_count_as_absent() {
        // An MCP client may fill every optional string with "": that is no
        // filter, not an empty tag or a clash with `all`.
        let args = search_args_from_json(&serde_json::json!({
            "query": "x", "tag": "", "kind": " ", "repo": "", "all": true, "cursor": ""
        }))
        .unwrap();
        assert_eq!(
            (args.filter, args.cursor),
            (
                Filter {
                    tag: None,
                    kind: None,
                    scope: ScopeArg::All
                },
                None
            )
        );
        let list = list_args_from_json(&serde_json::json!({"since": "", "sort": ""})).unwrap();
        assert_eq!((list.since, list.sort), (None, None));
    }

    #[test]
    fn mcp_list_arguments_take_since_as_text_or_number() {
        let text = list_args_from_json(
            &serde_json::json!({"since": "yesterday", "sort": "kind", "repo": "couplet"}),
        )
        .unwrap();
        assert_eq!(
            (text.since.as_deref(), text.sort),
            (Some("yesterday"), Some(ListSort::Kind))
        );
        assert_eq!(text.filter.scope, ScopeArg::Repo("couplet".to_string()));
        let number = list_args_from_json(&serde_json::json!({"since": 1790000000000_i64})).unwrap();
        assert_eq!(number.since.as_deref(), Some("1790000000000"));
        assert!(list_args_from_json(&serde_json::json!({"sort": "size"})).is_err());
        assert_eq!(
            string_array(&serde_json::json!({"tags": ["a", 3, "b"]}), "tags"),
            vec!["a".to_string(), "b".to_string()]
        );
        // One tag given as a plain string is that tag, not silently none.
        assert_eq!(
            string_array(&serde_json::json!({"tags": "infra"}), "tags"),
            vec!["infra".to_string()]
        );
        assert!(string_array(&serde_json::json!({}), "tags").is_empty());
    }
}
