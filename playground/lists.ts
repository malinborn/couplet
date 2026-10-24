// Playground for View → Explicit Lists. A real app editor (createExtensions,
// the live-preview plugin, both engines), with the layout knobs exposed as
// CSS variables so they can be tuned by hand before anything is decided.
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createExtensions, listStyleCompartment, previewCompartment } from '../src/lib/editor/setup';
import { livePreviewPlugin } from '../src/lib/editor/preview/plugin';
import { flavourFacet, LIVE_PREVIEW, LIVE_RENDER } from '../src/lib/editor/preview/flavour';
import { liveRenderExtensions } from '../src/lib/editor/live-render';
import { listStyleExtension, type ListStyle } from '../src/lib/editor/preview/explicit-lists';

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

const GUIDES: Record<string, string> = {
  solid: 'linear-gradient(var(--xl-guide-color), var(--xl-guide-color))',
  dashed:
    'repeating-linear-gradient(to bottom, var(--xl-guide-color) 0 4px, transparent 4px 7px)',
  dotted:
    'repeating-linear-gradient(to bottom, var(--xl-guide-color) 0 var(--xl-guide-w), transparent var(--xl-guide-w) calc(var(--xl-guide-w) * 3.5))',
  none: 'none',
};

const STORE = 'pg-explicit-lists';
interface Settings {
  mode: ListStyle;
  engine: 'live-preview' | 'live-render';
  theme: string;
  guide: string;
  width: number;
  vars: Record<string, string>;
}
const defaults: Settings = {
  mode: 'explicit',
  engine: 'live-render',
  theme: 'light',
  guide: 'solid',
  width: 640,
  vars: {},
};
function load(): Settings {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(STORE) ?? '{}') };
  } catch {
    return { ...defaults };
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
      listStyleCompartment.reconfigure(listStyleExtension(settings.mode)),
    ],
  });
}

function applyLook(): void {
  document.documentElement.dataset.theme = settings.theme;
  host.style.setProperty('--pg-width', `${settings.width}px`);
  const content = view.contentDOM;
  content.style.setProperty('--xl-guide', GUIDES[settings.guide] ?? GUIDES.solid);
  for (const [k, v] of Object.entries(settings.vars)) content.style.setProperty(k, v);
  view.requestMeasure();
}

// Segmented buttons
for (const seg of document.querySelectorAll<HTMLElement>('.pg-seg')) {
  const key = seg.dataset.key as 'mode' | 'engine' | 'guide';
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
    if (key === 'guide') applyLook();
    else applyEditor();
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
  const name = input.dataset.var;
  if (name && settings.vars[name]) input.value = String(parseFloat(settings.vars[name]));
  if (input.id === 'width') input.value = String(settings.width);
  const sync = () => {
    if (out) out.textContent = `${input.value}${unit}`;
  };
  input.addEventListener('input', () => {
    sync();
    if (name) settings.vars[name] = `${input.value}${unit}`;
    else settings.width = Number(input.value);
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
