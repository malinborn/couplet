// DEV-ONLY agent driving bridge — see "MCP dev bridge" in CLAUDE.md.
// This guard makes a release build carrying the bridge UNBUILDABLE rather than
// merely undesirable: it catches a stray `--features mcp-bridge` or an
// `--all-features` that would otherwise ship arbitrary-JS + IPC control of a
// running instance. If a release build fails here the guard WORKED — fix the
// build command, not the guard.
#[cfg(all(feature = "mcp-bridge", not(debug_assertions)))]
compile_error!("mcp-bridge must never be enabled in a release build");

pub mod ai_socket;
pub mod atomic_write;
mod closed;
pub mod comment_pause;
pub mod comments;
mod commands;
mod dock_icon;
mod git_info;
mod i18n;
mod locale;
pub mod mcp_server;
mod menu;
mod menu_route;
mod migration;
mod onboarding;
mod path_norm;
mod paths;
mod preferences;
mod recent;
mod recovery;
mod routing;
mod session;
mod tab_commands;
mod tabs;
mod typing;
mod updater;
pub mod watch;
mod watcher;
mod window;
mod window_numbers;

use tauri::{Emitter, Manager};
use tauri_plugin_cli::CliExt;
use session::SessionState;
use updater::UpdateState;
use window::{FileWatchers, OpenFiles, PendingFiles, PendingTab};

