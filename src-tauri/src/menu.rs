use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    AppHandle, Wry,
};

/// Истина о тумблере — здесь, а не в пункте меню.
///
/// Прочитать состояние `CheckMenuItem` в обработчике нельзя: macOS применяет
/// щелчок **после** того, как наш код отработал, и пункт отвечает
/// доизменённым значением (измерено: сразу после клика по снятой галочке
/// `is_checked()` даёт `false`). Значение засевается фронтендом при старте —
/// той же синхронизацией, что расставляет отметки, — и дальше живёт здесь.
///
/// Нужно всё это ради одного: событие меню рассылается во все окна, и каждое
/// применяет его к своей копии настройки. Для radio-пункта это безвредно, а
/// «переключи» N окон выполнили бы N раз — с двумя открытыми окнами галочка
/// на экране не менялась бы вовсе.
#[derive(Default)]
pub struct Toggle {
    value: AtomicBool,
}

impl Toggle {
    pub fn set(&self, value: bool) {
        self.value.store(value, Ordering::Relaxed);
    }

    /// Следующее значение — то, которое рассылается окнам.
    pub fn flip(&self) -> bool {
        let next = !self.value.load(Ordering::Relaxed);
        self.value.store(next, Ordering::Relaxed);
        next
    }
}

pub struct ThemeMenuItems {
    pub families: Vec<(&'static str, CheckMenuItem<Wry>)>,
    pub half_light: CheckMenuItem<Wry>,
    pub half_dark: CheckMenuItem<Wry>,
    pub system: CheckMenuItem<Wry>,
    pub follow_system: Toggle,
}

impl ThemeMenuItems {
    /// Single writer for the Theme checkmarks.
    ///
    /// Меню состоит из трёх групп — семья, половина и галочка «система», —
    /// поэтому сюда приходит уже разрешённая тема, а не выбор человека: с
    /// включённой галочкой половину выбирает ОС, и отметка должна стоять на
    /// той, что действительно на экране.
    ///
    /// Семья узнаётся по префиксу, а половина по суффиксу, потому что у
    /// classic идентификатор без префикса вовсе (`light` / `dark`) — так он
    /// записан в настройках у всех, кто уже пользуется приложением.
    pub fn sync(&self, resolved: &str, follow_system: bool) {
        let family = match resolved.rsplit_once('-') {
            Some((prefix, _)) => prefix,
            None => "classic",
        };
        for (name, item) in &self.families {
            let _ = item.set_checked(*name == family);
        }
        let dark = resolved.ends_with("dark");
        let _ = self.half_light.set_checked(!dark);
        let _ = self.half_dark.set_checked(dark);
        let _ = self.system.set_checked(follow_system);
        self.follow_system.set(follow_system);
    }
}

pub struct EngineMenuItems {
    pub raw: CheckMenuItem<Wry>,
    pub live_preview: CheckMenuItem<Wry>,
    pub live_render: CheckMenuItem<Wry>,
}

/// Тумблеры меню View, состояние которых фронтенд синхронизирует при старте.
///
/// Держатся отдельно от `EngineMenuItems` не для порядка: `lib.rs` читает
/// состояние такого пункта, чтобы разослать окнам значение, а не команду
/// «переключи» (см. `toggle_value`), и для этого пункт должен где-то жить.
pub struct ViewToggleItems {
    pub ocd_alignment: CheckMenuItem<Wry>,
    pub ocd_enabled: Toggle,
}

impl EngineMenuItems {
    /// Single writer for the Editor Engine checkmarks: checks exactly the
    /// item matching `engine` ("raw" | "live-preview" | "live-render"),
    /// unchecks the rest.
    pub fn sync(&self, engine: &str) {
        let _ = self.raw.set_checked(engine == "raw");
        let _ = self.live_preview.set_checked(engine == "live-preview");
        let _ = self.live_render.set_checked(engine == "live-render");
    }
}

impl ViewToggleItems {
    pub fn sync_ocd_alignment(&self, enabled: bool) {
        let _ = self.ocd_alignment.set_checked(enabled);
        self.ocd_enabled.set(enabled);
    }
}

pub fn build_menu(
    app: &AppHandle,
    pending_session_count: usize,
) -> tauri::Result<(
    tauri::menu::Menu<Wry>,
    ThemeMenuItems,
    EngineMenuItems,
    ViewToggleItems,
)> {
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

    // Подписи, и только они: идентификаторы (`engine_live_preview`) и значения
    // в настройках (`live-preview`) остались прежними — они записаны на диске
    // у всех, кто уже пользуется приложением.
    let engine_raw = CheckMenuItemBuilder::with_id("engine_raw", "Raw").build(app)?;
    let engine_live_preview =
        CheckMenuItemBuilder::with_id("engine_live_preview", "Preview").build(app)?;
    let engine_live_render =
        CheckMenuItemBuilder::with_id("engine_live_render", "Live Render").build(app)?;
    let engine_submenu = SubmenuBuilder::new(app, "Editor Engine")
        .item(&engine_raw)
        .item(&engine_live_preview)
        .item(&engine_live_render)
        .build()?;

    // Идеально центрированный крестик вместо галочки в чекбоксе — для тех, кого
    // выводит из себя её смещение. Пункт здесь, а не в Theme: это не палитра, а
    // способ рисовать один элемент.
    let toggle_ocd_alignment =
        CheckMenuItemBuilder::with_id("toggle_ocd_alignment", "OCD Alignment").build(app)?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("toggle_mode", "Toggle Raw Markdown")
                .accelerator("CmdOrCtrl+E")
                .build(app)?,
        )
        .item(&engine_submenu)
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
        .item(&toggle_ocd_alignment)
        .build()?;

