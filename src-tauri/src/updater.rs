//! Cross-window coordination for the update notification.
//!
//! The HTTP request itself stays in the frontend (`src/lib/updater.ts`) — pulling
//! an HTTP client into the Rust side for one hourly poll is not worth the
//! dependency. What lives here is the part that has to be shared by every window:
//!
//! - **who polls.** Every window used to run its own timer, so five windows meant
//!   five requests an hour for one answer. Exactly one window holds the claim.
//! - **whether the notice is dismissed.** Closing the toast used to close it in
//!   one window only, so the user had to dismiss it once per window. Dismissal is
//!   now process-wide and is remembered for windows opened later.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;

/// A newer release than the one running.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub latest: String,
    pub current: String,
    /// One-line summary from the release notes, when there is one. A bare
    /// version number never told anyone why to upgrade.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub highlight: Option<String>,
}

#[derive(Default)]
pub struct UpdateState {
    /// Label of the window that owns the poll timer.
    checker: Mutex<Option<String>>,
    found: Mutex<Option<UpdateInfo>>,
    dismissed: AtomicBool,
}

impl UpdateState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Try to become the polling window. True for the winner, and for the holder
    /// asking again (a reload re-runs `onMount` in the same window).
    pub fn claim(&self, label: &str) -> bool {
        let mut checker = self.checker.lock().unwrap();
        match checker.as_deref() {
            Some(existing) => existing == label,
            None => {
                *checker = Some(label.to_string());
                true
            }
        }
    }

    /// Give up the claim if this window held it, so a surviving window can take
    /// over. Without this, closing the polling window would stop update checks
    /// for the rest of the session.
    pub fn release(&self, label: &str) {
        let mut checker = self.checker.lock().unwrap();
        if checker.as_deref() == Some(label) {
            *checker = None;
        }
    }

    /// Test-only: who holds the claim. Production code only ever needs `claim`.
    #[cfg(test)]
    pub fn is_checker(&self, label: &str) -> bool {
        self.checker.lock().unwrap().as_deref() == Some(label)
    }

    /// The label of the window that owns the poll timer, if any window has
    /// claimed it yet. Read by `lib.rs`'s "Check for Updates…" handler so it
    /// can target that one window with `emit_to` instead of broadcasting —
    /// see the doc comment there for why an unfiltered `emit` is not enough.
    pub fn checker_label(&self) -> Option<String> {
        self.checker.lock().unwrap().clone()
    }

    /// Record a found update. Returns whether windows should be told — a
    /// dismissed notice stays dismissed, and re-reporting the same version on the
    /// next hourly poll must not make the toast reappear.
    ///
    /// `force` is for the manual "Check for Updates…" menu item: unlike the
    /// hourly autopoll, a manual check must always answer, even when the
    /// version is unchanged or was already dismissed — otherwise clicking it
    /// after dismissing the toast looks like nothing happened.
    pub fn record(&self, info: UpdateInfo, force: bool) -> bool {
        let mut found = self.found.lock().unwrap();
        let is_new = found.as_ref() != Some(&info);
        let already_shown = !is_new;
        *found = Some(info);
        drop(found);

        if force {
            // A manual check resurfaces a previously dismissed notice
            // unconditionally — that is the whole point of asking again.
            self.dismissed.store(false, Ordering::SeqCst);
            return true;
        }

        if is_new {
            // A different version than the one dismissed is worth showing again.
            self.dismissed.store(false, Ordering::SeqCst);
        }
        !already_shown && !self.dismissed.load(Ordering::SeqCst)
    }

    pub fn dismiss(&self) {
        self.dismissed.store(true, Ordering::SeqCst);
    }

    /// What a newly mounted window should display, if anything.
    pub fn pending(&self) -> Option<UpdateInfo> {
        if self.dismissed.load(Ordering::SeqCst) {
            return None;
        }
        self.found.lock().unwrap().clone()
    }
}

// -- IPC --

/// Ask to be the window that polls GitHub. Only the winner should start a timer.
#[tauri::command]
pub async fn claim_update_checker(
    window: tauri::Window,
    state: tauri::State<'_, UpdateState>,
) -> Result<bool, String> {
    Ok(state.claim(window.label()))
}

/// The polling window found a newer release. Tell every window once.
///
/// `force` distinguishes the hourly autopoll (`false`) from the manual "Check
/// for Updates…" menu item (`true`) — see `UpdateState::record`.
#[tauri::command]
pub async fn report_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdateState>,
    latest: String,
    current: String,
    highlight: Option<String>,
    force: bool,
) -> Result<(), String> {
    use tauri::Emitter;
    let info = UpdateInfo {
        latest,
        current,
        highlight,
    };
    if state.record(info.clone(), force) {
        let _ = app.emit("update-available", info);
    }
    Ok(())
}