/// Новое значение тумблера — то, которое рассылается окнам.
///
/// `None` для всего, что тумблером не является: такие события уходят как есть.
/// Здесь только пункты, чьё значение фронтенд сообщает при старте
/// (`sync_theme_menu`, `sync_ocd_alignment_menu`, `sync_tabs_compact_menu`,
/// `sync_tabs_dates_menu`) —
/// без этого `Toggle` не с чего было бы начинать. `toggle_line_glow` такой
/// синхронизации не имеет и
/// потому сюда не включён; он до сих пор рассылает «переключи» и ведёт себя
/// соответственно, когда окон больше одного.
fn toggle_value(app: &tauri::AppHandle, id: &str) -> Option<bool> {
    match id {
        "theme_system" => app
            .try_state::<menu::ThemeMenuItems>()
            .map(|s| s.follow_system.flip()),
        "toggle_ocd_alignment" => app
            .try_state::<menu::ViewToggleItems>()
            .map(|s| s.ocd_enabled.flip()),
        "toggle_tabs_compact" => app
            .try_state::<menu::ViewToggleItems>()
            .map(|s| s.compact_enabled.flip()),
        "toggle_tabs_dates" => app
            .try_state::<menu::ViewToggleItems>()
            .map(|s| s.dates_enabled.flip()),
        _ => None,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Rebrand data migration — deliberately the very first thing `run()`
    // does, before `tauri::Builder::default()` even starts. This is not
    // merely "early": `Builder::build()` creates every window listed in
    // `tauri.conf.json` (see `migration.rs`'s module doc for the exact call
    // site in the `tauri` crate) as its first internal step, before our own
    // `.setup()` closure ever runs — and creating the "main" window is what
    // creates its WKWebView, which is what creates
    // `~/Library/WebKit/<identifier>/`. There is no hook between "window
    // exists" and "our code runs" that comes early enough, so this has to sit
    // above the builder entirely. The context is read from here rather than
    // re-generated at the `.build()` call below, so both this and `.build()`
    // see the exact same identifier/product name.
    //
    // Live since the couplet rename: `tauri.conf.json` / `tauri.dev.conf.json`
    // carry the `to_*` names of `migration.rs`'s rename table, so the first
    // launch of each flavour carries md-mini's data across, and every later
    // one is an `AlreadyDone` no-op that never takes the lock.
    //
    // `migrate_all_real` may block on a native dialog (a matching-generation
    // legacy build is running, or a migration failed) and can
    // `std::process::exit(0)` if the user chooses to abandon this launch
    // rather than wait/retry — see `migration.rs`'s module doc comment. It
    // never asks `run()` to use a different product name any more: on
    // success (or a genuine no-op) the current name is always correct by
    // the time it returns.
    let context = tauri::generate_context!();
    let product_name = context
        .config()
        .product_name
        .as_deref()
        .unwrap_or(paths::FALLBACK_PRODUCT_NAME);
    migration::migrate_all_real(product_name, &context.config().identifier);

    // `mut` is only needed by the `mcp-bridge` registration below; without that
    // feature the builder is never reassigned.
    #[cfg_attr(not(feature = "mcp-bridge"), allow(unused_mut))]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // argv[0] is the binary path — skip it. Relative paths are the
            // caller's: resolved against its working directory, not ours.
            let files: Vec<String> = argv
                .into_iter()
                .skip(1)
                .filter(|arg| !arg.starts_with('-'))
                .map(|path| resolve_path(&path, Some(cwd.as_str())))
                .collect();
            if files.is_empty() {
                // No files — open a new empty window
                window::open_file_window(app, None);
            } else {
                // One new window with every file as a tab (spec §4).
                window::open_files_window(app, &files);
            }
        }))
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init());

    // `bind_address` is pinned to loopback ON PURPOSE: the plugin's own default is
    // `0.0.0.0`, i.e. every interface, which would expose arbitrary-JS + IPC control
    // of a running instance to anyone on the LAN.
    #[cfg(feature = "mcp-bridge")]
    {
        builder = builder.plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("127.0.0.1")
                .build(),
        );
    }

    let builder = builder
        .manage(OpenFiles::new())
        .manage(PendingFiles::new())
        .manage(FileWatchers::new())
        .manage(SessionState::new())
        .manage(closed::ClosedStack::new())
        .manage(menu_route::FocusTracker::new())
        .manage(UpdateState::new())
        .manage(ai_socket::AiPending::new())
        .manage(ai_socket::AiQueue::new())
        .manage(typing::TypingClock::new())
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::file_exists,
            commands::comment_threads,
            commands::comment_reply,
            commands::comment_resolve,
            comment_pause::comment_start,
            comment_pause::comment_write_reply,
            comment_pause::comment_commit,
            comment_pause::commit_document_pauses,
            window::get_window_init,
            tab_commands::tab_owner,
            tab_commands::tab_open,
            tab_commands::tab_claim,
            tab_commands::tab_release,
            tab_commands::tab_activate,
            tab_commands::tab_close,
            tab_commands::tab_move,
            tab_commands::tab_carousel_windows,
            git_info::tab_git_info,
            window::open_file_window_cmd,
            window::focus_if_open,
            window::reveal_window,
            window::reveal_other_window,
            window::window_set_number,
            window::window_reveal_number,
            recent::recent_files_list,
            recent::recent_files_add,
            recent::recent_files_import,
            recovery::save_recovery,
            recovery::delete_recovery,
            recovery::check_recovery,
            session::tabs_sync,
            session::pending_session_count,
            session::restore_session,
            updater::claim_update_checker,
            updater::report_update,
            updater::dismiss_update,
            updater::pending_update,
            ai_socket::ai_respond,
            ai_socket::ai_pull_pending,
            ai_socket::ai_is_pending,
            ai_socket::ai_forward,
            typing::note_typing,
            onboarding::ai_nudge_pending,
            onboarding::ai_nudge_dismiss,
            onboarding::ai_open_getting_started,
            commands::sync_theme_menu,
            commands::sync_dock_icon,
            commands::sync_engine_menu,
            commands::sync_ocd_alignment_menu,
            commands::sync_tabs_compact_menu,
            commands::sync_tabs_dates_menu,
            commands::sync_transient_menu,
            commands::broadcast_theme,
            i18n::resolved_language,
        ])
        .setup(|app| {
            // FIRST, before anything touches disk: decide which data directory this
            // build owns. A dev build must never share `recovery/` or `session.json`
            // with an installed release one.
            paths::init(app.config().product_name.as_deref().unwrap_or(paths::FALLBACK_PRODUCT_NAME));

            // Managed here, not on the builder: `RecentFiles::load()` reads
            // `recent.json`, and before `paths::init` `app_data_dir()` refuses — the
            // list would silently load empty.
            // No IPC reaches a command before `setup` returns.
            app.manage(recent::RecentFiles::load());
            // Before anything can register a file to `main` (CLI args, the
            // pending-files list) and before its frontend asks for its number.
            window::number_main_window(app.handle());

            // Locale resolution: stored preference -> system locale -> "en".
            // Must run before `menu::build_menu` — the menu's labels come from
            // `i18n::t()`, and there is no runtime reactivity by design (a
            // language change restarts the app; see `apply_language_change`).
            let explicit_language = preferences::read_language();
            let resolved_language = locale::resolve_at_startup(explicit_language.clone());
            i18n::init(resolved_language);

            // DEV-ONLY: grant the bridge's webview->host commands their ACL permission
            // AT RUNTIME, so `capabilities/default.json` never carries an
            // `mcp-bridge:default` entry. A static grant would leak into release
            // builds and, worse, break the feature-off build outright: `tauri-build`
            // rejects a permission whose plugin is not a dependency.
            // "main" is this app's window label (`tauri.conf.json` → app.windows[].label).
            #[cfg(feature = "mcp-bridge")]
            app.add_capability(
                r#"{
                    "identifier": "mcp-bridge-dev",
                    "description": "Dev-only MCP bridge commands. Granted at runtime, never in capabilities/default.json.",
                    "windows": ["main"],
                    "permissions": ["mcp-bridge:default"]
                }"#,
            )?;

            // Load the previous session before the menu is built — the menu item's
            // enabled state depends on whether there is anything to restore.
            let pending_count = {
                let state = app.state::<SessionState>();
                match session::read_session() {
                    Some(loaded) => {
                        let count = loaded.windows.len();
                        state.set_pending(loaded.windows);
                        count
                    }
                    None => 0,
                }
            };

            let (menu, theme_items, engine_items, view_toggles, session_menu_items, transient_items) =
                menu::build_menu(app.handle(), pending_count, explicit_language.as_deref())?;
            app.set_menu(menu)?;
            app.manage(theme_items);
            app.manage(view_toggles);
            app.manage(engine_items);
            app.manage(session_menu_items);
            app.manage(transient_items);

            let app_handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                let id = event.id().0.as_str().to_string();

                // Handle "new" menu action: open a new empty window
                if id == "new" {
                    window::open_file_window(&app_handle, None);
                    return;
                }

                // Restore windows in Rust, like "new" — they create windows.
                // Cmd+Shift+T brings back only what was closed; the previous
                // session has an item of its own, Safari-style (tabs-questions Q1).
                if id == "reopen_closed" {
                    closed::reopen_closed(&app_handle);
                    closed::refresh_reopen_item(&app_handle);
                    return;
                }
                if id == "restore_session" {
                    // Refreshes the items itself.
                    session::restore_pending(&app_handle);
                    return;
                }

                // AI menu — each item (re)writes its doc into app_data_dir() with
                // fresh content and opens it in a new window, so it always reflects
                // the current snippets rather than a stale cached copy.
                if id == "ai_connect" {
                    let content = onboarding::connect_doc();
                    if let Err(e) =
                        onboarding::open_bundled_doc(&app_handle, "teach-your-ai.md", &content)
                    {
                        eprintln!("AI menu: {}", e);
                    }
                    return;
                }
                if id == "ai_playbook" {
                    if let Err(e) =
                        onboarding::open_bundled_doc(&app_handle, "ai-playbook.md", onboarding::playbook_doc())
                    {
                        eprintln!("AI menu: {}", e);
                    }
                    return;
                }

                // Manual "Check for Updates…". Must reach exactly one window —
                // one GitHub request, not one per open window — and the one
                // that owns the update poll, which the generic `Focused` route
                // at the bottom of this handler does not know about.
                //
                // A bare `app.emit` does NOT do this — it broadcasts to every
                // registered listener regardless of target label (an unfiltered
                // `emit` matches `Any`), so every window's `onCheckUpdatesRequested`
                // would fire and race to run its own check. `emit_to` is what
                // actually restricts delivery to one window, the same primitive
                // `ai_socket.rs` uses to route a command to the window that owns
                // its file. The update-checker claim holder is the natural
                // target since it already owns update work; fall back to the
                // window a document action would go to if no claim has been
                // made yet (e.g. the poll hasn't started).
                if id == "check_updates" {
                    let target = _app
                        .state::<UpdateState>()
                        .checker_label()
                        .or_else(|| focused_window(_app));
                    if let Some(label) = target {
                        let _ = _app.emit_to(label.as_str(), "check-updates-requested", ());
                    }
                    return;
                }

                // Language radio group. Unlike Theme's checkboxes, a language
                // click needs no `Toggle`/`flip` dance: the id itself already
                // names the final value, not "switch it". `apply_language_change`
                // persists it, saves the session explicitly (a restart on the
                // main thread skips `RunEvent::Exit`, so `save_session_on_exit`
                // would otherwise never run), then restarts the process — the
                // rebuilt menu picks up the new language from `preferences.json`
                // on the way back up.
                if let Some(rest) = id.strip_prefix("language_") {
                    let language = if rest == "system" { None } else { Some(rest.to_string()) };
                    if let Err(e) = apply_language_change(_app, language) {
                        // `eprintln!` alone is invisible in a bundled app: the
                        // user clicked a language, nothing visibly happened, and
                        // that is indistinguishable from a broken menu item.
                        // This app already decided silent write failures need a
                        // surface — `save-error` and `comment-error` exist for
                        // exactly this reason — so this gets the same treatment.
                        eprintln!("language change: {}", e);
                        let _ = _app.emit("language-change-failed", &e);
                    }
                    return;
                }

                // Галочка обязана нести значение, а не команду «переключи».
                //
                // Ниже событие рассылается во все окна, и каждое применяет его
                // к своей копии настройки. Для radio-пункта это безвредно: N
                // окон выставляют одно и то же значение. Для тумблера — нет:
                // N окон переключают его N раз, и с двумя открытыми окнами
                // галочка на экране не меняется вовсе.
                //
                // Значение берётся из `Toggle`, а не из самого пункта меню:
                // macOS применяет щелчок уже после нашего обработчика, и пункт
                // отвечает доизменённым состоянием.
                let id = match toggle_value(_app, &id) {
                    Some(true) => format!("{id}:on"),
                    Some(false) => format!("{id}:off"),
                    None => id,
                };

                match menu_route::menu_route(&id) {
                    menu_route::MenuRoute::Broadcast => {
                        let _ = _app.emit("menu-event", &id);
                    }
                    menu_route::MenuRoute::Focused => {
                        if let Some(label) = focused_window(_app) {
                            let _ = _app.emit_to(label.as_str(), "menu-event", &id);
                        }
                    }
                }
            });

            // Handle CLI args on initial launch
            handle_cli_args(app.handle());

            // Handle files from CLI wrapper (written to temp file before `open`)
            load_pending_open_files(app.handle());

            // Crash-safety net. The authoritative save happens on the way out
            // (see `save_session_on_exit`); this only catches a hard kill.
            let ticker_handle = app.handle().clone();
            std::thread::spawn(move || {
                // `None`: purge on the first tick — an app that ran for weeks
                // empties the trash when it is next launched.
                let mut last_purge: Option<std::time::Instant> = None;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(1000));
                    let state = ticker_handle.state::<SessionState>();
                    if state.is_quitting() {
                        return;
                    }
                    // No live window (launch before the first heartbeat, or the
                    // last window destroyed ahead of the exit path): the file on
                    // disk stands — `snapshot_to_write` says why. The GC waits
                    // too: in the second case the file still names the destroyed
                    // window's draft, which nothing in memory references any
                    // more, and trashing it would restore that tab empty-handed.
                    if state.take_dirty() {
                        if let Some(snapshot) = state.snapshot_to_write(session::now_secs()) {
                            let _ = session::write_session(&snapshot);
                            // Includes the pending restore's buffers, not just the
                            // live ones, and everything the file just written
                            // names — see `untitled_to_keep_after`. What it leaves
                            // out goes to `session/.trash/`, never away.
                            session::prune_untitled_files(&state.untitled_to_keep_after(&snapshot));
                        }
                    }
                    let purge_due = match last_purge {
                        None => true,
                        Some(at) => at.elapsed() >= session::DRAFTS_TRASH_PURGE_EVERY,
                    };
                    if purge_due {
                        session::purge_drafts_trash(session::now_secs());
                        last_purge = Some(std::time::Instant::now());
                    }
                }
            });

            // Command socket for the `couplet show`/`edit` CLI verbs. Started last —
            // it can dispatch to windows created earlier in setup, but nothing
            // earlier in setup depends on it.
            ai_socket::start(app.handle());

            // One-time "what's new" window on a version bump. Never breaks
            // startup on failure — see `onboarding::maybe_show`.
            onboarding::maybe_show(app.handle());

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { .. } => {
                    // Allow close — the frontend auto-saves, so no need to prompt.
                    //
                    // A comment paused a second ago is a different matter: its
                    // countdown is about to stop existing along with this
                    // window, and a thread left `paused` is one no agent ever
                    // comes to. So the pause is ended here, while the window
                    // still knows which document it was showing.
                    let app = window.app_handle();
                    for doc in comment_pause::documents_of_window(app, window.label()) {
                        comment_pause::commit_document(&doc);
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    let app = window.app_handle();
                    let label = window.label();
                    app.state::<menu_route::FocusTracker>().forget(label);
                    let session_state = app.state::<SessionState>();
                    // Before `remove` and `untrack_window` below erase what
                    // this window held. The registry lock is released before
                    // `record_window_close` takes the stack's — see
                    // `ClosedStack` on lock order.
                    let closing = {
                        let open_files = app.state::<OpenFiles>();
                        let reg = open_files.0.lock().unwrap();
                        reg.window(label).cloned()
                    };
                    if let Some(tabs) = closing {
                        let stack = app.state::<closed::ClosedStack>();
                        if closed::record_window_close(&session_state, &stack, label, &tabs) > 0 {
                            closed::refresh_reopen_item(app);
                        }
                    }
                    // No-op while quitting, so an exit keeps every window.
                    session_state.remove(label);
                    // Hand the update poll to a surviving window.
                    app.state::<UpdateState>().release(label);
                    window::untrack_window(app, label);
                }
                tauri::WindowEvent::Focused(true) => {
                    window
                        .app_handle()
                        .state::<menu_route::FocusTracker>()
                        .focused(window.label());
                }
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                    let app = window.app_handle();
                    let label = window.label().to_string();
                    if let Some((x, y, width, height)) = session::window_geometry(window) {
                        app.state::<SessionState>()
                            .set_geometry(&label, x, y, width, height);
                    }
                }
                _ => {}
            }
        });

    let app = builder
        .build(context)
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        match event {
            tauri::RunEvent::Opened { urls } => {
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .filter_map(|path| path.to_str().map(str::to_string))
                    .collect();
                if !paths.is_empty() {
                    open_os_files(_app_handle.clone(), paths);
                }
            }
            tauri::RunEvent::Reopen { .. } => {
                // App re-activated (Dock click, `open` while running)
                // Open any pending files from CLI wrapper in new windows
                open_pending_files(_app_handle);
            }
            // Both quit paths must be handled, and they are NOT interchangeable:
            //   * `ExitRequested` only fires from `app.exit()` or after the last
            //     window is destroyed.
            //   * Cmd+Q and the AppleEvent `quit` that Homebrew sends go through
            //     `NSApp terminate:` -> `applicationWillTerminate` -> tao's
            //     `LoopDestroyed` -> `RunEvent::Exit`, and never emit
            //     `ExitRequested` at all.
            // Handling only the former would lose the session on exactly the
            // upgrade path this feature exists for.
            tauri::RunEvent::ExitRequested { .. } => {
                save_session_on_exit(_app_handle);
            }
            tauri::RunEvent::Exit => {
                save_session_on_exit(_app_handle);
            }
            _ => {}
        }
    });
}

