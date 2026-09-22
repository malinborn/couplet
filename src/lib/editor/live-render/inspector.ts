import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import { keymap, ViewPlugin } from '@codemirror/view';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { languages } from '@codemirror/language-data';
import {
  detectInspectorTarget,
  setLinkUrl,
  removeLink,
  setFenceLang,
  type InspectorTarget,
  type LinkTarget,
  type FenceTarget,
} from './inspector-model';
import { openInspectorFor } from './effects';
import { isAnchor, navigateToHeading } from '../heading-slugs';
import { t } from '../../i18n';
import '../../../styles/live-render-inspector.css';

/**
 * The element inspector — Phase 7 of live-render.
 *
 * Under the `'never'` reveal policy markdown markers are hidden and their
 * ranges are atomic (Phase 2), so a link's URL and a fenced code block's
 * language become unreachable by caret. This panel is the escape hatch:
 * caret inside a `Link` shows a URL editor; caret inside a `FencedCode`
 * shows a language picker. Mermaid stays `'on-cursor'` (see `flavour.ts`)
 * so its fenced source is already directly editable — see the mermaid
 * exclusion in `checkTarget` below.
 *
 * Bare DOM + `@floating-ui/dom`, same approach as `hover-menu.ts` and
 * `selection-toolbar.ts` — no Svelte component in the CM6 layer.
 *
 * ---
 * ## The feedback-loop problem, and why this diverges from `selection-toolbar.ts`
 *
 * `selection-toolbar.ts` closes on `view.dom`'s native `blur` event, because
 * every one of its buttons uses `mousedown` + `preventDefault()` specifically
 * so DOM focus *never* leaves the editor. This panel is different on
 * purpose: its `<input>`/`<select>` must take real DOM focus — that's the
 * whole point, since under permanent hiding the URL is invisible to a
 * screen reader too, and a real focusable control is the only way to reach
 * it with a keyboard. That means `view.dom` blurs *every time the panel is
 * used*, so this plugin never treats `view.hasFocus`/`focusChanged` as a
 * close signal. Only two things close the panel: an explicit user gesture
 * (Escape, Enter, Remove-link, or focus truly leaving the whole panel), or
 * the caret genuinely leaving the underlying element.
 *
 * The second risk is a literal loop: committing a URL edit dispatches a
 * transaction, which re-runs this plugin's `update()`, which re-detects the
 * same link (the caret is still inside it) and would otherwise reopen/rebuild
 * the panel it was just asked to close. Two mechanisms prevent that:
 *
 * 1. **Same-element reuse.** If the freshly detected target overlaps the one
 *    already shown, `checkTarget` only repositions the existing panel and
 *    updates the stored target's ranges — it never touches the `<input>`'s
 *    value or steals focus. This also means ordinary typing inside the
 *    `<input>` is 100% safe: it's a plain HTML control with local state and
 *    doesn't call `view.dispatch` (and therefore doesn't run this plugin's
 *    `update()`) until the user commits.
 * 2. **Explicit dismissal.** Enter and Escape record the just-closed target
 *    in `dismissedTarget` before hiding. As long as the caret stays inside
 *    (or re-enters) that same overlapping range, `checkTarget` treats it as
 *    "still dismissed" and stays hidden — including through the commit's
 *    own synchronous `update()` call. `dismissedTarget` is cleared the
 *    moment detection finds nothing, so a genuine new visit (caret leaves,
 *    then comes back) reopens normally.
 *
 * `hidePanel()` nulls the module-level singleton *before* removing the DOM
 * node, so the synchronous `focusout` that `Element.remove()` fires on a
 * focused descendant sees `activePanel !== panel` and no-ops — otherwise
 * Enter's own cleanup would re-trigger the "focus left the panel, commit"
 * path a second time.
 */

let activePanel: HTMLElement | null = null;
let activeView: EditorView | null = null;
let activeTarget: InspectorTarget | null = null;
// The target that was just explicitly dismissed (Enter/Escape) — suppresses
// reopening for the same element until the caret actually leaves it.
let dismissedTarget: InspectorTarget | null = null;

function overlaps(a: { from: number; to: number }, b: { from: number; to: number }): boolean {
  return a.from <= b.to && b.from <= a.to;
}

function sameLogicalElement(a: InspectorTarget, b: InspectorTarget): boolean {
  return a.kind === b.kind && overlaps(a, b);
}

function asLink(target: InspectorTarget | null): LinkTarget | null {
  return target && target.kind === 'link' ? target : null;
}

function asFence(target: InspectorTarget | null): FenceTarget | null {
  return target && target.kind === 'fence' ? target : null;
}

function onOutsideMouseDown(e: MouseEvent): void {
  if (activePanel && !activePanel.contains(e.target as Node)) {
    hidePanel();
  }
}

function hidePanel(): void {
  const panel = activePanel;
  // Null the singleton before touching the DOM — see the class-level doc
  // comment on why ordering here matters (the synchronous focusout that
  // `remove()` fires on a focused child must see the panel as already gone).
  activePanel = null;
  activeView = null;
  activeTarget = null;
  document.removeEventListener('mousedown', onOutsideMouseDown, true);
  if (panel) panel.remove();
}

