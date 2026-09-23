# Tabs 01 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the document-replace bugs that exist today in the one-document-per-window app (undo leak, lost autosave, no dedup, untitled collisions, last-writer-wins Recent Files) so the codebase is correct on its own *and* ready for the tabs work in plans 02–05.

**Architecture:** A single `switchDocument(path)` in `App.svelte` becomes the only path that replaces the document a window shows, built on a new `loadDocument` primitive in `Editor.svelte` (full-document swap that also resets CodeMirror's undo history via a `historyCompartment`) and a small autosave scheduler that can be flushed synchronously before that swap happens. Two pieces of app-wide state — Recent Files and a new Recently-Closed stack — move from frontend `localStorage` (last-writer-wins across windows) into Rust-owned JSON files under `paths::app_data_dir()`, broadcast to every window via existing Tauri events. Untitled buffers are named by a process-unique id instead of the window label, closing the `untitled-main.md` collision across launches.

**Tech Stack:** Tauri 2 (Rust), Svelte 5 runes, CodeMirror 6, vitest, cargo test

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/editor/document-load.ts` (new) | Pure CM6 helper: swap a document's full content and reset its undo/redo stack to empty via `historyCompartment`. |
| `src/lib/editor/document-load.test.ts` (new) | Reproduces today's undo leak against stock CM6, then proves the fix. |
| `src/lib/editor/setup.ts` (modify) | Exports `historyCompartment`; `history()` moves into it. |
| `src/lib/editor/Editor.svelte` (modify) | `EditorHandle.replaceContent` renamed to `loadDocument`, implemented via `document-load.ts`. |
| `src/lib/autosave.ts` (new) | Pure debounced-save scheduler (`schedule`/`flush`/`cancel`), independent of Svelte runes so it is directly unit-testable. |
| `src/lib/autosave.test.ts` (new) | Fake-timer tests for debounce and flush. |
| `src/lib/switch-document.ts` (new) | Pure decision function `decideSwitchAction` — what `switchDocument` should do (switch in place / focus another window / open a new window / refuse / no-op). |
| `src/lib/switch-document.test.ts` (new) | Table of every decision branch. |
| `src/lib/toasts.svelte.ts` (modify) | Adds `hasKind(kind)` query, used to detect a standing `save-error`. |
| `src/lib/toasts.svelte.test.ts` (modify) | Covers `hasKind`. |
| `src/lib/editor/ai-ask.ts` (modify) | Adds `clearAiAsks` `StateEffect`, mirroring `clearAiHighlights`. |
| `src/lib/editor/hover-menu.ts` (modify) | Exports `hideHoverMenu()` so a document switch can close the gutter "+" popup (module singleton holding the old view). |
| `src/lib/stores.svelte.ts` (modify) | `createRecentFilesStore` becomes Rust-backed (`recent_files_add`/`recent_files_import` IPC + `recent-changed` event), same public shape (`list`, `add`) plus `setList`/`init`. |
| `src/lib/stores.svelte.test.ts` (modify) | Covers dedup/cap/`setList` without touching Tauri IPC. |
| `src/lib/tauri/events.ts` (modify) | Adds `onRecentChanged`. |
| `src/App.svelte` (modify) | Replaces `handleOpen`/`handleOpenFilePath` with `switchDocument`/`loadDocumentInPlace`; wires the autosave scheduler; wires `onRecentChanged`; wires `recentFiles.init()`. |
| `src-tauri/src/window.rs` (modify) | Adds `label_to_focus` (pure) + `focus_if_open` IPC command. |
| `src-tauri/src/comment_pause.rs` (modify) | Adds `commit_document_pauses` IPC command wrapping the existing `commit_document`. |
| `src-tauri/src/ai_socket.rs` (modify) | `AiPending` tracks each pending id's path; adds `cancel_for_window_and_path` + `cancel_ai_ask` IPC command. |
| `src-tauri/src/session.rs` (modify) | `WindowSnapshot` gains `tab_id`; untitled sidecars are named from it instead of the window label; adds `SessionState::tab_id_for`/`seed`/`snapshot_for`. |
| `src-tauri/src/window.rs` (modify, 2nd pass) | `open_restored_window` seeds `SessionState` with the restored `tab_id` for continuity. |
| `src-tauri/src/recent.rs` (new) | Recent-files list, JSON in `paths::app_data_dir()`, replacing frontend `localStorage`. |
| `src-tauri/src/closed.rs` (new) | Recently-closed stack (cap 20, dedup by path) + reopen. |
| `src-tauri/src/menu.rs` (modify) | Captures a live handle to the "Reopen…" menu item (`SessionMenuItems`) so it can be re-enabled once a closed entry exists. |
| `src-tauri/src/lib.rs` (modify) | Registers new commands/state; `WindowEvent::Destroyed` pushes onto `ClosedStack` before removing the session entry; `reopen_session` menu handler tries the closed stack first. |

---

### Task 1: Undo history reset on document load

**Files:**
- Create: `src/lib/editor/document-load.ts`
- Create: `src/lib/editor/document-load.test.ts`
- Modify: `src/lib/editor/setup.ts:29-31` (compartment exports), `src/lib/editor/setup.ts:69` (`history(),` line)
- Modify: `src/lib/editor/Editor.svelte:5` (import), `:19-34` (`EditorHandle` interface), `:60-71` (`replaceContent` implementation)
- Modify: `src/App.svelte:263` (`handleOpen`), `:289,291` (`handleOpenFilePath`), `:1323` (`onMount` restored untitled)

- [ ] **Step 1: Write a test that reproduces today's bug against stock CodeMirror**

`src/lib/editor/document-load.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo, undoDepth } from '@codemirror/commands';

describe('the undo leak this file fixes', () => {
  it('a full-document replace with addToHistory(false) does not clear the existing undo stack', () => {
    const view = new EditorView({
      state: EditorState.create({ doc: 'A', extensions: [history()] }),
    });

    // A normal, recorded edit in document A.
    view.dispatch({ changes: { from: 1, to: 1, insert: '1' } });
    expect(view.state.doc.toString()).toBe('A1');
    expect(undoDepth(view.state)).toBeGreaterThan(0);

    // Today's `replaceContent`: full-doc swap, `addToHistory(false)` on the
    // swap itself — but the history extension stays mounted, and nothing
    // clears what it already recorded for document A.
    const docLen = view.state.doc.length;
    view.dispatch({
      changes: { from: 0, to: docLen, insert: 'B' },
      annotations: Transaction.addToHistory.of(false),
    });
    expect(view.state.doc.toString()).toBe('B');
    expect(undoDepth(view.state)).toBeGreaterThan(0); // the leak: still non-zero

    // Cmd+Z reaches back into document A's recorded edit instead of doing
    // nothing, because the history stack was never reset.
    undo(view);
    expect(view.state.doc.toString()).not.toBe('B');
  });
});
```

- [ ] **Step 2: Run it to confirm today's mechanism really does leak**

Run: `npx vitest run src/lib/editor/document-load.test.ts`
Expected: PASS — this test documents the bug against plain CodeMirror, independent of any app code, so it passes immediately. It is the "reproduce the leak first" checkpoint, not a red/green step.

- [ ] **Step 3: Write the failing test for the fix**

Append to `src/lib/editor/document-load.test.ts`:

```ts
import { Compartment } from '@codemirror/state';
import { loadDocumentContent } from './document-load';

describe('loadDocumentContent', () => {
  function makeView(doc: string, historyCompartment: Compartment): EditorView {
    return new EditorView({
      state: EditorState.create({ doc, extensions: [historyCompartment.of(history())] }),
    });
  }

  it('resets undo depth to zero after loading a new document', () => {
    const historyCompartment = new Compartment();
    const view = makeView('A', historyCompartment);
    view.dispatch({ changes: { from: 1, to: 1, insert: '1' } }); // doc A1, undo depth 1

    loadDocumentContent(view, historyCompartment, 'B');

    expect(view.state.doc.toString()).toBe('B');
    expect(undoDepth(view.state)).toBe(0);
  });

  it('undo after loading a new document is a no-op — it never reaches the previous document', () => {
    const historyCompartment = new Compartment();
    const view = makeView('A', historyCompartment);
    view.dispatch({ changes: { from: 1, to: 1, insert: '1' } });

    loadDocumentContent(view, historyCompartment, 'B');
    const ranUndo = undo(view);

    expect(ranUndo).toBe(false);
    expect(view.state.doc.toString()).toBe('B');
  });

  it('places the cursor at the end of the new content, matching the old replaceContent', () => {
    const historyCompartment = new Compartment();
    const view = makeView('A', historyCompartment);

    loadDocumentContent(view, historyCompartment, 'hello');

    expect(view.state.selection.main.head).toBe(5);
  });

  it('an empty document leaves the selection alone rather than forcing anchor 0', () => {
    const historyCompartment = new Compartment();
    const view = makeView('A', historyCompartment);

    loadDocumentContent(view, historyCompartment, '');

    expect(view.state.doc.toString()).toBe('');
  });
});
```

- [ ] **Step 4: Run it to see it fail**

Run: `npx vitest run src/lib/editor/document-load.test.ts`
Expected: FAIL — `Error: Failed to resolve import "./document-load"` (module does not exist yet).

- [ ] **Step 5: Implement `loadDocumentContent`**

`src/lib/editor/document-load.ts`:

```ts
import type { Compartment } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { history } from '@codemirror/commands';

/**
 * Swaps the whole document and resets undo/redo to empty — the loaded
 * document must start at `undoDepth === 0`, with no way to Cmd+Z back into
 * whatever this window was showing before (#see docs/investigations/2026-09-23-tabs-options.md §1).
 *
 * `history()` returns the same module-level `historyField` CodeMirror keeps
 * internally, so reconfiguring a compartment straight from `history()` to
 * `history()` again (skipping the intermediate `[]`) would NOT reset it — the
 * field's accumulated value survives a same-identity reconfigure, because
 * CodeMirror only re-runs a field's `create()` when the field is genuinely
 * absent from the immediately preceding config. Removing the field first is
 * what makes the final reconfigure below build a fresh one, at undo depth 0.
 *
 * Three separate dispatches, in this order: turn history off, swap the
 * document, turn history back on. The middle dispatch needs no
 * `addToHistory` annotation — there is no history field mounted to record it.
 */
export function loadDocumentContent(
  view: EditorView,
  historyCompartment: Compartment,
  newContent: string
): void {
  view.dispatch({ effects: historyCompartment.reconfigure([]) });

  const docLen = view.state.doc.length;
  view.dispatch({
    changes: { from: 0, to: docLen, insert: newContent },
    selection: newContent.length > 0 ? { anchor: newContent.length } : undefined,
  });

  view.dispatch({ effects: historyCompartment.reconfigure(history()) });
}
```

- [ ] **Step 6: Run it to see it pass**

Run: `npx vitest run src/lib/editor/document-load.test.ts`
Expected: PASS (5 tests: the repro + the 4 `loadDocumentContent` cases).

- [ ] **Step 7: Wire `historyCompartment` into `setup.ts`**

In `src/lib/editor/setup.ts`, change:

```ts
export const previewCompartment = new Compartment();
export const languageCompartment = new Compartment();
export const lineGlowCompartment = new Compartment();
```

to:

```ts
export const previewCompartment = new Compartment();
export const languageCompartment = new Compartment();
export const lineGlowCompartment = new Compartment();
export const historyCompartment = new Compartment();
```

and change the `createExtensions()` line:

```ts
    history(),
