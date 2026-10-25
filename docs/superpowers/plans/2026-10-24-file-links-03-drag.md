# File Links 03 — Drag to Insert a Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Drag a stash card onto the text, a tab card with ⌥ held, or a Finder file with ⌥ held, and a markdown link to it lands where it was dropped — with a drop caret showing where.

**Architecture:** One CM6 module (`src/lib/editor/links/link-drop.ts`) owns the drop caret (a StateField + a `layer()` drawing `.cm-dropCursor`), the insertion (`insertLinkAt`, reusing plan 02's `linkMarkdownFor`) and a small `LinkDropTarget` facade the app hands to the drawer. The drawer's existing pointer-drag machine learns one new drop target, `'text'` (pure `resolveDrop`), reached by a stash card anywhere over the text and by a tab card only while ⌥ is held — which also suppresses the window carousel. Finder drops stay Tauri drag-drop events; a new Rust command `current_modifiers` (`NSEvent modifierFlags`, `objc` runtime) tells the app whether ⌥ was held, and the drop position is converted physical → CSS px → `posAtCoords`.

**Tech Stack:** TypeScript, Svelte 5 runes, CodeMirror 6 (`layer`, `RectangleMarker`), Tauri 2 (Rust `objc` 0.2 runtime calls), Vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-10-24-file-links-design.md` — D7 (and the D9 strings for this part).

**Depends on:** plan 01 (`LinkControl`, `linkControlFacet`, `reveal.rs`) and plan 02 (`link-destination.ts`, `LinkControl.project`, `LinkProject`). Execute 01 → 02 → 03.

**Ground rules for every task**

- Work only in `/Users/maximkovalevskij/playground/md-mini/.claude/worktrees/file-links`. Every command below runs from that directory.
- Never `git stash`, `git checkout <file>`, `git reset`, `git rebase`. `git add` explicit paths only.
- Frontend tests: `npx vitest run <path>`; full suite `npx vitest run --dir src`.
- Never `npm run tauri dev` / `npm run tauri build`. Tauri checks: `npm run dev:app -- --features mcp-bridge`.
- Check unfamiliar Tauri 2 / CM6 / Svelte 5 APIs with context7 first.
- **Objective-C:** never pass or compare a `bool` literal with a `BOOL` (it is `i8` on x86_64) — this plan's call returns `NSUInteger` (`usize` on both arches) and has no `BOOL`; `npm run check:x86` still runs.
- Strict TypeScript, no `any`; ES2020 library only.
- Conventional commits, each ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Decisions this plan takes (beyond the spec)

| # | Decision | Why |
|---|---|---|
| R1 | Drops insert links only into a **markdown buffer** that is not read-only and has a `LinkControl`; anywhere else the text is not a drop target (a Finder ⌥-drop then opens the files as before). | A `[x](y)` dropped into a `.py` file, a CSV table buffer (its guard rewrites the table) or a read-only too-large CSV is never what was meant. |
| R2 | The drawer closes after a successful link drop. | The link lands in the text behind the scrim; closing shows it and gives the caret back. |
| R3 | In link mode the scrim lightens and stops catching the pointer (`pointer-events: none`). | `posAtCoords` resolves the column through `elementFromPoint`; with the scrim on top it falls back to an imprecise estimate. |
| R4 | The destination is computed from `LinkControl.project(docPath)` (plan 02's `link_project`), awaited after the drop; the drop caret holds — and maps — the position meanwhile. | Same normalization as the picker (`path_norm` spelling) without a candidate walk; typing during the IPC round trip cannot shift the insertion point. |
| R5 | A space is added on a side where the drop point touches a word (`padLink`). | `see[plan](plan.md)here` is never wanted. No space before closing punctuation. |
| R6 | `current_modifiers` reads `NSEvent.modifierFlags` on the main thread (hop + channel, like `reveal_in_finder`). | AppKit class state; the hop costs microseconds and removes any thread-safety question. Known limit: an ⌥ released within the IPC round trip after the drop reads as no ⌥ (live-checked). |
| R7 | No drop caret during a Finder drag (only on the drop itself). | The webview gets no key events during a Finder drag, and polling the OS on every `over` event is not worth an IPC per pointer move. Spec D7 asks for the caret during a link-mode drag, which is the tab-card ⌥ drag. |

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/lib/editor/links/link-drop.ts` | new | Drop caret field + layer, `linkTextFor`, `padLink`, `insertLinkAt`, `dropPointToClient`, `createLinkDropTarget` |
| `src/lib/editor/setup.ts` | modify | Install the caret with a `LinkControl` |
| `src/lib/stash/drop-target.ts` | modify | `'text'` target, `linkMode` |
| `src/lib/tabs/link-items.ts` | new | Dragged tabs → link items |
| `src/lib/tabs/TabDrawer.svelte` | modify | `linkDrop` prop, ⌥ tracking, stash-card drop, ghost, scrim |
| `src/lib/tabs/WindowCarousel.svelte` | modify | `linkHint` line in the carousel band |
| `src-tauri/src/reveal.rs` | modify | `current_modifiers` |
| `src-tauri/src/lib.rs` | modify | Register it |
| `src/lib/links/types.ts`, `src/lib/links/ipc.ts` | modify | `Modifiers`, `currentModifiers` |
| `src/App.svelte` | modify | `linkDrop` for the drawer; Finder ⌥-drop |
| `locales/*/app.json` | modify | Two strings |

---

### Task 1: Strings (D9)

**Files:**
- Modify: `locales/{en,ru,de,es,fr,zh}/app.json`

- [x] **Step 1: Insert the keys**

```bash
node --input-type=module <<'EOF'
import fs from 'node:fs';

const ANCHOR = 'tabs.carousel.foot_drag';
const KEYS = {
  en: { 'tabs.carousel.foot_link': '⌥ — insert a link instead', 'tabs.ghost.link': 'Insert link' },
  ru: { 'tabs.carousel.foot_link': '⌥ — вставить ссылку', 'tabs.ghost.link': 'Вставить ссылку' },
  de: { 'tabs.carousel.foot_link': '⌥ — stattdessen Link einfügen', 'tabs.ghost.link': 'Link einfügen' },
  es: { 'tabs.carousel.foot_link': '⌥ — insertar un enlace en su lugar', 'tabs.ghost.link': 'Insertar enlace' },
  fr: { 'tabs.carousel.foot_link': '⌥ — insérer un lien à la place', 'tabs.ghost.link': 'Insérer un lien' },
  zh: { 'tabs.carousel.foot_link': '⌥ — 改为插入链接', 'tabs.ghost.link': '插入链接' },
};

for (const [lang, entries] of Object.entries(KEYS)) {
  const file = `locales/${lang}/app.json`;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const at = lines.findIndex((l) => l.trimStart().startsWith(`"${ANCHOR}":`));
  if (at < 0) throw new Error(`${file}: anchor ${ANCHOR} not found`);
  const add = Object.entries(entries).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  lines.splice(at + 1, 0, ...add);
  fs.writeFileSync(file, lines.join('\n'));
  JSON.parse(fs.readFileSync(file, 'utf8'));
}
console.log('ok');
EOF
```

Expected output: `ok`.

- [x] **Step 2: Run the completeness test**

Run: `npx vitest run src/lib/i18n.test.ts`
Expected: PASS.

- [x] **Step 3: Commit**

```bash
git add locales/en/app.json locales/ru/app.json locales/de/app.json locales/es/app.json locales/fr/app.json locales/zh/app.json
git commit -m "feat(links): strings for drag-to-link

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `link-drop.ts` — caret, insertion, drop target

**Files:**
- Create: `src/lib/editor/links/link-drop.ts`
- Modify: `src/lib/editor/setup.ts` (the `linkControl` extensions line)
- Test: `src/lib/editor/links/link-drop.test.ts`

- [x] **Step 1: Write the failing tests**

```ts
// src/lib/editor/links/link-drop.test.ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdownExtension } from '../markdown-language';
import { documentPathField, setDocumentPath } from '../json-fence';
import { linkControlFacet, type LinkControl } from './open-link';
import { fakeLinkControl } from './fake-link-control';
import { createDocumentState } from '../state-factory';
import {
  createLinkDropTarget,
  dropPointToClient,
  insertLinkAt,
  linkDropCaretField,
  linkTextFor,
  padLink,
  setLinkDropCaret,
} from './link-drop';

const PROJECT = { projectRoot: '/r', docPath: '/r/docs/a.md' };

function projectControl(): LinkControl {
  return fakeLinkControl({ project: async (docPath) => ({ projectRoot: '/r', docPath }) });
}

let views: EditorView[] = [];
afterEach(() => {
  for (const v of views) v.destroy();
  views = [];
});

/** A real view whose geometry jsdom cannot give: a fixed rectangle, and every point maps to `pos`. */
function viewFor(
  doc: string,
  opts: { path?: string | null; control?: LinkControl | null; readOnly?: boolean; pos?: number } = {}
): EditorView {
  const control = opts.control === undefined ? projectControl() : opts.control;
  let state = EditorState.create({
    doc,
    extensions: [
      markdownExtension(),
      documentPathField,
      linkDropCaretField,
      ...(control ? [linkControlFacet.of(control)] : []),
      ...(opts.readOnly ? [EditorState.readOnly.of(true)] : []),
    ],
  });
  state = state.update({ effects: setDocumentPath.of(opts.path === undefined ? '/r/docs/a.md' : opts.path) }).state;
  const view = new EditorView({ state });
  views.push(view);
  view.scrollDOM.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  const pos = opts.pos ?? 4;
  view.posAtCoords = (() => pos) as unknown as EditorView['posAtCoords'];
  return view;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('pure helpers', () => {
  it('linkTextFor joins one link per item with ", "', () => {
    expect(
      linkTextFor(
        [
          { path: '/r/docs/plan.md', title: null },
          { path: '/n/x.md', title: 'Ideas' },
        ],
        PROJECT.docPath,
        PROJECT.projectRoot
      )
    ).toBe('[plan](plan.md), [Ideas](/n/x.md)');
  });

  it('padLink adds a space only where the drop point touches a word', () => {
    expect(padLink('L', 'a', 'b')).toBe(' L ');
    expect(padLink('L', ' ', ' ')).toBe('L');
    expect(padLink('L', '', '')).toBe('L');
    expect(padLink('L', 'a', '.')).toBe(' L');
    expect(padLink('L', '\n', ')')).toBe('L');
  });

  it('dropPointToClient divides by the scale factor and the page zoom', () => {
    expect(dropPointToClient({ x: 400, y: 200 }, 2, 1)).toEqual({ x: 200, y: 100 });
    expect(dropPointToClient({ x: 400, y: 200 }, 2, 1.25)).toEqual({ x: 160, y: 80 });
    expect(dropPointToClient({ x: 10, y: 20 }, 0, 0)).toEqual({ x: 10, y: 20 });
  });
});

describe('the drop caret', () => {
  it('is set, mapped through edits and cleared', () => {
    let state = EditorState.create({ doc: 'hello world', extensions: [linkDropCaretField] });
    state = state.update({ effects: setLinkDropCaret.of(5) }).state;
    state = state.update({ changes: { from: 0, insert: 'ab' } }).state;
    expect(state.field(linkDropCaretField)).toBe(7);
    state = state.update({ effects: setLinkDropCaret.of(null) }).state;
    expect(state.field(linkDropCaretField)).toBeNull();
  });

  it('is installed with a LinkControl', () => {
    expect(createDocumentState('x', 0, [], { linkControl: fakeLinkControl() }).field(linkDropCaretField, false)).toBeNull();
    expect(createDocumentState('x', 0, []).field(linkDropCaretField, false)).toBeUndefined();
  });
});

describe('insertLinkAt', () => {
  it('inserts the link, moves the caret after it and clears the drop caret', () => {
    const view = viewFor('see  here');
    view.dispatch({ effects: setLinkDropCaret.of(4) });
    expect(insertLinkAt(view, 4, [{ path: '/r/docs/plan.md', title: null }], PROJECT)).toBe(true);
    expect(view.state.doc.toString()).toBe('see [plan](plan.md) here');
    expect(view.state.selection.main.head).toBe(19);
    expect(view.state.field(linkDropCaretField)).toBeNull();
  });

  it('refuses a read-only document', () => {
    const view = viewFor('see  here', { readOnly: true });
    expect(insertLinkAt(view, 4, [{ path: '/r/docs/plan.md', title: null }], PROJECT)).toBe(false);
    expect(view.state.doc.toString()).toBe('see  here');
  });
});

describe('createLinkDropTarget', () => {
  it('the text is a target only in a markdown document with a LinkControl', () => {
    expect(createLinkDropTarget(() => viewFor('x')).over(10, 10)).toBe(true);
    expect(createLinkDropTarget(() => viewFor('x', { path: '/r/a.py' })).over(10, 10)).toBe(false);
    expect(createLinkDropTarget(() => viewFor('x', { path: '/r/t.csv' })).over(10, 10)).toBe(false);
    expect(createLinkDropTarget(() => viewFor('x', { control: null })).over(10, 10)).toBe(false);
    expect(createLinkDropTarget(() => viewFor('x', { readOnly: true })).over(10, 10)).toBe(false);
    expect(createLinkDropTarget(() => viewFor('x')).over(900, 10)).toBe(false);
    expect(createLinkDropTarget(() => undefined).over(10, 10)).toBe(false);
  });

  it('hover shows the caret under the pointer, clear removes it', () => {
    const view = viewFor('see  here', { pos: 4 });
    const target = createLinkDropTarget(() => view);
    target.hover(10, 10);
    expect(view.state.field(linkDropCaretField)).toBe(4);
    target.clear();
    expect(view.state.field(linkDropCaretField)).toBeNull();
  });

  it('drop holds the position, asks the project, then inserts there', async () => {
    const control = projectControl();
    const view = viewFor('see  here', { control, pos: 4 });
    const target = createLinkDropTarget(() => view);
    expect(target.drop(10, 10, [{ path: '/r/docs/plan.md', title: null }])).toBe(true);
    expect(view.state.field(linkDropCaretField)).toBe(4);
    await flush();
    expect(view.state.doc.toString()).toBe('see [plan](plan.md) here');
    expect(view.state.field(linkDropCaretField)).toBeNull();
  });

  it('a project that cannot be asked gives an absolute link', async () => {
    const control = fakeLinkControl({ project: () => Promise.reject(new Error('down')) });
    const view = viewFor('see  here', { control, pos: 4 });
    createLinkDropTarget(() => view).drop(10, 10, [{ path: '/r/docs/plan.md', title: null }]);
    await flush();
    expect(view.state.doc.toString()).toBe('see [plan](/r/docs/plan.md) here');
  });

  it('nothing lands in a state that replaced the dropped-on one', async () => {
    const view = viewFor('see  here', { pos: 4 });
    createLinkDropTarget(() => view).drop(10, 10, [{ path: '/r/docs/plan.md', title: null }]);
    view.setState(EditorState.create({ doc: 'other', extensions: [linkDropCaretField] }));
    await flush();
    expect(view.state.doc.toString()).toBe('other');
  });

  it('a drop with nothing to link is no drop', () => {
    const view = viewFor('x');
    expect(createLinkDropTarget(() => view).drop(10, 10, [])).toBe(false);
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/editor/links/link-drop.test.ts`
Expected: FAIL — `Failed to resolve import "./link-drop"`.

- [x] **Step 3: Implement**

```ts
// src/lib/editor/links/link-drop.ts
import { EditorSelection, StateEffect, StateField, type Extension } from '@codemirror/state';
import { RectangleMarker, layer, type EditorView } from '@codemirror/view';
import { documentPathField } from '../json-fence';
import { isMarkdownBuffer } from '../file-language';
import { linkControlOf } from './open-link';
import { linkMarkdownFor } from '../../links/link-destination';
import type { LinkProject } from '../../links/types';

/** One file a drop links to (file-links D7). `title`: a stash note's title, its label. */
export interface LinkInsertItem {
  path: string;
  title: string | null;
}

/** Where a link-mode drag would drop; `null` hides the caret. */
export const setLinkDropCaret = StateEffect.define<number | null>();

/**
 * The drop caret's position. Mapped through edits, so it also holds the
 * insertion point while the drop waits for `LinkControl.project` (R4).
 */
export const linkDropCaretField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setLinkDropCaret)) return effect.value;
    }
    return value !== null && tr.docChanged ? tr.changes.mapPos(value) : value;
  },
});

