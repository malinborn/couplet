//! Иконка в Dock следует за темой.
//!
//! Только Dock: `-[NSApplication setApplicationIconImage:]` живёт, пока живёт
//! процесс, и в бандл ничего не пишет. Иконку в Finder менять нельзя —
//! приложение подписано ad-hoc, и запись в бандл сломала бы подпись. У Tauri
//! API для этого нет, поэтому вызов идёт в AppKit напрямую.
//!
//! Вход — уже разрешённая тема, та же, что уходит в `sync_theme_menu`: с
//! галочкой «система» половину выбирает ОС, и иконка должна быть той, что на
//! экране. Поэтому отдельной команды нет — меню и Dock обновляются одним
//! вызовом, и все пути, которыми тема меняется (явный выбор, смена семьи,
//! переключение ОС, старт), приходят сюда сами.

use std::sync::Mutex;

use tauri::AppHandle;

/// Варианты, вшитые в бинарь: 512×512 копии растров из
/// `design/couplet-icon/variants/`, собранные `scripts/build-dock-icons.sh`.
/// Больше Dock не рисует (256pt @2x), а оригиналы по 1024 удвоили бы вес.
///
/// Имя варианта совпадает с идентификатором темы, кроме classic: у неё тема
/// без префикса (`light` / `dark`), а вариант — `classic-light` / `classic-dark`.
/// `default` здесь нет: это иконка бандла, и вернуть её — значит отдать AppKit
/// `nil`, а не вторую копию той же картинки.
const VARIANTS: &[(&str, &[u8])] = &[
    ("classic-light", include_bytes!("../dock-icons/classic-light.png")),
    ("classic-dark", include_bytes!("../dock-icons/classic-dark.png")),
    ("aurora-light", include_bytes!("../dock-icons/aurora-light.png")),
    ("aurora-dark", include_bytes!("../dock-icons/aurora-dark.png")),
    ("blueprint-light", include_bytes!("../dock-icons/blueprint-light.png")),
    ("blueprint-dark", include_bytes!("../dock-icons/blueprint-dark.png")),
    ("phosphor-light", include_bytes!("../dock-icons/phosphor-light.png")),
    ("phosphor-dark", include_bytes!("../dock-icons/phosphor-dark.png")),
    ("paper-light", include_bytes!("../dock-icons/paper-light.png")),
    ("paper-dark", include_bytes!("../dock-icons/paper-dark.png")),
    ("ink-light", include_bytes!("../dock-icons/ink-light.png")),
    ("ink-dark", include_bytes!("../dock-icons/ink-dark.png")),
];

/// Иконка бандла — для темы, у которой своего варианта нет.
pub const DEFAULT: &str = "default";

/// Имя варианта для разрешённой темы; неизвестная тема получает [`DEFAULT`].
pub fn variant_for(resolved: &str) -> &'static str {
    let wanted = match resolved {
        "light" => "classic-light",
        "dark" => "classic-dark",
        other => other,
    };
    VARIANTS
        .iter()
        .find(|(name, _)| *name == wanted)
        .map_or(DEFAULT, |(name, _)| name)
}

fn png_for(variant: &str) -> Option<&'static [u8]> {
    VARIANTS
        .iter()
        .find(|(name, _)| *name == variant)
        .map(|(_, png)| *png)
}

/// Вариант, который последним ушёл в AppKit. Каждое окно синхронизирует меню
/// само, и без этой отметки N окон декодировали бы одну и ту же картинку N раз
/// на каждую смену темы.
static APPLIED: Mutex<Option<&'static str>> = Mutex::new(None);

