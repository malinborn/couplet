// Playground for View → Lists. A real app editor (createExtensions, the
// live-preview plugin, both engines) driven by the same menu ids the native
// menu sends, through the same `listLayoutFromMenu` the app uses.
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createExtensions, listLayoutCompartment, previewCompartment } from '../src/lib/editor/setup';
import { livePreviewPlugin } from '../src/lib/editor/preview/plugin';
import { flavourFacet, LIVE_PREVIEW, LIVE_RENDER } from '../src/lib/editor/preview/flavour';
import { liveRenderExtensions } from '../src/lib/editor/live-render';
import {
  listLayoutExtension,
  listLayoutFromMenu,
  listPresetOf,
  normalizeListLayout,
  type ListLayout,
} from '../src/lib/editor/preview/explicit-lists';

import '../src/lib/theme/dark.css';
import '../src/lib/theme/light.css';
import '../src/lib/theme/aurora-dark.css';
import '../src/lib/theme/aurora-light.css';
import '../src/lib/theme/blueprint.css';
import '../src/lib/theme/phosphor.css';
import '../src/lib/theme/paper.css';
import '../src/lib/theme/ink.css';
import '../src/lib/theme/autumn.css';
import '../src/styles/global.css';
import '../src/styles/editor.css';
import '../src/styles/editor-metrics.css';
import '../src/styles/search.css';
import './lists.css';

const SAMPLE = `# План переезда на новый кластер

Список задач, который обычно разрастается до четырёх-пяти уровней и превращается в кашу.

- Подготовка инфраструктуры — длинный пункт, который специально написан так, чтобы перенестись на вторую строку и показать висячий отступ
  - Сеть
    - Выделить подсети под каждое окружение: prod, stage, dev, и отдельно под CI-раннеры, которые ходят во внутренний registry
    - Настроить пиринг
      - между VPC прода и общего сервиса логов
      - между stage и dev
        - временно, до конца миграции
        - потом снести и проверить, что ничего не отвалилось
    - Обновить правила firewall
      - один ребёнок — одна строка под маркером, линии нет
  - Хранилище
    - Снапшоты PostgreSQL
    - Перенос бакетов

    Отдельный абзац внутри пункта «Хранилище»: продолжение текста под маркером, а не новый пункт.
- Миграция сервисов
  1. Сначала stateless-сервисы
  2. Потом очереди
     - Redis
     - RabbitMQ — с двойной записью на время переключения
  3. Базы данных в последнюю очередь
  4. Пятый
  5. Шестой
  6. Седьмой
  7. Восьмой
  8. Девятый
  9. Девятый с половиной
  10. Десятый — двузначный номер, текст всё равно встаёт в ту же колонку
- Приёмка
  - [x] Smoke-тесты на stage
  - [ ] Нагрузочное тестирование
    - [ ] сценарий «чёрная пятница»
    - [ ] деградация одного AZ, когда половина подов уходит, а трафик продолжает литься в оставшиеся
  - [ ] Ретро

Обычный абзац после списка — линии здесь заканчиваются.

1. Нумерованный список верхнего уровня
   1. Вложенный нумерованный
      - и буллет внутри
2. Второй пункт
`;

const THEMES = [
  'light', 'dark',
  'aurora-light', 'aurora-dark',
  'paper-light', 'paper-dark',
  'ink-light', 'ink-dark',
  'autumn-light', 'autumn-dark',
  'blueprint-light', 'blueprint-dark',
  'phosphor-light', 'phosphor-dark',
];

const STORE = 'pg-lists';
interface Settings {
  layout: ListLayout;
  engine: 'live-preview' | 'live-render';
  theme: string;
  width: number;
}
function load(): Settings {
  const fallback: Settings = {
    layout: normalizeListLayout({ guides: true, strict: true }),
    engine: 'live-render',
    theme: 'light',
    width: 640,
  };
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Partial<Settings> | null;
    if (!raw) return fallback;
    return { ...fallback, ...raw, layout: normalizeListLayout(raw.layout) };
  } catch {
    return fallback;
  }
}
const settings = load();
function save(): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(settings));
  } catch {
    // private window — settings just do not persist
  }
}