/// Persist the language preference (`None` = follow system), then restart the
/// app so the native menu — built once in `setup`, never rebuilt live — comes
/// back up with the new language. Called from the native menu's Language
/// items, the only caller: there is no IPC counterpart (an in-app language
/// picker would need one, but nothing calls this from the frontend today —
/// see the removed `set_language` command's history for why an unvalidated
/// IPC entry point here is worth avoiding rather than convenient to keep).
///
/// `AppHandle::restart()` never returns (it calls `cleanup_before_exit()` then
/// `process::restart()`), and critically it does so **without** emitting
/// `RunEvent::Exit` when called from the main thread — which is exactly where
/// a menu handler and an IPC command both run. `save_session_on_exit` is
/// therefore called explicitly here rather than relied upon via the event; see
/// the trap documented at `docs/superpowers/specs/2026-09-21-i18n-design.md`.
fn apply_language_change(app: &tauri::AppHandle, language: Option<String>) -> Result<(), String> {
    preferences::write_language(language)?;
    save_session_on_exit(app);
    // `AppHandle::restart()` skips `RunEvent::Exit` (that is why `save_session_on_exit`
    // is called explicitly above), and the single-instance plugin only unlinks its
    // socket from that same event (`tauri-plugin-single-instance`'s macOS impl removes
    // it in its `RunEvent::Exit` handler, nowhere else). `restart()` spawns the child
    // process and then exits the parent — `tauri::process::restart` — so the two
    // briefly overlap. If the child's single-instance handshake reaches the parent's
    // listening socket before the parent has torn it down, the child reads that as
    // "an instance is already running" and exits as a duplicate, and couplet never
    // comes back. Removing the socket ourselves, here, closes that window.
    tauri_plugin_single_instance::destroy(app);
    app.restart();
}