/// Ставит в Dock иконку, соответствующую теме, если она ещё не стоит.
pub fn apply(app: &AppHandle, resolved: &str) {
    let variant = variant_for(resolved);
    {
        let mut applied = APPLIED.lock().unwrap_or_else(|e| e.into_inner());
        if *applied == Some(variant) {
            return;
        }
        // Отметка ставится до постановки в очередь, а не после отрисовки:
        // главный поток выполняет задачи по порядку, так что последней на
        // экране окажется последняя поставленная — ровно та, что записана.
        *applied = Some(variant);
    }
    #[cfg(debug_assertions)]
    eprintln!("dock icon: {resolved} -> {variant}");

    let png = png_for(variant);
    // AppKit — только с главного потока, а команды Tauri приходят с пула.
    if let Err(e) = app.run_on_main_thread(move || set_dock_image(png)) {
        eprintln!("dock icon: {e}");
        *APPLIED.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

// `cocoa` целиком помечен deprecated в пользу `objc2`: двадцать с лишним
// предупреждений об одном и том же, а не о нашем коде.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn set_dock_image(png: Option<&'static [u8]>) {
    use cocoa::appkit::{NSApp, NSApplication, NSImage};
    use cocoa::base::{id, nil, NO};
    use cocoa::foundation::{NSAutoreleasePool, NSData};

    unsafe {
        let pool = NSAutoreleasePool::new(nil);
        let ns_app = NSApp();
        match png {
            // `nil` возвращает иконку бандла.
            None => ns_app.setApplicationIconImage_(nil),
            Some(png) => {
                // Без копии: байты `'static`, и отдавать их AppKit на
                // освобождение нельзя — `freeWhenDone` строго `NO`
                // (`cocoa::base::NO`, не `false`: BOOL на x86_64 — `i8`).
                let data: id = NSData::dataWithBytesNoCopy_length_freeWhenDone_(
                    nil,
                    png.as_ptr() as *const std::ffi::c_void,
                    png.len() as u64,
                    NO,
                );
                let image: id = NSImage::initWithData_(NSImage::alloc(nil), data);
                if image.is_null() {
                    eprintln!("dock icon: NSImage rejected the embedded PNG");
                } else {
                    // Свойство держит свою ссылку; наша, от `alloc`, уходит в
                    // пул и освобождается на `drain` ниже.
                    ns_app.setApplicationIconImage_(NSAutoreleasePool::autorelease(image));
                }
            }
        }
        pool.drain();
    }
}

#[cfg(not(target_os = "macos"))]
fn set_dock_image(_png: Option<&'static [u8]>) {}

#[cfg(test)]
mod tests {
    use super::*;

    const SHIPPED_FAMILIES: [&str; 6] = ["classic", "aurora", "blueprint", "phosphor", "paper", "ink"];

    fn theme_id(family: &str, half: &str) -> String {
        if family == "classic" {
            half.to_string()
        } else {
            format!("{family}-{half}")
        }
    }

    #[test]
    fn classic_maps_onto_its_prefixed_variant() {
        assert_eq!(variant_for("light"), "classic-light");
        assert_eq!(variant_for("dark"), "classic-dark");
    }

    #[test]
    fn every_shipped_theme_has_its_own_variant() {
        for family in SHIPPED_FAMILIES {
            for half in ["light", "dark"] {
                let theme = theme_id(family, half);
                assert_eq!(
                    variant_for(&theme),
                    format!("{family}-{half}"),
                    "{theme} has no Dock variant — add a row to VARIANTS"
                );
            }
        }
    }

    #[test]
    fn unknown_theme_falls_back_to_the_bundle_icon() {
        assert_eq!(variant_for("coral-dark"), DEFAULT);
        assert_eq!(variant_for(""), DEFAULT);
        assert_eq!(png_for(DEFAULT), None);
    }

    /// PNG-сигнатура и IHDR: ширина и высота — big-endian u32 по смещениям 16 и 20.
    #[test]
    fn embedded_copies_are_512_square_pngs() {
        for (name, png) in VARIANTS {
            assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "{name} is not a PNG");
            let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
            let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
            assert_eq!((width, height), (512, 512), "{name}: run scripts/build-dock-icons.sh");
        }
    }

    /// Копия на диске, которой нет в таблице, — вариант, который собрали, но
    /// забыли подключить.
    #[test]
    fn every_copy_on_disk_is_wired() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("dock-icons");
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("png") {
                continue;
            }
            let stem = path.file_stem().unwrap().to_str().unwrap();
            assert!(png_for(stem).is_some(), "{stem}.png is not in VARIANTS");
        }
    }
}
