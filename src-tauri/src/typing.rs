//! "The human is typing", app-wide (tabs-questions Q10).
//!
//! Each window keeps its own typing clock (`src/lib/tabs/typing.ts`), and that
//! is enough inside the window: a command there never takes the tab being
//! typed in. It cannot see a command landing in *another* window — that one
//! would come forward, take key focus mid-word, and the next letters would go
//! into the agent's document. So every window also reports its typing here
//! (`note_typing`, at most once per `TYPING_NOTE_INTERVAL_MS`), and an agent's
//! command that would bring a window other than the typed-in one forward is
//! kept in the background (`ai_socket::dispatch`, `window::reveal_window`).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

/// Mirror of `TYPING_GRACE_MS` in `src/lib/tabs/typing.ts` (a test keeps them equal).
pub const TYPING_GRACE_MS: u64 = 2000;

/// Mirror of `TYPING_NOTE_INTERVAL_MS` there: a window reports at most this
/// often, so the last report can be up to one interval older than the last
/// key. The grace here is widened by it — on the safe side, like the rule.
pub const TYPING_NOTE_INTERVAL_MS: u64 = 500;

/// The window typed in last, and when it reported.
pub struct TypingClock(Mutex<Option<(String, Instant)>>);

impl TypingClock {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub fn note(&self, label: &str, at: Instant) {
        *self.0.lock().unwrap() = Some((label.to_string(), at));
    }

    /// The window the human is typing in at `now`, if any.
    pub fn typing_in(&self, now: Instant) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(_, at)| typed_recently(*at, now))
            .map(|(label, _)| label.clone())
    }
}

impl Default for TypingClock {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether a report at `at` still counts as typing at `now`.
pub fn typed_recently(at: Instant, now: Instant) -> bool {
    now.saturating_duration_since(at) < Duration::from_millis(TYPING_GRACE_MS + TYPING_NOTE_INTERVAL_MS)
}

/// Whether an agent may not bring `target` forward while the human types in
/// `typing_in`. `target` `None`: a window still to be built. The typed-in
/// window itself is its own frontend's business — it is already in front, and
/// its per-window rule decides what moves there.
pub fn blocks_raise(typing_in: Option<&str>, target: Option<&str>) -> bool {
    match (typing_in, target) {
        (None, _) => false,
        (Some(typed), Some(target)) => typed != target,
        (Some(_), None) => true,
    }
}

/// `blocks_raise` against the app's clock now. `try_state`: a command can
/// arrive before `setup` is done (CLAUDE.md), and an unknown clock is no typing.
pub fn blocks_raise_now(app: &AppHandle, target: Option<&str>) -> bool {
    app.try_state::<TypingClock>()
        .is_some_and(|clock| blocks_raise(clock.typing_in(Instant::now()).as_deref(), target))
}

/// IPC: the calling window's human typed a key that `typing.ts` counts.
#[tauri::command]
pub async fn note_typing(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if let Some(clock) = app.try_state::<TypingClock>() {
        clock.note(window.label(), Instant::now());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GRACE: Duration = Duration::from_millis(TYPING_GRACE_MS + TYPING_NOTE_INTERVAL_MS);

    #[test]
    fn a_report_counts_for_the_grace_plus_one_note_interval() {
        let at = Instant::now();
        assert!(typed_recently(at, at));
        assert!(typed_recently(at, at + GRACE - Duration::from_millis(1)));
        assert!(!typed_recently(at, at + GRACE));
        assert!(typed_recently(at + Duration::from_millis(5), at), "a clock read before the report still counts");
    }

    #[test]
    fn the_clock_answers_the_last_window_while_its_report_is_fresh() {
        let clock = TypingClock::new();
        let t0 = Instant::now();
        assert_eq!(clock.typing_in(t0), None);
        clock.note("editor-3", t0);
        clock.note("main", t0 + Duration::from_millis(100));
        assert_eq!(clock.typing_in(t0 + Duration::from_millis(200)).as_deref(), Some("main"));
        assert_eq!(clock.typing_in(t0 + Duration::from_millis(100) + GRACE), None);
    }

    #[test]
    fn typing_blocks_every_other_window_and_a_new_one_but_not_its_own() {
        assert!(!blocks_raise(None, Some("editor-7")));
        assert!(!blocks_raise(None, None));
        assert!(blocks_raise(Some("editor-3"), Some("editor-7")));
        assert!(blocks_raise(Some("editor-3"), None), "a new window would take the focus too");
        assert!(!blocks_raise(Some("editor-3"), Some("editor-3")));
    }

    #[test]
    fn the_constants_mirror_typing_ts() {
        let ts = include_str!("../../src/lib/tabs/typing.ts");
        for decl in [
            format!("export const TYPING_GRACE_MS = {TYPING_GRACE_MS};"),
            format!("export const TYPING_NOTE_INTERVAL_MS = {TYPING_NOTE_INTERVAL_MS};"),
        ] {
            assert!(ts.contains(&decl), "typing.ts must declare `{decl}`");
        }
    }
}