/// Snapshot and persist the session on the way out, then freeze it.
///
/// Freezing first is what makes the following `Destroyed` storm harmless: a quit
/// destroys every window, and `SessionState::remove` is a no-op once quitting.
/// Whichever quit path fires first wins; the second call returns immediately.
fn save_session_on_exit(app: &tauri::AppHandle) {
    let state = app.state::<SessionState>();
    if state.is_quitting() {
        return;
    }
    // Both quit paths call this, and either one is the last thing that runs —
    // clean up the command socket file here rather than duplicating it at each
    // `RunEvent` match arm.
    ai_socket::remove_socket(app);
    // Same reason as in `CloseRequested`, for the path where no window is ever
    // asked to close: Cmd+Q and the AppleEvent quit reach us through
    // `RunEvent::Exit` alone. A comment paused seconds before a quit has to be
    // handed over on the way out, or nothing is left to hand it over.
    comment_pause::commit_all_open(app);
    let snapshot = state.snapshot_to_write(session::now_secs());
    state.mark_quitting();
    // A quit records the session, it never erases it: with no live window
    // left, the last good file on disk stands (`snapshot_to_write` says why
    // that also keeps the un-restored drafts named).
    if let Some(snapshot) = snapshot {
        let _ = session::write_session(&snapshot);
    }
}

