//! One-time "what's new" window shown the first time a new app version runs.
//!
//! Gated by a marker file (`onboarding-version`) in the app data directory holding
//! the last version this was shown for. A dev build has its own data directory
//! (see `paths.rs`), so repeated dev testing is naturally isolated from a real
//! install and from itself across `npm run build:dev` bumps.

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;

use crate::paths;
use crate::window;

const MARKER_FILE: &str = "onboarding-version";
const WELCOME_MD: &str = include_str!("../welcome.md");
const PLAYBOOK_MD: &str = include_str!("../playbook.md");
const GETTING_STARTED_MD: &str = include_str!("../getting-started-ai.md");

/// Written once, the first time an AI command reaches this install over the
/// command socket. Its presence is what silences the startup nudge forever.
const CONNECTED_FILE: &str = "ai-connected";

/// Persisted counters for the startup nudge.
const NUDGE_FILE: &str = "ai-nudge.json";

/// How many times the startup nudge may appear before it gives up on its own.
const MAX_NUDGE_SHOWS: u32 = 3;

/// Minimum gap between two nudges, so a user who restarts the app five times in
/// an afternoon sees it once.
const NUDGE_INTERVAL_SECS: u64 = 24 * 60 * 60;

/// Whether the welcome window opened during *this* launch. The nudge stands down
/// when it did — the welcome window already says everything the nudge would.
static WELCOME_SHOWN_THIS_LAUNCH: AtomicBool = AtomicBool::new(false);

/// True when the welcome window should be shown for `current` — the marker is
/// absent (fresh install / fresh data dir) or names a different version.
pub fn should_show(stored: Option<&str>, current: &str) -> bool {
    match stored {
        None => true,
        Some(v) => v != current,
    }
}

fn read_marker(base_dir: &Path) -> Option<String> {
    fs::read_to_string(base_dir.join(MARKER_FILE))
        .ok()
        .map(|s| s.trim().to_string())
}

fn write_marker(base_dir: &Path, version: &str) -> std::io::Result<()> {
    fs::write(base_dir.join(MARKER_FILE), version)
}

/// Write `content` to `app_data_dir()/filename` (overwriting any previous
/// version) and open it in a new window.
///
/// Shared by the first-run welcome window and the "AI" menu's on-demand docs.
/// The AI menu docs are meant to always reflect the current snippets, so
/// callers regenerate `content` at click time rather than caching a copy.
pub fn open_bundled_doc(app: &AppHandle, filename: &str, content: &str) -> Result<(), String> {
    let base_dir = paths::app_data_dir()?;
    let path = base_dir.join(filename);
    fs::write(&path, content).map_err(|e| format!("failed to write {}: {}", filename, e))?;
    window::open_file_window(app, Some(path.to_string_lossy().to_string()));
    Ok(())
}

/// Show the welcome window if this version hasn't been shown yet. Called at the
/// end of `setup`, after `paths::init`. Never panics or breaks startup — any
/// failure is logged to stderr and swallowed.
pub fn maybe_show(app: &AppHandle) {
    let version = app
        .config()
        .version
        .clone()
        .unwrap_or_else(|| "0.0.0".to_string());

    let base_dir = match paths::app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("onboarding: failed to get app data dir: {}", e);
            return;
        }
    };

    let stored = read_marker(&base_dir);
    if !should_show(stored.as_deref(), &version) {
        return;
    }

    let filename = format!("welcome-{}.md", version);
    if let Err(e) = open_bundled_doc(app, &filename, WELCOME_MD) {
        eprintln!("onboarding: {}", e);
        return;
    }
    WELCOME_SHOWN_THIS_LAUNCH.store(true, Ordering::SeqCst);

    if let Err(e) = write_marker(&base_dir, &version) {
        eprintln!("onboarding: failed to write marker: {}", e);
    }
}