/// Dismiss the notice everywhere, not just in the window that was clicked.
#[tauri::command]
pub async fn dismiss_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdateState>,
) -> Result<(), String> {
    use tauri::Emitter;
    state.dismiss();
    let _ = app.emit("update-dismissed", ());
    Ok(())
}

/// Catch-up for a window that mounted after the check ran.
#[tauri::command]
pub async fn pending_update(
    state: tauri::State<'_, UpdateState>,
) -> Result<Option<UpdateInfo>, String> {
    Ok(state.pending())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(latest: &str) -> UpdateInfo {
        UpdateInfo {
            latest: latest.to_string(),
            current: "0.5.0".to_string(),
            highlight: None,
        }
    }

    #[test]
    fn only_one_window_claims_the_checker() {
        let state = UpdateState::new();
        assert!(state.claim("main"));
        assert!(!state.claim("editor-1"));
        assert!(state.is_checker("main"));
    }

    #[test]
    fn the_holder_may_reclaim() {
        // A reload re-runs onMount in the same window; it must not lose the claim.
        let state = UpdateState::new();
        assert!(state.claim("main"));
        assert!(state.claim("main"));
    }

    #[test]
    fn releasing_lets_another_window_take_over() {
        let state = UpdateState::new();
        state.claim("main");
        state.release("main");
        assert!(state.claim("editor-1"));
        assert!(state.is_checker("editor-1"));
    }

    #[test]
    fn releasing_from_a_non_holder_is_a_no_op() {
        let state = UpdateState::new();
        state.claim("main");
        state.release("editor-1");
        assert!(state.is_checker("main"), "main must keep the claim");
    }

    #[test]
    fn checker_label_is_none_before_any_claim() {
        assert_eq!(UpdateState::new().checker_label(), None);
    }

    #[test]
    fn checker_label_reports_the_claim_holder() {
        let state = UpdateState::new();
        state.claim("main");
        assert_eq!(state.checker_label(), Some("main".to_string()));
    }

    #[test]
    fn checker_label_is_cleared_on_release() {
        let state = UpdateState::new();
        state.claim("main");
        state.release("main");
        assert_eq!(state.checker_label(), None);
    }

    #[test]
    fn first_report_is_broadcast() {
        let state = UpdateState::new();
        assert!(state.record(info("v0.6.0"), false));
    }

    #[test]
    fn repeated_report_of_the_same_version_is_not_rebroadcast() {
        // The poll runs hourly and would otherwise re-raise the toast every hour.
        let state = UpdateState::new();
        assert!(state.record(info("v0.6.0"), false));
        assert!(!state.record(info("v0.6.0"), false));
    }

    #[test]
    fn dismissal_survives_the_next_poll() {
        let state = UpdateState::new();
        state.record(info("v0.6.0"), false);
        state.dismiss();
        assert!(
            !state.record(info("v0.6.0"), false),
            "an hourly re-report must not resurrect a dismissed notice"
        );
        assert_eq!(state.pending(), None);
    }

    #[test]
    fn a_newer_version_shows_again_after_dismissal() {
        let state = UpdateState::new();
        state.record(info("v0.6.0"), false);
        state.dismiss();
        assert!(state.record(info("v0.7.0"), false));
        assert_eq!(state.pending(), Some(info("v0.7.0")));
    }

    #[test]
    fn forced_report_resurfaces_a_dismissed_notice_of_the_same_version() {
        // The manual "Check for Updates…" click must always answer, even when
        // the version is unchanged and was already dismissed — otherwise
        // clicking it after dismissing the toast looks like nothing happened.
        let state = UpdateState::new();
        state.record(info("v0.6.0"), false);
        state.dismiss();
        assert!(state.record(info("v0.6.0"), true));
        assert_eq!(state.pending(), Some(info("v0.6.0")));
    }

    #[test]
    fn forced_report_broadcasts_even_when_nothing_changed_and_nothing_was_dismissed() {
        let state = UpdateState::new();
        state.record(info("v0.6.0"), false);
        // Not dismissed, same version — an unforced re-report here would be
        // `false` (already shown). A forced one always answers.
        assert!(state.record(info("v0.6.0"), true));
    }

    #[test]
    fn a_forced_check_does_not_mask_a_genuinely_new_version_later() {
        let state = UpdateState::new();
        state.record(info("v0.6.0"), true);
        assert!(state.record(info("v0.7.0"), false));
        assert_eq!(state.pending(), Some(info("v0.7.0")));
    }

    #[test]
    fn pending_is_empty_before_any_check() {
        assert_eq!(UpdateState::new().pending(), None);
    }

    #[test]
    fn pending_serves_windows_opened_later() {
        let state = UpdateState::new();
        state.record(info("v0.6.0"), false);
        assert_eq!(state.pending(), Some(info("v0.6.0")));
    }
}