/// The window a document-scoped menu action belongs to — see `menu_route`.
///
/// Only a window the user can see is a candidate. With every window minimized
/// the app stays active with no key window, and the tracker still names the
/// last one — ⌘W would close it and ⌘S would save a document nobody is looking
/// at. No candidate means the action does nothing.
fn focused_window(app: &tauri::AppHandle) -> Option<String> {
    let live: Vec<String> = app
        .webview_windows()
        .into_iter()
        .filter(|(_, w)| w.is_visible().unwrap_or(true) && !w.is_minimized().unwrap_or(false))
        .map(|(label, _)| label)
        .collect();
    let last = app.state::<menu_route::FocusTracker>().last();
    menu_route::menu_target(last.as_deref(), &live)
}

/// Files the OS handed over (`RunEvent::Opened`: Finder, Open With, a drop on
/// the Dock icon), routed by project (`window::route_opened_file`, Q4).
///
/// Off the main thread: normalizing a path, binding projects and finding the
/// file's own walk directories, and on a slow or network volume that would
/// freeze every window. Each file's open then runs on the main thread (window
/// creation belongs there) and is waited for before the next file is routed,
/// so a second file of the same new project finds the window the first one
/// built. Locks as everywhere: the tracker's and the registry's one at a time,
/// none held across the walk or the hop.
fn open_os_files(app: tauri::AppHandle, paths: Vec<String>) {
    tauri::async_runtime::spawn_blocking(move || {
        for raw in paths {
            let file_path = resolve_path(&raw, None);
            routing::bind_missing_projects(&app);
            let file_project = routing::project_of(&file_path);
            let order = app.state::<menu_route::FocusTracker>().order();
            let route = {
                let open_files = app.state::<window::OpenFiles>();
                let reg = open_files.0.lock().unwrap();
                window::route_opened_file(&reg, &file_path, &file_project, &order, |label| {
                    app.get_webview_window(label).is_some()
                })
            };
            let (done_tx, done_rx) = std::sync::mpsc::channel();
            let handle = app.clone();
            let hopped = app.run_on_main_thread(move || {
                open_routed(&handle, route, file_path);
                let _ = done_tx.send(());
            });
            if hopped.is_err() {
                return;
            }
            let _ = done_rx.recv();
        }
    });
}

