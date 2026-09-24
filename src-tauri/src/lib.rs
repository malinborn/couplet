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
mod i18n;
mod locale;
pub mod mcp_server;
mod menu;
mod menu_route;
mod migration;
mod onboarding;
mod paths;
mod preferences;
mod recent;
mod recovery;
mod session;
mod tab_commands;
mod tabs;
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
/// (`sync_theme_menu`, `sync_ocd_alignment_menu`) — без этого `Toggle` не с
/// чего было бы начинать. `toggle_line_glow` такой синхронизации не имеет и
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
    // No-op today: `migration.rs`'s rename table only matches a renamed
    // product/identifier, not the current one. It activates on its own the
    // moment `tauri.conf.json` / `tauri.dev.conf.json` are renamed.
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
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // argv[0] is the binary path — skip it
            let file_args: Vec<String> = argv.into_iter().skip(1).collect();

            if file_args.is_empty() {
                // No files — open a new empty window
                window::open_file_window(app, None);
            } else {
                for path in file_args {
                    if !path.starts_with('-') {
                        let abs_path = resolve_path(&path, None);
                        window::open_file_window(app, Some(abs_path));
                    }
                }
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
            window::open_file_window_cmd,
            window::focus_if_open,
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
            watcher::start_watching,
            ai_socket::ai_respond,
            ai_socket::ai_pull_pending,
            ai_socket::ai_is_pending,
            ai_socket::cancel_ai_ask,
            onboarding::ai_nudge_pending,
            onboarding::ai_nudge_dismiss,
            onboarding::ai_open_getting_started,
            commands::sync_theme_menu,
            commands::sync_engine_menu,
            commands::sync_ocd_alignment_menu,
            i18n::resolved_language,
        ])
        .setup(|app| {
            // FIRST, before anything touches disk: decide which data directory this
            // build owns. A dev build must never share `recovery/` or `session.json`
            // with an installed release one.
            paths::init(app.config().product_name.as_deref().unwrap_or(paths::FALLBACK_PRODUCT_NAME));

            // Managed here, not on the builder: `RecentFiles::load()` reads
            // `recent.json`, and before `paths::init` `app_data_dir()` answers the
            // release directory — a dev build would load the installed app's list.
            // No IPC reaches a command before `setup` returns.
            app.manage(recent::RecentFiles::load());
            // After `paths::init`, for the same reason as `RecentFiles::load`.
            app.manage(window_numbers::WindowNumbers::load());
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

            let (menu, theme_items, engine_items, view_toggles, session_menu_items) =
                menu::build_menu(app.handle(), pending_count, explicit_language.as_deref())?;
            app.set_menu(menu)?;
            app.manage(theme_items);
            app.manage(view_toggles);
            app.manage(engine_items);
            app.manage(session_menu_items);

            let app_handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                let id = event.id().0.as_str().to_string();

                // Handle "new" menu action: open a new empty window
                if id == "new" {
                    window::open_file_window(&app_handle, None);
                    return;
                }

                // Restore windows in Rust, like "new" — it creates windows. The
                // last closed window comes back first; only with none left does
                // the previous session's restore run.
                if id == "reopen_session" {
                    if !closed::reopen_closed(&app_handle) {
                        session::restore_pending(&app_handle);
                    }
                    closed::refresh_reopen_item(&app_handle);
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
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(1000));
                let state = ticker_handle.state::<SessionState>();
                if state.is_quitting() {
                    return;
                }
                if state.take_dirty() {
                    let snapshot = state.snapshot(session::now_secs());
                    let _ = session::write_session(&snapshot);
                    // Must include the pending restore's buffers, not just the
                    // live ones — see `referenced_untitled`.
                    session::prune_untitled_files(&state.referenced_untitled());
                }
            });

            // Command socket for the `mdmini show`/`edit` CLI verbs. Started last —
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
                for url in &urls {
                    if let Ok(path) = url.to_file_path() {
                        if let Some(path_str) = path.to_str() {
                            let file_path = path_str.to_string();
                            let route = {
                                let open_files = _app_handle.state::<window::OpenFiles>();
                                let reg = open_files.0.lock().unwrap();
                                window::route_opened_file(&reg, &file_path, |label| {
                                    _app_handle.get_webview_window(label).is_some()
                                })
                            };
                            match route {
                                window::OpenedRoute::FocusExisting(label) => {
                                    if let Some(win) = _app_handle.get_webview_window(&label) {
                                        window::reveal(&win);
                                        // The file may sit in a background tab
                                        // there; that window activates it
                                        // through its own open path.
                                        let _ = win.emit_to(label.as_str(), "open-file", &file_path);
                                    }
                                }
                                window::OpenedRoute::UseMain => {
                                    assign_file_to_main(_app_handle, file_path);
                                }
                                window::OpenedRoute::NewWindow => {
                                    window::open_file_window(_app_handle, Some(file_path));
                                }
                            }
                        }
                    }
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
    // "an instance is already running" and exits as a duplicate, and md-mini never
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
    let snapshot = state.snapshot(session::now_secs());
    state.mark_quitting();
    // A quit records the session, it never erases it. An empty snapshot here
    // means the windows were already gone before we were called — not that the
    // user had nothing open — so the last good file on disk is the better answer.
    if snapshot.windows.is_empty() {
        return;
    }
    let _ = session::write_session(&snapshot);
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

/// Give the `main` window a tab for `path`.
///
/// Before its frontend mounts, an event would be lost: the tab is registered
/// in `OpenFiles` — every dedup check consults it, and registering only in
/// `PendingFiles` once made the launch file invisible to them, so opening it
/// again produced a duplicate window — and waits in main's pending payload. A
/// tab, not a replacement: launch arguments may add several. Once mounted,
/// main gets `open-file` and opens and claims the tab itself.
///
/// Returns `false` when another live window already holds the file: that
/// window is brought forward instead and main is left untouched.
fn assign_file_to_main(app: &tauri::AppHandle, path: String) -> bool {
    let tab = PendingTab {
        tab_id: session::new_tab_id(),
        path: Some(path.clone()),
        content: None,
        cursor: 0,
        top_line: 1,
    };
    match window::hand_over_tab(app, "main", tab) {
        window::Handover::Pending => true,
        window::Handover::Mounted => {
            // `emit_to`, not `emit`: a bare `emit` reaches every window.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.emit_to("main", "open-file", &path);
                let _ = win.set_focus();
            }
            true
        }
        window::Handover::Held(owner) => {
            eprintln!("assign_file_to_main: {path} is held by {owner}; focusing it instead of main");
            if let Some(win) = app.get_webview_window(&owner) {
                window::reveal(&win);
            }
            false
        }
    }
}

