/* Лаборатория тем.
 *
 * Показывает темы на настоящем редакторе — тот же `createExtensions()`, что
 * монтирует приложение, поэтому видно ровно то, что получится, а не макет.
 * Кандидат кладётся сюда отдельным файлом в том же формате, что и боевые
 * палитры в `src/lib/theme/`, и переезжает туда как есть, если понравился;
 * так уехали «Блюпринт» и «Фосфор», и сейчас стенд смотрит прямо на них.
 *
 * Страницу собирает dev-сервер vite (`/theme-lab.html`). В прод-сборку она не
 * попадает: rollup берёт только `index.html`.
 */

import '../src/styles/editor.css';
import '../src/styles/editor-metrics.css';

// Все четыре выпущенные семьи плюс кандидаты из `candidates/`.
import '../src/lib/theme/light.css';
import '../src/lib/theme/dark.css';
import '../src/lib/theme/aurora-light.css';
import '../src/lib/theme/aurora-dark.css';
import '../src/lib/theme/blueprint.css';
import '../src/lib/theme/phosphor.css';
import './candidates/paper.css';
import './candidates/ink.css';
import './candidates/coral.css';

import './lab.css';

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createExtensions, previewCompartment } from '../src/lib/editor/setup';
import { livePreviewPlugin } from '../src/lib/editor/preview/plugin';
import { liveRenderExtensions } from '../src/lib/editor/live-render';
import { flavourFacet, LIVE_RENDER } from '../src/lib/editor/preview/flavour';

interface Family {
  name: string;
  note: string;
  light: string;
  dark: string;
  shipped?: boolean;
}

const FAMILIES: Family[] = [
  {
    name: 'Classic',
    note: 'Светлая — камень и бумага, тёмная — Rosé Pine. В меню звалась Default.',
    light: 'light',
    dark: 'dark',
    shipped: true,
  },
  {
    name: 'Aurora',
    note: 'Фиолет, розовый и бирюза, градиенты в заголовках.',
    light: 'aurora-light',
    dark: 'aurora-dark',
    shipped: true,
  },
  {
    name: 'Блюпринт',
    note: 'Чертёж: цианотипия (белым по синему) / калька с синим карандашом. Красный — только правка: каретка, чекбоксы, вычеркнутое.',
    light: 'blueprint-light',
    dark: 'blueprint-dark',
    shipped: true,
  },
  {
    name: 'Фосфор',
    note: 'Терминал до появления цвета: зелёный люминофор с янтарём / лист АЦПУ. Моноширинный в самом тексте.',
    light: 'phosphor-light',
    dark: 'phosphor-dark',
    shipped: true,
  },
  {
    name: 'Paper',
    note: 'Иконка backlog-paper: тушь по бумаге / та же бумага ночью, сепия. Коралл — только правка: каретка, чекбоксы, линия выполненного.',
    light: 'paper-light',
    dark: 'paper-dark',
  },
  {
    name: 'Ink',
    note: 'Иконка backlog-ink: крем по туши, каретка-градиент со свечением / тушь по холодному светлому листу с тем же градиентом.',
    light: 'ink-light',
    dark: 'ink-dark',
  },
  {
    name: 'Coral',
    note: 'Иконка backlog-coral: коралловая заря в подложке и заголовках. Светлая — крем с тушевой кареткой, тёмная — терракота.',
    light: 'coral-light',
    dark: 'coral-dark',
  },
];

const SAMPLE = `# Заголовок первого уровня

Обычный абзац, чтобы увидеть основной текст на подложке. В нём есть **жирное**,
*курсив*, ~~зачёркнутое~~, \`инлайн-код\` и [ссылка](https://md-mini.com) — по ним
и видно, как тема разводит акценты между собой.

## Второй уровень

### Третий уровень

- [x] выполненная задача — серая и перечёркнутая
- [x] выполненная с **жирным** и \`кодом\` внутри
- [ ] ещё не сделана
  - [ ] вложенная, не сделана
- обычный пункт без чекбокса

1. нумерованный пункт
2. второй
3. третий

> Цитата: по ней видно цвет полосы слева и приглушённый текст.

| Колонка | Значение | Комментарий |
| --- | --- | --- |
| Первая | 42 | строка таблицы |
| Вторая | 17 | чётная строка |
| Третья | 8 | и ещё одна |

\`\`\`ts
// Подсветка синтаксиса — отдельный слой поверх палитры.
export function greet(name: string): string {
  const times = 3;
  return Array.from({ length: times }, () => \`hello, \${name}\`).join('\\n');
}
\`\`\`

---

Последний абзац, чтобы было куда поставить курсор и посмотреть на каретку,
выделение и подсветку активной строки.
`;