```

to:

```ts
    historyCompartment.of(history()),
```

- [ ] **Step 8: Run the frontend test suite to confirm nothing else depended on the old wiring**

Run: `npx vitest run --dir src`
Expected: PASS, same count as before this task plus the 5 new tests.

- [ ] **Step 9: Rename `replaceContent` to `loadDocument` on `EditorHandle`**

In `src/lib/editor/Editor.svelte`, change the import:

```ts
  import { createExtensions, languageCompartment, previewCompartment } from './setup';
```

to:

```ts
  import { createExtensions, languageCompartment, previewCompartment, historyCompartment } from './setup';
  import { loadDocumentContent } from './document-load';
```

Change the interface member:

```ts
    replaceContent: (newContent: string) => void;
```

to:

```ts
    loadDocument: (newContent: string) => void;
```

Change the implementation:

```ts
      replaceContent(newContent: string) {
        if (!view) return;
        const docLen = view.state.doc.length;
        view.dispatch({
          changes: { from: 0, to: docLen, insert: newContent },
          selection: newContent.length > 0 ? { anchor: newContent.length } : undefined,
          annotations: Transaction.addToHistory.of(false),
        });
        if (newContent.length > 0) {
          view.contentDOM.blur();
        }
      },
```

to:

```ts
      loadDocument(newContent: string) {
        if (!view) return;
        loadDocumentContent(view, historyCompartment, newContent);
        if (newContent.length > 0) {
          view.contentDOM.blur();
        }
      },
```

- [ ] **Step 10: Update the four call sites in `App.svelte`**

In `src/App.svelte`, three occurrences change verbatim from `editorHandle?.replaceContent(` to `editorHandle?.loadDocument(`:

- Line 263 (`handleOpen`): `editorHandle?.replaceContent(content);` → `editorHandle?.loadDocument(content);`
- Line 289 (`handleOpenFilePath`, file exists): `editorHandle?.replaceContent(content);` → `editorHandle?.loadDocument(content);`
- Line 291 (`handleOpenFilePath`, file missing): `editorHandle?.replaceContent('');` → `editorHandle?.loadDocument('');`
- Line 1323 (`onMount`, restored untitled buffer): `editorHandle?.replaceContent(pending.content);` → `editorHandle?.loadDocument(pending.content);`

- [ ] **Step 11: Type-check and run the full suite**

Run: `npm run check`
Expected: no errors (the `Transaction` import in `Editor.svelte` is still used by `updateContent`, so it stays).

Run: `npx vitest run --dir src`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add src/lib/editor/document-load.ts src/lib/editor/document-load.test.ts src/lib/editor/setup.ts src/lib/editor/Editor.svelte src/App.svelte
git commit -m "$(cat <<'EOF'
fix(editor): reset undo history when a window loads a different document

Cmd+O / Recent Files replaced the document but left the old undo stack
mounted, so Cmd+Z afterwards could splice the previous document's text back
in and autosave would write it to the new file. `loadDocument` now drops and
rebuilds the history compartment around the swap, so undo depth is always 0
right after a load.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Flush pending autosave before switching documents

**Files:**
- Create: `src/lib/autosave.ts`
- Create: `src/lib/autosave.test.ts`
- Modify: `src/App.svelte:176-198` (`autoSaveTimer` state + `handleChange`/`scheduleAutoSave`)

- [ ] **Step 1: Write the failing test**

`src/lib/autosave.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAutoSaveScheduler } from './autosave';

describe('createAutoSaveScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces: multiple schedule() calls within the delay produce one save', () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const scheduler = createAutoSaveScheduler({ delayMs: 300, shouldSave: () => true, save });

    scheduler.schedule();
    vi.advanceTimersByTime(100);
    scheduler.schedule();
    vi.advanceTimersByTime(100);
    scheduler.schedule();
    vi.advanceTimersByTime(300);

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('does not save when the timer fires but shouldSave() is now false', () => {
    const save = vi.fn().mockResolvedValue(undefined);
    let dirty = true;
    const scheduler = createAutoSaveScheduler({ delayMs: 300, shouldSave: () => dirty, save });

    scheduler.schedule();
    dirty = false;
    vi.advanceTimersByTime(300);

    expect(save).not.toHaveBeenCalled();
  });

  it('flush() cancels the pending timer and saves immediately when dirty', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const scheduler = createAutoSaveScheduler({ delayMs: 300, shouldSave: () => true, save });

    scheduler.schedule();
    await scheduler.flush();
    vi.advanceTimersByTime(300);

    expect(save).toHaveBeenCalledTimes(1); // not called again when the (now cancelled) timer would have fired
  });

  it('flush() is a no-op when nothing is dirty', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const scheduler = createAutoSaveScheduler({ delayMs: 300, shouldSave: () => false, save });

    await scheduler.flush();

    expect(save).not.toHaveBeenCalled();
  });

  it('cancel() drops a pending timer without saving', () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const scheduler = createAutoSaveScheduler({ delayMs: 300, shouldSave: () => true, save });

    scheduler.schedule();
    scheduler.cancel();
    vi.advanceTimersByTime(300);

    expect(save).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/autosave.test.ts`
Expected: FAIL — `Failed to resolve import "./autosave"`.

- [ ] **Step 3: Implement the scheduler**

`src/lib/autosave.ts`:

```ts
/**
 * Debounced autosave, extracted so `switchDocument` can `flush()` it
 * synchronously before replacing the document — otherwise the last ≤300ms of
 * typing before a Cmd+O / Recent Files switch is silently dropped (the
 * pending `setTimeout` was still holding it, unfired, when the document
 * underneath it changed). See docs/investigations/2026-09-23-tabs-options.md §1.
 */
export interface AutoSaveScheduler {
  /** Debounce: (re)start the delay. Call on every document change. */
  schedule(): void;
  /** Cancel any pending timer and save now, if there is something to save. */
  flush(): Promise<void>;
  /** Cancel any pending timer without saving. */
  cancel(): void;
}

export interface AutoSaveSchedulerOptions {
  delayMs: number;
  /** Whether a save is actually warranted right now (dirty + has a path). */
  shouldSave: () => boolean;
  save: () => Promise<void>;
}

export function createAutoSaveScheduler(opts: AutoSaveSchedulerOptions): AutoSaveScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancel(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(): void {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      if (opts.shouldSave()) {
        void opts.save();
      }
    }, opts.delayMs);
  }

  async function flush(): Promise<void> {
    cancel();
    if (opts.shouldSave()) {
      await opts.save();
    }
  }

  return { schedule, flush, cancel };
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/lib/autosave.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire it into `App.svelte`**

In `src/App.svelte`, replace:

```ts
  // --- Timers ---
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryInterval: ReturnType<typeof setInterval> | null = null;

  // Track whether we are currently writing to disk (to avoid reacting to our own save)
  let isSaving = false;

  function handleChange(doc: string) {
    fileState.isDirty = true;
    scheduleAutoSave();
  }

  // --- Auto-save (300ms debounce) ---
  function scheduleAutoSave(): void {
    if (autoSaveTimer !== null) {
      clearTimeout(autoSaveTimer);
    }
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null;
      if (fileState.isDirty && fileState.filePath) {
        performSave();
      }
    }, 300);
  }
```

with:

```ts
  // --- Timers ---
  let recoveryInterval: ReturnType<typeof setInterval> | null = null;

  // Track whether we are currently writing to disk (to avoid reacting to our own save)
  let isSaving = false;

  function handleChange(doc: string) {
    fileState.isDirty = true;
    autoSave.schedule();
  }

  // --- Auto-save (300ms debounce). `performSave` is declared below, but
  // `function` declarations are hoisted, so referencing it here is safe. ---
  const autoSave = createAutoSaveScheduler({
    delayMs: 300,
    shouldSave: () => fileState.isDirty && fileState.filePath !== null,
    save: performSave,
  });
```

Add the import near the other `./lib/...` imports:

```ts
  import { createAutoSaveScheduler } from './lib/autosave';
```

- [ ] **Step 6: Type-check and run the full suite**

Run: `npm run check`
Expected: no errors.

Run: `npx vitest run --dir src`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/autosave.ts src/lib/autosave.test.ts src/App.svelte
git commit -m "$(cat <<'EOF'
feat(editor): extract a flushable autosave scheduler

switchDocument (next commit) needs to flush the pending 300ms debounce
before replacing the document, or the last few keystrokes before a
Cmd+O/Recent Files switch are silently lost. Pulling the scheduler out of
App.svelte into a plain, timer-mockable module makes that flush point
directly testable.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: switchDocument — Rust plumbing (dedup, pause commit, ask cancellation)