/**
 * Drawn like CM6's own `dropCursor()` — a `.cm-dropCursor` marker, which the
 * editor theme already styles — but driven by our pointer drags, which are
 * not HTML5 drag-and-drop and so never reach `dropCursor()`.
 */
const linkDropCaretLayer = layer({
  above: true,
  class: 'cm-md-link-drop',
  update: (update) =>
    update.state.field(linkDropCaretField, false) !== update.startState.field(linkDropCaretField, false) ||
    update.docChanged ||
    update.geometryChanged,
  markers(view) {
    const pos = view.state.field(linkDropCaretField, false);
    if (pos === null || pos === undefined) return [];
    return RectangleMarker.forRange(view, 'cm-dropCursor', EditorSelection.cursor(pos));
  },
});

/** Installed by `createExtensions` together with a `LinkControl`. */
export const linkDropCaret: Extension = [linkDropCaretField, linkDropCaretLayer];

/** One link per item, separated by `, ` (several Finder files, several tabs). */
export function linkTextFor(items: readonly LinkInsertItem[], docPath: string | null, projectRoot: string | null): string {
  return items.map((item) => linkMarkdownFor(item, docPath, projectRoot)).join(', ');
}

/** R5: a space where the drop point touches a word — none before closing punctuation. */
export function padLink(text: string, before: string, after: string): string {
  const left = before !== '' && !/\s/.test(before) ? ' ' : '';
  const right = after !== '' && !/[\s.,;:!?)\]]/.test(after) ? ' ' : '';
  return `${left}${text}${right}`;
}