// ---------------------------------------------------------------------------
// AI discoverability: the startup nudge and the "first AI command" marker.
//
// Three surfaces name one place — the AI menu's "Getting Started" — so someone
// who sets this up once and forgets has a way back. See
// docs/superpowers/specs/2026-08-23-ai-discoverability-design.md.
// ---------------------------------------------------------------------------

/// Persisted state of the startup nudge. A missing or unparseable file reads as
/// the default (never shown, never dismissed) — this drives a toast, so a
/// corrupt file must not be able to break startup.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct NudgeState {
    pub shown: u32,
    pub last_shown: u64,
    pub dismissed: bool,
}

/// Whether the startup nudge should appear. Pure — every input is passed in, so
/// each branch is directly testable.
///
/// `connected` is the presence of the `ai-connected` marker: once an agent has
/// actually driven this install, the nudge has nothing left to say.
pub fn should_nudge(state: &NudgeState, connected: bool, welcome_shown: bool, now: u64) -> bool {
    if connected || welcome_shown || state.dismissed {
        return false;
    }
    if state.shown >= MAX_NUDGE_SHOWS {
        return false;
    }
    // A never-shown nudge has last_shown == 0, so the subtraction below lets it
    // through on any real clock without a special case.
    now.saturating_sub(state.last_shown) >= NUDGE_INTERVAL_SECS
}

