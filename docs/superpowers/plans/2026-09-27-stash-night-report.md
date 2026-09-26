# Тайник — ночной отчёт 2026-09-27

## Где я сейчас

- **Этап:** 01 (страховка черновиков), ветка `fix/draft-safety`
- **Задача:** Task 8 — живая проверка на бандле (Task 0–7 готовы)
- **Worktree:** `.claude/worktrees/stash-impl`
- **Будильники:** `0e23cd44` (03:50), `6e34efbc` (08:50) — разовые, session-only
- **Архитектор:** сессия `ARCH stash` [531eba], на связи с 01:15

## Как я работаю (отступление от шаблона навыка)

Планы содержат готовый код каждого шага, поэтому ревью соответствия плану между задачами делаю сам (дифф против текста плана), а не отдельным субагентом-ревьюером на каждую задачу. Субагенты — строго по одному, на Opus. В конце каждого этапа — `code-reviewer` по диффу этапа.

## Сделано

_(заполняется по ходу)_

## Этап 01 — страховка черновиков

### Базовые замеры

База: `05a41cb` (main `b65ed49` + origin/worktree-shelf-design).

| Проверка | Результат |
|---|---|
| `cargo test` | 643 passed, 3 ignored, 0 failed |
| `cargo test --lib session::` | 62 passed |
| `cargo clippy` | 50 warnings (lib) |
| `npx vitest run --dir src` | 97 файлов, 2079 passed |
| `controller.test.ts` | 161 passed |
| `npm run check` | 0 errors, 0 warnings |

### Воспроизведение (Task 1)

Бандл `~/.cargo/stash-impl-target/debug/bundle/macos/couplet-safety.app` (`pro.couplet.safety`, debug + mcp-bridge, код без фикса). `bash scripts/verify-draft-safety.sh <bundle>`:

```
PASS [launch 1, nobody restored] draft still in session/
FAIL [launch 1, nobody restored] session-v2.json no longer names it
PASS [after quit 1] draft still in session/
FAIL [after quit 1] session-v2.json no longer names it
FAIL [launch 2, nobody restored] draft gone from session/
FAIL [launch 2, nobody restored] session-v2.json no longer names it
FAIL [after quit 2] draft gone from session/
FAIL [after quit 2] session-v2.json no longer names it
FAIL [launch 3, nobody restored] draft gone from session/
FAIL [launch 3, nobody restored] session-v2.json no longer names it
FAIL [after quit 3] draft gone from session/
FAIL [after quit 3] session-v2.json no longer names it
exit=1
```

H1 подтверждена на живом бандле: первый запуск без восстановления переписывает `session-v2.json` без черновика, второй запуск удаляет сам файл. Коммит `ceb8bc0`.

Попутно (не блокирует): `/tmp/couplet-pending-files` (`PENDING_FILES_PATH` в `lib.rs`) общий для всех идентичностей — dev/safety-запуск может забрать файл, предназначенный боевому приложению. Существовало до этапа.

### Ход задач

| Задача | Коммит | Итог |
|---|---|---|
| 1 живая проверка | `ceb8bc0` | воспроизведение, см. выше |
| 2 GC → `session/.trash/` | `ab09634` | session:: 64; `trashed_at` перенесена в Task 3 (без вызова — лишнее предупреждение clippy) |
| 3 очистка через 30 дней | `5d74c9b` | session:: 67, lib 648; тиккер чистит при запуске и каждые 6 ч |
| 4 причина: snapshot пишет невосстановленные черновики | `9f47052` | 4 теста падали до фикса ровно как в плане; session:: 73, lib 654; порядок блокировок entries→pending→restoring везде |
| 5 спасательная копия ⌘W (Rust) | `febbedb` | session:: 75, lib 657 |
| 6 контроллер отдаёт текст в `tab_close` | `83adc35` | controller 164, vitest 2082; дополнительно исправлена отрицательная проверка `CloseTabsLeavesAnActiveTabWhoseSaveDidNotLand…` (с 3 аргументами она перестала бы что-то проверять) |
| 7 CLAUDE.md: правило безопасности данных | `b7748a0` | делал сам, текст из плана |

Риски после Task 4 (приняты, по плану D6): выход в первую ~1 с после запуска (до первого тика) теперь пишет файл только с перенесёнными окнами черновиков вместо «не писать пустое» — окна одних файлов из прошлой сессии выпадают из файла (файлы на диске, ничего не теряется); невосстановленное окно с черновиком переносится в каждую следующую сессию, пока его не восстановят (закрывается этапом 03).

### Проверка после фикса (Task 8)

Пересобранный бандл `pro.couplet.safety` из `b7748a0`. Скрипт:

```
PASS [launch 1, nobody restored] draft still in session/
PASS [launch 1, nobody restored] session-v2.json still names it
PASS [after quit 1] draft still in session/
PASS [after quit 1] session-v2.json still names it
PASS [launch 2, nobody restored] draft still in session/
PASS [launch 2, nobody restored] session-v2.json still names it
PASS [after quit 2] draft still in session/
PASS [after quit 2] session-v2.json still names it
PASS [launch 3, nobody restored] draft still in session/
PASS [launch 3, nobody restored] session-v2.json still names it
PASS [after quit 3] draft still in session/
PASS [after quit 3] session-v2.json still names it
exit 0
```

