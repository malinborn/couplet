use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    AppHandle, Wry,
};

use crate::i18n::t;

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

/// `explicit_language` is the stored preference (`preferences::read_language`),
/// `None` meaning "follow system" — it decides which item in the Language
/// radio group starts checked. There is no runtime `sync` for it like Theme
/// or Editor Engine have: a language change restarts the app (see
/// `lib.rs::apply_language_change`), so the menu is only ever built once per
/// process with the answer already known.
pub fn build_menu(
    app: &AppHandle,
    pending_session_count: usize,
    explicit_language: Option<&str>,
) -> tauri::Result<(
    tauri::menu::Menu<Wry>,
    ThemeMenuItems,
    EngineMenuItems,
    ViewToggleItems,
)> {
    let file_menu = SubmenuBuilder::new(app, t("menu.file.title"))
        .item(
            &MenuItemBuilder::with_id("new", t("menu.file.new"))
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("open", t("menu.file.open"))
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("save", t("menu.file.save"))
                .accelerator("CmdOrCtrl+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("save_as", t("menu.file.save_as"))
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("close", t("menu.file.close"))
                .accelerator("CmdOrCtrl+W")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("recent_files", t("menu.file.recent_files")).build(app)?)
        .separator()
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

    let edit_menu = SubmenuBuilder::new(app, t("menu.edit.title"))
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .item(
            &MenuItemBuilder::with_id("select_all", t("menu.edit.select_all"))
                .accelerator("CmdOrCtrl+A")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("find", t("menu.edit.find"))
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
            &MenuItemBuilder::with_id("format_json", t("menu.edit.format_json"))
                .accelerator("CmdOrCtrl+Shift+J")
                .build(app)?,
        )
        .build()?;

    // Подписи, и только они: идентификаторы (`engine_live_preview`) и значения
    // в настройках (`live-preview`) остались прежними — они записаны на диске
    // у всех, кто уже пользуется приложением.
    let engine_raw = CheckMenuItemBuilder::with_id("engine_raw", t("menu.view.engine_raw")).build(app)?;
    let engine_live_preview =
        CheckMenuItemBuilder::with_id("engine_live_preview", t("menu.view.engine_preview")).build(app)?;
    let engine_live_render =
        CheckMenuItemBuilder::with_id("engine_live_render", t("menu.view.engine_live_render")).build(app)?;
    let engine_submenu = SubmenuBuilder::new(app, t("menu.view.engine_title"))
        .item(&engine_raw)
        .item(&engine_live_preview)
        .item(&engine_live_render)
        .build()?;

    // Идеально центрированный крестик вместо галочки в чекбоксе — для тех, кого
    // выводит из себя её смещение. Пункт здесь, а не в Theme: это не палитра, а
    // способ рисовать один элемент.
    let toggle_ocd_alignment =
        CheckMenuItemBuilder::with_id("toggle_ocd_alignment", t("menu.view.ocd_alignment")).build(app)?;

    let view_menu = SubmenuBuilder::new(app, t("menu.view.title"))
        .item(
            &MenuItemBuilder::with_id("toggle_mode", t("menu.view.toggle_mode"))
                .accelerator("CmdOrCtrl+E")
                .build(app)?,
        )
        .item(&engine_submenu)
        .separator()
        .item(
            // `Equal`, а не `Plus`: muda разбирает ускорители по кодам клавиш
            // (`Minus`, `Digit0`, `Equal`), а `Plus` кодом не является — пункт
            // оставался без клавиши вовсе, и по нему было видно, что чего-то
            // не хватает, только в сравнении с соседним Zoom Out.
            &MenuItemBuilder::with_id("zoom_in", t("menu.view.zoom_in"))
                .accelerator("CmdOrCtrl+Equal")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom_out", t("menu.view.zoom_out"))
                .accelerator("CmdOrCtrl+Minus")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom_reset", t("menu.view.zoom_reset"))
                .accelerator("CmdOrCtrl+0")
                .build(app)?,
        )
        .separator()
        .item(&CheckMenuItemBuilder::with_id("toggle_line_glow", t("menu.view.line_glow")).build(app)?)
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
    //
    // Названия семей — Classic / Aurora / Blueprint / Phosphor / Paper / Ink —
    // имена собственные и не переводятся.
    let theme_family_classic = CheckMenuItemBuilder::with_id("theme_family_classic", "Classic").build(app)?;
    let theme_family_aurora = CheckMenuItemBuilder::with_id("theme_family_aurora", "Aurora").build(app)?;
    let theme_family_blueprint =
        CheckMenuItemBuilder::with_id("theme_family_blueprint", "Blueprint").build(app)?;
    let theme_family_phosphor =
        CheckMenuItemBuilder::with_id("theme_family_phosphor", "Phosphor").build(app)?;
    let theme_family_paper = CheckMenuItemBuilder::with_id("theme_family_paper", "Paper").build(app)?;
    let theme_family_ink = CheckMenuItemBuilder::with_id("theme_family_ink", "Ink").build(app)?;
    let theme_half_light =
        CheckMenuItemBuilder::with_id("theme_half_light", t("menu.theme.half_light")).build(app)?;
    let theme_half_dark =
        CheckMenuItemBuilder::with_id("theme_half_dark", t("menu.theme.half_dark")).build(app)?;
    let theme_system =
        CheckMenuItemBuilder::with_id("theme_system", t("menu.common.follow_system")).build(app)?;

    let theme_menu = SubmenuBuilder::new(app, t("menu.theme.title"))
        .item(&theme_family_classic)
        .item(&theme_family_aurora)
        .item(&theme_family_blueprint)
        .item(&theme_family_phosphor)
        .item(&theme_family_paper)
        .item(&theme_family_ink)
        .separator()
        .item(&theme_half_light)
        .item(&theme_half_dark)
        .separator()
        .item(&theme_system)
        .build()?;

    // Язык — та же радиогруппа, что Theme: «Follow System» чекбоксом сверху,
    // разделитель, затем варианты. Ровно один отмечен изначально, и навсегда
    // на время процесса — смена языка перестраивает меню не «на лету», а
    // рестартом (см. `lib.rs::apply_language_change`), так что здесь не нужен
    // ни `Toggle`, ни последующий `sync`: правильная отметка известна уже в
    // момент постройки меню.
    //
    // Названия языков — на самих языках, не переводятся: немец находит
    // «Deutsch» в любой локали.
    let language_system =
        CheckMenuItemBuilder::with_id("language_system", t("menu.common.follow_system")).build(app)?;
    let language_en = CheckMenuItemBuilder::with_id("language_en", "English").build(app)?;
    let language_es = CheckMenuItemBuilder::with_id("language_es", "Español").build(app)?;
    let language_de = CheckMenuItemBuilder::with_id("language_de", "Deutsch").build(app)?;
    let language_fr = CheckMenuItemBuilder::with_id("language_fr", "Français").build(app)?;
    let language_ru = CheckMenuItemBuilder::with_id("language_ru", "Русский").build(app)?;
    let language_zh = CheckMenuItemBuilder::with_id("language_zh", "简体中文").build(app)?;

    // Builder-time defaults are unchecked (same as every other `CheckMenuItem`
    // in this file); the correct mark is applied right after construction via
    // `set_checked`, the same method `ThemeMenuItems::sync` and
    // `EngineMenuItems::sync` use at runtime — proven to exist, unlike a
    // builder-time `checked()` this file never otherwise relies on.
    let _ = language_system.set_checked(explicit_language.is_none());
    let _ = language_en.set_checked(explicit_language == Some("en"));
    let _ = language_es.set_checked(explicit_language == Some("es"));
    let _ = language_de.set_checked(explicit_language == Some("de"));
    let _ = language_fr.set_checked(explicit_language == Some("fr"));
    let _ = language_ru.set_checked(explicit_language == Some("ru"));
    let _ = language_zh.set_checked(explicit_language == Some("zh"));

    let language_menu = SubmenuBuilder::new(app, t("menu.app.language"))
        .item(&language_system)
        .separator()
        .item(&language_en)
        .item(&language_es)
        .item(&language_de)
        .item(&language_fr)
        .item(&language_ru)
        .item(&language_zh)
        .build()?;

    // Заголовок подменю приложения — «md-mini» — не переводится: macOS сама
    // подставляет туда имя бандла.
    let app_menu = SubmenuBuilder::new(app, "md-mini")
        .about(None)
        .separator()
        .item(&MenuItemBuilder::with_id("check_updates", t("menu.app.check_updates")).build(app)?)
        .separator()
        .item(&language_menu)
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
    // Один пункт вместо четырёх («Getting Started», «Connect via CLI»,
    // «Connect via MCP», «Teach your AI»). Каждый из них объяснял свою часть и
    // оставлял сборку человеку — владелец, подключая себе, в итоге составлял
    // из них солянку вручную. Теперь документ выдаёт промпт, а сборку делает
    // агент: см. `onboarding::connect_doc`.
    let ai_menu = SubmenuBuilder::new(app, t("menu.ai.title"))
        .item(&MenuItemBuilder::with_id("ai_connect", t("menu.ai.connect")).build(app)?)
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
            &MenuItemBuilder::with_id("ai_comment", t("menu.ai.comment"))
                .accelerator("CmdOrCtrl+Shift+M")
                .build(app)?,
        )
        // Nothing in the app can make an agent watch for comments — that has
        // to happen in the agent's own session, which the editor cannot reach
        // into. So the discoverable surface is a command the user hands over,
        // and it belongs next to the other "Connect AI via …" items.
        .item(&MenuItemBuilder::with_id("ai_watch_command", t("menu.ai.watch_command")).build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("ai_playbook", t("menu.ai.playbook")).build(app)?)
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
            ("paper", theme_family_paper),
            ("ink", theme_family_ink),
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