**Files:**
- Modify: `src-tauri/src/window.rs:1-9` (imports/`OpenFiles`), end of file (new `label_to_focus` + `focus_if_open` + tests)
- Modify: `src-tauri/src/comment_pause.rs:120-131` (near `comment_commit`/`commit_document`)
- Modify: `src-tauri/src/ai_socket.rs:320-387` (`AiPending`), `:580-636` (`dispatch`'s two `register` call sites), `:638-644` (near `ai_respond`), `:1678-1697` (tests)
- Modify: `src-tauri/src/lib.rs:135-168` (`invoke_handler!`)

- [ ] **Step 1: Write the failing test for `label_to_focus`**

Add to the bottom of `src-tauri/src/window.rs` (new file — it currently has no `#[cfg(test)]` module):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_to_focus_finds_another_window_showing_the_path() {
        let mut map = HashMap::new();
        map.insert("/tmp/a.md".to_string(), "editor-2".to_string());
        assert_eq!(
            label_to_focus(&map, "/tmp/a.md", "main"),
            Some("editor-2".to_string())
        );
    }

    #[test]
    fn label_to_focus_excludes_the_calling_window() {
        let mut map = HashMap::new();
        map.insert("/tmp/a.md".to_string(), "main".to_string());
        assert_eq!(label_to_focus(&map, "/tmp/a.md", "main"), None);
    }

    #[test]
    fn label_to_focus_is_none_when_the_path_is_not_open_anywhere() {
        let map = HashMap::new();
        assert_eq!(label_to_focus(&map, "/tmp/a.md", "main"), None);
    }
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd src-tauri && cargo test label_to_focus`
Expected: FAIL — `cannot find function 'label_to_focus' in this scope`.

- [ ] **Step 3: Implement `label_to_focus` and the `focus_if_open` command**

Append to `src-tauri/src/window.rs`, above the `#[cfg(test)]` module added in Step 1:

```rust
/// Which window (if any) should be focused for `path`, excluding
/// `exclude_label` (the window making the request) — split out from
/// `focus_if_open` so the decision is testable without a running window.
pub fn label_to_focus(
    open_files: &HashMap<String, String>,
    path: &str,
    exclude_label: &str,
) -> Option<String> {
    open_files
        .get(path)
        .filter(|label| label.as_str() != exclude_label)
        .cloned()
}

/// IPC command: if `path` is already open in a *different* window, focus it
/// and report `true`. Used by `switchDocument` before it replaces the current
/// window's document, so the same file never ends up open — and
/// autosaving — in two windows at once.
#[tauri::command]
pub async fn focus_if_open(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<bool, String> {
    let label = window.label().to_string();
    let target = {
        let open_files = app.state::<OpenFiles>();
        let map = open_files.0.lock().unwrap();
        label_to_focus(&map, &path, &label)
    };
    match target {
        Some(other) => match app.get_webview_window(&other) {
            Some(win) => {
                let _ = win.set_focus();
                Ok(true)
            }
            None => Ok(false),
        },
        None => Ok(false),
    }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `cd src-tauri && cargo test label_to_focus`
Expected: PASS (3 tests).

- [ ] **Step 5: Add `commit_document_pauses` IPC command**

In `src-tauri/src/comment_pause.rs`, immediately after the existing `commit_document` function (after line 131), add:

```rust
/// IPC command: commit whatever a document's comment pauses were mid-typing.
/// `switchDocument` calls this for the document it is about to leave, so a
/// countdown started a moment before the switch is handed over instead of
/// ticking down inside a window that no longer shows that document.
#[tauri::command]
pub async fn commit_document_pauses(path: String) -> Result<(), String> {
    commit_document(Path::new(&path));
    Ok(())
}
```

(No new test: this is a thin wrapper over `commit_document`, already covered by `closing_a_window_hands_over_what_was_being_typed_in_it` — same convention as `comment_commit`/`comment_start` above it, which also have no command-level tests.)

- [ ] **Step 6: Write the failing tests for `cancel_for_window_and_path`**

In `src-tauri/src/ai_socket.rs`, add after `cancel_for_window_responds_window_closed_to_matching_entries_only` (around line 1697):

```rust
    #[test]
    fn cancel_for_window_and_path_responds_only_the_matching_entry() {
        let pending = AiPending::new();

        let (tx_a, rx_a) = mpsc::channel();
        let id_a = pending.alloc_id();
        pending.register(id_a, "editor-1", tx_a);
        pending.set_path(id_a, "/tmp/a.md");

        let (tx_b, rx_b) = mpsc::channel();
        let id_b = pending.alloc_id();
        pending.register(id_b, "editor-1", tx_b);
        pending.set_path(id_b, "/tmp/b.md");

        pending.cancel_for_window_and_path("editor-1", "/tmp/a.md");

        let received = rx_a.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(!received.ok);
        assert_eq!(received.error.as_deref(), Some("switched away from this document"));
        assert!(
            rx_b.try_recv().is_err(),
            "a different path in the same window must be untouched"
        );
    }

    #[test]
    fn cancel_for_window_and_path_ignores_a_different_window_with_the_same_path() {
        let pending = AiPending::new();
        let (tx, rx) = mpsc::channel();
        let id = pending.alloc_id();
        pending.register(id, "editor-1", tx);
        pending.set_path(id, "/tmp/a.md");

        pending.cancel_for_window_and_path("editor-2", "/tmp/a.md");

        assert!(rx.try_recv().is_err(), "a different window must not be cancelled");
    }
```

- [ ] **Step 7: Run it to see it fail**

Run: `cd src-tauri && cargo test cancel_for_window_and_path`
Expected: FAIL — `no method named 'set_path' found` / `no method named 'cancel_for_window_and_path' found`.

- [ ] **Step 8: Implement path tracking on `AiPending`**

In `src-tauri/src/ai_socket.rs`, change the struct (around line 320):

```rust
pub struct AiPending {
    map: Mutex<HashMap<u64, (String, mpsc::Sender<AiResponse>)>>,
    next: AtomicU64,
}
```

to:

```rust
pub struct AiPending {
    map: Mutex<HashMap<u64, (String, mpsc::Sender<AiResponse>)>>,
    /// Which document each pending id was raised against — kept separately
    /// from `map` rather than folded into its tuple, so every existing
    /// two-argument `register` call site (product code and the whole test
    /// suite below) keeps compiling unchanged. Populated by `set_path`,
    /// called right after `register` at the two spots in `dispatch` that
    /// know the path.
    paths: Mutex<HashMap<u64, String>>,
    next: AtomicU64,
}
```

Change `new()`:

```rust
    pub fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
        }
    }
```

to:

```rust
    pub fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
            paths: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
        }
    }
```

Change `respond`:

```rust
    pub fn respond(&self, id: u64, response: AiResponse) {
        if let Some((_, tx)) = self.map.lock().unwrap().remove(&id) {
            let _ = tx.send(response);
        }
    }
```

to:

```rust
    pub fn respond(&self, id: u64, response: AiResponse) {
        if let Some((_, tx)) = self.map.lock().unwrap().remove(&id) {
            let _ = tx.send(response);
        }
        self.paths.lock().unwrap().remove(&id);
    }
```

Change `cancel`:

```rust
    pub fn cancel(&self, id: u64) {
        self.map.lock().unwrap().remove(&id);
    }
```

to:

```rust
    pub fn cancel(&self, id: u64) {
        self.map.lock().unwrap().remove(&id);
        self.paths.lock().unwrap().remove(&id);
    }
```

Change `cancel_for_window` to also drop the now-stale path entries:

```rust
    pub fn cancel_for_window(&self, label: &str) {
        let mut map = self.map.lock().unwrap();
        let ids: Vec<u64> = map
            .iter()
            .filter(|(_, (l, _))| l == label)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            if let Some((_, tx)) = map.remove(&id) {
                let _ = tx.send(AiResponse::error("window closed"));
            }
        }
    }
```

to:

```rust
    pub fn cancel_for_window(&self, label: &str) {
        let mut map = self.map.lock().unwrap();
        let ids: Vec<u64> = map
            .iter()
            .filter(|(_, (l, _))| l == label)
            .map(|(id, _)| *id)
            .collect();
        let mut paths = self.paths.lock().unwrap();
        for id in &ids {
            paths.remove(id);
        }
        for id in ids {
            if let Some((_, tx)) = map.remove(&id) {
                let _ = tx.send(AiResponse::error("window closed"));
            }
        }
    }
```

Add two new methods, right after `cancel_for_window`:

```rust
    /// Record which document a pending id belongs to — called right after
    /// `register`, only at the two call sites in `dispatch` that know the
    /// path.
    pub fn set_path(&self, id: u64, path: impl Into<String>) {
        self.paths.lock().unwrap().insert(id, path.into());
    }

    /// Fail every entry registered under `label` for `path` with "switched
    /// away from this document" — called by `switchDocument`'s
    /// `cancel_ai_ask` before the document currently on screen is replaced,
    /// so an agent's `ask` mid-question doesn't silently vanish into a
    /// document that no longer shows it (it used to hang until the
    /// request's own timeout — up to an hour for `ask`).
    pub fn cancel_for_window_and_path(&self, label: &str, path: &str) {
        let mut map = self.map.lock().unwrap();
        let mut paths = self.paths.lock().unwrap();
        let ids: Vec<u64> = map
            .iter()
            .filter(|(id, (l, _))| l == label && paths.get(*id).map(String::as_str) == Some(path))
            .map(|(id, _)| *id)
            .collect();
        for id in &ids {
            paths.remove(id);
        }
        for id in ids {
            if let Some((_, tx)) = map.remove(&id) {
                let _ = tx.send(AiResponse::error("switched away from this document"));
            }
        }
    }
