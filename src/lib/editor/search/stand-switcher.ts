/**
 * STAND ONLY — delete once the owner has picked a dimming variant.
 *
 * A floating `A · B · C · off` control in the top-right corner of the app's
 * editor that switches the search spotlight live, so the three variants in
 * `spotlight.ts` can be compared on the same document. Development builds
 * only (`import.meta.env.DEV` at the call site in `setup.ts`), and only in the
 * app's own editor host — not in the landing's demo cards, which share
 * `createExtensions()`.
 *
 * Removal is this file plus its one import and one line in `setup.ts`; the
 * chosen variant then becomes the default of `spotlightVariant`.
 */
import { Compartment, Prec, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { spotlightVariant, type SpotlightVariant } from './spotlight';

const STORAGE_KEY = 'couplet.dev.search-spotlight';

const OPTIONS: readonly { variant: SpotlightVariant; label: string; title: string }[] = [
  { variant: 'veil', label: 'A', title: 'A — вуаль с вырезами под совпадения' },
  { variant: 'lines', label: 'B', title: 'B — гаснут строки без совпадений' },
  { variant: 'spotlight', label: 'C', title: 'C — вуаль, вырез только под текущим' },
  { variant: 'off', label: 'off', title: 'Без затемнения' },
];

const variantCompartment = new Compartment();

/**
 * A document to search in: several screens, every element the highlights have
 * to survive (gradient headings, bold, code, quotes, done tasks, tables,
 * links, a code block, a mermaid diagram), and words that repeat at different
 * densities — «поиск» often, «вуаль» a few times, «редкое» once.
 */
const SAMPLE_DOC = `# Поиск по документу

Это демо-текст для стенда. Попробуй искать **поиск**, \`код\`, «вуаль», «редкое» или регулярку вроде \`по[а-я]+\`.

Обычный абзац, в котором слово **поиск** встречается внутри жирного, а ещё поиск просто в тексте. Иногда *поиск курсивом*, иногда ~~зачёркнутый поиск~~, а иногда [ссылка про поиск](https://example.com).

## Как работает поиск

Панель внизу показывает счётчик: сколько всего совпадений и на каком ты сейчас. Enter — следующее, Shift+Enter — предыдущее, Esc — закрыть.

- пункт списка про поиск
- ещё один пункт, без совпадений
- [x] выполненная задача с поиском
- [ ] невыполненная задача, тоже про поиск
- \`inline поиск в коде\`

> Цитата: поиск должен быть виден сразу, а всё остальное — уйти под вуаль.

### Таблица

| Вариант | Что гаснет | Поиск виден |
|---------|------------|-------------|
| A | всё, кроме совпадений | да |
| B | строки без совпадений | да |
| C | всё, кроме текущего | только текущий поиск |

### Код

\`\`\`js
// поиск по документу
const поиск = find('поиск');
for (const match of поиск) highlight(match);
\`\`\`

## Длинный кусок для прокрутки

Lorem ipsum по-русски: текст идёт, абзацы сменяют друг друга, и где-то среди них прячется поиск. Важно, чтобы при прокрутке вуаль ехала вместе с текстом и вырезы не отставали.

Второй абзац без нужного слова. Он нужен только для того, чтобы было что затемнять и было видно контраст между фоном и найденным.

Третий абзац: вуаль должна быть мягкой, но заметной. Если вуаль слишком тёмная — теряется контекст, если слишком светлая — не видно фокуса.

#### Заголовок четвёртого уровня про поиск

1. Нумерованный список
2. Второй пункт про поиск
3. Третий пункт

Ещё немного текста. Здесь есть одно редкое слово, которое встречается в документе ровно один раз.

\`\`\`mermaid
graph LR
  A[Запрос] --> B{Есть совпадения?}
  B -- да --> C[Вуаль + вырезы]
  B -- нет --> D[Поле краснеет]
\`\`\`

##### Пятый уровень

###### Шестой уровень — поиск

Последний абзац: *курсив*, ~~зачёркнутое~~, **жирное**, \`код\` и ссылка про поиск — всё рядом, чтобы проверить подсветку на любом оформлении.
`;

/**
 * In the plain browser `App.svelte`'s startup effect throws on the missing
 * Tauri internals before the theme effect gets to set `data-theme`, so the
 * page has no palette at all — and the veil, mixed from `--bg-base`, comes
 * out black. The stand therefore carries its own theme picker there. Inside
 * Tauri the app owns the theme and the picker is not rendered.
 */
const THEMES = [
  'dark', 'light', 'aurora-dark', 'aurora-light', 'autumn-dark', 'autumn-light',
  'blueprint-dark', 'blueprint-light', 'ink-dark', 'ink-light',
  'paper-dark', 'paper-light', 'phosphor-dark', 'phosphor-light',
] as const;
const THEME_KEY = 'couplet.dev.search-stand-theme';

function storedTheme(): string {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value && (THEMES as readonly string[]).includes(value) ? value : 'dark';
  } catch {
    return 'dark';
  }
}

function applyTheme(theme: string): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Blocked storage: the theme just resets on reload.
  }
}