const host = document.getElementById('editor')!;
host.classList.add('md-editor-host');

function previewFor(engine: Settings['engine']) {
  const render = engine === 'live-render';
  return [
    livePreviewPlugin,
    flavourFacet.of(render ? LIVE_RENDER : LIVE_PREVIEW),
    ...(render ? liveRenderExtensions() : []),
  ];
}

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [createExtensions(), EditorView.lineWrapping],
  });
}

const view = new EditorView({ state: makeState(SAMPLE), parent: host });
(window as unknown as { view: EditorView }).view = view;

function applyEditor(): void {
  view.dispatch({
    effects: [
      previewCompartment.reconfigure(previewFor(settings.engine)),
      listLayoutCompartment.reconfigure(listLayoutExtension(settings.layout)),
    ],
  });
}

function applyLook(): void {
  document.documentElement.dataset.theme = settings.theme;
  host.style.setProperty('--pg-width', `${settings.width}px`);
  view.requestMeasure();
}

// The menu: what `sync_list_menu` would check, and the ids it would send.
const menu = document.getElementById('menu')!;
function syncMenu(): void {
  const l = settings.layout;
  const preset = listPresetOf(l);
  for (const b of menu.querySelectorAll<HTMLButtonElement>('button')) {
    const id = b.dataset.id!;
    const on =
      id === `list_preset_${preset}` ||
      (id === 'toggle_list_guides' && l.guides) ||
      (id === 'toggle_list_strict' && l.strict) ||
      id === `list_guide_${l.guideStyle}` ||
      id === `list_density_${l.density}`;
    b.classList.toggle('on', on);
    b.disabled = 'needsGuides' in b.dataset && !l.guides;
  }
}
menu.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b?.dataset.id) return;
  // `toggle_value` in lib.rs: a switch carries its next value.
  let id = b.dataset.id;
  if (id === 'toggle_list_guides') id += settings.layout.guides ? ':off' : ':on';
  if (id === 'toggle_list_strict') id += settings.layout.strict ? ':off' : ':on';
  const next = listLayoutFromMenu(settings.layout, id);
  if (!next) return;
  settings.layout = next;
  save();
  syncMenu();
  applyEditor();
});
syncMenu();

// Segmented buttons
for (const seg of document.querySelectorAll<HTMLElement>('.pg-seg')) {
  const key = seg.dataset.key as 'engine';
  const sync = () => {
    for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) {
      b.classList.toggle('on', b.dataset.v === settings[key]);
    }
  };
  seg.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b?.dataset.v) return;
    e.preventDefault();
    (settings as unknown as Record<string, string>)[key] = b.dataset.v;
    sync();
    save();
    applyEditor();
  });
  sync();
}

// Theme
const themeSelect = document.getElementById('theme') as HTMLSelectElement;
for (const t of THEMES) themeSelect.add(new Option(t, t));
themeSelect.value = settings.theme;
themeSelect.addEventListener('change', () => {
  settings.theme = themeSelect.value;
  save();
  applyLook();
});

// Sliders
for (const input of document.querySelectorAll<HTMLInputElement>('input[type=range]')) {
  const out = input.parentElement?.querySelector('output');
  const unit = input.dataset.unit ?? '';
  input.value = String(settings.width);
  const sync = () => {
    if (out) out.textContent = `${input.value}${unit}`;
  };
  input.addEventListener('input', () => {
    sync();
    settings.width = Number(input.value);
    save();
    applyLook();
  });
  sync();
}

document.getElementById('reset')!.addEventListener('click', () => {
  view.setState(makeState(SAMPLE));
  applyEditor();
  applyLook();
});

applyEditor();
applyLook();