```

- [ ] **Step 9: Call `set_path` at both `register` sites in `dispatch`**

In `src-tauri/src/ai_socket.rs`, around line 588:

```rust
        if let Some(win) = app.get_webview_window(&label) {
            app.state::<AiPending>().register(id, label.clone(), tx);
```

becomes:

```rust
        if let Some(win) = app.get_webview_window(&label) {
            app.state::<AiPending>().register(id, label.clone(), tx);
            app.state::<AiPending>().set_path(id, path.clone());
```

And around line 626:

```rust
        if let Some(label) = label {
            app.state::<AiPending>().register(id, label.clone(), tx);
            app.state::<AiQueue>().push(&label, payload);
```

becomes:

```rust
        if let Some(label) = label {
            app.state::<AiPending>().register(id, label.clone(), tx);
            app.state::<AiPending>().set_path(id, path.clone());
            app.state::<AiQueue>().push(&label, payload);
```

- [ ] **Step 10: Add the `cancel_ai_ask` IPC command**

In `src-tauri/src/ai_socket.rs`, immediately after `ai_respond` (after line 644), add:

```rust
/// IPC command: cancel any `ask`/`edit` still waiting on a response for
/// `path` in the calling window — called by `switchDocument` before it
/// replaces that window's document.
#[tauri::command]
pub async fn cancel_ai_ask(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<(), String> {
    app.state::<AiPending>()
        .cancel_for_window_and_path(window.label(), &path);
    Ok(())
}
```

- [ ] **Step 11: Run the ai_socket and window tests**

Run: `cd src-tauri && cargo test cancel_for_window_and_path label_to_focus`
Expected: PASS (5 tests total).

Run: `cd src-tauri && cargo test`
Expected: PASS, full suite (nothing else touches `AiPending`'s tuple shape).

- [ ] **Step 12: Register the three new commands**

In `src-tauri/src/lib.rs`, change:

```rust
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::file_exists,
            commands::get_pending_file,
            commands::comment_threads,
            commands::comment_reply,
            commands::comment_resolve,
            comment_pause::comment_start,
            comment_pause::comment_write_reply,
            comment_pause::comment_commit,
            window::open_file_window_cmd,
            window::register_open_file,
```

to:

```rust
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::file_exists,
            commands::get_pending_file,
            commands::comment_threads,
            commands::comment_reply,
            commands::comment_resolve,
            comment_pause::comment_start,
            comment_pause::comment_write_reply,
            comment_pause::comment_commit,
            comment_pause::commit_document_pauses,
            window::open_file_window_cmd,
            window::register_open_file,
            window::focus_if_open,
            ai_socket::cancel_ai_ask,
```

(`ai_socket::ai_respond` and `ai_socket::ai_pull_pending` already appear further down the same list — `cancel_ai_ask` sits next to `register_open_file` here only for locality with the other new commands in this task; exact position among the 18 entries doesn't matter to `generate_handler!`.)

- [ ] **Step 13: Build and run the full Rust suite**

Run: `cd src-tauri && cargo test`
Expected: PASS.

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml`
Expected: no warnings.

- [ ] **Step 14: Commit**

```bash
git add src-tauri/src/window.rs src-tauri/src/comment_pause.rs src-tauri/src/ai_socket.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(rust): dedup, comment-pause handover, and ask cancellation for switchDocument

Three primitives the frontend's switchDocument (next commit) needs before it
can safely replace a window's document: focus_if_open (so the same file is
never open in two autosaving windows at once), commit_document_pauses (hand
over an in-progress comment reply instead of leaving it paused in a window
that no longer shows that document), and cancel_ai_ask (fail a pending
mdmini ask/edit for the document being left, instead of hanging it for up
to an hour).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: switchDocument — frontend orchestration

**Files:**
- Create: `src/lib/switch-document.ts`
- Create: `src/lib/switch-document.test.ts`
- Modify: `src/lib/toasts.svelte.ts:156-163` (add `hasKind`)
- Modify: `src/lib/toasts.svelte.test.ts` (cover `hasKind`)
- Modify: `src/lib/editor/ai-ask.ts:38-41` (add `clearAiAsks`), `:213-234` (`aiAskField.update`)
- Modify: `src/lib/editor/hover-menu.ts:8-17` (export `hideHoverMenu`)
- Modify: `src/App.svelte:52` (import), `:249-336` (`handleOpen`/`handleOpenFilePath` → `switchDocument`/`loadDocumentInPlace`), `:1320`, `:1459`, `:1487`, `:1769` (call sites)

- [ ] **Step 1: Write the failing test for the pure decision function**

`src/lib/switch-document.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decideSwitchAction } from './switch-document';

const base = {
  targetPath: '/docs/b.md',
  currentPath: '/docs/a.md',
  currentIsDirty: false,
  saveErrorPending: false,
  alreadyOpenElsewhere: false,
};

describe('decideSwitchAction', () => {
  it('is a no-op when the target is already showing', () => {
    expect(decideSwitchAction({ ...base, targetPath: '/docs/a.md' })).toEqual({
      kind: 'noop-already-showing',
    });
  });

  it('refuses when the last save failed', () => {
    expect(decideSwitchAction({ ...base, saveErrorPending: true })).toEqual({
      kind: 'refuse-save-error',
    });
  });

  it('the save-error refusal wins over already-open-elsewhere', () => {
    expect(
      decideSwitchAction({ ...base, saveErrorPending: true, alreadyOpenElsewhere: true })
    ).toEqual({ kind: 'refuse-save-error' });
  });

  it('focuses the other window when the file is already open there', () => {
    expect(decideSwitchAction({ ...base, alreadyOpenElsewhere: true })).toEqual({
      kind: 'focus-other-window',
    });
  });

  it('opens a new window rather than discarding a dirty untitled buffer', () => {
    expect(
      decideSwitchAction({ ...base, currentPath: null, currentIsDirty: true })
    ).toEqual({ kind: 'open-new-window' });
  });

  it('switches in place when leaving an empty (non-dirty) untitled buffer', () => {
    expect(
      decideSwitchAction({ ...base, currentPath: null, currentIsDirty: false })
    ).toEqual({ kind: 'switch-in-place' });
  });

  it('switches in place in the ordinary case', () => {
    expect(decideSwitchAction(base)).toEqual({ kind: 'switch-in-place' });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/switch-document.test.ts`
Expected: FAIL — `Failed to resolve import "./switch-document"`.

- [ ] **Step 3: Implement `decideSwitchAction`**

`src/lib/switch-document.ts`:

```ts
export type SwitchAction =
  | { kind: 'noop-already-showing' }
  | { kind: 'refuse-save-error' }
  | { kind: 'focus-other-window' }
  | { kind: 'open-new-window' }
  | { kind: 'switch-in-place' };

export interface SwitchDecisionInput {
  /** The file `switchDocument` was asked to open. */
  targetPath: string;
  /** What this window currently shows, or `null` for an Untitled buffer. */
  currentPath: string | null;
  /** Whether the current buffer has unsaved changes. */
  currentIsDirty: boolean;
  /** A save of the current document is known to have failed and has not
   * succeeded since — see `toasts.hasKind('save-error')`. */
  saveErrorPending: boolean;
  /** `focus_if_open` already found (and focused) another window showing
   * `targetPath`. */
  alreadyOpenElsewhere: boolean;
}

/**
 * Decides what `switchDocument` should do, before it touches the editor,
 * Rust, or the filesystem — see `App.svelte`'s `switchDocument` for the
 * imperative steps each outcome triggers.
 *
 * Order matters: a document whose save is known to have failed can never be
 * left — even to re-open the very file it's already showing — and an
 * untitled buffer with unsaved text is never discarded to make room for a
 * different file; the new file gets a window of its own instead.
 */
export function decideSwitchAction(input: SwitchDecisionInput): SwitchAction {
  if (input.targetPath === input.currentPath) {
    return { kind: 'noop-already-showing' };
  }
  if (input.saveErrorPending) {
    return { kind: 'refuse-save-error' };
  }
  if (input.alreadyOpenElsewhere) {
    return { kind: 'focus-other-window' };
  }
  if (input.currentPath === null && input.currentIsDirty) {
    return { kind: 'open-new-window' };
  }
  return { kind: 'switch-in-place' };
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/lib/switch-document.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing test for `toasts.hasKind`**

Add to `src/lib/toasts.svelte.test.ts`, after `DismissKind_RemovesEveryToastOfThatKind`:

```ts
  it('HasKind_TrueWhileThatKindIsStanding', () => {
    const store = createToastStore();
    expect(store.hasKind('save-error')).toBe(false);
    store.push({ kind: 'save-error', fileName: 'a.md', message: 'disk full' });
    expect(store.hasKind('save-error')).toBe(true);
    store.dismissKind('save-error');
    expect(store.hasKind('save-error')).toBe(false);
  });
```

- [ ] **Step 6: Run it to see it fail**

Run: `npx vitest run src/lib/toasts.svelte.test.ts`
Expected: FAIL — `store.hasKind is not a function`.

- [ ] **Step 7: Implement `hasKind`**

In `src/lib/toasts.svelte.ts`, add after `dismissKind`:

```ts
    dismissKind(kind: ToastKind): void {
      entries = entries.filter((e) => e.payload.kind !== kind);
    },

    /** Whether a toast of `kind` is currently standing. */
    hasKind(kind: ToastKind): boolean {
      return entries.some((e) => e.payload.kind === kind);
    },
```

- [ ] **Step 8: Run it to see it pass**

Run: `npx vitest run src/lib/toasts.svelte.test.ts`
Expected: PASS.

- [ ] **Step 9: Add `clearAiAsks` to `ai-ask.ts`**

In `src/lib/editor/ai-ask.ts`, change:

```ts
/** Removes the ask widget with the given id. A no-op if that id isn't present
 * (e.g. the stale-widget cleanup timer racing an already-answered click). */
export const removeAiAsk = StateEffect.define<number>();
```

to:

```ts
/** Removes the ask widget with the given id. A no-op if that id isn't present
 * (e.g. the stale-widget cleanup timer racing an already-answered click). */
export const removeAiAsk = StateEffect.define<number>();

/**
 * Clears every pending ask widget without invoking any `onAnswer` callback.
 * Used by `switchDocument` right before it replaces the document: the CLI
 * connection behind each ask is answered separately, in Rust, by
 * `cancel_ai_ask` — this effect only takes the now-stale widget off the
 * screen so it doesn't survive into whatever document loads next.
 */
export const clearAiAsks = StateEffect.define<null>();
```

And in the `aiAskField` `update` function, change:

```ts
      } else if (effect.is(removeAiAsk)) {
        const id = effect.value;
        deco = deco.update({
          filter: (_from, _to, value) => !(isAskWidget(value.spec.widget) && value.spec.widget.spec.id === id),
        });
      }
```

to:

```ts
      } else if (effect.is(removeAiAsk)) {
        const id = effect.value;
        deco = deco.update({
          filter: (_from, _to, value) => !(isAskWidget(value.spec.widget) && value.spec.widget.spec.id === id),
        });
      } else if (effect.is(clearAiAsks)) {
        deco = Decoration.none;
      }
```

- [ ] **Step 10: Run the ai-ask tests**

Run: `npx vitest run src/lib/editor/ai-ask.test.ts`
Expected: PASS (no existing test exercises `clearAiAsks` yet; this step only guards the file still compiles and its existing behaviour is unchanged).

- [ ] **Step 11: Replace `handleOpen`/`handleOpenFilePath` with `switchDocument`**

In `src/App.svelte`, add the import (next to the other `ai-ask` import around line 53):

```ts
  import { addAiAsk, removeAiAsk, clearAiAsks } from './lib/editor/ai-ask';
```

Add near the top of the `<script>` block, alongside the other `./lib/...` imports:

```ts
  import { decideSwitchAction } from './lib/switch-document';
  import { activeCellEditSession, endCellEditSession } from './lib/editor/cell-edit-session';
  import { hideHoverMenu } from './lib/editor/hover-menu';
```

In `src/lib/editor/hover-menu.ts`, directly below `hidePopup` (line 17), add the export — the popup is a module singleton that still points at the leaving document's view and line position, so a click on it after a switch would insert a block into the new document at the old offset:

```ts
/** Close the gutter "+" popup, if open. Called before the window swaps documents. */
export function hideHoverMenu(): void {
  hidePopup();
  activeView = null;
}
```

Replace the whole block from `async function handleOpen()` through the end of `handleOpenFilePath` (lines 249–336) with:

```ts
  async function handleOpen(): Promise<void> {
    const path = await showOpenDialog();
    if (!path) return;
    await switchDocument(path);
  }

  /**
   * The one path that replaces the document a window shows — Cmd+O, Recent
   * Files, an externally-opened file routed to this window, and a dropped
   * file all go through this. See docs/investigations/2026-09-23-tabs-options.md
   * §1 for the bugs this consolidation fixes (undo leak, lost autosave, no
   * dedup, lost untitled text, orphaned `ask`).
   */
  async function switchDocument(path: string): Promise<void> {
    await autoSave.flush();

    const alreadyOpenElsewhere = await invoke<boolean>('focus_if_open', { path }).catch(
      () => false
    );

    const decision = decideSwitchAction({
      targetPath: path,
      currentPath: fileState.filePath,
      currentIsDirty: fileState.isDirty,
      saveErrorPending: toasts.hasKind('save-error'),
      alreadyOpenElsewhere,
    });

    switch (decision.kind) {
      case 'noop-already-showing':
      case 'focus-other-window':
        return;
      case 'refuse-save-error':
        // The standing `save-error` toast already explains why; nothing to
        // add, and nothing here may touch the document that failed to save.
        return;
      case 'open-new-window':
        await invoke('open_file_window_cmd', { path }).catch((err: unknown) => {
          console.error('Failed to open new window:', err);
        });
        return;
      case 'switch-in-place':
        await loadDocumentInPlace(path);
        return;
    }
  }

  async function loadDocumentInPlace(path: string): Promise<void> {
    // Leaving the previous document: hand over anything it was mid-way
    // through before the editor's content is replaced out from under it.
    const leavingPath = fileState.filePath;
    if (leavingPath) {
      await invoke('commit_document_pauses', { path: leavingPath }).catch(() => {});
      await invoke('cancel_ai_ask', { path: leavingPath }).catch(() => {});
    }
    editorHandle?.view?.dispatch({ effects: clearAiAsks.of(null) });
    const activeEdit = activeCellEditSession();
    if (activeEdit) endCellEditSession(activeEdit.textarea);
    hideHoverMenu();

    try {
      const exists = await fileExists(path);
      const content = exists ? await readFile(path) : '';
      editorHandle?.loadDocument(content);
      fileState.filePath = path;
      // Register this window as the owner of `path` in the Rust-side
      // `OpenFiles` map and (re)start its watcher. Without this, a file
      // opened here is invisible to every dedup/routing check that consults
      // `OpenFiles` (AI commands, `focus_if_open`), and never gets watched
      // for external changes either.
      invoke('register_open_file', { path }).catch(() => {});
      fileState.isDirty = false;
      recentFiles.add(path);

      // A different document means different comments; drafts belonged to
      // the file we just left and must not reappear anchored in this one.
      commentDrafts = new Map();
      void reloadComments();

      // Detect file type and switch editor mode
      const basename = path.split('/').pop()?.toLowerCase() ?? '';
      const ext = path.split('.').pop()?.toLowerCase() ?? '';
      const isEnvFile = basename.startsWith('.env') || ext === 'env';

      if (isEnvFile) {
        editorHandle?.setEnvMode(true);
        activePreview = 'env';
      } else if (!MARKDOWN_EXTENSIONS.has(ext)) {
        editorHandle?.setEnvMode(false);
        editorHandle?.setCodeMode(ext, basename);
        activePreview = isShellConfig(basename) ? 'shell' : 'code';
      } else {
        editorHandle?.setEnvMode(false);
        editorHandle?.setCodeMode(null);
        activePreview = 'markdown';
      }

      // `setCodeMode`/`setEnvMode` above reconfigure the preview compartment
      // themselves, and the markdown branch installs a bare livePreviewPlugin
      // — no flavour facet, no live-render bundle. Re-assert the engine's own
      // configuration on top, or a freshly opened window sits in a half-built
      // state. `activePreview` was just assigned, so this cannot rely on the
      // `$effect` firing first.
      applyPreviewConfig();
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  }
```

- [ ] **Step 12: Update the four remaining call sites**

In `src/App.svelte`:

- Line 1320 (`onMount`, pending file for a brand-new window): `await handleOpenFilePath(pending.path);` → `await switchDocument(pending.path);`
- Line 1459 (`onOpenFile` — CLI file routed to this window): `handleOpenFilePath(path);` → `switchDocument(path);`
- Line 1487 (drag & drop, current window is empty): `await handleOpenFilePath(path);` → `await switchDocument(path);`
- Line 1769 (`RecentFilesPanel` `onopen` prop): `onopen={handleOpenFilePath}` → `onopen={switchDocument}`

- [ ] **Step 13: Type-check and run the full suite**

Run: `npm run check`
Expected: no errors.

Run: `npx vitest run --dir src`
Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add src/lib/switch-document.ts src/lib/switch-document.test.ts src/lib/toasts.svelte.ts src/lib/toasts.svelte.test.ts src/lib/editor/ai-ask.ts src/App.svelte
git commit -m "$(cat <<'EOF'
feat(editor): unify document replacement into switchDocument

handleOpen (Cmd+O) and handleOpenFilePath (Recent Files) were two
independently-drifted paths with different bugs (see
docs/investigations/2026-09-23-tabs-options.md §1). switchDocument replaces
both: flush the pending autosave, dedup against files already open in
another window, never discard a dirty untitled buffer, hand over
comment-pause state and pending mdmini asks for the document being left,
and only then load the new one — through the undo-safe loadDocument from
the previous commit.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Untitled draft naming by a process-unique id, not the window label

**Files:**
- Modify: `src-tauri/src/session.rs:16-58` (`WindowSnapshot`), `:78-81` (`untitled_file_name`), `:107-137` (new id generator + `SessionState` fields untouched), `:171-204` (`set_document`/`set_untitled` unaffected), `:388-426` (`update_session_document`), `:458-667` (existing tests + new ones)
- Modify: `src-tauri/src/window.rs:230-324` (`open_restored_window`)

**Note on "uuid":** this sandbox has no crates.io access to add a new dependency (see the existing comment on `locale.rs`'s choice of `objc`/`cocoa` over `sys-locale` for the same reason), so this task generates a process-and-time-unique id instead of pulling in the `uuid` crate. It has the one property this needs — never colliding with a previous run's id, which is exactly what `untitled-<label>.md` failed to guarantee — without a new dependency.

- [ ] **Step 1: Write the failing collision-scenario test**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/session.rs`, after `untitled_file_name_is_derived_from_label` (around line 631):

```rust
    #[test]
    fn two_launches_reusing_the_same_window_label_get_different_tab_ids() {
        // Regression for the bug this task fixes: `untitled-main.md` used to
        // be shared by every launch's "main" window, so starting to type in
        // one before Reopen Session silently overwrote the previous run's
        // unsaved buffer.
        let launch_one = SessionState::new();
        let launch_two = SessionState::new();

        let id_one = launch_one.tab_id_for("main");
        let id_two = launch_two.tab_id_for("main");

        assert_ne!(id_one, id_two);
    }

    #[test]
    fn tab_id_for_is_stable_across_repeated_calls() {
        let state = SessionState::new();
        let first = state.tab_id_for("editor-2");
        let second = state.tab_id_for("editor-2");
        assert_eq!(first, second);
    }

    #[test]
    fn seed_preserves_the_restored_tab_id() {
        let state = SessionState::new();
        let mut snapshot = WindowSnapshot::empty();
        snapshot.tab_id = "restored-id-123".to_string();

        state.seed("editor-5", snapshot);

        assert_eq!(state.tab_id_for("editor-5"), "restored-id-123");
    }

    #[test]
    fn seed_does_not_overwrite_an_entry_that_already_exists() {
        let state = SessionState::new();
        let first_id = state.tab_id_for("editor-5");

        let mut snapshot = WindowSnapshot::empty();
        snapshot.tab_id = "should-be-ignored".to_string();
        state.seed("editor-5", snapshot);

        assert_eq!(state.tab_id_for("editor-5"), first_id);
    }

    #[test]
    fn snapshot_for_returns_the_recorded_entry() {
        let state = SessionState::new();
        state.set_document("editor-1", Some("/tmp/a.md".to_string()), 3, 2);
        let snap = state.snapshot_for("editor-1").expect("entry exists");
        assert_eq!(snap.path.as_deref(), Some("/tmp/a.md"));
    }

    #[test]
    fn snapshot_for_returns_none_for_an_unknown_label() {
        let state = SessionState::new();
        assert!(state.snapshot_for("no-such-window").is_none());
    }
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd src-tauri && cargo test tab_id_for`
Expected: FAIL — `no field 'tab_id' on type 'WindowSnapshot'` / `no method named 'tab_id_for' found` / `no method named 'seed' found` / `no method named 'snapshot_for' found`.

- [ ] **Step 3: Add `tab_id` to `WindowSnapshot` and the id generator**

In `src-tauri/src/session.rs`, change the struct:

```rust
/// One window as it was when the session was captured.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSnapshot {
    /// Absolute path of the open file, or `None` for an Untitled window.
    #[serde(default)]
    pub path: Option<String>,
    /// File name inside the `session/` directory holding an unsaved buffer.
    #[serde(default)]
    pub untitled: Option<String>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub cursor: usize,
    #[serde(default = "default_top_line")]
    pub top_line: usize,
}
```

to:

```rust
/// One window as it was when the session was captured.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSnapshot {
    /// Absolute path of the open file, or `None` for an Untitled window.
    #[serde(default)]
    pub path: Option<String>,
    /// File name inside the `session/` directory holding an unsaved buffer.
    #[serde(default)]
    pub untitled: Option<String>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub cursor: usize,
    #[serde(default = "default_top_line")]
    pub top_line: usize,
    /// Process-and-time-unique id for this window, stable across a restore.
    /// A session.json written before this field existed has none — such an
    /// entry gets a fresh id on load, which is harmless: `untitled` already
    /// holds the sidecar's literal file name from that older run, so restore
    /// still finds the right file regardless of this field's value.
    #[serde(default = "new_tab_id")]
    pub tab_id: String,
}
```

Add the generator right after `SESSION_VERSION` (near the top of the file, after line 10):

```rust
static TAB_ID_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A fresh id, unique for the lifetime of this process, salted with the wall
/// clock so two different launches never collide either — the property
/// `untitled-<label>.md` lacked, since `label` (`main`, `editor-2`, …) is
/// reused by every launch.
pub fn new_tab_id() -> String {
    let n = TAB_ID_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    format!("{}-{}-{}", now_secs(), std::process::id(), n)
}
```

`now_secs()` is defined further down in this same file (line 304) — Rust does not require definition-before-use within a module, so this forward reference compiles as-is.

Update `WindowSnapshot::empty()`:

```rust
    fn empty() -> Self {
        Self {
            path: None,
            untitled: None,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            cursor: 0,
            top_line: 1,
        }
    }
```

to:

```rust
    fn empty() -> Self {
        Self {
            path: None,
            untitled: None,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            cursor: 0,
            top_line: 1,
            tab_id: new_tab_id(),
        }
    }
```

`WindowSnapshot::empty()` is private to the module (no `pub`); the new tests above call it as `WindowSnapshot::empty()` from inside `mod tests`, which is a child module and can see it — no visibility change needed.

- [ ] **Step 4: Rename `untitled_file_name`'s parameter and add the three `SessionState` methods**

Change:

```rust
/// Name of the sidecar file that stores an Untitled window's text.
pub fn untitled_file_name(label: &str) -> String {
    format!("untitled-{}.md", label)
}
```

to:

```rust
/// Name of the sidecar file that stores an Untitled window's text, keyed by
/// the window's `tab_id` rather than its label — see `new_tab_id` for why.
pub fn untitled_file_name(tab_id: &str) -> String {
    format!("untitled-{}.md", tab_id)
}
```

In `impl SessionState`, add three methods after `remove` (after line 215):

```rust
    /// The persistent tab id for `label`, creating its entry (with a fresh
    /// id) if this is the first time anything has been recorded for it.
    pub fn tab_id_for(&self, label: &str) -> String {
        let mut map = self.entries.lock().unwrap();
        let entry = map.entry(label.to_string()).or_insert_with(WindowSnapshot::empty);
        entry.tab_id.clone()
    }

    /// Seed this window's session entry from a restored snapshot — so the
    /// first heartbeat (`update_session_document`) merges into it, keeping
    /// the same `tab_id`, instead of `tab_id_for` minting a fresh one via
    /// `WindowSnapshot::empty()`. A no-op if an entry already exists.
    pub fn seed(&self, label: &str, snapshot: WindowSnapshot) {
        self.entries.lock().unwrap().entry(label.to_string()).or_insert(snapshot);
    }

    /// A copy of this window's current entry, if it has one. Used by the
    /// window-close handler to decide whether (and with what) to push onto
    /// the recently-closed stack before the entry itself is removed.
    pub fn snapshot_for(&self, label: &str) -> Option<WindowSnapshot> {
        self.entries.lock().unwrap().get(label).cloned()
    }
```

- [ ] **Step 5: Use `tab_id_for` in `update_session_document`**

In `src-tauri/src/session.rs`, inside `update_session_document` (around line 396-419), change:

```rust
    let label = window.label().to_string();
    state.set_document(&label, path.clone(), cursor, top_line);
```

to (unchanged — kept for context) and change the untitled-file branch:

```rust
        (None, Some(text)) if !text.is_empty() => {
            let file_name = untitled_file_name(&label);
            write_untitled(&file_name, &text)?;
            state.set_untitled(&label, Some(file_name));
        }
```

to:

```rust
        (None, Some(text)) if !text.is_empty() => {
            let tab_id = state.tab_id_for(&label);
            let file_name = untitled_file_name(&tab_id);
            write_untitled(&file_name, &text)?;
            state.set_untitled(&label, Some(file_name));
        }
```

- [ ] **Step 6: Run the session tests**

Run: `cd src-tauri && cargo test --lib session::`
Expected: PASS, including the new tests from Step 1 and the pre-existing ones (`untitled_file_name_is_derived_from_label` still passes unchanged — it only asserts the formatter's output shape, independent of what the caller happens to pass as the parameter).

- [ ] **Step 7: Seed the restored `tab_id` in `open_restored_window`**

In `src-tauri/src/window.rs`, inside `open_restored_window` (around line 253), change:

```rust
    let count = WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst);
    let label = format!("editor-{}", count);
```

to:

```rust
    let count = WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst);
    let label = format!("editor-{}", count);

    // Seed the session entry with the restored tab_id before this window's
    // frontend ever sends its first heartbeat — otherwise `tab_id_for` would
    // mint a brand new one on that first call, breaking the continuity this
    // is for (the restored untitled sidecar, if any, would then be written
    // under a new file name while the old one goes unreferenced and gets
    // pruned).
    app.state::<crate::session::SessionState>()
        .seed(&label, snapshot.clone());
```

- [ ] **Step 8: Run the full Rust suite**

Run: `cd src-tauri && cargo test`
Expected: PASS.

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml`
Expected: no warnings.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/session.rs src-tauri/src/window.rs
git commit -m "$(cat <<'EOF'
fix(session): name untitled sidecars by a per-window id, not the window label

untitled-main.md was shared by every launch's "main" window, so typing in
one before "Reopen Session" silently overwrote the previous run's unsaved
buffer. WindowSnapshot now carries a process-and-time-unique tab_id, seeded
into a restored window's session entry so the id (and its sidecar) survive
a restore.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Recent files in Rust

**Files:**
- Create: `src-tauri/src/recent.rs`
- Modify: `src-tauri/src/lib.rs:9-27` (`mod` list), `:128-134` (`.manage(...)`), `:135-168` (`invoke_handler!`)
- Modify: `src/lib/stores.svelte.ts:1-14` (imports), `:319-339` (`createRecentFilesStore`)
- Modify: `src/lib/stores.svelte.test.ts` (new `describe` block)
- Modify: `src/lib/tauri/events.ts` (add `onRecentChanged`)
- Modify: `src/App.svelte` (wire `recentFiles.init()` + `onRecentChanged`)

- [ ] **Step 1: Write the failing Rust tests for the pure list functions**

`src-tauri/src/recent.rs` (create with just the pure logic + tests first):

```rust
//! Recent-files list, persisted in `paths::app_data_dir()/recent.json`.
//!
//! Replaces the frontend's `localStorage`-backed list
//! (`src/lib/stores.svelte.ts`), which lived under
//! `~/Library/WebKit/<bundle id>/...` — a location the pending couplet
//! rebrand changes — and which every window overwrote independently
//! (last writer wins), so an agent's rapid `show` calls could wipe out the
//! human's last entries within minutes. See
//! docs/investigations/2026-09-23-tabs-options.md §1.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const MAX_ENTRIES: usize = 10;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub path: String,
    pub timestamp: u64,
}

/// Move `path` to the front, deduped, capped at `MAX_ENTRIES` — same
/// semantics as today's frontend `createRecentFilesStore.add`.
pub fn touch(list: Vec<RecentFile>, path: &str, timestamp: u64) -> Vec<RecentFile> {
    let mut out = vec![RecentFile {
        path: path.to_string(),
        timestamp,
    }];
    out.extend(list.into_iter().filter(|f| f.path != path));
    out.truncate(MAX_ENTRIES);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, ts: u64) -> RecentFile {
        RecentFile {
            path: path.to_string(),
            timestamp: ts,
        }
    }

    #[test]
    fn touch_adds_to_the_front() {
        let list = touch(vec![], "/a.md", 1);
        assert_eq!(list, vec![entry("/a.md", 1)]);
    }

    #[test]
    fn touch_moves_an_existing_path_to_the_front_instead_of_duplicating() {
        let list = vec![entry("/a.md", 1), entry("/b.md", 2)];
        let list = touch(list, "/a.md", 3);
        assert_eq!(list, vec![entry("/a.md", 3), entry("/b.md", 2)]);
    }

    #[test]
    fn touch_caps_at_ten_entries() {
        let mut list = Vec::new();
        for i in 0..10 {
            list = touch(list, &format!("/f{}.md", i), i as u64);
        }
        list = touch(list, "/new.md", 100);
        assert_eq!(list.len(), 10);
        assert_eq!(list[0].path, "/new.md");
        // The oldest entry (/f0.md) was pushed out.
        assert!(!list.iter().any(|f| f.path == "/f0.md"));
    }
}
```

- [ ] **Step 2: Run it to see it pass immediately (pure functions, no Tauri types yet)**

Run: `cd src-tauri && cargo test --lib recent::`
Expected: PASS — `mod recent;` is not yet declared in `lib.rs`, so this actually fails to compile at the crate level first. Add the module declaration now so the test can run in isolation:

In `src-tauri/src/lib.rs`, change:

```rust
mod paths;
mod preferences;
mod recovery;
```

to:

```rust
mod paths;
mod preferences;
mod recent;
mod recovery;
```

Re-run: `cd src-tauri && cargo test --lib recent::`
Expected: PASS (3 tests).

- [ ] **Step 3: Add the Rust-side store and commands**

Append to `src-tauri/src/recent.rs`, above the `#[cfg(test)]` module:

```rust
fn recent_file() -> Result<PathBuf, String> {
    Ok(crate::paths::app_data_dir()?.join("recent.json"))
}

fn read() -> Option<Vec<RecentFile>> {
    let path = recent_file().ok()?;
    let data = fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

/// Same tmp+rename shape as `session.rs::write_session` — this file lives in
/// the app's own data dir, not a user's, so the hardened `atomic_write` (mode
/// / owner / ACL / xattr preservation) is unnecessary here.
fn write(list: &[RecentFile]) -> Result<(), String> {
    let path = recent_file()?;
    let tmp = path.with_extension("json.tmp");
    let data = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// The live list, shared by every window in this process.
pub struct RecentFiles(Mutex<Vec<RecentFile>>);

impl RecentFiles {
    pub fn new() -> Self {
        Self(Mutex::new(read().unwrap_or_default()))
    }

    pub fn list(&self) -> Vec<RecentFile> {
        self.0.lock().unwrap().clone()
    }

    pub fn add(&self, path: String, timestamp: u64) -> Vec<RecentFile> {
        let mut guard = self.0.lock().unwrap();
        *guard = touch(std::mem::take(&mut *guard), &path, timestamp);
        let _ = write(&guard);
        guard.clone()
    }

    /// One-time import from a window's `localStorage` copy, only when this
    /// process's own store is still empty — otherwise a second window
    /// importing after the first already wrote real entries would stomp
    /// them with a stale browser-side copy.
    pub fn import_if_empty(&self, entries: Vec<RecentFile>) -> Vec<RecentFile> {
        let mut guard = self.0.lock().unwrap();
        if guard.is_empty() && !entries.is_empty() {
            let mut merged = entries;
            merged.truncate(MAX_ENTRIES);
            *guard = merged;
            let _ = write(&guard);
        }
        guard.clone()
    }
}

impl Default for RecentFiles {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub async fn recent_files_list(state: tauri::State<'_, RecentFiles>) -> Result<Vec<RecentFile>, String> {
    Ok(state.list())
}

#[tauri::command]
pub async fn recent_files_add(
    app: tauri::AppHandle,
    state: tauri::State<'_, RecentFiles>,
    path: String,
    timestamp: u64,
) -> Result<(), String> {
    use tauri::Emitter;
    let list = state.add(path, timestamp);
    let _ = app.emit("recent-changed", &list);
    Ok(())
}

#[tauri::command]
pub async fn recent_files_import(
    app: tauri::AppHandle,
    state: tauri::State<'_, RecentFiles>,
    entries: Vec<RecentFile>,
) -> Result<Vec<RecentFile>, String> {
    use tauri::Emitter;
    let list = state.import_if_empty(entries);
    let _ = app.emit("recent-changed", &list);
    Ok(list)
}
```

- [ ] **Step 4: Register `RecentFiles` state and the three commands**

In `src-tauri/src/lib.rs`, change:

```rust
        .manage(OpenFiles::new())
```

to:

```rust
        .manage(OpenFiles::new())
        .manage(recent::RecentFiles::new())
```

(match this to whatever `.manage(...)` chain line 128 actually reads in the file at the time you edit it — the point is adding one more `.manage()` call alongside the existing ones, order does not matter.)

And extend `invoke_handler!` (added to the list from Task 3, Step 12):

```rust
            i18n::resolved_language,
        ])
```

to:

```rust
            i18n::resolved_language,
            recent::recent_files_list,
            recent::recent_files_add,
            recent::recent_files_import,
        ])
```

- [ ] **Step 5: Run the full Rust suite**

Run: `cd src-tauri && cargo test`
Expected: PASS.

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml`
Expected: no warnings.

- [ ] **Step 6: Write the failing frontend tests**

Add to `src/lib/stores.svelte.test.ts`:

```ts
import { createRecentFilesStore } from './stores.svelte';

describe('createRecentFilesStore', () => {
  it('AddsToTheFrontAndDedupsByPath', () => {
    const store = createRecentFilesStore();
    store.add('/a.md');
    store.add('/b.md');
    store.add('/a.md');
    expect(store.list.map((f) => f.path)).toEqual(['/a.md', '/b.md']);
  });

  it('CapsAtTen', () => {
    const store = createRecentFilesStore();
    for (let i = 0; i < 12; i++) store.add(`/f${i}.md`);
    expect(store.list).toHaveLength(10);
  });

  it('SetListReplacesLocalStateWholesale', () => {
    const store = createRecentFilesStore();
    store.add('/a.md');
    store.setList([{ path: '/b.md', timestamp: 1 }]);
    expect(store.list).toEqual([{ path: '/b.md', timestamp: 1 }]);
  });
});
```

- [ ] **Step 7: Run it to see it fail**

Run: `npx vitest run src/lib/stores.svelte.test.ts`
Expected: FAIL — `store.setList is not a function` (the existing `add` already exists and would otherwise pass, since it does not yet touch Rust; `setList` is the new addition that fails).

- [ ] **Step 8: Make `createRecentFilesStore` Rust-backed**

In `src/lib/stores.svelte.ts`, add to the imports at the top:

```ts
import { invoke } from '@tauri-apps/api/core';
```

Replace:

```ts
export function createRecentFilesStore() {
  let files = $state<RecentFile[]>(loadSetting('recentFiles', []));

  return {
    get list() {
      return files;
    },
    add(path: string) {
      files = [
        { path, timestamp: Date.now() },
        ...files.filter((f) => f.path !== path),
      ].slice(0, 10);
      saveSetting('recentFiles', files);
    },
  };
}
```

with:

```ts
export function createRecentFilesStore() {
  // Starts from the old localStorage copy so the panel is non-empty on the
  // very first paint; `init()` (called once from `onMount`) replaces this
  // with the Rust-backed list moments later, one-time-importing this copy
  // if Rust's own store is still empty.
  let files = $state<RecentFile[]>(loadSetting('recentFiles', []));

  return {
    get list() {
      return files;
    },
    add(path: string) {
      const timestamp = Date.now();
      files = [
        { path, timestamp },
        ...files.filter((f) => f.path !== path),
      ].slice(0, 10);
      invoke('recent_files_add', { path, timestamp }).catch(() => {});
    },
    /** Replaces the local list wholesale — used when another window's `add`
     * arrives via the `recent-changed` event, and by `init()`. */
    setList(next: RecentFile[]) {
      files = next;
    },
    /**
     * Pulls the Rust-backed list, one-time-importing this window's
     * localStorage copy if Rust's own store is still empty. Call once, from
     * `onMount`; deliberately not run at construction time, so tests that
     * only exercise `add`/`setList` stay synchronous and cannot race an
     * in-flight import.
     */
    async init(): Promise<void> {
      const legacy = files;
      const imported = await invoke<RecentFile[]>('recent_files_import', {
        entries: legacy,
      }).catch(() => legacy);
      files = imported;
    },
  };
}
```

- [ ] **Step 9: Run it to see it pass**

Run: `npx vitest run src/lib/stores.svelte.test.ts`
Expected: PASS. `invoke()` rejects outside a Tauri runtime; `add`'s call is fire-and-forget (`.catch(() => {})`), so the synchronous, locally-computed `files` value is exactly what these tests assert — `init()` is never called by them, so there's nothing to race.

- [ ] **Step 10: Add `onRecentChanged` and wire `App.svelte`**

In `src/lib/tauri/events.ts`, add near `onSessionRestored`:

```ts
import type { RecentFile } from '../stores.svelte';

/** Emitted by Rust whenever any window adds to, or imports into, the shared
 * Recent Files list — every other window applies it via `setList`. */
export function onRecentChanged(handler: (files: RecentFile[]) => void): Promise<() => void> {
  return listen<RecentFile[]>('recent-changed', (event) => {
    handler(event.payload);
  });
}
```

In `src/App.svelte`, add `onRecentChanged` to the `./lib/tauri/events` import list, and inside `onMount` (near the other `unlisten*` listeners, alongside `unlistenSessionRestored`), add:

```ts
    void recentFiles.init();
    const unlistenRecentChanged = onRecentChanged((files) => {
      recentFiles.setList(files);
    });
```

Add `unlistenRecentChanged` to the cleanup block where the other `unlisten*().then((fn) => fn())` calls live (same pattern as `unlistenSessionRestored`).

- [ ] **Step 11: Type-check and run the full suite**

Run: `npm run check`
Expected: no errors.

Run: `npx vitest run --dir src`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add src-tauri/src/recent.rs src-tauri/src/lib.rs src/lib/stores.svelte.ts src/lib/stores.svelte.test.ts src/lib/tauri/events.ts src/App.svelte
git commit -m "$(cat <<'EOF'
feat(recent-files): move the shared list from localStorage to Rust

Every window wrote its own localStorage copy of Recent Files, last writer
wins — an agent's rapid mdmini show calls could wipe the human's last
entries within minutes, and the list lived under a WebKit path keyed by the
bundle identifier the pending rebrand changes. recent.rs owns the list now,
broadcasting recent-changed to every window; a window's old localStorage
copy is imported once if Rust's own store is still empty.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Recently-closed stack + Cmd+Shift+T

**Files:**
- Create: `src-tauri/src/closed.rs`
- Modify: `src-tauri/src/menu.rs:114-123, 379-412` (`build_menu`, capture a live `MenuItem` handle)
- Modify: `src-tauri/src/lib.rs:9-27` (`mod`), `:135-168` (`invoke_handler!`/`.manage`, no new commands needed here — only new state), `:213-218` (`build_menu` call site), `:220-234` (`reopen_session` handler), `:405-439` (`WindowEvent::Destroyed`)

- [ ] **Step 1: Write the failing tests for the pure stack logic**

`src-tauri/src/closed.rs` (create):

```rust
//! Stack of recently-closed windows, for Cmd+Shift+T.
//!
//! Only windows that were showing a **saved file** are pushed — an Untitled
//! window's Cmd+W is a deliberate, permanent discard (design doc §8), and a
//! window closed as part of quitting is not "closed" in this sense at all:
//! `SessionState`'s `quitting` flag exists so those windows come back via
//! session restore instead.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const MAX_ENTRIES: usize = 20;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedEntry {
    pub path: String,
    pub cursor: usize,
    pub top_line: usize,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Whether a just-destroyed window should be pushed onto the stack at all —
/// split out from the window-event handler so this guard is directly
/// testable without a running window.
pub fn should_push_on_close(is_quitting: bool, path: Option<&str>) -> bool {
    !is_quitting && path.is_some()
}

/// Push `entry` to the top, deduped by path (an existing entry for the same
/// file moves to the top with its latest position rather than appearing
/// twice), capped at `MAX_ENTRIES`.
pub fn push(stack: Vec<ClosedEntry>, entry: ClosedEntry) -> Vec<ClosedEntry> {
    let mut out = vec![entry.clone()];
    out.extend(stack.into_iter().filter(|e| e.path != entry.path));
    out.truncate(MAX_ENTRIES);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str) -> ClosedEntry {
        ClosedEntry {
            path: path.to_string(),
            cursor: 0,
            top_line: 1,
            x: 0,
            y: 0,
            width: 900,
            height: 700,
        }
    }

    #[test]
    fn should_push_on_close_requires_a_path() {
        assert!(!should_push_on_close(false, None));
        assert!(should_push_on_close(false, Some("/tmp/a.md")));
    }

    #[test]
    fn should_push_on_close_is_false_while_quitting() {
        assert!(!should_push_on_close(true, Some("/tmp/a.md")));
    }

    #[test]
    fn push_adds_to_the_front() {
        let stack = push(vec![], entry("/a.md"));
        assert_eq!(stack, vec![entry("/a.md")]);
    }

    #[test]
    fn push_dedups_by_path_moving_the_existing_entry_to_the_front() {
        let stack = vec![entry("/a.md"), entry("/b.md")];
        let stack = push(stack, entry("/a.md"));
        assert_eq!(stack.len(), 2);
        assert_eq!(stack[0].path, "/a.md");
        assert_eq!(stack[1].path, "/b.md");
    }

    #[test]
    fn push_caps_at_twenty_entries() {
        let mut stack = Vec::new();
        for i in 0..20 {
            stack = push(stack, entry(&format!("/f{}.md", i)));
        }
        stack = push(stack, entry("/new.md"));
        assert_eq!(stack.len(), 20);
        assert_eq!(stack[0].path, "/new.md");
        assert!(!stack.iter().any(|e| e.path == "/f0.md"));
    }
}
```

- [ ] **Step 2: Declare the module and run the tests**

In `src-tauri/src/lib.rs`, change:

```rust
pub mod ai_socket;
pub mod atomic_write;
pub mod comment_pause;
pub mod comments;
mod commands;
```

to:

```rust
pub mod ai_socket;
pub mod atomic_write;
mod closed;
pub mod comment_pause;
pub mod comments;
mod commands;
```

Run: `cd src-tauri && cargo test --lib closed::`
Expected: PASS (5 tests).

- [ ] **Step 3: Add the `ClosedStack` state and `reopen_closed`**

Append to `src-tauri/src/closed.rs`, above `#[cfg(test)]`:

```rust
/// The live stack, shared by every window in this process. Not persisted —
/// unlike Recent Files and the session, losing this on a full quit is
/// acceptable: it exists to undo an accidental Cmd+W a moment ago, not to
/// survive a restart (session restore already covers that case).
pub struct ClosedStack(Mutex<Vec<ClosedEntry>>);

impl ClosedStack {
    pub fn new() -> Self {
        Self(Mutex::new(Vec::new()))
    }

    pub fn push_entry(&self, entry: ClosedEntry) {
        let mut guard = self.0.lock().unwrap();
        *guard = push(std::mem::take(&mut *guard), entry);
    }

    /// Pop the most recently closed entry, if any.
    pub fn pop(&self) -> Option<ClosedEntry> {
        let mut guard = self.0.lock().unwrap();
        if guard.is_empty() {
            None
        } else {
            Some(guard.remove(0))
        }
    }
}

impl Default for ClosedStack {
    fn default() -> Self {
        Self::new()
    }
}

/// Pop the most recently closed entry and reopen it. Returns `false` (and
/// does nothing) when the stack is empty, so callers can fall back to
/// session restore. Reuses `window::open_restored_window`'s own dedup: if
/// the file is already open somewhere, that window is focused instead of a
/// duplicate being created.
pub fn reopen_closed(app: &tauri::AppHandle) -> bool {
    let Some(entry) = app.state::<ClosedStack>().pop() else {
        return false;
    };
    let snapshot = crate::session::WindowSnapshot::from_closed_entry(entry);
    crate::window::open_restored_window(app, &snapshot);
    true
}
```

This calls a `WindowSnapshot::from_closed_entry` constructor that does not exist yet — that is the next failing step.

- [ ] **Step 4: Write the failing test for `WindowSnapshot::from_closed_entry`**

Add to `src-tauri/src/session.rs`'s test module, near the other `WindowSnapshot` tests:

```rust
    #[test]
    fn from_closed_entry_carries_geometry_and_position_with_a_fresh_tab_id() {
        let entry = crate::closed::ClosedEntry {
            path: "/tmp/a.md".to_string(),
            cursor: 42,
            top_line: 3,
            x: 10,
            y: 20,
            width: 900,
            height: 700,
        };
        let snapshot = WindowSnapshot::from_closed_entry(entry);
        assert_eq!(snapshot.path.as_deref(), Some("/tmp/a.md"));
        assert_eq!(snapshot.cursor, 42);
        assert_eq!(snapshot.top_line, 3);
        assert_eq!((snapshot.x, snapshot.y, snapshot.width, snapshot.height), (10, 20, 900, 700));
        assert!(!snapshot.tab_id.is_empty());
    }
```

Run: `cd src-tauri && cargo test from_closed_entry`
Expected: FAIL — `no function or associated item named 'from_closed_entry' found`.

- [ ] **Step 5: Implement `WindowSnapshot::from_closed_entry`**

In `src-tauri/src/session.rs`, in `impl WindowSnapshot` (right after `empty()`), add:

```rust
    /// Builds a snapshot to hand to `window::open_restored_window` for
    /// `Cmd+Shift+T`'s "reopen last closed" — a brand new window, so it gets
    /// its own fresh `tab_id` rather than reusing the closed window's.
    pub fn from_closed_entry(entry: crate::closed::ClosedEntry) -> Self {
        Self {
            path: Some(entry.path),
            untitled: None,
            x: entry.x,
            y: entry.y,
            width: entry.width,
            height: entry.height,
            cursor: entry.cursor,
            top_line: entry.top_line,
            tab_id: new_tab_id(),
        }
    }
```

- [ ] **Step 6: Run the closed + session tests**

Run: `cd src-tauri && cargo test --lib closed:: session::`
Expected: PASS.

- [ ] **Step 7: Push onto the stack when a window with a saved file closes**

In `src-tauri/src/lib.rs`, change the `Destroyed` arm:

```rust
                tauri::WindowEvent::Destroyed => {
                    let app = window.app_handle();
                    let label = window.label();
                    // No-op while quitting, so an exit keeps every window.
                    app.state::<SessionState>().remove(label);
                    // Hand the update poll to a surviving window.
                    app.state::<UpdateState>().release(label);
                    window::untrack_window(app, label);
                }
```

to:

```rust
                tauri::WindowEvent::Destroyed => {
                    let app = window.app_handle();
                    let label = window.label();
                    let session_state = app.state::<SessionState>();
                    // Snapshot before `remove` erases it below.
                    if let Some(snap) = session_state.snapshot_for(label) {
                        if closed::should_push_on_close(session_state.is_quitting(), snap.path.as_deref())
                        {
                            app.state::<closed::ClosedStack>().push_entry(closed::ClosedEntry {
                                path: snap.path.clone().expect("checked by should_push_on_close"),
                                cursor: snap.cursor,
                                top_line: snap.top_line,
                                x: snap.x,
                                y: snap.y,
                                width: snap.width,
                                height: snap.height,
                            });
                            let _ = app
                                .state::<menu::SessionMenuItems>()
                                .reopen_session
                                .set_enabled(true);
                        }
                    }
                    // No-op while quitting, so an exit keeps every window.
                    session_state.remove(label);
                    // Hand the update poll to a surviving window.
                    app.state::<UpdateState>().release(label);
                    window::untrack_window(app, label);
                }
```

This references `menu::SessionMenuItems`, which does not exist yet — the next step.

- [ ] **Step 8: Capture a live handle to the "reopen" menu item**

In `src-tauri/src/menu.rs`, add a new struct near `ViewToggleItems`:

```rust
/// A live handle to the "Reopen…" item, so it can be re-enabled once the
/// closed-window stack gets an entry — the item is built once, at startup,
/// disabled whenever there is nothing to restore yet, and this is the only
/// way to flip that after the fact (macOS disables the accelerator along
/// with the item, so without this, Cmd+Shift+T would stay dead for the rest
/// of the process on any launch that starts with nothing pending).
pub struct SessionMenuItems {
    pub reopen_session: tauri::menu::MenuItem<Wry>,
}
```

In `build_menu`, change:

```rust
        .item(
            &MenuItemBuilder::with_id(
                "reopen_session",
                crate::i18n::t_plural("menu.file.reopen_session", pending_session_count as u64),
            )
            .accelerator("CmdOrCtrl+Shift+T")
            .enabled(pending_session_count > 0)
            .build(app)?,
        )
        .build()?;
```

to:

```rust
        .item(&reopen_session_item)
        .build()?;
```

and add, just before the `let file_menu = ...` line:

```rust
    let reopen_session_item = MenuItemBuilder::with_id(
        "reopen_session",
        crate::i18n::t_plural("menu.file.reopen_session", pending_session_count as u64),
    )
    .accelerator("CmdOrCtrl+Shift+T")
    .enabled(pending_session_count > 0)
    .build(app)?;
```

Change the function's return type:

```rust
) -> tauri::Result<(
    tauri::menu::Menu<Wry>,
    ThemeMenuItems,
    EngineMenuItems,
    ViewToggleItems,
)> {
```

to:

```rust
) -> tauri::Result<(
    tauri::menu::Menu<Wry>,
    ThemeMenuItems,
    EngineMenuItems,
    ViewToggleItems,
    SessionMenuItems,
)> {
```

And change the final `Ok((...))`:

```rust
    Ok((menu, theme_items, engine_items, view_toggles))
}
```

to:

```rust
    let session_items = SessionMenuItems {
        reopen_session: reopen_session_item,
    };

    Ok((menu, theme_items, engine_items, view_toggles, session_items))
}
```

- [ ] **Step 9: Update the call site and manage the new state**

In `src-tauri/src/lib.rs`, change:

```rust
            let (menu, theme_items, engine_items, view_toggles) =
                menu::build_menu(app.handle(), pending_count, explicit_language.as_deref())?;
            app.set_menu(menu)?;
            app.manage(theme_items);
            app.manage(view_toggles);
            app.manage(engine_items);
```

to:

```rust
            let (menu, theme_items, engine_items, view_toggles, session_menu_items) =
                menu::build_menu(app.handle(), pending_count, explicit_language.as_deref())?;
            app.set_menu(menu)?;
            app.manage(theme_items);
            app.manage(view_toggles);
            app.manage(engine_items);
            app.manage(session_menu_items);
            app.manage(closed::ClosedStack::new());
```

- [ ] **Step 10: Try the closed stack first in the `reopen_session` handler**

In `src-tauri/src/lib.rs`, change:

```rust
                // Restore windows in Rust, like "new" — it creates windows.
                if id == "reopen_session" {
                    session::restore_pending(&app_handle);
                    return;
                }
```

to:

```rust
                // Restore windows in Rust, like "new" — it creates windows.
                // The closed-window stack (Cmd+W a moment ago) takes priority
                // over the previous session's window list; on a fresh
                // process with nothing closed yet, this falls straight
                // through to the old behaviour.
                if id == "reopen_session" {
                    if !closed::reopen_closed(&app_handle) {
                        session::restore_pending(&app_handle);
                    }
                    return;
                }
```

- [ ] **Step 11: Build, run the full Rust suite, clippy**

Run: `cd src-tauri && cargo build`
Expected: builds clean (this task touches `lib.rs`'s setup closure and `Destroyed` handler, which have no unit tests of their own — verified manually in Task 8).

Run: `cd src-tauri && cargo test`
Expected: PASS.

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml`
Expected: no warnings.

- [ ] **Step 12: Commit**

```bash
git add src-tauri/src/closed.rs src-tauri/src/lib.rs src-tauri/src/menu.rs src-tauri/src/session.rs
git commit -m "$(cat <<'EOF'
feat(session): Cmd+Shift+T reopens the last closed window before falling back to session restore

Only windows that were showing a saved file are pushed onto the stack (cap
20, deduped by path); an Untitled window's Cmd+W stays a deliberate,
permanent discard, and quitting never pushes (those windows come back via
session restore instead). The existing "Reopen N Windows from Last Session"
menu item now needs to be re-enabled at runtime once the stack gets its
first entry, since macOS disables an item's accelerator along with the item
itself.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Verification

- [ ] **Step 1: Full frontend test suite**

Run: `npx vitest run --dir src`
Expected: PASS, all tests green (515+ tests — 513 at the time of writing per `CLAUDE.md`, plus the new tests added across Tasks 1–7: 5 in `document-load.test.ts`, 5 in `autosave.test.ts`, 7 in `switch-document.test.ts`, 1 in `toasts.svelte.test.ts`, 3 in `stores.svelte.test.ts`).

Do **not** use plain `npm run test` for the count — it overcounts by also picking up stale copies under `.claude/worktrees/`.

- [ ] **Step 2: Full Rust test suite**

Run: `cd src-tauri && cargo test`
Expected: PASS, all tests green, including the new ones in `window.rs`, `ai_socket.rs`, `session.rs`, `recent.rs`, `closed.rs`.

- [ ] **Step 3: Clippy**

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml`
Expected: no warnings.

- [ ] **Step 4: Svelte type-check**

Run: `npm run check`
Expected: no errors.

- [ ] **Step 5: Intel cross-compile guard**

Run: `npm run check:x86`
Expected: builds clean (this task touches no `objc`/`cocoa` call sites directly, but `window.rs` and `session.rs` are on the compile path — confirms nothing here reintroduces the `bool`-vs-`BOOL` trap documented in `CLAUDE.md`).

- [ ] **Step 6: Manual verification in `npm run dev:app`**

Kill port 1420 first if a previous session left Vite running: `lsof -ti:1420 | xargs kill -9`.

Then `npm run dev:app` (never `npm run tauri dev` — see `CLAUDE.md`) and walk through the bug repros from `docs/investigations/2026-09-23-tabs-options.md` §1:

1. **Undo leak (Task 1).** Open a file, type a few characters, delete them, then re-type something different (an insertion-carrying edit, not a pure deletion). Cmd+O a *different* file. Press Cmd+Z. **Expected:** nothing happens — the second file's content is unchanged, no fragment of the first file appears.
2. **Lost autosave (Task 2/4).** Open a file, type quickly, and within ~250ms (faster than you can consciously pace) trigger Recent Files → open a different file. Reopen the first file from disk. **Expected:** the last keystrokes are present — they were flushed before the switch, not dropped.
3. **No dedup (Task 4).** Open the same file in two windows (e.g. Cmd+O the same path twice). **Expected:** the second attempt focuses the first window instead of opening a second copy.
4. **Untitled-with-text discarded (Task 4).** Cmd+T, type some text (don't save), then Cmd+O a file. **Expected:** the file opens in a **new** window; the untitled window with your text is untouched.
5. **`ask` surviving a switch (Task 3/4).** With an MCP client available, have an agent call `ask` on the currently open document, then switch documents in that window before answering. **Expected:** the ask widget disappears from the editor, and the agent's `ask` call returns promptly with an error instead of hanging for its full timeout.
6. **Untitled collision across launches (Task 5).** In the empty `main` window (the one the app opens with) type some text, quit without saving, relaunch, and before using Reopen Session type different text in the new `main` window. **Expected:** both buffers are recoverable independently (check `~/Library/Application Support/md-mini-dev/session/` for two distinct `untitled-*.md` files, not one overwriting the other).
7. **Recent Files shared across windows (Task 6).** Open two windows, open a file in each. **Expected:** both windows' Recent Files panels show both files — not just the one each window opened itself.
8. **Reopen last closed (Task 7).** Open a saved file, close its window with Cmd+W, then press Cmd+Shift+T. **Expected:** that window reopens at the same file, cursor, and position — even if this was the very first thing you did after launch (no prior session to restore).

- [ ] **Step 7: Final commit if any manual-verification fixes were needed**

Only if Step 6 surfaced a real bug — fix it, re-run the relevant automated suite, and commit with an accurate message. If Step 6 passes clean, there is nothing to commit here.
