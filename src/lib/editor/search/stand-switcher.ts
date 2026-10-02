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
      view.dom.append(dom);
      this.dom = dom;
      this.paint();
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
        b.setAttribute('aria-checked', String(b.dataset.variant === current));
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
  '.cm-md-search-stand button[aria-checked="true"]': {
    background: 'rgba(var(--color-glow), 0.18)',
    color: 'var(--text-primary)',
  },
});

/** The stand: the stored variant and the control that changes it. */
export function searchStandSwitcher(): Extension {
  return [variantCompartment.of(provide(stored())), switcher, standTheme];
}