fn read_nudge(base_dir: &Path) -> NudgeState {
    fs::read_to_string(base_dir.join(NUDGE_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_nudge(base_dir: &Path, state: &NudgeState) -> Result<(), String> {
    let json = serde_json::to_string(state).map_err(|e| e.to_string())?;
    fs::write(base_dir.join(NUDGE_FILE), json).map_err(|e| e.to_string())
}

fn is_connected(base_dir: &Path) -> bool {
    base_dir.join(CONNECTED_FILE).exists()
}

/// Record that an AI command reached this install, and report whether *this*
/// call is the one that made the transition.
///
/// Check-and-set: exactly one call over the lifetime of an install returns
/// `true`, and that call's command is the one that carries `first_use` to the
/// frontend. A failure to write is reported as "not the first" so a read-only
/// data directory produces no toast at all rather than one on every command.
pub fn mark_connected(version: &str) -> bool {
    let Ok(base_dir) = paths::app_data_dir() else {
        return false;
    };
    if is_connected(&base_dir) {
        return false;
    }
    match fs::write(base_dir.join(CONNECTED_FILE), version) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("onboarding: failed to write {}: {}", CONNECTED_FILE, e);
            false
        }
    }
}

/// Whether to raise the startup nudge, counting this launch's show if so.
/// Called once, by the `main` window, on mount.
#[tauri::command]
pub fn ai_nudge_pending() -> bool {
    let Ok(base_dir) = paths::app_data_dir() else {
        return false;
    };
    let mut state = read_nudge(&base_dir);
    let now = crate::session::now_secs();
    if !should_nudge(
        &state,
        is_connected(&base_dir),
        WELCOME_SHOWN_THIS_LAUNCH.load(Ordering::SeqCst),
        now,
    ) {
        return false;
    }
    state.shown += 1;
    state.last_shown = now;
    if let Err(e) = write_nudge(&base_dir, &state) {
        // Showing it without recording the show would repeat it every launch.
        eprintln!("onboarding: failed to write {}: {}", NUDGE_FILE, e);
        return false;
    }
    true
}

/// Retire the startup nudge permanently — the user either followed it or closed it.
#[tauri::command]
pub fn ai_nudge_dismiss() {
    let Ok(base_dir) = paths::app_data_dir() else {
        return;
    };
    let mut state = read_nudge(&base_dir);
    if state.dismissed {
        return;
    }
    state.dismissed = true;
    if let Err(e) = write_nudge(&base_dir, &state) {
        eprintln!("onboarding: failed to write {}: {}", NUDGE_FILE, e);
    }
}

/// Open the "Getting Started" doc. Shared by the AI menu item and the startup
/// nudge's call to action, so both land on exactly the same document.
#[tauri::command]
pub fn ai_open_getting_started(app: AppHandle) {
    if let Err(e) = open_bundled_doc(&app, "ai-getting-started.md", GETTING_STARTED_MD) {
        eprintln!("onboarding: {}", e);
    }
}

/// Content for the "Connect Your AI" menu item.
///
/// Заменил собой четыре документа: «Getting Started», «Connect via CLI»,
/// «Connect via MCP» и «Teach your AI». Каждый из них объяснял свою часть и
/// оставлял человеку работу по сборке — владелец, собирая себе, в итоге делал
/// из них солянку вручную. Здесь вместо объяснения выдаётся промпт: агент сам
/// регистрирует MCP, пишет скилл и добавляет короткий абзац в главный конфиг.
///
/// Тело скилла — это `MCP_AGENT_SNIPPET` и `AGENT_SNIPPET` дословно, поэтому
/// промпт не может разойтись с тем, что печатает `mdmini agent`.
///
/// Внешний забор — четыре бэктика: внутри промпта есть свои тройные блоки.
pub(crate) fn connect_doc() -> String {
    let mut d = String::new();

    d.push_str(
        r#"# Connect Your AI

Одно действие: отдайте агенту промпт ниже. Дальше он всё сделает сам.

Промпт делает четыре вещи:

1. **Регистрирует md-mini как MCP-сервер** — тогда `show` / `edit` / `ask` /
   `question` / `answer` становятся обычными инструментами агента, которые он
   видит сам и которым не нужен сниппет в инструкциях.
2. **Создаёт скилл `mdmini`** — всё знание о том, как пользоваться этими
   инструментами хорошо, лежит в нём. Скилл грузится только когда понадобился,
   поэтому он ничего не стоит, пока не нужен.
3. **Добавляет короткий абзац в главный конфиг агента** (`~/.claude/CLAUDE.md`
   или его аналог) — только про то, *когда* звать md-mini и что перед этим
   надо загрузить скилл. Всё остальное знание остаётся в скилле.
4. **Задаёт порядок: MCP, а если не вышло — CLI.** Агенту прямо сказано:
   умеешь MCP — работай через MCP; не умеешь, не зарегистрировался или он
   молчит — те же действия доступны через `mdmini` в терминале.

Если главный конфиг трогать не хочется —
[есть второй промпт, только со скиллом](#только-скилл-без-правки-конфига)
(⌘-клик: обычный клик в md-mini ставит каретку, чтобы текст ссылки можно было
править).

## Промпт

Скопируйте целиком и отдайте агенту.

````
"#,
    );

    d.push_str(PROMPT_INTRO);
    d.push_str(
        r#"
3. Append the block between the CONFIG markers below to my main config file
   (`~/.claude/CLAUDE.md`, or this harness's equivalent). That block and
   nothing else: the file is read on every run, so it stays short on purpose.
   If a block like it is already there, replace it rather than adding a second.
"#,
    );
    d.push_str(PROMPT_VERIFY);
    d.push_str(&prompt_payload());
    d.push_str(
        r#"

--- CONFIG ---
"#,
    );
    d.push_str(CONFIG_BLOCK);
    d.push_str(
        r#"
--- CONFIG END ---
````

## Только скилл, без правки конфига

Тот же промпт, но главный конфиг он не трогает. Цена — агент не узнает сам,
что пора звать md-mini: скилл придётся звать вручную (`/mdmini` или «используй
скилл mdmini»). Поэтому для гладкой работы мы всё же советуем первый вариант —
[вернуться к нему](#промпт) (⌘-клик).

````
"#,
    );
    d.push_str(PROMPT_INTRO);
    d.push_str(
        r#"
3. Do not touch my main config file (`~/.claude/CLAUDE.md`, or this harness's
   equivalent) at all, and do not create one.
"#,
    );
    d.push_str(PROMPT_VERIFY);
    d.push_str(&prompt_payload());
    d.push_str(
        r#"
````

## Где лежит главный конфиг

Промпт выше знает эти места сам; список здесь на случай, если агент спросит.

"#,
    );
    d.push_str(crate::ai_socket::INSTRUCTION_FILE_LOCATIONS);
    d.push('\n');
    d
}

/// Первые два шага обоих промптов — они одинаковы; различается только третий.
const PROMPT_INTRO: &str = r#"Set up md-mini (`mdmini`) for me. Do the steps in order, then tell me in one
short paragraph what you changed and what you skipped.

1. Register md-mini over MCP, if your harness supports MCP at all.
   Claude Code: `claude mcp add --scope user mdmini -- mdmini mcp`
   Other clients: add `"mdmini": {"command": "mdmini", "args": ["mcp"]}` to
   their `mcpServers` config.
   If your harness has no MCP support, skip this step and say so — everything
   below still works through the CLI.

2. Create the skill file `~/.claude/skills/mdmini/SKILL.md` (create the
   directories if needed; for a non-Claude harness use its own skill location).
   Its frontmatter is exactly:

   ---
   name: mdmini
   description: Use when the user should read something with their own eyes, when a file or report needs to be shown, when asking a question about a document they already have open, or when replying to comments they left in one. Covers the MCP tools (show/edit/ask/question/answer) and the CLI fallback.
   ---

   Its body is everything between the SKILL markers below, verbatim.
"#;

/// Последний шаг обоих промптов.
const PROMPT_VERIFY: &str = r#"
4. Check your work: `mdmini --version` prints a version, and the skill file
   exists. If `mdmini` is not on PATH, stop and tell me — do not install
   anything yourself and do not guess a path.

Rule to carry into the skill and the config: prefer the MCP tools when they
are available, and fall back to the `mdmini` CLI when MCP is not registered,
not supported, or a call fails. Same capabilities either way.
"#;

/// Тело скилла — оба сниппета дословно, поэтому промпт не может разойтись с
/// тем, что печатает `mdmini agent` и `mdmini agent --mcp`.
fn prompt_payload() -> String {
    format!(
        "\n--- SKILL ---\n\n{}\n\nIf MCP is unavailable, unregistered, or failing, the same capabilities are on the command line:\n\n{}\n\n--- SKILL END ---\n",
        crate::ai_socket::MCP_AGENT_SNIPPET,
        crate::ai_socket::AGENT_SNIPPET,
    )
}

/// Всё, что попадает в главный конфиг. Намеренно короткое: этот файл читается
/// при каждом запуске агента, поэтому знание живёт в скилле, а здесь — только
/// повод его загрузить.
const CONFIG_BLOCK: &str = r#"
## md-mini

`mdmini` is the local editor the user reads in. Reach for it when they should
see something with their own eyes — a report, plan, spec or review you just
wrote; when they say "show me"; when the question is about a document they
already have open; when a mermaid diagram is involved; or when they left
comments in a document for you. Load the `mdmini` skill before using it.

Prefer the MCP tools (`show`, `edit`, `ask`, `question`, `answer`). If MCP is
not registered, not supported by this harness, or a call fails, use the
`mdmini` CLI instead — the skill documents both. Skip it for short answers and
throwaway files.
"#;

/// Content for the "AI Playbook" menu item — static, bundled at compile time.
pub(crate) fn playbook_doc() -> &'static str {
    PLAYBOOK_MD
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_show_when_no_marker() {
        assert!(should_show(None, "1.0.0"));
    }

    #[test]
    fn should_not_show_when_same_version() {
        assert!(!should_show(Some("1.0.0"), "1.0.0"));
    }

    #[test]
    fn should_show_when_version_differs() {
        assert!(should_show(Some("0.5.1"), "1.0.0"));
    }

    fn temp_base_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "md-mini-onboarding-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn marker_round_trip() {
        let dir = temp_base_dir("round-trip");

        assert_eq!(read_marker(&dir), None);

        write_marker(&dir, "1.0.0").expect("write marker");
        assert_eq!(read_marker(&dir).as_deref(), Some("1.0.0"));

        write_marker(&dir, "1.1.0").expect("overwrite marker");
        assert_eq!(read_marker(&dir).as_deref(), Some("1.1.0"));

        let _ = fs::remove_dir_all(&dir);
    }

    // --- Connect Your AI ----------------------------------------------------

    #[test]
    fn connect_doc_carries_both_snippets_verbatim() {
        let doc = connect_doc();
        assert!(doc.starts_with("# Connect Your AI"));
        // Смысл документа в том, что тело скилла — это те же сниппеты, что
        // печатает CLI. Пересказ здесь разойдётся с ними на первой же правке.
        assert!(doc.contains(crate::ai_socket::MCP_AGENT_SNIPPET));
        assert!(doc.contains(crate::ai_socket::AGENT_SNIPPET));
    }

    #[test]
    fn connect_doc_has_both_prompts_and_the_link_between_them() {
        let doc = connect_doc();
        // Два промпта — два забора из четырёх бэктиков, открывающий и
        // закрывающий у каждого.
        assert_eq!(doc.matches("````").count(), 4);
        // Ссылки ведут к заголовкам друг друга: слаг считается так же, как
        // `slugify` во фронтенде (нижний регистр, пробелы в дефисы,
        // пунктуация выброшена). Обе стороны — вниз к запасному варианту и
        // обратно наверх к рекомендованному: человек, передумавший на втором
        // промпте, не должен искать дорогу назад скроллом.
        assert!(doc.contains("(#только-скилл-без-правки-конфига)"));
        assert!(doc.contains("## Только скилл, без правки конфига"));
        assert!(doc.contains("(#промпт)"));
        assert!(doc.contains("## Промпт"));
    }

    #[test]
    fn connect_doc_tells_the_agent_mcp_first_then_cli() {
        let doc = connect_doc();
        assert!(doc.contains("prefer the MCP tools"));
        assert!(doc.contains("fall back to the `mdmini` CLI"));
    }

    #[test]
    fn config_block_stays_short() {
        // Он попадает в файл, который читается при каждом запуске агента.
        // Порог с запасом: дело не в точном числе, а в том, чтобы сюда не
        // переехал скилл.
        assert!(
            CONFIG_BLOCK.lines().count() < 20,
            "config block grew to {} lines",
            CONFIG_BLOCK.lines().count()
        );
    }

    #[test]
    fn playbook_doc_is_nonempty_and_mentions_spec_driven() {
        let doc = playbook_doc();
        assert!(!doc.is_empty());
        assert!(doc.contains("Spec-driven"));
    }

    // --- Getting Started doc ------------------------------------------------

    #[test]
    fn getting_started_doc_maps_the_ai_menu() {
        let doc = GETTING_STARTED_MD;
        assert!(doc.starts_with("# Getting Started with AI in md-mini"));
        // Карта меню — смысл этого документа: без неё остаётся руководство,
        // которое не говорит, где всё это лежит.
        assert!(doc.contains("## Where this lives"));

        // Список пунктов берётся из самого меню, а не переписывается сюда
        // руками. Ровно этот дрейф и случился, когда четыре пункта заменили
        // одним: документ продолжал рисовать старую схему, а тест —
        // проверять её же, и оба молчали.
        for label in ai_menu_labels() {
            assert!(
                doc.contains(&label),
                "menu map is missing {:?}; AI menu and getting-started-ai.md have drifted",
                label
            );
        }
    }

    /// Подписи пунктов меню AI, вытащенные из `menu.rs`.
    fn ai_menu_labels() -> Vec<String> {
        const MENU_RS: &str = include_str!("menu.rs");
        let mut out = Vec::new();
        for rest in MENU_RS.split("with_id(\"ai_").skip(1) {
            // …"ai_connect", "Connect Your AI")… — нужна вторая строка.
            let Some(after_id) = rest.split_once("\", \"") else {
                continue;
            };
            let Some((label, _)) = after_id.1.split_once('"') else {
                continue;
            };
            out.push(label.to_string());
        }
        assert!(!out.is_empty(), "no AI menu items found in menu.rs");
        out
    }


    #[test]
    fn welcome_doc_also_points_at_the_ai_menu() {
        // First-run users only ever see the welcome window, and they are the
        // ones who set this up once and forget where it was.
        assert!(WELCOME_MD.contains("## Where this lives"));
        assert!(WELCOME_MD.contains("Getting Started"));
    }

    // --- Startup nudge ------------------------------------------------------

    const DAY: u64 = 24 * 60 * 60;

    /// A fresh install, one day into using the app: everything permits a nudge.
    fn fresh() -> NudgeState {
        NudgeState::default()
    }

    #[test]
    fn nudges_a_fresh_install() {
        assert!(should_nudge(&fresh(), false, false, DAY));
    }

    #[test]
    fn never_nudges_once_an_agent_has_connected() {
        assert!(!should_nudge(&fresh(), true, false, DAY));
    }

    #[test]
    fn never_nudges_on_the_launch_that_showed_the_welcome_window() {
        assert!(!should_nudge(&fresh(), false, true, DAY));
    }

    #[test]
    fn never_nudges_after_dismissal() {
        let state = NudgeState { shown: 1, last_shown: 0, dismissed: true };
        assert!(!should_nudge(&state, false, false, 10 * DAY));
    }

    #[test]
    fn stops_nudging_after_the_show_limit() {
        let at_limit = NudgeState {
            shown: MAX_NUDGE_SHOWS,
            last_shown: DAY,
            dismissed: false,
        };
        assert!(!should_nudge(&at_limit, false, false, 100 * DAY));

        let below_limit = NudgeState {
            shown: MAX_NUDGE_SHOWS - 1,
            last_shown: DAY,
            dismissed: false,
        };
        assert!(should_nudge(&below_limit, false, false, 100 * DAY));
    }

    #[test]
    fn holds_off_within_a_day_of_the_last_nudge() {
        let state = NudgeState { shown: 1, last_shown: 10 * DAY, dismissed: false };
        // Restarting the app an hour later must not nudge again.
        assert!(!should_nudge(&state, false, false, 10 * DAY + 3600));
        // Exactly a day later is the boundary, and it is inclusive.
        assert!(should_nudge(&state, false, false, 11 * DAY));
    }

    #[test]
    fn a_clock_that_went_backwards_does_not_nudge() {
        // Saturating subtraction: an earlier `now` than `last_shown` yields 0,
        // which is below the interval, so we simply stay quiet.
        let state = NudgeState { shown: 1, last_shown: 100 * DAY, dismissed: false };
        assert!(!should_nudge(&state, false, false, DAY));
    }

    #[test]
    fn nudge_state_round_trips_and_tolerates_junk() {
        let dir = temp_base_dir("nudge");

        // Missing file reads as the default rather than failing.
        assert_eq!(read_nudge(&dir), NudgeState::default());

        let state = NudgeState { shown: 2, last_shown: 12345, dismissed: true };
        write_nudge(&dir, &state).expect("write nudge state");
        assert_eq!(read_nudge(&dir), state);

        // A corrupt file must not be able to break startup either.
        fs::write(dir.join(NUDGE_FILE), "{not json").expect("write junk");
        assert_eq!(read_nudge(&dir), NudgeState::default());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn connected_marker_is_a_one_shot() {
        let dir = temp_base_dir("connected");
        assert!(!is_connected(&dir));

        // `mark_connected` itself resolves the real app data dir, so exercise
        // its check-and-set shape against a temp dir here and leave the path
        // resolution to the caller.
        assert!(!is_connected(&dir));
        fs::write(dir.join(CONNECTED_FILE), "1.0.0").expect("write marker");
        assert!(is_connected(&dir));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_connected_install_never_nudges_regardless_of_counters() {
        // Whatever the counters say, having connected ends the conversation.
        for shown in 0..=MAX_NUDGE_SHOWS {
            let state = NudgeState { shown, last_shown: 0, dismissed: false };
            assert!(!should_nudge(&state, true, false, 1000 * DAY));
        }
    }
}
