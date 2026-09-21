use tauri::{
    menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    AppHandle, Wry,
};

pub struct ThemeMenuItems {
    pub light: CheckMenuItem<Wry>,
    pub dark: CheckMenuItem<Wry>,
    pub aurora_light: CheckMenuItem<Wry>,
    pub aurora_dark: CheckMenuItem<Wry>,
    pub system: CheckMenuItem<Wry>,
}

impl ThemeMenuItems {
    /// Single writer for the Theme checkmarks: checks exactly the item
    /// matching the preference ("light" | "dark" | "aurora-light" |
    /// "aurora-dark" | "system"), unchecks the rest.
    pub fn sync(&self, preference: &str) {
        let _ = self.light.set_checked(preference == "light");
        let _ = self.dark.set_checked(preference == "dark");
        let _ = self.aurora_light.set_checked(preference == "aurora-light");
        let _ = self.aurora_dark.set_checked(preference == "aurora-dark");
        let _ = self.system.set_checked(preference == "system");
    }
}

pub struct EngineMenuItems {
    pub raw: CheckMenuItem<Wry>,
    pub live_preview: CheckMenuItem<Wry>,
    pub live_render: CheckMenuItem<Wry>,
    pub beta_in_cycle: CheckMenuItem<Wry>,
}

impl EngineMenuItems {
    /// Single writer for the Editor Engine checkmarks: checks exactly the
    /// item matching `engine` ("raw" | "live-preview" | "live-render"),
    /// unchecks the rest. `beta_in_cycle` is synced separately since it's
    /// an independent toggle, not one of the three mutually exclusive choices.
    pub fn sync(&self, engine: &str) {
        let _ = self.raw.set_checked(engine == "raw");
        let _ = self.live_preview.set_checked(engine == "live-preview");
        let _ = self.live_render.set_checked(engine == "live-render");
    }

    pub fn sync_beta_in_cycle(&self, enabled: bool) {
        let _ = self.beta_in_cycle.set_checked(enabled);
    }
}