/// Act on one `route_opened_file` decision. A human's open: the window it
/// lands in comes forward.
fn open_routed(app: &tauri::AppHandle, route: window::OpenedRoute, file_path: String) {
    match route {
        window::OpenedRoute::FocusExisting(label) => {
            if let Some(win) = app.get_webview_window(&label) {
                window::reveal(&win);
                // The file may sit in a background tab there; that window
                // activates it through its own open path.
                let _ = win.emit_to(label.as_str(), "open-file", &file_path);
            }
        }
        window::OpenedRoute::ProjectWindow(label) => {
            if assign_file_to(app, &label, file_path) {
                if let Some(win) = app.get_webview_window(&label) {
                    window::reveal(&win);
                }
            }
        }
        window::OpenedRoute::UseMain => {
            assign_file_to_main(app, file_path);
        }
        window::OpenedRoute::NewWindow => {
            window::open_file_window(app, Some(file_path));
        }
    }
}

/// Give the `main` window a tab for `path`.
///
/// Before its frontend mounts, an event would be lost: the tab is registered
/// in `OpenFiles` — every dedup check consults it, so a tab only in
/// `PendingFiles` is invisible to them and opening the file again produces a
/// duplicate window — and waits in main's pending payload. A tab, not a
/// replacement: launch arguments may add several. Once mounted, main gets
/// `open-file` and opens and claims the tab itself.
///
/// Returns `false` when another live window already holds the file: that
/// window is brought forward instead and main is left untouched.
fn assign_file_to_main(app: &tauri::AppHandle, path: String) -> bool {
    assign_file_to(app, "main", path)
}

