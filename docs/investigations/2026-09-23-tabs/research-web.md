# Выжимка веб-исследования (2026-09-23)

## Анти-sprawl механизмы
- VS Code: preview tab (курсив, одна на группу, заменяется следующим лёгким открытием; постоянная после double-click/правки). Жалоба №1 — «моя вкладка пропала». Лимит `workbench.editor.limit` (1.42, выкл по умолчанию, 10, LRU; dirty не закрываются; `excludeDirty`). `showTabs: single|none`.
- Zed: preview_tabs (по умолчанию вкл, по одной на pane), `max_tabs` (null), `close clean items`. Жалобы «stop opening a new tab for everything».
- Arc: auto-archive незакреплённых через 12ч/24ч/7д/30д, выключить нельзя, архив восстановим. Реакция смешанная: «anxiety» и «liberating». Little Arc — внешние ссылки в отдельном временном окошке, перенос в основное явный. Arc в maintenance с 05.2025.
- Safari: автозакрытие через 1д/1нед/1мес (по умолчанию вручную), Recently Closed. Chrome Tab Declutter — ПРЕДЛАГАЕТ закрыть неактивные >7д. Firefox/Edge — выгрузка из памяти, вкладка остаётся.
- TextMate 2: при переполнении полосы авто-закрывает давно неиспользованные; «Sticky» защищает. Прецедент LRU.
- BBEdit: вкладок нет, «Currently Open Documents» сайдбар при >1 документа в окне.
- iA Writer: НАТИВНЫЕ macOS-вкладки + Library («keep documents within the same window, instead of fracturing your focus»). MarkEdit — тоже нативные NSWindow tabs.
- Typora: вкладок нет, просят с 2016.
- Obsidian: клик заменяет текущую вкладку (новая — Cmd+клик); жалобы в обе стороны.
- Emacs midnight-mode: раз в сутки убивает буферы, не показывавшиеся 3 дня, модифицированные не трогает. Helix: bufferline=never по умолчанию, picker.
- JetBrains: tab limit 10, LRU, pinned не трогает, «close non-modified first».

## Исследования
- Chang et al., CHI 2021 «When the Tab Comes Due»: вкладки держат как напоминание/todo, из страха потерять и «black hole effect» («как только скрылось из виду — пропало»). Skeema: вкладки как задачи → меньше вкладок, меньше стресса.
- Dubroy & Balakrishnan, CHI 2010: 17/21 держат вкладки как напоминание.
- Импликации: закрытие обратимо + видимое место, куда ушло; отделить «напоминание» от «открыт документ»; авто-уборка предсказуемая; dirty никогда; согласие (предложить) спокойнее принуждения.

## Нативные вкладки macOS + Tauri
- AppKit: tabbingMode (.automatic = системная «Prefer tabs»: по умолчанию «In Full Screen»; .preferred = всегда), tabbingIdentifier, AppKit сам добавляет Show Tab Bar / Show All Tabs (⌘⇧\) / Merge All Windows / Move Tab to New Window (нужно Window-меню). Кнопка «+» только при `newWindowForTab:` в responder chain.
- Tauri 2.10.3: `WebviewWindowBuilder::tabbing_identifier`, `tabbingIdentifier` в conf. tauri-runtime-wry выключает automatic tabbing app-wide если identifier не задан (или transparent / decorations:false). НЕТ tabbingMode-сеттера, НЕТ addTabbedWindow, НЕТ newWindowForTab — всё через objc по ns_window().
- Баг tauri #6548 (открыт с 03.2023): при системной «fullscreen only» окна не группируются + подвисание при входе в fullscreen.
- Window-меню: `Submenu::set_as_windows_menu_for_nsapp()` — в md-mini не используется.
- Память: каждое окно = свой WebContent-процесс (Networking/GPU общие), свой JS-бандл. Типично 40–110 MB RSS (не замер на md-mini).

## CM6 in-app
- Паттерн Marijn: один EditorView + Map<docId, EditorState>, view.setState(). История undo живёт в state.
- setState пересоздаёт все ViewPlugin'ы (их данные теряются), StateField переживают. Scroll не в state — scrollSnapshot(). Compartments живут в каждом state — смену темы/режима надо применять ко всем кешированным или при переключении. Неактивная вкладка = только EditorState, дёшево.

## ИИ-паттерны
- Claude Code в VS Code: каждый Edit открывает diff-вкладку, выключить нельзя — стабильные жалобы (#25018, #52832, #84542, #43619, #36263): «quickly fills the editor with stale diff tabs». Ровно страх владельца.
- Zed Agent Panel: правки агента не плодят вкладки; список изменённых файлов, «Review Changes» — ОДНА multibuffer-вкладка со всеми hunk'ами. «Follow the Agent» — режим слежения, а не накопления.
- Zed multibuffer: одна вкладка = редактируемые выдержки из многих файлов.
- Cursor: review-бар Keep/Undo по файлам.
- Little Arc — аналог: внешний источник открывает во временной поверхности.
