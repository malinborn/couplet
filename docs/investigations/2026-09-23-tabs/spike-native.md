# Спайк: нативные вкладки macOS в md-mini (2026-09-23)
Ветка worktree `worktree-agent-acf7ff122c5eda2d6`, не закоммичено, throwaway. Правки: window.rs, menu.rs, lib.rs.

- `tabbingIdentifier` + `tabbingMode=Preferred` (через ns_window() ПОСЛЕ .build()) — НЕ слило окна (2 окна на разных AX-позициях). Возможно, потому что режим ставился после показа окна — не проверено.
- Явный `[anchor addTabbedWindow:new ordered:NSWindowAbove]` — СЛИВАЕТ: 5 WebviewWindow в Tauri, одно AXWindow в Accessibility.
- AppKit-вызов не из main thread (async IPC-команда `open_file_window_cmd`, колбэк single-instance) — ТИХО УБИВАЕТ процесс (без паники, без stderr). Работает из on_menu_event (main thread). Нужен `app.run_on_main_thread` вокруг всех NSWindow-вызовов; аудит всех call sites open_file_window/open_restored_window.
- Cmd+W закрывает одну вкладку.
- Window-меню: `tauri::menu::WINDOW_SUBMENU_ID` ("__tauri_window_menu__") → init_app_menu вызывает `Submenu::set_as_windows_menu_for_nsapp()` → macOS сам добавляет Show Tab Bar / Show All Tabs / Merge All Windows / Move Tab to New Window. Скомпилировано, визуально не подтверждено.
- Память: главный процесс 39→49MB при 1→5 окнах (~2.5MB/окно). Каждое окно — СВОЙ WebContent-процесс, phys_footprint 57/56/57/52MB (пустой буфер). Итого ≈58MB на вкладку. С контентом/mermaid не замерено.
- Каскад позиций становится мёртвым кодом при принудительном слиянии.
- Session restore: сохранённая геометрия каждого окна теряется при авто-слиянии — продуктовое решение.
- Скриншоты нативной полосы не сняты (нет Screen Recording permission) — вид, мигание, маркер ● в заголовке вкладки, светофоры не проверены.
