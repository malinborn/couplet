//! The pause that keeps an agent from being woken mid-sentence (#36).
//!
//! Autosave made every keystroke a wake-up: the box writes as you type, and
//! the write set `status=open`, which is exactly what `mdmini watch` emits an
//! event for. So an agent arrived with half a question. The fix is a third
//! status — `paused` — that `watch` skips, plus a deadline on the marker line
//! that says when the pause runs out.
//!
//! The three writes that make up a thread's life while a human is typing —
//! creating it, rewriting the box, ending the pause — live together here
//! because they have to agree on one rule ([`comments::status_after_edit`])
//! and on one clock. Splitting them across call sites is precisely how the
//! create path would end up writing an unpaused thread while the reply path
//! paused it.
//!
//! The app's countdown is not what makes delivery work: the deadline is in the
//! file, and `awaiting` in `comments.rs` reads it. What the commits here buy is
//! promptness — a write the watcher sees immediately, instead of waiting for
//! its next resync.

use std::path::{Path, PathBuf};

use tauri::Manager;

use crate::comments::{self, Status};

/// Create a thread the user is still typing.
///
/// The thread is born `paused`: the first keystroke is what creates it, and
/// there is no version of "just started typing" that should reach an agent.
/// Returns the id the file gave it and the epoch second its pause runs out, so
/// the card can count down against the same number that is on disk.
#[tauri::command]
pub async fn comment_start(
    path: String,
    line: usize,
    quote: String,
    text: String,
    prefix: Option<String>,
    suffix: Option<String>,
) -> Result<StartedComment, String> {
    let doc = Path::new(&path);
    let taken: Vec<String> = comments::load(doc)?
        .into_iter()
        .map(|thread| thread.id)
        .collect();
    let id = comments::new_id_avoiding(doc, comments::now_epoch(), &taken);
    let prefix = prefix.unwrap_or_default();
    let suffix = suffix.unwrap_or_default();
    let context = comments::Context {
        prefix: &prefix,
        suffix: &suffix,
    };
    let until = comments::append_thread_paused(
        doc,
        &id,
        line,
        &quote,
        context,
        comments::SELF_AUTHOR,
        &text,
    )?;
    Ok(StartedComment { id, until })
}

/// What [`comment_start`] hands back.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedComment {
    pub id: String,
    /// Epoch seconds at which the pause ends.
    pub until: u64,
}

/// Write what is in a thread's comment box and set the status the edit implies.
///
/// The previous version of this wrote the text and then set `open`
/// unconditionally — the wake-up-per-keystroke this feature removes. The
/// status now comes from [`comments::status_after_edit`], so:
///
/// * a thread being written, or already paused, pauses again with a fresh
///   deadline — every keystroke pushes the wake-up further out;
/// * a thread the agent has answered starts a new turn, also paused;
/// * a thread that is already `open` stays open. That is the point of no
///   return, and the reasoning for it is on `status_after_edit`.
///
/// Returns the deadline, or `None` when the thread is past the point of no
/// return and there is nothing to count down.
#[tauri::command]
pub async fn comment_write_reply(
    path: String,
    id: String,
    text: String,
) -> Result<Option<u64>, String> {
    let doc = Path::new(&path);
    // Read before writing: `set_last_reply` does not tell us what the thread
    // was, and what it was is the whole input to the decision.
    let current =
        comments::status_of(doc, &id)?.ok_or_else(|| format!("unknown comment id: {id}"))?;
    comments::set_last_reply(doc, &id, comments::SELF_AUTHOR, &text)?;

    match comments::status_after_edit(current) {
        Status::Paused => {
            let until = comments::now_epoch() + comments::PAUSE_SECS;
            comments::set_status_until(doc, &id, Status::Paused, Some(until))?;
            Ok(Some(until))
        }
        // Nothing to rewrite: the marker already says `open` and carries no
        // deadline. Writing it again would only be another file event for
        // every watcher on the tree.
        _ => Ok(None),
    }
}