/** Tauri's drop position (physical px) → the page's CSS px: divide by the scale factor and the page zoom. */
export function dropPointToClient(
  position: { x: number; y: number },
  scaleFactor: number,
  zoom: number
): { x: number; y: number } {
  const factor = (scaleFactor > 0 ? scaleFactor : 1) * (zoom > 0 ? zoom : 1);
  return { x: position.x / factor, y: position.y / factor };
}

/** Insert the links at `pos`; `false` (nothing changed) for a read-only document or no items. */
export function insertLinkAt(
  view: EditorView,
  pos: number,
  items: readonly LinkInsertItem[],
  project: LinkProject
): boolean {
  if (items.length === 0 || view.state.readOnly) return false;
  const at = Math.max(0, Math.min(pos, view.state.doc.length));
  const before = at > 0 ? view.state.sliceDoc(at - 1, at) : '';
  const after = view.state.sliceDoc(at, at + 1);
  const text = padLink(linkTextFor(items, project.docPath, project.projectRoot), before, after);
  view.dispatch({
    changes: { from: at, insert: text },
    selection: { anchor: at + text.length },
    effects: setLinkDropCaret.of(null),
    userEvent: 'input.drop',
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/** What the drawer and the Finder drop handler need from the editor (D7). Coordinates are CSS px. */
export interface LinkDropTarget {
  /** Is (x, y) over text a link may be dropped into (R1)? */
  over(x: number, y: number): boolean;
  /** Show the drop caret at the text position under (x, y), or hide it when there is none. */
  hover(x: number, y: number): void;
  clear(): void;
  /** Insert links to `items` at (x, y). `true`: accepted (the insert follows the project answer). */
  drop(x: number, y: number, items: readonly LinkInsertItem[]): boolean;
}

export function createLinkDropTarget(currentView: () => EditorView | undefined): LinkDropTarget {
  function usable(): EditorView | null {
    const view = currentView();
    if (!view || view.state.readOnly || !linkControlOf(view.state)) return null;
    return isMarkdownBuffer(view.state.field(documentPathField, false) ?? null) ? view : null;
  }

  function inside(view: EditorView, x: number, y: number): boolean {
    const r = view.scrollDOM.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function hit(x: number, y: number): { view: EditorView; pos: number } | null {
    const view = usable();
    if (!view || !inside(view, x, y)) return null;
    const pos = view.posAtCoords({ x, y });
    return pos === null ? null : { view, pos };
  }

  function clear(): void {
    const view = currentView();
    if (view && (view.state.field(linkDropCaretField, false) ?? null) !== null) {
      view.dispatch({ effects: setLinkDropCaret.of(null) });
    }
  }

  return {
    over(x, y) {
      const view = usable();
      return view !== null && inside(view, x, y);
    },
    hover(x, y) {
      const at = hit(x, y);
      if (!at) {
        clear();
        return;
      }
      if (at.view.state.field(linkDropCaretField, false) !== at.pos) {
        at.view.dispatch({ effects: setLinkDropCaret.of(at.pos) });
      }
    },
    clear,
    drop(x, y, items) {
      const at = items.length > 0 ? hit(x, y) : null;
      const control = at ? linkControlOf(at.view.state) : null;
      if (!at || !control) {
        clear();
        return false;
      }
      const { view, pos } = at;
      view.dispatch({ effects: setLinkDropCaret.of(pos) });
      const docPath = view.state.field(documentPathField, false) ?? null;
      void control
        .project(docPath)
        .catch((err: unknown): LinkProject => {
          console.warn('link_project failed, linking absolutely:', err);
          return { projectRoot: null, docPath };
        })
        .then((project) => {
          // A state swapped in meanwhile (another tab) has no caret: nothing lands there.
          const held = view.state.field(linkDropCaretField, false);
          if (held === null || held === undefined) return;
          insertLinkAt(view, held, items, project);
        });
      return true;
    },
  };
}
```

- [x] **Step 4: Install the caret**

In `src/lib/editor/setup.ts`, add the import after `import { linkAction } from './links/slash-link';`:

```ts
import { linkDropCaret } from './links/link-drop';
```

and replace

```ts
    ...(linkControl ? [linkControlFacet.of(linkControl), linkExistence] : []),
```

with

```ts
    ...(linkControl ? [linkControlFacet.of(linkControl), linkExistence, linkDropCaret] : []),
```

- [x] **Step 5: Run to verify it passes**

Run: `npx vitest run src/lib/editor/links/link-drop.test.ts`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/lib/editor/links/link-drop.ts src/lib/editor/links/link-drop.test.ts src/lib/editor/setup.ts
git commit -m "feat(links): drop caret and link insertion at a drop point

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The `'text'` drop target

**Files:**
- Modify: `src/lib/stash/drop-target.ts`
- Test: `src/lib/stash/drop-target.test.ts` (append)

- [x] **Step 1: Write the failing tests**

Append inside `describe('resolveDrop', …)` in `src/lib/stash/drop-target.test.ts`:

```ts
  it('a stash card over the text links (file links, plan 03); the drawers still win', () => {
    expect(resolveDrop('stash', { ...none, text: true }, false)).toBe('text');
    expect(resolveDrop('stash', { ...none, text: true, tabsDrawer: true }, false)).toBe('tabs-drawer');
    expect(resolveDrop('stash', { ...none, text: true, stashDrawer: true }, false)).toBe('none');
  });

  it('a tab card over the page moves it — with ⌥ it links instead, and never opens the carousel', () => {
    expect(resolveDrop('tabs', { ...none, text: true }, false)).toBe('page');
    expect(resolveDrop('tabs', { ...none, text: true }, false, true)).toBe('text');
    expect(resolveDrop('tabs', none, false, true)).toBe('none');
    expect(resolveDrop('tabs', { ...none, text: true, stashZone: true, tabsDrawer: true }, false, true)).toBe('stash-zone');
  });
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/stash/drop-target.test.ts`
Expected: FAIL — `'none'` received where `'text'` expected (and a TS complaint about `text` in `DropHits`, which vitest does not enforce).

- [x] **Step 3: Implement**

Replace the whole body of `src/lib/stash/drop-target.ts` below its doc comment with:

```ts
export type DragSource = 'tabs' | 'stash';

export type DropTarget = 'list' | 'stash-zone' | 'stash-drawer' | 'tabs-drawer' | 'page' | 'text' | 'none';

export interface DropHits {
  stashDrawer: boolean;
  /** The stash area at the bottom of the tabs drawer — inside it, so tested first. */
  stashZone: boolean;
  list: boolean;
  /** The tabs drawer or its notch. */
  tabsDrawer: boolean;
  /** The editor's text, where a link may be dropped (file links D7). Absent: no link drops. */
  text?: boolean;
}

/**
 * `linkMode`: ⌥ is held during a tab-card drag (D7) — over the page the card
 * links instead of moving, so the carousel ('page') is never the answer. A
 * stash card is always in link mode over the text.
 */
export function resolveDrop(src: DragSource, hits: DropHits, filtered: boolean, linkMode = false): DropTarget {
  if (src === 'stash') {
    if (hits.tabsDrawer || hits.list) return 'tabs-drawer';
    if (hits.stashDrawer) return 'none';
    return hits.text ? 'text' : 'none';
  }
  if (hits.stashDrawer) return 'stash-drawer';
  if (hits.stashZone) return 'stash-zone';
  if (hits.list) return filtered ? 'none' : 'list';
  if (hits.tabsDrawer) return 'none';
  if (linkMode) return hits.text ? 'text' : 'none';
  return 'page';
}
```

and add to the module's doc comment, after "Stash cards: anywhere on the tabs drawer opens them here (mockup `hitTarget`).":

```ts
 * File links (plan 03): a stash card over the text, or a tab card with ⌥,
 * inserts a link there ('text').
```

- [x] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/stash/drop-target.test.ts`
Expected: PASS (old cases unchanged).

- [x] **Step 5: Commit**

```bash
git add src/lib/stash/drop-target.ts src/lib/stash/drop-target.test.ts
git commit -m "feat(links): text as a drop target for stash cards and alt-dragged tabs

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Dragged tabs → link items

**Files:**
- Create: `src/lib/tabs/link-items.ts`
- Test: `src/lib/tabs/link-items.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// src/lib/tabs/link-items.test.ts
import { describe, expect, it } from 'vitest';
import { linkItemsForTabs } from './link-items';
import type { TabMeta } from './tab-model';
import type { StashMark } from '../stash/marks';

const tab = (id: string, path: string | null): TabMeta => ({
  id,
  path,
  dirty: false,
  openedAt: 0,
  viewedAt: 0,
  unviewed: false,
});

describe('linkItemsForTabs', () => {
  it('one item per tab with a file, in drag order; a note under its title; untitled skipped', () => {
    const byId = new Map<string, TabMeta>([
      ['a', tab('a', '/r/plan.md')],
      ['b', tab('b', null)],
      ['c', tab('c', '/n/2026-10-24-ab12.md')],
    ]);
    const marks = (path: string | null): StashMark | null =>
      path === '/n/2026-10-24-ab12.md' ? { kind: 'note', title: 'Ideas', repo: null } : null;
    expect(linkItemsForTabs(['c', 'b', 'a', 'gone'], byId, marks)).toEqual([
      { path: '/n/2026-10-24-ab12.md', title: 'Ideas' },
      { path: '/r/plan.md', title: null },
    ]);
  });

  it('a file reference in the stash keeps its file name', () => {
    const byId = new Map<string, TabMeta>([['a', tab('a', '/r/plan.md')]]);
    const marks = (): StashMark => ({ kind: 'file', title: 'Plan', repo: 'r' });
    expect(linkItemsForTabs(['a'], byId, marks)).toEqual([{ path: '/r/plan.md', title: null }]);
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/tabs/link-items.test.ts`
Expected: FAIL — `Failed to resolve import "./link-items"`.

- [x] **Step 3: Implement**

```ts
// src/lib/tabs/link-items.ts
import type { TabMeta } from './tab-model';
import type { StashMark } from '../stash/marks';
import type { LinkInsertItem } from '../editor/links/link-drop';

/**
 * Tabs dropped onto the text with ⌥ (file links D7): one link per tab that
 * has a file, in drag order. An untitled tab has nothing to link to. A stash
 * note links under its title — its file name is a date and a hash.
 */
export function linkItemsForTabs(
  ids: readonly string[],
  byId: ReadonlyMap<string, TabMeta>,
  marks: (path: string | null) => StashMark | null
): LinkInsertItem[] {
  const out: LinkInsertItem[] = [];
  for (const id of ids) {
    const tab = byId.get(id);
    if (!tab || tab.path === null) continue;
    const mark = marks(tab.path);
    out.push({ path: tab.path, title: mark?.kind === 'note' ? mark.title : null });
  }
  return out;
}
```

- [x] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/tabs/link-items.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/lib/tabs/link-items.ts src/lib/tabs/link-items.test.ts
git commit -m "feat(links): turn dragged tabs into link items

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The ⌥ hint in the carousel band

**Files:**
- Modify: `src/lib/tabs/WindowCarousel.svelte` (props, `.car-foot`, styles)
- Test: `src/lib/tabs/WindowCarousel.svelte.test.ts` (extend `show` + one test)

- [x] **Step 1: Write the failing test**

In `src/lib/tabs/WindowCarousel.svelte.test.ts`, change the `show` signature's `extra` type to

```ts
  extra: Partial<{ mode: 'drag' | 'keys'; kb: number; count: number; linkHint: boolean }> = {}
```

and add to its `props` object, after `pointer: null,`:

```ts
      linkHint: extra.linkHint ?? false,
```

Then append inside `describe('WindowCarousel', …)`:

```ts
  it('ADragWithLinksAvailableSaysOptionInsertsALink', () => {
    show(carouselItems([win('editor-3', 12)]), { linkHint: true });
    expect(target.querySelector('.car-foot-link')?.textContent).toBe('⌥ — insert a link instead');
    unmount(component!);
    component = null;
    target.remove();
    show(carouselItems([win('editor-3', 12)]), { linkHint: true, mode: 'keys' });
    expect(target.querySelector('.car-foot-link')).toBeNull();
    unmount(component!);
    component = null;
    target.remove();
    show(carouselItems([win('editor-3', 12)]));
    expect(target.querySelector('.car-foot-link')).toBeNull();
  });
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/tabs/WindowCarousel.svelte.test.ts`
Expected: FAIL — `.car-foot-link` not found.

- [x] **Step 3: Implement**

In `src/lib/tabs/WindowCarousel.svelte`, add `linkHint = false,` to the props destructuring after `pointer,`, and to its type after `pointer: { x: number; y: number } | null;`:

```ts
    /** File links (D7): ⌥ would insert a link instead — said in drag mode only. */
    linkHint?: boolean;
```

Replace

```svelte
  <div class="car-foot">{mode === 'keys' ? t('tabs.carousel.foot_keys') : t('tabs.carousel.foot_drag')}</div>
```

with

```svelte
  <div class="car-foot">
    {mode === 'keys' ? t('tabs.carousel.foot_keys') : t('tabs.carousel.foot_drag')}
    {#if linkHint && mode === 'drag'}<span class="car-foot-link">{t('tabs.carousel.foot_link')}</span>{/if}
  </div>
```

In `<style>`, after the `.car-foot { … }` rule add:

```css
  .car-foot-link {
    display: block;
    margin-top: 4px;
    color: var(--text-subtle);
  }
```

- [x] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/tabs/WindowCarousel.svelte.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/lib/tabs/WindowCarousel.svelte src/lib/tabs/WindowCarousel.svelte.test.ts
git commit -m "feat(links): carousel band says alt inserts a link

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The drawer — stash-card drop, ⌥ link mode

**Files:**
- Modify: `src/lib/tabs/TabDrawer.svelte` (imports, props, `dropTargetAt`, `dragAt`, `dragMove`, `onKeyDown`, `onKeyUp`, `finishDrag`, ghost markup, root classes, styles)
- Test: existing `src/lib/tabs/TabDrawer.svelte.test.ts` must stay green; behaviour is covered by Tasks 2–4 (pure) and the live check.

- [x] **Step 1: Imports and prop**

After `import { resolveDrop, type DropTarget } from '../stash/drop-target';` add:

```ts
  import type { LinkDropTarget, LinkInsertItem } from '../editor/links/link-drop';
  import { linkItemsForTabs } from './link-items';
```

In the props destructuring, after `onstashtag,` add `linkDrop,`; in its type, after `onstashtag?: (entry: StashEntry, change: TagChange) => void;` add:

```ts
    /**
     * File links (D7): the editor's text as a drop target. A stash card over
     * it, or a tab card with ⌥, inserts a link there. Absent: no link drops.
     */
    linkDrop?: LinkDropTarget;
```

- [x] **Step 2: ⌥ state and the drop target**

Right after `let inWrap = false;` add:

```ts
  /** ⌥ held during the current drag (D7): a tab card links instead of moving. Read from every pointer and key event. */
  let altHeld = false;
```

Replace `dropTargetAt`:

```ts
  function dropTargetAt(src: 'tabs' | 'stash', x: number, y: number): DropTarget {
    return resolveDrop(
      src,
      {
        stashDrawer: stashOpen && (stashHandle?.contains(x, y) ?? false),
        stashZone: !!stash && inside(stashBarEl, x, y),
        list: overList(x, y),
        tabsDrawer: inside(asideEl, x, y),
      },
      !!ds.query
    );
  }
```

with:

```ts
  function dropTargetAt(src: 'tabs' | 'stash', x: number, y: number): DropTarget {
    return resolveDrop(
      src,
      {
        stashDrawer: stashOpen && (stashHandle?.contains(x, y) ?? false),
        stashZone: !!stash && inside(stashBarEl, x, y),
        list: overList(x, y),
        tabsDrawer: inside(asideEl, x, y),
        text: !!linkDrop && linkDrop.over(x, y),
      },
      !!ds.query,
      altHeld
    );
  }
```

Replace `dragAt`:

```ts
  /** The drag with the pointer at `ev`: where it is, and what a drop there would do. */
  function dragAt(d: DragState, ev: PointerEvent): DragState {
    const target = dropTargetAt(d.src, ev.clientX, ev.clientY);
    // A filtered view has no manual order to drop into (mockup).
    const inList = !ds.query && overList(ev.clientX, ev.clientY) && (target === 'list' || target === 'tabs-drawer');
    return {
      ...d,
      x: ev.clientX,
      y: ev.clientY,
      target,
      inList,
      before: inList ? dropBefore(cardBoxes(), ev.clientY, new Set(d.src === 'tabs' ? d.ids : [])) : null,
    };
  }
```

with:

```ts
  /** The drag with the pointer at `ev`: where it is, and what a drop there would do. */
  function dragAt(d: DragState, ev: PointerEvent): DragState {
    altHeld = ev.altKey;
    return dragAtPoint(d, ev.clientX, ev.clientY);
  }

  function dragAtPoint(d: DragState, x: number, y: number): DragState {
    const target = dropTargetAt(d.src, x, y);
    // A filtered view has no manual order to drop into (mockup).
    const inList = !ds.query && overList(x, y) && (target === 'list' || target === 'tabs-drawer');
    return {
      ...d,
      x,
      y,
      target,
      inList,
      before: inList ? dropBefore(cardBoxes(), y, new Set(d.src === 'tabs' ? d.ids : [])) : null,
    };
  }

  /** The drop caret follows a drag over the text (D7). */
  function followLink(d: DragState): void {
    if (d.target === 'text') linkDrop?.hover(d.x, d.y);
    else linkDrop?.clear();
  }

  /** ⌥ pressed or released with the pointer still: decide the drop under it again (D7). */
  function setAlt(alt: boolean): void {
    const d = drag;
    const changed = alt !== altHeld;
    altHeld = alt;
    if (!d || !changed) return;
    const next = dragAtPoint(d, d.x, d.y);
    drag = next;
    followLink(next);
    if (d.src === 'tabs') followCarousel(d.x, d.y, next.target === 'page');
  }

  function linkItemsFor(d: DragState): LinkInsertItem[] {
    if (d.src === 'stash') {
      return d.entry ? [{ path: d.entry.path, title: d.entry.kind === 'note' ? d.entry.title : null }] : [];
    }
    return linkItemsForTabs(d.ids, byId, marks);
  }
```

Replace `dragMove`'s body:

```ts
    const next = dragAt(d, ev);
    drag = next;
    if (next.inList) autoScroll(ev.clientY);
    if (d.src === 'tabs') followCarousel(ev.clientX, ev.clientY, next.target === 'page');
```

with:

```ts
    const next = dragAt(d, ev);
    drag = next;
    if (next.inList) autoScroll(ev.clientY);
    followLink(next);
    if (d.src === 'tabs') followCarousel(ev.clientX, ev.clientY, next.target === 'page');
```

- [x] **Step 3: Keys during a drag**

In `onKeyDown`, replace the drag branch:

```ts
    if (gesture === 'drag') {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') endGesture?.();
      return;
    }
```

with:

```ts
    if (gesture === 'drag') {
      e.preventDefault();
      e.stopPropagation();
      setAlt(e.altKey);
      if (e.key === 'Escape') endGesture?.();
      return;
    }
```

Replace `onKeyUp`:

```ts
  function onKeyUp(e: KeyboardEvent): void {
    trackShift(e);
  }
```

with:

```ts
  function onKeyUp(e: KeyboardEvent): void {
    trackShift(e);
    if (gesture === 'drag') setAlt(e.altKey);
  }
```

- [x] **Step 4: The drop**

In `finishDrag`, right before the line `if (d?.src === 'stash') {`, insert:

```ts
    // File links (D7): a stash card, or a tab card with ⌥, dropped on the text.
    linkDrop?.clear();
    const linked =
      dropped && ev !== null && d?.target === 'text' && !!linkDrop && linkDrop.drop(ev.clientX, ev.clientY, linkItemsFor(d));
    altHeld = false;
    if (linked) {
      if (c?.mode === 'drag') closeCarousel();
      closeDrawer();
      return;
    }
```

- [x] **Step 5: Ghost and scrim**

In the ghost block, after `{@const toOpen = drag.src === 'stash' && drag.target === 'tabs-drawer'}` add:

```svelte
    {@const toLink = drag.target === 'text'}
```

On the ghost `<div class="ghost" …>`: change `class:cancel={!drag.inList && !hotItem && !toStash && !toOpen}` to `class:cancel={!drag.inList && !hotItem && !toStash && !toOpen && !toLink}`, add `class:as-link={toLink}` after `class:as-open={toOpen}`, and in `style:transform` change `: toOpen` to `: toOpen || toLink`.

In the ghost bar label, change

```svelte
              : toOpen
                ? t('stash.ghost.open')
                : ''}</span
```

to

```svelte
              : toOpen
                ? t('stash.ghost.open')
                : toLink
                  ? t('tabs.ghost.link')
                  : ''}</span
```

On the root `<div class="tab-drawer" …>` add `class:link-mode={drag?.target === 'text'}` after `class:narrow={layout.narrow}`.

Pass the hint to the carousel: in `<WindowCarousel …>` add `linkHint={!!linkDrop}` after `pointer={…}`.

In `<style>`, right after the `.stash-open .scrim { … }` rule add:

```css
  /* File links (D7, R3): a link drop looks at the text — the scrim lightens
     and lets the pointer through, so `posAtCoords` hits the line under it. */
  .link-mode .scrim {
    opacity: 0.25;
    pointer-events: none;
  }
```

and after the `.ghost.as-open { … }` rule add:

```css
  .ghost.as-link {
    outline: 2px solid var(--color-link);
  }

  .ghost.as-link .ghost-bar {
    height: 24px;
  }
```

- [x] **Step 6: Type check and the drawer tests**

Run: `npm run check`
Expected: 0 errors.

Run: `npx vitest run src/lib/tabs src/lib/stash`
Expected: PASS (no `linkDrop` given in the existing tests: no link drops, behaviour unchanged).

- [x] **Step 7: Commit**

```bash
git add src/lib/tabs/TabDrawer.svelte
git commit -m "feat(links): drop a stash card or an alt-dragged tab onto the text

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Rust — `current_modifiers`

**Files:**
- Modify: `src-tauri/src/reveal.rs`
- Modify: `src-tauri/src/lib.rs` (`generate_handler!`)
- Modify: `src/lib/links/types.ts`, `src/lib/links/ipc.ts`
- Test: `reveal::tests` (append), `src/lib/links/ipc.test.ts` (append)

- [x] **Step 1: Write the failing Rust test**

Append inside `mod tests` of `src-tauri/src/reveal.rs`:

```rust
    #[test]
    fn modifier_flags_map_to_keys() {
        assert_eq!(modifiers_from_flags(0), Modifiers::default());
        assert_eq!(modifiers_from_flags(1 << 19), Modifiers { alt: true, ..Modifiers::default() });
        assert_eq!(
            modifiers_from_flags((1 << 17) | (1 << 18) | (1 << 20)),
            Modifiers { alt: false, shift: true, ctrl: true, meta: true }
        );
        // Caps Lock (1 << 16) and device-dependent low bits are not modifiers here.
        assert_eq!(modifiers_from_flags((1 << 16) | 0x100), Modifiers::default());
    }

    #[test]
    fn modifiers_serialize_as_plain_flags() {
        let json = serde_json::to_value(Modifiers { alt: true, ..Modifiers::default() }).unwrap();
        assert_eq!(json, serde_json::json!({ "alt": true, "shift": false, "ctrl": false, "meta": false }));
    }
```

- [x] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml reveal::tests`
Expected: FAIL to compile — `cannot find function modifiers_from_flags`.

- [x] **Step 3: Implement**

In `src-tauri/src/reveal.rs`, add `use serde::Serialize;` after `use std::path::{Path, PathBuf};`, and change the module doc's "Plan 03 adds `current_modifiers` here" sentence to "`current_modifiers` (plan 03) lives here too".

Append before `#[cfg(test)]`:

```rust
/// The modifier keys held right now (file-links D7). While Finder drives a
/// drag the webview receives no key events, so a drop asks the OS.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Modifiers {
    pub alt: bool,
    pub shift: bool,
    pub ctrl: bool,
    pub meta: bool,
}

// `NSEventModifierFlags` bits.
const NS_SHIFT: u64 = 1 << 17;
const NS_CONTROL: u64 = 1 << 18;
const NS_OPTION: u64 = 1 << 19;
const NS_COMMAND: u64 = 1 << 20;

pub fn modifiers_from_flags(flags: u64) -> Modifiers {
    Modifiers {
        alt: (flags & NS_OPTION) != 0,
        shift: (flags & NS_SHIFT) != 0,
        ctrl: (flags & NS_CONTROL) != 0,
        meta: (flags & NS_COMMAND) != 0,
    }
}

/// `+[NSEvent modifierFlags]` — global state, independent of any event —
/// read on the main thread (R6).
#[tauri::command]
pub async fn current_modifiers(app: AppHandle) -> Result<Modifiers, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(modifier_flags());
    })
    .map_err(|e| e.to_string())?;
    let outcome = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?;
    match outcome {
        Ok(flags) => flags.map(modifiers_from_flags),
        Err(_) => Err("the main thread did not answer".to_string()),
    }
}

#[cfg(target_os = "macos")]
fn modifier_flags() -> Result<u64, String> {
    use objc::runtime::{Class, Sel};
    use objc::Message;
    let class = Class::get("NSEvent").ok_or_else(|| "NSEvent is not available".to_string())?;
    // `NSEventModifierFlags` is an `NSUInteger`: `usize` on arm64 and x86_64
    // alike. No `BOOL` is involved (CLAUDE.md's per-arch trap).
    let flags: usize = unsafe { class.send_message(Sel::register("modifierFlags"), ()) }.map_err(|e| format!("{e:?}"))?;
    Ok(flags as u64)
}

#[cfg(not(target_os = "macos"))]
fn modifier_flags() -> Result<u64, String> {
    Ok(0)
}
```

In `src-tauri/src/lib.rs` `generate_handler!`, after `reveal::reveal_in_finder,` add:

```rust
            reveal::current_modifiers,
```

- [x] **Step 4: Run the Rust tests, clippy and the Intel guard**

Run: `cargo test --manifest-path src-tauri/Cargo.toml reveal::tests`
Expected: PASS — 4 tests.

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml`
Expected: no new warnings.

Run: `npm run check:x86`
Expected: `Finished`.

- [x] **Step 5: Frontend wrapper — failing test first**

Append to `src/lib/links/ipc.test.ts`:

```ts
import { currentModifiers } from './ipc';

describe('modifiers ipc', () => {
  it('currentModifiers takes no arguments', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ alt: true, shift: false, ctrl: false, meta: false });
    await expect(currentModifiers()).resolves.toEqual({ alt: true, shift: false, ctrl: false, meta: false });
    expect(invoke).toHaveBeenCalledWith('current_modifiers');
  });
});
```

Run: `npx vitest run src/lib/links/ipc.test.ts`
Expected: FAIL — `currentModifiers` is not exported.

- [x] **Step 6: Implement the wrapper**

Append to `src/lib/links/types.ts`:

```ts
/** `Modifiers` in `src-tauri/src/reveal.rs`: the keys held at the moment of asking. */
export interface Modifiers {
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
  meta: boolean;
}
```

Extend the type import in `src/lib/links/ipc.ts` to include `Modifiers`, and append:

```ts
/** The modifier keys held right now — asked at a Finder drop, which brings no key events. */
export function currentModifiers(): Promise<Modifiers> {
  return invoke<Modifiers>('current_modifiers');
}
```

Run: `npx vitest run src/lib/links/ipc.test.ts`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src-tauri/src/reveal.rs src-tauri/src/lib.rs src/lib/links/types.ts src/lib/links/ipc.ts src/lib/links/ipc.test.ts
git commit -m "feat(links): current_modifiers for alt-drops from Finder

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: App wiring — the drawer's `linkDrop` and Finder ⌥-drop

**Files:**
- Modify: `src/App.svelte` (imports, `linkDrop` next to `linkControl`, `finderDropAsLink`, `onDragDropEvent` ~2759, `<TabDrawer>`)

- [x] **Step 1: Imports**

Replace

```ts
  import { linkCandidates, linkProject, pathKinds, revealInFinder } from './lib/links/ipc';
```

with

```ts
  import { currentModifiers, linkCandidates, linkProject, pathKinds, revealInFinder } from './lib/links/ipc';
  import { createLinkDropTarget, dropPointToClient } from './lib/editor/links/link-drop';
```

- [x] **Step 2: The drop target and the Finder helper**

Right after the closing `};` of `const linkControl: LinkControl = { … };` add:

```ts
  /** The editor's text as a link drop target (file-links D7) — for the drawer and Finder drops. */
  const linkDrop = createLinkDropTarget(() => editorHandle?.view);

  /**
   * ⌥-drop from Finder (D7): links at the drop point instead of tabs. The
   * webview gets no key events while Finder drives the drag, so the modifier
   * is asked from the OS at drop time; any failure counts as no modifier and
   * the files open as tabs, as before. `true`: the drop became links.
   */
  async function finderDropAsLink(paths: string[], position: { x: number; y: number }): Promise<boolean> {
    if (paths.length === 0) return false;
    const mods = await currentModifiers().catch(() => null);
    if (!mods?.alt) return false;
    const scale = await import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().scaleFactor())
      .catch(() => window.devicePixelRatio || 1);
    const point = dropPointToClient(position, scale, zoom.level);
    if (!linkDrop.over(point.x, point.y)) return false;
    return linkDrop.drop(
      point.x,
      point.y,
      paths.map((path) => ({ path, title: null }))
    );
  }
```

- [x] **Step 3: Route Finder drops**

Replace

```ts
    // Drag & drop: every dropped file becomes a tab of this window; the first
    // may take a blank tab's place.
    const unlistenDragDrop = import('@tauri-apps/api/webview').then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent(async (event) => {
        if (event.payload.type !== 'drop') return;
        for (const path of event.payload.paths as string[]) {
          await openTab(path);
        }
      })
    );
```

with

```ts
    // Drag & drop: every dropped file becomes a tab of this window; the first
    // may take a blank tab's place. With ⌥ held over the text the files become
    // links at the drop point instead (file-links D7).
    const unlistenDragDrop = import('@tauri-apps/api/webview').then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent(async (event) => {
        if (event.payload.type !== 'drop') return;
        const paths = event.payload.paths as string[];
        if (await finderDropAsLink(paths, event.payload.position)) return;
        for (const path of paths) {
          await openTab(path);
        }
      })
    );
```

- [x] **Step 4: Give the drawer the target**

In `<TabDrawer …>`, after `onstashtag={(entry, change) => void tagStashEntry(entry, change)}` add:

```svelte
  {linkDrop}
```

- [x] **Step 5: Type check and the suite**

Run: `npm run check`
Expected: 0 errors.

Run: `npx vitest run --dir src`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/App.svelte
git commit -m "feat(links): alt-drop from Finder inserts links; drawer gets the drop target

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Verification

**Executed 2026-10-24.** Deviations from the steps above: in link mode the ghost shrinks to 240 px and sits below-right of the pointer (it covered the drop caret at the grab offset); App's page blur (`oncarousel`) lifts in link mode too, not only the scrim; `linkItemsFor` skips a trashed stash entry; the drawer gained six `TabDrawer.svelte.test.ts` cases for the link drop. Step 3's agent checks passed live on a `couplet-filelinks` dev build (synthetic pointer/key events, CSV not re-checked live — unit-tested). Step 4 is left to Max.

**Files:** none changed (fix-forward commits only if a check fails).

- [x] **Step 1: Frontend**

Run: `npx vitest run --dir src`
Expected: all green.

Run: `npm run check`
Expected: 0 errors, no new warnings.

Run: `npx vite build --config vite.config.site.ts --outDir /tmp/couplet-site-check --emptyOutDir`
Expected: `✓ built`; `git status --short docs/` prints nothing.

- [x] **Step 2: Rust**

Run: `cd src-tauri && cargo test`
Expected: all green.

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml`
Expected: no new warnings.

Run: `npm run check:x86`
Expected: `Finished`.

- [x] **Step 3: Live check (agent part)**

```bash
lsof -ti:1420 | xargs kill -9 2>/dev/null; npm run dev:app -- --features mcp-bridge \
  --config '{"app":{"windows":[{"title":"file-links 03 · local"}]}}'
```

Use `/tmp/fl` from plans 01–02; open `index.md` and `docs/plan.md` as tabs; have a note and a file reference in the stash. With the bridge, synthetic pointer events dispatched on the drawer's card and `window` drive the drag machine (see CLAUDE.md "MCP dev bridge": dispatch on elements, read state from the DOM, not from animation end states):

- [x] ⌘J, drag the `plan.md` card over the text (no ⌥): the carousel opens as before; the band's foot reads «⌥ — insert a link instead».
- [x] Same drag with `altKey: true` on the pointer events: the carousel closes, the scrim lightens, a drop caret (`.cm-md-link-drop .cm-dropCursor`) follows the pointer; the ghost bar says «Insert link».
- [x] Toggle ⌥ with a synthetic `keydown`/`keyup` (`key: 'Alt', altKey: true/false`, dispatched on `document.body`) without moving: link mode switches on and off, the carousel comes back on release.
- [x] Release with ⌥: `[plan](docs/plan.md)` appears at the caret position; the drawer closes; ⌘Z removes it in one step.
- [x] Open the stash (⌃S), drag the note card onto the text (no ⌥ needed): `[<note title>](/Users/…/couplet/….md)` at the drop point; a file-reference card: `[name](relative or absolute path)`.
- [x] Dragging onto a `.py` tab's text or a CSV tab: no caret, nothing inserted, the card behaves as before.
- [x] Two selected tab cards (⇧-click) ⌥-dropped: two links separated by `, `.

- [ ] **Step 4: Live check (Max, manual — no OS-level drags from an agent)**

- [ ] Drag `/tmp/fl/docs/plan.md` from Finder into the window without ⌥: it opens as a tab (unchanged).
- [ ] Same with ⌥ held through the release, over the text, on the built-in Retina screen: `[plan](docs/plan.md)` lands at the line under the pointer (within one character). The position is points relative to the webview (wry `draggingLocation()`, unscaled — see `dropPointToClient`), divided by page zoom only. If it lands at about half the pointer's coordinates (up and left), something divides by the scale factor again. If it lands consistently one title-bar height off, the webview does not fill the window's content view: compare `frame.size.height` in wry's `perform_drag_operation` with `window.innerHeight`. Repeat once on a 1× external display if one is at hand.
- [ ] Two files ⌥-dropped: two links, `, ` between them.
- [ ] At page zoom 125 % (⌘+ twice) the ⌥-drop still lands under the pointer.
- [ ] ⌥-drop with ⌥ released a hair after the mouse button: note whether it still links (R6 — known limit; report, do not fix here).

- [x] **Step 5: Commit any fixes**

If a live check needed a fix, commit it with explicit paths (`fix(links): …` + the `Co-Authored-By` line). Otherwise nothing to commit.