function loadSample(view: EditorView): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: SAMPLE_DOC },
    selection: { anchor: 0 },
    scrollIntoView: true,
  });
  view.focus();
}

function isVariant(value: string | null): value is SpotlightVariant {
  return OPTIONS.some((o) => o.variant === value);
}

function stored(): SpotlightVariant {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isVariant(value) ? value : 'veil';
  } catch {
    return 'veil';
  }
}

function store(variant: SpotlightVariant): void {
  try {
    localStorage.setItem(STORAGE_KEY, variant);
  } catch {
    // Private mode or blocked storage: the choice just does not survive a reload.
  }
}

function provide(variant: SpotlightVariant): Extension {
  return Prec.highest(spotlightVariant.of(variant));
}

const switcher = ViewPlugin.fromClass(
  class {
    private readonly dom: HTMLElement | null = null;

    constructor(private readonly view: EditorView) {
      if (!view.dom.closest('.md-editor-host')) return;
      const dom = document.createElement('div');
      dom.className = 'cm-md-search-stand';
      dom.setAttribute('role', 'radiogroup');
      dom.setAttribute('aria-label', 'Search spotlight variant (stand)');
      for (const option of OPTIONS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = option.label;
        b.title = option.title;
        b.dataset.variant = option.variant;
        // Keep focus where it is — in the Find field — so the dimming being
        // compared stays on while clicking through the variants.
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', () => this.select(option.variant));
        dom.append(b);
      }
      const demo = document.createElement('button');
      demo.type = 'button';
      demo.textContent = 'демо';
      demo.title = 'Заменить документ демо-текстом для поиска';
      demo.className = 'cm-md-search-stand-demo';
      demo.addEventListener('mousedown', (e) => e.preventDefault());
      demo.addEventListener('click', () => loadSample(this.view));
      dom.append(demo);
      if (!('__TAURI_INTERNALS__' in window)) {
        const select = document.createElement('select');
        select.className = 'cm-md-search-stand-theme';
        select.title = 'Тема (только на стенде в браузере)';
        for (const theme of THEMES) select.add(new Option(theme, theme));
        select.value = storedTheme();
        applyTheme(select.value);
        select.addEventListener('change', () => applyTheme(select.value));
        dom.append(select);
      }
      view.dom.append(dom);
      this.dom = dom;
      this.paint();
      // In the plain browser (`npm run dev`) there is no file to open, so an
      // empty editor gets the sample straight away. Never inside Tauri, where
      // an empty editor is a real untitled document. Deferred: no dispatch
      // from a plugin constructor.
      if (view.state.doc.length === 0 && !('__TAURI_INTERNALS__' in window)) {
        queueMicrotask(() => {
          if (this.view.state.doc.length === 0) loadSample(this.view);
        });
      }
    }

    update(): void {
      this.paint();
    }

    destroy(): void {
      this.dom?.remove();
    }

    private select(variant: SpotlightVariant): void {
      store(variant);
      this.view.dispatch({ effects: variantCompartment.reconfigure(provide(variant)) });
    }

    private paint(): void {
      if (!this.dom) return;
      const current = this.view.state.facet(spotlightVariant);
      for (const b of this.dom.querySelectorAll<HTMLButtonElement>('button')) {
        if (b.dataset.variant) b.setAttribute('aria-checked', String(b.dataset.variant === current));
      }
    }
  }
);

// Styled here rather than in search.css so that removing the stand stays a
// one-file change.
const standTheme = EditorView.baseTheme({
  '.cm-md-search-stand': {
    position: 'absolute',
    top: '10px',
    right: '14px',
    zIndex: '300',
    display: 'flex',
    gap: '2px',
    padding: '3px',
    borderRadius: '8px',
    background: 'var(--bg-surface)',
    boxShadow: '0 0 0 1px var(--border), 0 4px 14px rgba(0, 0, 0, 0.18)',
    font: "500 11px/1 'Inter', -apple-system, system-ui, sans-serif",
  },
  '.cm-md-search-stand button': {
    minWidth: '26px',
    height: '22px',
    padding: '0 7px',
    border: 'none',
    borderRadius: '5px',
    background: 'transparent',
    color: 'var(--text-subtle)',
    font: 'inherit',
    cursor: 'pointer',
  },
  '.cm-md-search-stand button:hover': {
    background: 'var(--highlight)',
    color: 'var(--text-primary)',
  },
  '.cm-md-search-stand .cm-md-search-stand-demo': {
    marginLeft: '4px',
    boxShadow: 'inset 1px 0 0 var(--border)',
    borderRadius: '0 5px 5px 0',
  },
  '.cm-md-search-stand .cm-md-search-stand-theme': {
    marginLeft: '4px',
    height: '22px',
    border: 'none',
    borderRadius: '5px',
    background: 'transparent',
    color: 'var(--text-subtle)',
    font: 'inherit',
    cursor: 'pointer',
  },
  '.cm-md-search-stand button[aria-checked="true"]': {
    background: 'rgba(var(--color-glow), 0.18)',
    color: 'var(--text-primary)',
  },
});

/** The stand: the stored variant and the control that changes it. */
export function searchStandSwitcher(): Extension {
  return [variantCompartment.of(provide(stored())), switcher, standTheme];
}