/// `assign_file_to_main` for any window `label` — a Finder open landing in
/// its project's window (tabs-questions Q4).
fn assign_file_to(app: &tauri::AppHandle, label: &str, path: String) -> bool {
    let tab = PendingTab {
        tab_id: session::new_tab_id(),
        path: Some(path.clone()),
        content: None,
        cursor: 0,
        top_line: 1,
        ..Default::default()
    };
    match window::hand_over_tab(app, label, tab) {
        window::Handover::Pending => true,
        window::Handover::Mounted => {
            // `emit_to`, not `emit`: a bare `emit` reaches every window.
            if let Some(win) = app.get_webview_window(label) {
                let _ = win.emit_to(label, "open-file", &path);
                let _ = win.set_focus();
            }
            true
        }
        window::Handover::Held(owner) => {
            eprintln!("assign_file_to: {path} is held by {owner}; focusing it instead of {label}");
            if let Some(win) = app.get_webview_window(&owner) {
                window::reveal(&win);
            }
            false
        }
    }
}

/// Resolve a potentially relative path to an absolute one, in its one
/// spelling (`path_norm::normalize_path`) — absolute paths included.
pub(crate) fn resolve_path(path: &str, cwd: Option<&str>) -> String {
    let p = std::path::Path::new(path);
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        match cwd {
            Some(c) => std::path::PathBuf::from(c),
            None => std::env::current_dir().unwrap_or_default(),
        }
        .join(p)
    };
    path_norm::normalize_path(&joined).to_string_lossy().into_owned()
}

/// Where `scripts/couplet` leaves the file list when it has to launch the app
/// with `open` (which passes no arguments). Spelled out in the script too —
/// `cli_script_tests` pins the two together.
pub(crate) const PENDING_FILES_PATH: &str = "/tmp/couplet-pending-files";

/// Open pending files when app is already running (Reopen event): one new
/// window, the files as its tabs.
fn open_pending_files(app: &tauri::AppHandle) {
    let path = std::path::Path::new(PENDING_FILES_PATH);
    if !path.exists() {
        return;
    }
    let contents = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let _ = std::fs::remove_file(path);

    let files: Vec<String> = contents
        .lines()
        .map(str::trim)
        .filter(|f| !f.is_empty())
        .map(|f| resolve_path(f, None))
        .collect();
    if !files.is_empty() {
        window::open_files_window(app, &files);
    }
}

/// Load files written by the CLI wrapper script to `PENDING_FILES_PATH`:
/// each becomes a tab of "main", as CLI args do.
fn load_pending_open_files(app: &tauri::AppHandle) {
    let path = std::path::Path::new(PENDING_FILES_PATH);
    if !path.exists() {
        return;
    }
    let contents = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let _ = std::fs::remove_file(path);

    for line in contents.lines() {
        let file = line.trim();
        if !file.is_empty() {
            // The wrapper writes absolute paths; this gives them their one spelling.
            assign_file_to_main(app, resolve_path(file, None));
        }
    }
}

/// Handle CLI file arguments on initial launch: every file is a tab of the
/// "main" window, pulled via PendingFiles on mount (spec §4: one window, the
/// files as tabs).
fn handle_cli_args(app: &tauri::AppHandle) {
    if let Ok(matches) = app.cli().matches() {
        if let Some(files_arg) = matches.args.get("files") {
            if let serde_json::Value::Array(arr) = &files_arg.value {
                for val in arr {
                    if let serde_json::Value::String(path) = val {
                        if path.is_empty() {
                            continue;
                        }
                        assign_file_to_main(app, resolve_path(path.as_str(), None));
                    }
                }
            }
        }
    }
}