Вручную через MCP-мост (каждый раз сверял `ipc_get_backend_state` → `pro.couplet.safety`):

| Шаг | Результат |
|---|---|
| Набран живой текст `- [ ] LIVE: typed before the quit`, через 7 с | sidecar `draft-1790461861828-77504-1.md` с этим текстом |
| Выход AppleEvent (`osascript quit app id "pro.couplet.safety"`) | `session-v2.json` (`savedAt` = секунда выхода) — 2 окна, черновик назван; `.trash` нет → **H2 опровергнута**, Task 8b не нужна |
| Два запуска без восстановления | черновик на месте, назван (count 1) |
| `restore_session` | 1 окно; в нём `- [ ] LIVE: typed before the quit`. Окно welcome (только файлы) не переносилось — как D6 |
| ⌘W на восстановленной вкладке (`emit_to` → `menu-event:"close"` в `editor-1`) | `.trash/closed-<tab>.trashed-<secs>.md` с живым текстом **и** `draft-<tab>.trashed-<secs>.md` от GC в ту же секунду; `session/` пуст |

Наблюдение: `ipc_emit_event` в tauri MCP шлёт всем окнам (закрыл и пустую вкладку `main` → приложение вышло до тика, файл сессии сохранил последнюю запись с закрытой вкладкой — существующее правило «не писать пустой список»; две копии, риска нет). Адресное закрытие — `invoke('plugin:event|emit_to', …)` из вебвью.

### Ревью этапа 01 (`code-reviewer`)

Critical — нет. Исправлено отдельными коммитами:

| Находка | Коммит | Суть |
|---|---|---|
| I1 выход после закрытия последнего окна писал файл только с перенесёнными окнами в обход защиты «не писать пустое» | `35a0389` | `SessionState::exit_snapshot` → `None`, если нет живых окон; файл на диске уже называет перенесённые окна |
| I2 скрипт проверял только bundle id, а каталог данных и сокет зависят от productName | `7580726` | проверка `CFBundleName == couplet-safety` + проверка, что `session-v2.json` переписан после первого запуска |
| M1 `trashed_at` принимал мусорный хвост (`.trashed-5-foo.md`) | `760a8fd` | только `<digits>` или `<digits>-<digits>` |
| M2 гонка между проверкой свободного имени и `rename` (перезапись копии) | `a431625` | `hard_link` (EEXIST → следующее имя), потом `remove_file`; копия никогда не затирается |
| M3 корзина-симлинк | `de0bc68` | корзина должна быть настоящим каталогом, иначе отказ |
| M4 `release` мог выкинуть untitled, в который успели набрать текст | `05090ae` | такой release идёт через `tab_close` со спасательной копией (вкладка закрывается; оставить её открытой — вопрос UX, не делал) |
| M6 пробелы в тестах | `2a1988e` | + тест закрытой ни разу не открытой untitled; отрицательная проверка переписана |

Дополнительно после ревью: `9b48153` — тиккер тоже не пишет сессию без живых окон (гонка между `Destroyed` последнего окна и выходом) и в этом случае пропускает GC (иначе черновик последнего окна ушёл бы в корзину и вкладка перестала бы восстанавливаться); после записи GC держит всё, что названо в только что записанном файле (`untitled_to_keep_after`). `SessionState::snapshot` стал `#[cfg(test)]`, писатели идут через `snapshot_to_write`. `68417d4` — CLAUDE.md приведён в соответствие. Бандл пересобран, живая проверка — **13 PASS, exit 0** (новая строка: `PASS [launch 1] session-v2.json rewritten`).

Итог этапа 01: cargo lib **666 passed** / 3 ignored (база 643, +23), clippy **50** (= база), vitest **2084** (база 2079, +5), `npm run check` 0 ошибок, `check:x86` собирается.

Не исправлял (в отчёт): M5 — невосстановленные окна с черновиками копятся в предложении восстановления (закроется этапом 03); M7 — синхронная запись спасательной копии внутри async `tab_close` (как и остальной код сессии).

## Причина потери черновиков 2026-09-26 (итог этапа 01)

`SessionState::snapshot` писал в `session-v2.json` только живые окна, а восстановление прошлой сессии — по желанию (тост/меню). Первый запуск 2.0.1 после `brew upgrade` (окно welcome перекрыло тост) переписал файл без черновиков 2.0.0; переключение языка через 18 с перезапустило приложение, и первый тик нового процесса удалил черновики как «никем не упомянутые» (`session/` mtime 02:17:09). Подтверждено: хронология из unified log и mtime (план 01), воспроизведение на живом бандле (Task 1, FAIL), 4 падающих юнит-теста до фикса, 12 PASS после фикса (Task 8). Защита в глубину: GC больше ничего не удаляет — только переносит в `session/.trash/` (30 дней), ⌘W оставляет спасательную копию.

## Отступления от планов

## Что осталось / известные пробелы

- Карточки битых ссылок «файл не найден» и переиндексация отложенных файлов, изменённых вне couplet — не в этой поставке (roadmap A14).

## Вопросы

См. `docs/superpowers/plans/stash-questions.md`.
