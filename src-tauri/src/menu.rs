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

/// File → "Unanswered quick looks after an hour" (spec §7): what becomes of
/// a quick look the human saw and never answered. A radio pair whose value
/// the frontend owns (`localStorage`) and reports with `sync_transient_menu`.
pub struct TransientMenuItems {
    pub keep: CheckMenuItem<Wry>,
    pub close: CheckMenuItem<Wry>,
}

/// `(keep, close)` checkmarks for a policy; anything but `"close"` is the
/// default, keep.
pub fn transient_marks(policy: &str) -> (bool, bool) {
    let close = policy == "close";
    (!close, close)
}

impl TransientMenuItems {
    pub fn sync(&self, policy: &str) {
        let (keep, close) = transient_marks(policy);
        let _ = self.keep.set_checked(keep);
        let _ = self.close.set_checked(close);
    }
}

/// Тумблеры меню View, состояние которых фронтенд синхронизирует при старте.
///
/// Держатся отдельно от `EngineMenuItems` не для порядка: `lib.rs` читает
/// состояние такого пункта, чтобы разослать окнам значение, а не команду
/// «переключи» (см. `toggle_value`), и для этого пункт должен где-то жить.
pub struct ViewToggleItems {
    pub ocd_alignment: CheckMenuItem<Wry>,
    pub ocd_enabled: Toggle,
    /// View → Tabs → Compact (spec §6): one-line drawer cards.
    pub tabs_compact: CheckMenuItem<Wry>,
    pub compact_enabled: Toggle,
}

/// Live handles to the two "Reopen…" items, so they follow the closed stack
/// and the pending restore — macOS disables an accelerator along with its
/// item, so without this Cmd+Shift+T would stay dead for the rest of the
/// process on any launch that starts with nothing closed.
pub struct SessionMenuItems {
    /// Cmd+Shift+T: the most recently closed tab or window (`closed.rs`).
    pub reopen_closed: tauri::menu::MenuItem<Wry>,
    /// The previous session's windows, Safari-style: no key (tabs-questions Q1).
    pub restore_session: tauri::menu::MenuItem<Wry>,
}

/// Which of the two items are enabled: `(reopen_closed, restore_session)`.
/// Independent — Cmd+Shift+T never restores the session, and the session
/// item stays on after a close, until the session is restored.
pub fn session_items_enabled(closed_count: usize, pending_count: usize) -> (bool, bool) {
    (closed_count > 0, pending_count > 0)
}

/// The session item's text: "Reopen 3 Windows from Last Session" while there
/// is a session to restore, the count-free "Reopen Windows from Last Session"
/// once there is none (the item is then disabled).
fn restore_session_text(pending_count: usize) -> String {
    restore_session_text_for(crate::i18n::active_language(), pending_count)
}

fn restore_session_text_for(lang: &str, pending_count: usize) -> String {
    if pending_count > 0 {
        crate::i18n::t_plural_for(lang, "menu.file.reopen_session", pending_count as u64)
    } else {
        crate::i18n::t_for(lang, "menu.file.reopen_last_session")
    }
}

impl SessionMenuItems {
    pub fn sync(&self, closed_count: usize, pending_count: usize) {
        let (reopen, restore) = session_items_enabled(closed_count, pending_count);
        let _ = self.reopen_closed.set_enabled(reopen);
        let _ = self.restore_session.set_text(restore_session_text(pending_count));
        let _ = self.restore_session.set_enabled(restore);
    }
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