    // Семья и половина — две независимые группы, а не восемь комбинаций:
    // добавить тему теперь стоит один пункт, а не два, и «система» имеет на
    // что влиять, не будучи при этом отдельным вариантом выбора.
    //
    // Идентификаторы пунктов — `theme_family_classic` и прочие; значения в
    // настройках остались прежними (`light`, `dark`, `aurora-light`…), и
    // «Classic» здесь — то же имя, которым эта семья зовётся в коде с самого
    // начала (`ThemeFamily`), просто раньше в меню она была «Default».
    let theme_family_classic =
        CheckMenuItemBuilder::with_id("theme_family_classic", "Classic").build(app)?;
    let theme_family_aurora =
        CheckMenuItemBuilder::with_id("theme_family_aurora", "Aurora").build(app)?;
    let theme_family_blueprint =
        CheckMenuItemBuilder::with_id("theme_family_blueprint", "Blueprint").build(app)?;
    let theme_family_phosphor =
        CheckMenuItemBuilder::with_id("theme_family_phosphor", "Phosphor").build(app)?;
    let theme_half_light = CheckMenuItemBuilder::with_id("theme_half_light", "Light").build(app)?;
    let theme_half_dark = CheckMenuItemBuilder::with_id("theme_half_dark", "Dark").build(app)?;
    let theme_system =
        CheckMenuItemBuilder::with_id("theme_system", "Follow System").build(app)?;

    let theme_menu = SubmenuBuilder::new(app, "Theme")
        .item(&theme_family_classic)
        .item(&theme_family_aurora)
        .item(&theme_family_blueprint)
        .item(&theme_family_phosphor)
        .separator()
        .item(&theme_half_light)
        .item(&theme_half_dark)
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
        families: vec![
            ("classic", theme_family_classic),
            ("aurora", theme_family_aurora),
            ("blueprint", theme_family_blueprint),
            ("phosphor", theme_family_phosphor),
        ],
        half_light: theme_half_light,
        half_dark: theme_half_dark,
        system: theme_system,
        follow_system: Toggle::default(),
    };

    let engine_items = EngineMenuItems {
        raw: engine_raw,
        live_preview: engine_live_preview,
        live_render: engine_live_render,
    };

    let view_toggles = ViewToggleItems {
        ocd_alignment: toggle_ocd_alignment,
        ocd_enabled: Toggle::default(),
    };

    Ok((menu, theme_items, engine_items, view_toggles))
}