/// `scripts/couplet` is bash, so it cannot read the config: it spells out the
/// bundle path, both sockets and the pending-files path by hand. Each value
/// has a Rust-side owner, and a mismatch fails silently — files not opened,
/// commands waiting on a socket nobody binds. These tests read the script and
/// hold every value to the thing it has to agree with.
#[cfg(test)]
mod cli_script_tests {
    const SCRIPT: &str = include_str!("../../scripts/couplet");

    fn config_str(key: &str) -> String {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("config is JSON");
        config[key].as_str().unwrap_or_else(|| panic!("{key} is set")).to_string()
    }

    /// The value of a top-level `NAME="…"` assignment, as written.
    fn raw(name: &str) -> String {
        let prefix = format!("{name}=\"");
        let line = SCRIPT
            .lines()
            .find(|l| l.starts_with(&prefix))
            .unwrap_or_else(|| panic!("scripts/couplet assigns {name}"));
        line[prefix.len()..].trim_end().trim_end_matches('"').to_string()
    }

    /// The same, with `$APP` expanded the way bash would.
    fn var(name: &str) -> String {
        raw(name).replace("$APP", &raw("APP"))
    }

    #[test]
    fn app_and_binary_follow_the_bundle() {
        let app = format!("/Applications/{}.app", config_str("productName"));
        assert_eq!(var("APP"), app);
        assert_eq!(var("BIN"), format!("{app}/Contents/MacOS/{}", config_str("mainBinaryName")));
    }

    #[test]
    fn single_instance_socket_follows_the_identifier() {
        // tauri-plugin-single-instance on macOS: `/tmp/{identifier, `.`/`-` as `_`}_si.sock`.
        let identifier = config_str("identifier").replace(['.', '-'], "_");
        assert_eq!(var("SOCK"), format!("/tmp/{identifier}_si.sock"));
    }

    #[test]
    fn command_socket_is_the_one_the_app_binds() {
        let expected = crate::ai_socket::socket_path(crate::paths::RELEASE_PRODUCT_NAME);
        assert_eq!(var("CMD_SOCK"), expected.to_string_lossy());
    }

    #[test]
    fn pending_files_path_is_the_one_the_app_reads() {
        assert_eq!(var("PENDING"), super::PENDING_FILES_PATH);
    }

    /// Runs a copy of the script whose `APP` points at a fake bundle under a
    /// scratch dir. The fake binary leaves a file behind if anything runs it.
    #[cfg(target_os = "macos")]
    fn run_against_fake_bundle(tag: &str, version: Option<&str>, arg: &str) -> (std::process::Output, bool) {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("couplet-cli-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let app = dir.join("couplet.app");
        let macos = app.join("Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        if let Some(version) = version {
            std::fs::write(
                app.join("Contents/Info.plist"),
                format!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\
                     <key>CFBundleShortVersionString</key><string>{version}</string></dict></plist>\n"
                ),
            )
            .unwrap();
        }
        let ran = dir.join("binary-ran");
        let bin = macos.join("couplet");
        std::fs::write(&bin, format!("#!/bin/sh\ntouch '{}'\n", ran.display())).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        let script: String = SCRIPT
            .lines()
            .map(|l| if l.starts_with("APP=\"") { format!("APP=\"{}\"", app.display()) } else { l.to_string() })
            .collect::<Vec<_>>()
            .join("\n");
        let script_path = dir.join("couplet");
        std::fs::write(&script_path, script).unwrap();

        let out = std::process::Command::new("bash").arg(&script_path).arg(arg).output().unwrap();
        let binary_ran = ran.exists();
        let _ = std::fs::remove_dir_all(&dir);
        (out, binary_ran)
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn version_is_read_from_the_bundle_and_never_launches_the_app() {
        for arg in ["--version", "-V"] {
            let (out, binary_ran) = run_against_fake_bundle("version", Some("9.8.7"), arg);
            assert!(out.status.success(), "{arg}: {out:?}");
            assert_eq!(String::from_utf8_lossy(&out.stdout), "couplet 9.8.7\n", "{arg}");
            assert!(!binary_ran, "{arg} must not run the app binary");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn version_without_a_bundle_fails_instead_of_launching() {
        let (out, binary_ran) = run_against_fake_bundle("no-plist", None, "--version");
        assert_eq!(out.status.code(), Some(1));
        assert!(out.stdout.is_empty());
        assert!(!binary_ran);
    }
}