function apply(theme: string): void {
  document.documentElement.setAttribute('data-theme', theme);
  const family = FAMILIES.find((f) => f.light === theme || f.dark === theme);
  const mode = family && family.dark === theme ? 'тёмная' : 'светлая';
  document.querySelector<HTMLElement>('#bar .title')!.textContent = family
    ? `${family.name} — ${mode}`
    : theme;
  document.querySelector<HTMLElement>('#bar .id')!.textContent = `data-theme="${theme}"`;
  for (const button of document.querySelectorAll<HTMLButtonElement>('.family-row button')) {
    button.setAttribute('aria-pressed', String(button.dataset.theme === theme));
  }
  try {
    localStorage.setItem('mdmini-theme-lab', theme);
  } catch {
    /* приватное окно — переживём */
  }
}

/**
 * Четыре цвета, по которым тему узнают, не открывая её. Читаются из самого
 * стиля, а не дублируются здесь — иначе свотч и тема разъехались бы на первой
 * же правке палитры.
 *
 * Тему приходится примерять на `<html>`: палитры объявлены как
 * `:root[data-theme=…]`, и этот селектор не совпадёт ни с каким другим
 * элементом, сколько ему ни выставляй атрибут. Цикл синхронный, до первой
 * отрисовки, так что мигания не видно.
 */
function swatches(theme: string): string[] {
  const root = document.documentElement;
  const before = root.getAttribute('data-theme');
  root.setAttribute('data-theme', theme);
  const cs = getComputedStyle(root);
  const out = ['--bg-base', '--text-primary', '--color-heading', '--color-checkbox'].map((v) =>
    cs.getPropertyValue(v).trim()
  );
  if (before === null) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', before);
  return out;
}

function buildPicker(): void {
  const picker = document.getElementById('picker')!;
  for (const family of FAMILIES) {
    const box = document.createElement('div');
    box.className = 'family';

    const name = document.createElement('div');
    name.className = 'family-name';
    name.textContent = family.shipped ? `${family.name} ·` : family.name;
    box.appendChild(name);

    const strip = document.createElement('div');
    strip.className = 'swatches';
    for (const theme of [family.light, family.dark]) {
      for (const color of swatches(theme)) {
        const chip = document.createElement('i');
        chip.style.background = color;
        strip.appendChild(chip);
      }
    }
    box.appendChild(strip);

    const note = document.createElement('div');
    note.className = 'family-note';
    note.textContent = family.note;
    box.appendChild(note);

    const row = document.createElement('div');
    row.className = 'family-row';
    for (const [label, theme] of [
      ['Светлая', family.light],
      ['Тёмная', family.dark],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.theme = theme;
      button.addEventListener('click', () => apply(theme));
      row.appendChild(button);
    }
    box.appendChild(row);
    picker.appendChild(box);
  }
}

/** Порядок обхода стрелками: светлая и тёмная каждой семьи подряд. */
const ORDER = FAMILIES.flatMap((f) => [f.light, f.dark]);

function step(delta: number): void {
  const current = document.documentElement.getAttribute('data-theme') ?? ORDER[0];
  const index = ORDER.indexOf(current);
  apply(ORDER[(index + delta + ORDER.length) % ORDER.length]);
}

/**
 * `?engine=live-render` поднимает стенд в live-render — том же виде, что
 * собирает приложение. Нужно не только для тем: часть интерфейса существует
 * только в этом движке (инспектор ссылок, плавающая панель форматирования), и
 * иначе её негде посмотреть, кроме как в собранном приложении.
 */
function liveRenderRequested(): boolean {
  return new URLSearchParams(location.search).get('engine') === 'live-render';
}

function mountEditor(): void {
  const parent = document.getElementById('editor')!;
  const liveRender = liveRenderRequested();
  const state = EditorState.create({
    // Курсор в конце: `cursorInRange()` раскрывает разметку под кареткой, и на
    // позиции 0 первая строка показала бы сырой markdown.
    doc: SAMPLE,
    selection: { anchor: SAMPLE.length },
    extensions: [createExtensions()],
  });
  const view = new EditorView({ state, parent });
  // Компартмент уже занят движком по умолчанию, поэтому не при создании
  // состояния, а переконфигурацией после — ровно как это делает приложение.
  if (liveRender) {
    view.dispatch({
      effects: previewCompartment.reconfigure([
        flavourFacet.of(LIVE_RENDER),
        livePreviewPlugin,
        liveRenderExtensions(),
      ]),
    });
  }
  document.querySelector<HTMLElement>('#bar .id')!.dataset.engine = liveRender
    ? 'live-render'
    : 'live-preview';
}

buildPicker();
mountEditor();

let restored: string | null = null;
try {
  restored = localStorage.getItem('mdmini-theme-lab');
} catch {
  /* приватное окно */
}
apply(restored && ORDER.includes(restored) ? restored : 'phosphor-dark');

document.addEventListener('keydown', (e) => {
  // Стрелки работают, только когда фокус не в редакторе — иначе они двигали бы
  // каретку, а не тему.
  if (document.activeElement?.closest('.cm-editor')) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') step(1);
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') step(-1);
});
