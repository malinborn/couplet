//! `mdmini watch` — a stream of events about new comments, meant to be handed
//! to a Claude Code Monitor: every line of stdout wakes the agent's live
//! session.
//!
//! Deliberately never touches the command socket. The source of truth is the
//! `.mdmini_comments_*.md` files, so delivery keeps working with the app
//! closed, and the scope is a directory tree — which happens to coincide with
//! the agent's cwd, so no scope logic of its own is needed.
//!
//! Flood control here is not an optimisation but a condition of working at
//! all: the harness stops a monitor that emits too much, and the agent is not
//! told. Hence exactly one line per thread becoming `open`.

use std::collections::HashSet;
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};

use crate::comments::Located;

/// Threads already reported. Lives in the monitor process's memory.
#[derive(Default)]
pub struct Seen {
    emitted: HashSet<String>,
}

impl Seen {
    /// Pick out the threads not yet reported. A thread that leaves the set
    /// (answered or closed) is forgotten, so one returning to `open` is an
    /// event again: the human added a follow-up and is waiting.
    pub fn newly_open<'a>(&mut self, open: &'a [Located]) -> Vec<&'a Located> {
        let current: HashSet<String> = open.iter().map(|l| l.thread.id.clone()).collect();
        self.emitted.retain(|id| current.contains(id));

        let mut fresh = Vec::new();
        for located in open {
            if self.emitted.insert(located.thread.id.clone()) {
                fresh.push(located);
            }
        }
        fresh
    }
}

/// One event line. Everything on a single line: the harness batches output
/// within 200ms, so a multi-line event would blend into its neighbour.
pub fn event_line(located: &Located) -> String {
    let question = located
        .thread
        .replies
        .last()
        .map(|r| r.text.replace('\n', " ⏎ "))
        .unwrap_or_default();
    format!(
        "[mdmini] {} {} · «{}» · {}",
        located.doc.display(),
        located.thread.id,
        located.thread.quote.replace('\n', " "),
        question
    )
}

/// Start watching. Returns the process exit code.
pub fn run(root: &Path) -> i32 {
    let (tx, rx) = mpsc::channel();
    let mut watcher = match notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    }) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("failed to start watcher: {e}");
            return 2;
        }
    };
    if let Err(e) = watcher.watch(root, RecursiveMode::Recursive) {
        eprintln!("failed to watch {}: {e}", root.display());
        return 2;
    }

    let mut seen = Seen::default();
    // First pass: threads already sitting open are events too. An agent that
    // arms the monitor mid-task has to learn about what accumulated before.
    emit(&mut seen, root);

    loop {
        match rx.recv_timeout(Duration::from_secs(60)) {
            Ok(Ok(event)) => {
                // The atomic write in comments.rs is a write to a temp followed
                // by a `rename` onto the final name. An event on the temp path
                // carries no finished content and arrives before the rename,
                // while the event for the final path arrives after it — so
                // filtering on the final path via `is_sidecar` is what makes
                // this correct. No temp path passes that check: its name is not
                // of the `.mdmini_comments_*` shape.
                //
                // That last sentence only became true in #54. The old temp name
                // was `path.with_extension("tmp")`, i.e.
                // `.mdmini_comments_spec.tmp` — which still starts with
                // `.mdmini_comments_`, so `is_sidecar` said yes and this filter
                // let a half-written file through. `atomic_write::temp_path_for`
                // now prepends a further dot, and
                // `the_sidecar_temp_is_not_itself_mistaken_for_a_sidecar` holds
                // it there.
                let touched_sidecar = event.paths.iter().any(|p| crate::comments::is_sidecar(p));
                if touched_sidecar {
                    // Small delay: on some filesystems a rename is split into
                    // separate events, and without a pause the file can be
                    // read in the gap between them.
                    std::thread::sleep(Duration::from_millis(50));
                    emit(&mut seen, root);
                }
            }
            Ok(Err(e)) => eprintln!("watch error: {e}"),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Periodic resync: fsevents can drop events during bulk
                // operations such as a branch switch or a git checkout.
                emit(&mut seen, root);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return 0,
        }
    }
}