/** A `VirtualElement` (`@floating-ui/dom`) anchored to `target`'s document range. */
function targetReference(
  view: EditorView,
  target: InspectorTarget
): { getBoundingClientRect(): DOMRect; contextElement: Element } {
  return {
    contextElement: view.dom,
    getBoundingClientRect(): DOMRect {
      const start = view.coordsAtPos(target.from);
      const end = view.coordsAtPos(Math.max(target.from, target.to - 1), -1) ?? start;
      if (!start) {
        const r = view.dom.getBoundingClientRect();
        return new DOMRect(r.left, r.top, 0, 0);
      }
      const anchor = end ?? start;
      const left = Math.min(start.left, anchor.left);
      const right = Math.max(start.right, anchor.right);
      const top = Math.min(start.top, anchor.top);
      const bottom = Math.max(start.bottom, anchor.bottom);
      return new DOMRect(left, top, right - left, bottom - top);
    },
  };
}

function positionPanel(view: EditorView, target: InspectorTarget): void {
  if (!activePanel) return;
  const panel = activePanel;
  computePosition(targetReference(view, target), panel, {
    placement: 'bottom-start',
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  }).then(({ x, y }) => {
    // The panel may have been dismissed while computePosition was pending.
    if (activePanel !== panel) return;
    Object.assign(panel.style, { left: `${x}px`, top: `${y}px` });
  });
}

function commitLinkUrlIfChanged(view: EditorView, target: LinkTarget, value: string): void {
  const current = view.state.doc.sliceString(target.url.from, target.url.to);
  if (value !== current) {
    view.dispatch(setLinkUrl(view.state, target, value));
  }
}

function buildLinkPanel(view: EditorView, target: LinkTarget, autoFocus: boolean): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'cm-inspector-panel cm-inspector-panel-link';
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', t('editor.inspector.link_group'));

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cm-inspector-input';
  input.placeholder = 'https://…';
  input.setAttribute('aria-label', t('editor.inspector.link_url'));
  input.value = view.state.doc.sliceString(target.url.from, target.url.to);

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'cm-inspector-btn';
  openBtn.textContent = t('editor.inspector.open');

  /**
   * Подпись зависит от того, куда ведёт ссылка: у якоря «открыть в браузере»
   * было бы враньём, а кнопка одна. Обновляется по мере правки поля, иначе
   * разойдётся с тем, что в нём сейчас написано.
   */
  function syncOpenLabel(): void {
    openBtn.setAttribute(
      'aria-label',
      isAnchor(input.value) ? t('editor.inspector.jump_to_heading') : t('editor.inspector.open_in_browser')
    );
  }
  syncOpenLabel();
  input.addEventListener('input', syncOpenLabel);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'cm-inspector-btn cm-inspector-btn-danger';
  removeBtn.textContent = t('editor.inspector.remove_link');
  removeBtn.setAttribute('aria-label', t('editor.inspector.remove_link'));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const live = asLink(activeTarget) ?? target;
      commitLinkUrlIfChanged(view, live, input.value);
      dismissedTarget = live;
      hidePanel();
      view.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      dismissedTarget = asLink(activeTarget) ?? target;
      hidePanel(); // revert: never dispatches, so nothing to undo
      view.focus();
    }
  });

  // preventDefault on mousedown keeps focus (and any uncommitted input
  // text) exactly where it is — same trick as hover-menu.ts / selection-toolbar.ts.
  openBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url) return;
    // Якорь ведёт внутрь документа, и до этого кнопка на нём просто молчала:
    // открыть его в браузере нельзя, а перейти по нему — можно, ровно как это
    // делает ⌘-клик по самой ссылке.
    if (isAnchor(url)) {
      hidePanel();
      view.focus();
      navigateToHeading(view, url.slice(1));
      return;
    }
    import('@tauri-apps/plugin-shell')
      .then(({ open }) => open(url))
      .catch(() => {
        window.open(url, '_blank');
      });
  });

  removeBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const live = asLink(activeTarget) ?? target;
    dismissedTarget = null;
    view.dispatch(removeLink(view.state, live));
    hidePanel();
    view.focus();
  });

  panel.append(input, openBtn, removeBtn);

  if (autoFocus) {
    // Panel isn't attached to the document yet — defer past that.
    requestAnimationFrame(() => input.focus());
  }

  return panel;
}

const LANGUAGE_OPTIONS: { value: string; label: string }[] = languages
  .slice()
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((l) => ({ value: l.alias[0] ?? l.name.toLowerCase(), label: l.name }));