/// End a thread's pause now — the countdown fired, or the user pressed
/// "send now", or the window lost focus.
///
/// Not an error when the thread is no longer paused: an agent may have
/// answered it while the countdown ran. See [`comments::commit_pause`].
#[tauri::command]
pub async fn comment_commit(path: String, id: String) -> Result<bool, String> {
    comments::commit_pause(Path::new(&path), &id)
}

/// Commit every pause on one document. Called when that document's window is
/// destroyed.
pub fn commit_document(doc: &Path) {
    if let Err(e) = comments::commit_pauses(doc) {
        eprintln!("failed to commit comment pauses for {}: {e}", doc.display());
    }
}

/// IPC command: commit whatever a document's comment pauses were mid-typing.
/// `switchDocument` calls this for the document it is about to leave, so a
/// countdown started a moment before the switch is handed over instead of
/// ticking down inside a window that no longer shows that document.
#[tauri::command]
pub async fn commit_document_pauses(path: String) -> Result<(), String> {
    commit_document(Path::new(&path));
    Ok(())
}

/// Commit every pause on every document the app still has open.
///
/// This is the answer to "who flips the status if the app is closed five
/// seconds before the timer fires". It runs from both quit paths — and both
/// are needed, because `RunEvent::ExitRequested` does not fire on Cmd+Q or on
/// the AppleEvent quit Homebrew sends; only `RunEvent::Exit` does. Missing one
/// would leave threads paused forever, which is a worse bug than the one the
/// pause fixes.
///
/// Cheap enough for an exit path: a handful of small files, rewritten only
/// when they actually contain a paused thread.
pub fn commit_all_open(app: &tauri::AppHandle) {
    for doc in open_documents(app) {
        commit_document(&doc);
    }
}

/// The document a window is showing, if it has one.
pub fn document_of_window(app: &tauri::AppHandle, label: &str) -> Option<PathBuf> {
    let open_files = app.state::<crate::window::OpenFiles>();
    let reg = open_files.0.lock().ok()?;
    reg.paths_of(label).into_iter().next().map(PathBuf::from)
}

/// Every document currently open in a window.
fn open_documents(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let open_files = app.state::<crate::window::OpenFiles>();
    let Ok(reg) = open_files.0.lock() else {
        return Vec::new();
    };
    reg.paths().into_iter().map(PathBuf::from).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::comments::{append_thread_paused, load, sidecar_path, Context, SELF_AUTHOR};

    fn temp_doc(name: &str) -> PathBuf {
        // The counter is not decoration: tests run in parallel, and a directory
        // named after the second would be shared — and wiped — by whichever
        // test starts next.
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "mdmini-pause-test-{}-{}-{}",
            std::process::id(),
            comments::now_epoch(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    /// The exact call the window-close handler makes. Worth its own test
    /// because the handler itself cannot be run without a window: if this
    /// stops committing, a comment typed seconds before a close is one no
    /// agent is ever told about.
    #[test]
    fn closing_a_window_hands_over_what_was_being_typed_in_it() {
        let doc = temp_doc("spec.md");
        append_thread_paused(
            &doc,
            "c-aaaaaa",
            1,
            "цитата",
            Context::default(),
            SELF_AUTHOR,
            "Почему не ng",
        )
        .unwrap();

        commit_document(&doc);

        let threads = load(&doc).unwrap();
        assert_eq!(threads[0].status, Status::Open);
        assert_eq!(threads[0].until, None);
        assert_eq!(
            threads[0].replies[0].text, "Почему не ng",
            "half a sentence is still handed over — better early than never"
        );
    }

    #[test]
    fn closing_a_window_whose_document_has_no_comments_is_silent() {
        let doc = temp_doc("spec.md");
        commit_document(&doc);
        assert!(!sidecar_path(&doc).unwrap().exists(), "no file conjured up");
    }
}