    pub fn sync_tabs_compact(&self, enabled: bool) {
        let _ = self.tabs_compact.set_checked(enabled);
        self.compact_enabled.set(enabled);
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
    SessionMenuItems,
    TransientMenuItems,
)> {
    let (reopen_enabled, restore_enabled) = session_items_enabled(0, pending_session_count);
    let reopen_closed_item = MenuItemBuilder::with_id("reopen_closed", t("menu.file.reopen_closed"))
        .accelerator("CmdOrCtrl+Shift+T")
        .enabled(reopen_enabled)
        .build(app)?;
    let restore_session_item =
        MenuItemBuilder::with_id("restore_session", restore_session_text(pending_session_count))
            .enabled(restore_enabled)
            .build(app)?;

    let transient_keep =
        CheckMenuItemBuilder::with_id("transient_ignored_keep", t("menu.file.transient_keep")).build(app)?;
    let transient_close =
        CheckMenuItemBuilder::with_id("transient_ignored_close", t("menu.file.transient_close")).build(app)?;
    // Checked here for the default; the frontend's sync corrects it at start.
    let _ = transient_keep.set_checked(true);
    let transient_submenu = SubmenuBuilder::new(app, t("menu.file.transient_title"))
        .item(&transient_keep)
        .item(&transient_close)
        .build()?;

    let file_menu = SubmenuBuilder::new(app, t("menu.file.title"))
        .item(
            &MenuItemBuilder::with_id("new", t("menu.file.new"))
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("new_tab", t("menu.file.new_tab"))
                .accelerator("CmdOrCtrl+T")
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
        .item(&transient_submenu)
        .separator()
        .item(&reopen_closed_item)
        .item(&restore_session_item)
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

    let tabs_compact =
        CheckMenuItemBuilder::with_id("toggle_tabs_compact", t("menu.view.tabs_compact")).build(app)?;

    // Nine literal builder chains, not a loop: the accelerator mirror test
    // (`native-menu-accelerators.test.ts`) reads each item id as a string
    // literal right after its builder call.
    let tab_label = |n: u32| t("menu.view.select_tab").replace("{n}", &n.to_string());
    let tabs_submenu = SubmenuBuilder::new(app, t("menu.view.tabs_title"))
        // The drawer (spec §6). ⌘J is its only key; it is printed on the
        // notch, which reads it from the mirror of this line.
        .item(
            &MenuItemBuilder::with_id("toggle_drawer", t("menu.view.show_tabs"))
                .accelerator("CmdOrCtrl+J")
                .build(app)?,
        )
        .item(&tabs_compact)
        .separator()
        .item(
            &MenuItemBuilder::with_id("next_tab", t("menu.view.next_tab"))
                .accelerator("Ctrl+Tab")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("prev_tab", t("menu.view.prev_tab"))
                .accelerator("Ctrl+Shift+Tab")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("select_tab_1", tab_label(1)).accelerator("CmdOrCtrl+1").build(app)?)
        .item(&MenuItemBuilder::with_id("select_tab_2", tab_label(2)).accelerator("CmdOrCtrl+2").build(app)?)
        .item(&MenuItemBuilder::with_id("select_tab_3", tab_label(3)).accelerator("CmdOrCtrl+3").build(app)?)
        .item(&MenuItemBuilder::with_id("select_tab_4", tab_label(4)).accelerator("CmdOrCtrl+4").build(app)?)
        .item(&MenuItemBuilder::with_id("select_tab_5", tab_label(5)).accelerator("CmdOrCtrl+5").build(app)?)
        .item(&MenuItemBuilder::with_id("select_tab_6", tab_label(6)).accelerator("CmdOrCtrl+6").build(app)?)
        .item(&MenuItemBuilder::with_id("select_tab_7", tab_label(7)).accelerator("CmdOrCtrl+7").build(app)?)
        .item(&MenuItemBuilder::with_id("select_tab_8", tab_label(8)).accelerator("CmdOrCtrl+8").build(app)?)
        .item(&MenuItemBuilder::with_id("select_tab_9", tab_label(9)).accelerator("CmdOrCtrl+9").build(app)?)
        .build()?;

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
        .separator()
        .item(&tabs_submenu)
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
    // Названия семей — Classic / Aurora / Blueprint / Phosphor — имена
    // собственные и не переводятся.
    let theme_family_classic = CheckMenuItemBuilder::with_id("theme_family_classic", "Classic").build(app)?;
    let theme_family_aurora = CheckMenuItemBuilder::with_id("theme_family_aurora", "Aurora").build(app)?;
    let theme_family_blueprint =
        CheckMenuItemBuilder::with_id("theme_family_blueprint", "Blueprint").build(app)?;
    let theme_family_phosphor =
        CheckMenuItemBuilder::with_id("theme_family_phosphor", "Phosphor").build(app)?;
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

    // The standard Window menu, for ⌘M. The predefined item carries the key
    // itself (no `.accelerator("…")` string), so the drawer's «В окно…» key
    // is ⌘G, not ⌘M — `drawer-keys.test.ts` holds both sides of that.
    let window_menu = SubmenuBuilder::new(app, t("menu.window.title"))
        .minimize_with_text(t("menu.window.minimize"))
        .build()?;

    // Window before AI: the AI menu stands where Help would, last.
    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&theme_menu)
        .item(&window_menu)
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
        tabs_compact,
        compact_enabled: Toggle::default(),
    };

    let session_items = SessionMenuItems {
        reopen_closed: reopen_closed_item,
        restore_session: restore_session_item,
    };
    let transient_items = TransientMenuItems { keep: transient_keep, close: transient_close };
    Ok((menu, theme_items, engine_items, view_toggles, session_items, transient_items))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reopen_closed_follows_only_the_closed_stack() {
        assert!(!session_items_enabled(0, 3).0, "⌘⇧T never restores the session");
        assert!(session_items_enabled(2, 0).0);
        assert!(!session_items_enabled(0, 0).0);
    }

    #[test]
    fn the_session_item_stays_on_after_a_close_until_the_session_is_restored() {
        assert_eq!(session_items_enabled(0, 3), (false, true));
        assert_eq!(session_items_enabled(1, 3), (true, true), "a ⌘W does not take the session away");
        assert_eq!(session_items_enabled(1, 0), (true, false), "restored: nothing left to offer");
    }

    #[test]
    fn the_session_item_names_the_windows_it_would_open() {
        assert_eq!(restore_session_text_for("en", 3), "Reopen 3 Windows from Last Session");
        assert_eq!(restore_session_text_for("en", 0), "Reopen Windows from Last Session");
        assert_eq!(restore_session_text_for("ru", 2), "Открыть 2 окна прошлой сессии");
        assert_eq!(restore_session_text_for("ru", 0), "Открыть окна прошлой сессии");
    }

    #[test]
    fn the_quick_look_policy_marks_one_item() {
        assert_eq!(transient_marks("keep"), (true, false));
        assert_eq!(transient_marks("close"), (false, true));
        assert_eq!(transient_marks("anything else"), (true, false), "unknown means the default");
    }
}