function buildFencePanel(view: EditorView, target: FenceTarget): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'cm-inspector-panel cm-inspector-panel-fence';
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', t('editor.inspector.code_language_group'));

  const select = document.createElement('select');
  select.className = 'cm-inspector-select';
  select.setAttribute('aria-label', t('editor.inspector.code_language_group'));

  const currentLang = view.state.doc.sliceString(target.lang.from, target.lang.to);
  const normalizedCurrent = currentLang.trim().toLowerCase();

  const options: { value: string; label: string }[] = [
    { value: '', label: t('editor.inspector.plain_text') },
  ];
  let matchedValue: string | null = normalizedCurrent === '' ? '' : null;
  for (const opt of LANGUAGE_OPTIONS) {
    options.push(opt);
    if (matchedValue === null && opt.value.toLowerCase() === normalizedCurrent) {
      matchedValue = opt.value;
    }
  }
  if (matchedValue === null) {
    // Info string isn't one @codemirror/language-data knows about — keep it
    // selectable rather than silently discarding it the first time the
    // panel opens.
    options.push({ value: currentLang, label: currentLang });
    matchedValue = currentLang;
  }

  for (const { value, label } of options) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  }
  select.value = matchedValue;

  select.addEventListener('change', () => {
    const live = asFence(activeTarget) ?? target;
    view.dispatch(setFenceLang(view.state, live, select.value));
  });

  select.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      dismissedTarget = asFence(activeTarget) ?? target;
      hidePanel();
      view.focus();
    }
  });

  panel.appendChild(select);
  return panel;
}

function showPanel(view: EditorView, target: InspectorTarget, autoFocus: boolean): void {
  hidePanel();
  activeView = view;
  activeTarget = target;

  const panel =
    target.kind === 'link' ? buildLinkPanel(view, target, autoFocus) : buildFencePanel(view, target);

  document.body.appendChild(panel);
  activePanel = panel;

  panel.addEventListener('focusout', (e) => {
    if (activePanel !== panel) return; // already torn down — see hidePanel()
    const next = e.relatedTarget as Node | null;
    if (next && panel.contains(next)) return; // focus moved within the panel itself

    const link = asLink(activeTarget);
    if (link) {
      const input = panel.querySelector<HTMLInputElement>('.cm-inspector-input');
      if (input) commitLinkUrlIfChanged(view, link, input.value);
    }
    hidePanel();
  });

  positionPanel(view, target);

  // Deferred so the interaction that opened the panel (e.g. a mousedown
  // that moved the caret into the link) doesn't immediately trigger this
  // same listener — same pattern as hover-menu.ts / selection-toolbar.ts.
  setTimeout(() => {
    document.addEventListener('mousedown', onOutsideMouseDown, true);
  }, 0);
}

function checkTarget(view: EditorView): void {
  const pos = view.state.selection.main.head;
  let target = detectInspectorTarget(view.state, pos);

  // Mermaid keeps the 'on-cursor' reveal policy (flavour.ts), so its fenced
  // source — including the info string — is already directly visible and
  // editable by hand when the caret is inside it. Showing the language
  // picker on top would be a redundant, confusing second UI for the same
  // thing, so skip it specifically for mermaid fences.
  if (target?.kind === 'fence') {
    const lang = view.state.doc.sliceString(target.lang.from, target.lang.to).trim().toLowerCase();
    if (lang === 'mermaid') target = null;
  }

  if (!target) {
    dismissedTarget = null;
    hidePanel();
    return;
  }

  if (dismissedTarget && sameLogicalElement(dismissedTarget, target)) {
    return; // explicitly dismissed — stays hidden until the caret leaves and re-enters
  }
  dismissedTarget = null;

  if (activePanel && activeTarget && sameLogicalElement(activeTarget, target)) {
    // Same element already shown: never rebuild the DOM here — the control
    // inside may hold uncommitted keystrokes the user is mid-typing. Just
    // keep the stored range fresh and reposition for any layout shift.
    activeTarget = target;
    positionPanel(view, target);
    return;
  }

  showPanel(view, target, false);
}

class InspectorPlugin {
  constructor(private readonly view: EditorView) {}

  update(update: ViewUpdate): void {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(openInspectorFor)) {
          const target = detectInspectorTarget(update.state, effect.value.pos);
          if (target) {
            dismissedTarget = null;
            showPanel(update.view, target, true);
          }
          return;
        }
      }
    }

    if (update.selectionSet || update.docChanged) {
      checkTarget(update.view);
    }
  }

  destroy(): void {
    if (activeView === this.view) hidePanel();
  }
}

/**
 * Mod-k moves keyboard focus into the panel when the caret is already
 * inside an inspectable element and the panel is showing. This is the
 * deliberate, discoverable "reach the inspector from the keyboard" gesture
 * — the panel does NOT auto-steal focus merely because the caret passed
 * through the element (e.g. while arrowing through the document), since
 * that would be disruptive during ordinary navigation and editing.
 */
function focusInspector(view: EditorView): boolean {
  if (!activePanel || activeView !== view) return false;
  const control = activePanel.querySelector<HTMLInputElement | HTMLSelectElement>(
    '.cm-inspector-input, .cm-inspector-select'
  );
  if (!control) return false;
  control.focus();
  return true;
}

export function elementInspector(): Extension {
  return [ViewPlugin.fromClass(InspectorPlugin), keymap.of([{ key: 'Mod-k', run: focusInspector }])];
}