fn emit(seen: &mut Seen, root: &Path) {
    let open = crate::comments::collect_open(root);
    for located in seen.newly_open(&open) {
        println!("{}", event_line(located));
    }
    use std::io::Write;
    let _ = std::io::stdout().flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn located(id: &str) -> crate::comments::Located {
        crate::comments::Located {
            doc: PathBuf::from("/repo/spec.md"),
            thread: crate::comments::Thread {
                id: id.to_string(),
                status: crate::comments::Status::Open,
                line: 1,
                quote: "цитата".to_string(),
                prefix: None,
                suffix: None,
                until: None,
                replies: vec![crate::comments::Reply {
                    author: "Макс".to_string(),
                    at: "2026-08-24 14:02".to_string(),
                    text: "Вопрос?".to_string(),
                }],
            },
        }
    }

    #[test]
    fn first_sighting_emits_and_second_is_silent() {
        let mut seen = Seen::default();
        assert_eq!(seen.newly_open(&[located("c-aaaaaa")]).len(), 1);
        assert!(seen.newly_open(&[located("c-aaaaaa")]).is_empty());
    }

    #[test]
    fn a_thread_that_leaves_and_returns_to_open_emits_again() {
        let mut seen = Seen::default();
        assert_eq!(seen.newly_open(&[located("c-aaaaaa")]).len(), 1);
        // The agent answered — the thread is no longer in the open set.
        assert!(seen.newly_open(&[]).is_empty());
        // The human added a follow-up — open again, so a new event.
        assert_eq!(seen.newly_open(&[located("c-aaaaaa")]).len(), 1);
    }

    #[test]
    fn event_line_carries_file_id_quote_and_question() {
        let line = event_line(&located("c-aaaaaa"));
        assert!(line.contains("spec.md"));
        assert!(line.contains("c-aaaaaa"));
        assert!(line.contains("цитата"));
        assert!(line.contains("Вопрос?"));
        assert!(!line.contains('\n'), "exactly one line: {line}");
    }

    /// End to end over real files: what the monitor actually prints while a
    /// human is typing a comment, and what it prints once they stop.
    ///
    /// The unit tests on `Seen` work on a hand-built list, so they cannot see
    /// the filter that matters here — it lives in `collect_open`, which is the
    /// only thing standing between a half-typed sentence and an agent's
    /// session.
    #[test]
    fn a_comment_being_typed_never_reaches_the_stream_until_its_pause_ends() {
        use crate::comments::{self, Context, Status, SELF_AUTHOR};

        let dir = std::env::temp_dir().join(format!(
            "mdmini-watch-pause-{}-{}",
            std::process::id(),
            comments::now_epoch()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let doc = dir.join("spec.md");

        comments::append_thread_paused(
            &doc,
            "c-aaaaaa",
            1,
            "цитата",
            Context::default(),
            SELF_AUTHOR,
            "Почему не ng",
        )
        .unwrap();

        let mut seen = Seen::default();
        assert!(
            seen.newly_open(&comments::collect_open(&dir)).is_empty(),
            "mid-sentence, so nobody is woken"
        );

        // Still typing: the deadline moves, the silence holds.
        comments::set_status_until(
            &doc,
            "c-aaaaaa",
            Status::Paused,
            Some(comments::now_epoch() + comments::PAUSE_SECS),
        )
        .unwrap();
        assert!(seen.newly_open(&comments::collect_open(&dir)).is_empty());

        // The pause ran out — the app committed it.
        assert!(comments::commit_pause(&doc, "c-aaaaaa").unwrap());
        let open = comments::collect_open(&dir);
        let fresh = seen.newly_open(&open);
        assert_eq!(fresh.len(), 1);
        assert!(event_line(fresh[0]).contains("Почему не ng"));

        // And exactly once: a resync must not repeat it.
        assert!(seen.newly_open(&comments::collect_open(&dir)).is_empty());

        // A follow-up pauses the thread again. Leaving the open set is what
        // makes `Seen` forget it, so the next commit is an event again — the
        // human is waiting once more.
        comments::set_status_until(
            &doc,
            "c-aaaaaa",
            Status::Paused,
            Some(comments::now_epoch() + comments::PAUSE_SECS),
        )
        .unwrap();
        assert!(seen.newly_open(&comments::collect_open(&dir)).is_empty());
        comments::commit_pause(&doc, "c-aaaaaa").unwrap();
        assert_eq!(seen.newly_open(&comments::collect_open(&dir)).len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn multiline_text_is_flattened_into_one_line() {
        let mut l = located("c-aaaaaa");
        l.thread.replies[0].text = "первая\nвторая".to_string();
        let line = event_line(&l);
        assert!(!line.contains('\n'));
        assert!(line.contains("первая"));
        assert!(line.contains("вторая"));
    }
}
