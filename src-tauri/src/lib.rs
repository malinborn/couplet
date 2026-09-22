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
pub mod comment_pause;
pub mod comments;
mod commands;
mod i18n;
mod locale;
pub mod mcp_server;
mod menu;
mod migration;
mod onboarding;
mod paths;
mod preferences;
mod recovery;
mod session;
mod updater;
pub mod watch;
mod watcher;
mod window;

use tauri::{Emitter, Manager};
use tauri_plugin_cli::CliExt;
use session::SessionState;
use updater::UpdateState;
use window::{FileWatchers, OpenFiles, PendingFiles, PendingOpen};

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
    // No-op today: `migration.rs`'s legacy-identity table only matches a
    // renamed product/identifier, not the current one. It activates on its
    // own the moment `tauri.conf.json` / `tauri.dev.conf.json` are renamed.
    let context = tauri::generate_context!();
    let product_name = context
        .config()
        .product_name
        .as_deref()
        .unwrap_or("md-mini");
    migration::migrate_app_data_dir_real(product_name);
    migration::migrate_webkit_profile_real(&context.config().identifier);

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
        .manage(UpdateState::new())
        .manage(ai_socket::AiPending::new())
        .manage(ai_socket::AiQueue::new())
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
            recovery::save_recovery,
            recovery::delete_recovery,
            recovery::check_recovery,
            session::update_session_document,
            session::pending_session_count,
            session::restore_session,
            updater::claim_update_checker,
            updater::report_update,
            updater::dismiss_update,
            updater::pending_update,
            watcher::start_watching,
            ai_socket::ai_respond,
            ai_socket::ai_pull_pending,
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
            paths::init(app.config().product_name.as_deref().unwrap_or("md-mini"));

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

            let (menu, theme_items, engine_items, view_toggles) =
                menu::build_menu(app.handle(), pending_count, explicit_language.as_deref())?;
            app.set_menu(menu)?;
            app.manage(theme_items);
            app.manage(view_toggles);
            app.manage(engine_items);

            let app_handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                let id = event.id().0.as_str().to_string();

                // Handle "new" menu action: open a new empty window
                if id == "new" {
                    window::open_file_window(&app_handle, None);
                    return;
                }

                // Restore windows in Rust, like "new" — it creates windows.
                if id == "reopen_session" {
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

                // "Comment on Selection" acts on a specific document's
                // selection, so it goes to the focused window only — same
                // reasoning as "close" below. The generic path at the bottom
                // broadcasts to every window, which is right for global
                // preferences (theme, zoom) but here would drop a draft comment
                // card into every open document at once.
                // "Comment on Selection" acts on one document's selection, so
                // it needs exactly one handler to run exactly once — which the
                // generic path below cannot give it.
                //
                // Two traps, both learned the hard way. First, `is_focused()`
                // queried here is not reliable: the menu bar is what the OS
                // considers active, and gating on it silently swallowed the
                // command. Second, the generic path emits per window in a
                // loop, and `onMenuEvent` listens *globally* — and a global
                // listener's target is `Any`, so it also receives targeted
                // emits (the same trap `onAiCommand` documents). With two
                // windows open, one menu click therefore arrived twice in each
                // window and created a draft card per delivery.
                //
                // So: emit once, app-wide, and let the frontend ignore it
                // unless its own window has focus. That is the only place
                // where focus is actually knowable.
                if id == "ai_comment" {
                    let _ = _app.emit("menu-event", &id);
                    return;
                }

                // Manual "Check for Updates…". Must reach exactly one window,
                // for the same reason "ai_comment" is not routed through the
                // per-window broadcast loop at the bottom of this handler:
                // that loop would fire one GitHub request per open window.
                //
                // A bare `app.emit` does NOT do this — it broadcasts to every
                // registered listener regardless of target label (an unfiltered
                // `emit` matches `Any`), so every window's `onCheckUpdatesRequested`
                // would fire and race to run its own check. `emit_to` is what
                // actually restricts delivery to one window, the same primitive
                // `ai_socket.rs` uses to route a command to the window that owns
                // its file. The update-checker claim holder is the natural
                // target since it already owns update work; fall back to any
                // window if no claim has been made yet (e.g. the poll hasn't
                // started).
                if id == "check_updates" {
                    let target = _app
                        .state::<UpdateState>()
                        .checker_label()
                        .or_else(|| _app.webview_windows().keys().next().cloned());
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

                // Handle "close" — close the focused window directly from Rust
                if id == "close" {
                    for (_label, win) in _app.webview_windows() {
                        if win.is_focused().unwrap_or(false) {
                            let _ = win.close();
                            break;
                        }
                    }
                    return;
                }

                // Галочка обязана нести значение, а не команду «переключи».
                //
                // Ниже событие рассылается во все окна, и каждое применяет его
                // к своей копии настройки. Для radio-пункта это безвредно: N
                // окон выставляют одно и то же значение. Для тумблера — нет:
                // N окон переключают его N раз, и с двумя открытыми окнами
                // галочка на экране не меняется вовсе. Это родня того, что уже
                // описано выше про `ai_comment`, только там дублировалась
                // доставка, а здесь — сам эффект.
                //
                // Значение берётся из `Toggle`, а не из самого пункта меню:
                // macOS применяет щелчок уже после нашего обработчика, и пункт
                // отвечает доизменённым состоянием.
                let id = match toggle_value(_app, &id) {
                    Some(true) => format!("{id}:on"),
                    Some(false) => format!("{id}:off"),
                    None => id,
                };

                // Broadcast all other menu events to all windows
                for (_label, win) in _app.webview_windows() {
                    let _ = win.emit("menu-event", &id);
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
                    if let Some(doc) = comment_pause::document_of_window(app, window.label()) {
                        comment_pause::commit_document(&doc);
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    let app = window.app_handle();
                    let label = window.label();
                    // No-op while quitting, so an exit keeps every window.
                    app.state::<SessionState>().remove(label);
                    // Hand the update poll to a surviving window.
                    app.state::<UpdateState>().release(label);
                    window::untrack_window(app, label);
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
                            // Check if "main" window is empty (not tracking a file)
                            let main_is_empty = {
                                let open_files = _app_handle.state::<window::OpenFiles>();
                                let map = open_files.0.lock().unwrap();
                                !map.values().any(|v| v == "main")
                            };
                            if main_is_empty {
                                // Reuse "main" — store in PendingFiles + OpenFiles
                                let pending = _app_handle.state::<window::PendingFiles>();
                                let mut pmap = pending.0.lock().unwrap();
                                pmap.insert(
                                    "main".to_string(),
                                    PendingOpen::from_path(file_path.clone()),
                                );
                                drop(pmap);
                                let open_files = _app_handle.state::<window::OpenFiles>();
                                let mut map = open_files.0.lock().unwrap();
                                map.insert(file_path.clone(), "main".to_string());
                                drop(map);
                                // Emit in case frontend is already loaded
                                if let Some(win) = _app_handle.get_webview_window("main") {
                                    let _ = win.emit("open-file", &file_path);
                                    let _ = win.set_focus();
                                }
                                // Start watcher
                                if let Ok(watcher) = crate::watcher::watch_file(_app_handle, "main".to_string(), file_path) {
                                    let watchers = _app_handle.state::<window::FileWatchers>();
                                    let mut wmap = watchers.0.lock().unwrap();
                                    wmap.insert("main".to_string(), watcher);
                                }
                            } else {
                                window::open_file_window(_app_handle, Some(file_path));
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

/// Hand a file to the `main` window and register it as open.
///
/// `OpenFiles` is what every dedup check consults — `open_file_window`'s focus
/// path and `open_restored_window`'s. Registering only in `PendingFiles`, as the
/// CLI paths used to, leaves the file the app launched with invisible to both, so
/// opening it a second time or restoring a session that contains it silently
/// produces a duplicate window.
fn assign_file_to_main(app: &tauri::AppHandle, path: String) {
    let pending = app.state::<PendingFiles>();
    pending
        .0
        .lock()
        .unwrap()
        .insert("main".to_string(), PendingOpen::from_path(path.clone()));

    let open_files = app.state::<OpenFiles>();
    open_files.0.lock().unwrap().insert(path, "main".to_string());
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