pub fn build_menu(
    app: &AppHandle,
    pending_session_count: usize,
) -> tauri::Result<(tauri::menu::Menu<Wry>, ThemeMenuItems, EngineMenuItems)> {
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id("new", "New")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("open", "Open...")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("save", "Save")
                .accelerator("CmdOrCtrl+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("save_as", "Save As...")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("close", "Close Window")
                .accelerator("CmdOrCtrl+W")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("recent_files", "Recent Files...")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id(
                "reopen_session",
                if pending_session_count == 1 {
                    "Reopen 1 Window from Last Session".to_string()
                } else {
                    format!("Reopen {} Windows from Last Session", pending_session_count)
                },
            )
            .accelerator("CmdOrCtrl+Shift+T")
            .enabled(pending_session_count > 0)
            .build(app)?,
        )
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .item(
            &MenuItemBuilder::with_id("select_all", "Select All")
                .accelerator("CmdOrCtrl+A")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("find", "Find...")
                .accelerator("CmdOrCtrl+F")
                .build(app)?,
        )
        .separator()
        // The third way into JSON expansion, after the paste offer and the
        // accelerator. Same PR #11 lesson as "Comment on Selection": a feature
        // reachable only by a chord is a feature only its author uses.
        //
        // No handling needed in lib.rs — an unclaimed id falls through to the
        // generic `menu-event` emit and the frontend switches on it.
        .item(
            &MenuItemBuilder::with_id("format_json", "Format JSON")
                .accelerator("CmdOrCtrl+Shift+J")
                .build(app)?,
        )
        .build()?;

    let engine_raw = CheckMenuItemBuilder::with_id("engine_raw", "Raw").build(app)?;
    let engine_live_preview =
        CheckMenuItemBuilder::with_id("engine_live_preview", "Live Preview").build(app)?;
    let engine_live_render =
        CheckMenuItemBuilder::with_id("engine_live_render", "(beta) Live Render").build(app)?;
    let engine_submenu = SubmenuBuilder::new(app, "Editor Engine")
        .item(&engine_raw)
        .item(&engine_live_preview)
        .separator()
        .item(&engine_live_render)
        .build()?;

    let toggle_beta_in_cycle = CheckMenuItemBuilder::with_id(
        "toggle_beta_in_cycle",
        "Include Live Render in Cmd+E",
    )
    .build(app)?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("toggle_mode", "Toggle Raw Markdown")
                .accelerator("CmdOrCtrl+E")
                .build(app)?,
        )
        .item(&engine_submenu)
        .item(&toggle_beta_in_cycle)
        .separator()
        .item(
            &MenuItemBuilder::with_id("zoom_in", "Zoom In")
                .accelerator("CmdOrCtrl+Plus")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom_out", "Zoom Out")
                .accelerator("CmdOrCtrl+Minus")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom_reset", "Reset Zoom")
                .accelerator("CmdOrCtrl+0")
                .build(app)?,
        )
        .separator()
        .item(
            &CheckMenuItemBuilder::with_id("toggle_line_glow", "Line Glow")
                .build(app)?,
        )
        .build()?;

    // Labels only — the ids and the stored preference values stay `light` and
    // `dark`, so a settings file written by an earlier version still resolves.
    let theme_light = CheckMenuItemBuilder::with_id("theme_light", "Default Light").build(app)?;
    let theme_dark = CheckMenuItemBuilder::with_id("theme_dark", "Default Dark").build(app)?;
    let theme_aurora_light =
        CheckMenuItemBuilder::with_id("theme_aurora_light", "Aurora Light").build(app)?;
    let theme_aurora_dark =
        CheckMenuItemBuilder::with_id("theme_aurora_dark", "Aurora Dark").build(app)?;
    let theme_system = CheckMenuItemBuilder::with_id("theme_system", "System").build(app)?;

    let theme_menu = SubmenuBuilder::new(app, "Theme")
        .item(&theme_light)
        .item(&theme_dark)
        .item(&theme_aurora_light)
        .item(&theme_aurora_dark)
        .separator()
        .item(&theme_system)
        .build()?;

    let app_menu = SubmenuBuilder::new(app, "md-mini")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // "Getting Started" is deliberately first and deliberately named the same
    // thing the startup nudge says out loud — a user who half-remembers the
    // toast a month later scans this menu for that exact phrase.
    let ai_menu = SubmenuBuilder::new(app, "AI")
        .item(
            &MenuItemBuilder::with_id("ai_getting_started", "Getting Started").build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("ai_connect_cli", "Connect AI via CLI").build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("ai_connect_mcp", "Connect AI via MCP").build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("ai_teach", "Teach your AI md-mini").build(app)?,
        )
        .separator()
        // The one item here that *does* something to the open document rather
        // than explaining setup. It carries an accelerator because it is used
        // repeatedly while reading, but it stays in the menu regardless: the
        // PR #11 lesson is that a feature needs a permanent home a user can
        // scan for, not only a shortcut they have to already know.
        //
        // No handling needed in lib.rs — an unclaimed id falls through to the
        // generic `menu-event` emit, and the frontend switches on it.
        .item(
            &MenuItemBuilder::with_id("ai_comment", "Comment on Selection")
                .accelerator("CmdOrCtrl+Shift+M")
                .build(app)?,
        )
        // Nothing in the app can make an agent watch for comments — that has
        // to happen in the agent's own session, which the editor cannot reach
        // into. So the discoverable surface is a command the user hands over,
        // and it belongs next to the other "Connect AI via …" items.
        .item(
            &MenuItemBuilder::with_id("ai_watch_command", "Connect Agent to Doc Questions")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("ai_playbook", "AI Playbook").build(app)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&theme_menu)
        .item(&ai_menu)
        .build()?;

    let theme_items = ThemeMenuItems {
        light: theme_light,
        dark: theme_dark,
        aurora_light: theme_aurora_light,
        aurora_dark: theme_aurora_dark,
        system: theme_system,
    };

    let engine_items = EngineMenuItems {
        raw: engine_raw,
        live_preview: engine_live_preview,
        live_render: engine_live_render,
        beta_in_cycle: toggle_beta_in_cycle,
    };

    Ok((menu, theme_items, engine_items))
}