/// Resolve a potentially relative path to an absolute path.
pub(crate) fn resolve_path(path: &str, cwd: Option<&str>) -> String {
    let p = std::path::Path::new(path);
    if p.is_absolute() {
        return path.to_string();
    }
    let base = match cwd {
        Some(c) => std::path::PathBuf::from(c),
        None => std::env::current_dir().unwrap_or_default(),
    };
    base.join(p)
        .canonicalize()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| base.join(path).to_string_lossy().to_string())
}

/// Open pending files when app is already running (Reopen event).
/// Each file gets a new window since "main" already exists.
fn open_pending_files(app: &tauri::AppHandle) {
    let path = std::path::Path::new("/tmp/md-mini-pending-files");
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
            window::open_file_window(app, Some(file.to_string()));
        }
    }
}

/// Load files written by the CLI wrapper script to /tmp/md-mini-pending-files.
/// Uses the same PendingFiles mechanism as CLI args — first file goes into "main" window.
fn load_pending_open_files(app: &tauri::AppHandle) {
    let path = std::path::Path::new("/tmp/md-mini-pending-files");
    if !path.exists() {
        return;
    }
    let contents = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let _ = std::fs::remove_file(path);

    let pending = app.state::<PendingFiles>();
    let mut map = pending.0.lock().unwrap();
    let already_has_main = map.contains_key("main");

    let mut first = !already_has_main; // only use "main" slot if CLI args didn't take it
    drop(map);

    for line in contents.lines() {
        let file = line.trim();
        if file.is_empty() {
            continue;
        }
        if first {
            first = false;
            assign_file_to_main(app, file.to_string());
        } else {
            window::open_file_window(app, Some(file.to_string()));
        }
    }
}

/// Handle CLI file arguments on initial launch.
/// The first file is loaded into the existing "main" window via PendingFiles;
/// any additional files each get a new window (also via PendingFiles).
fn handle_cli_args(app: &tauri::AppHandle) {
    if let Ok(matches) = app.cli().matches() {
        if let Some(files_arg) = matches.args.get("files") {
            if let serde_json::Value::Array(arr) = &files_arg.value {
                let mut first = true;
                for val in arr {
                    if let serde_json::Value::String(path) = val {
                        if path.is_empty() {
                            continue;
                        }
                        let abs_path = resolve_path(path.as_str(), None);
                        if first {
                            first = false;
                            // The "main" window pulls this on mount.
                            assign_file_to_main(app, abs_path);
                        } else {
                            // Additional files each get a new window.
                            window::open_file_window(app, Some(abs_path));
                        }
                    }
                }
            }
        }
    }
}
