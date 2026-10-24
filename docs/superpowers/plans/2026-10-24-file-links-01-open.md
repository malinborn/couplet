# File Links 01 — Opening a Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ⌘-click on `[план](2026-09-30-github-allowlist.md)` (and the inspector's Open, and a click on a link in a table cell) opens that file as a tab, switches to the tab/window that holds it, reveals a non-document in Finder, or offers to create a missing one — and a link to a missing file looks missing before anyone clicks it.

**Architecture:** One pure resolver (`src/lib/links/link-target.ts`) turns a link destination into `anchor | external | file | unresolvable`. One CM6 router (`openLink(view, url)` in `src/lib/editor/links/open-link.ts`) acts on it through a `LinkControl` dep carried by a facet, exactly like `stashControl`; without the dep (the couplet.pro landing's demo editors) the old external-only behaviour stays. Two tiny Rust commands answer what a path is (`path_kinds`) and select a file in Finder (`reveal_in_finder`, `objc` runtime, no new crate). A StateField + batching ViewPlugin caches whether linked files exist and the decorator marks missing ones.

**Tech Stack:** TypeScript, Svelte 5 runes, CodeMirror 6, Tauri 2 (Rust, `objc` 0.2 runtime calls), Vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-10-24-file-links-design.md` — decisions D1, D2, D3, D4 and the D9 strings for this part. Read it first.

**Plans in this series:** 01 (this one) → `2026-10-24-file-links-02-picker.md` (extends `LinkControl`) → `2026-10-24-file-links-03-drag.md`. Execute in order.

**Ground rules for every task**

- Work only in `/Users/maximkovalevskij/playground/md-mini/.claude/worktrees/file-links`. Every command below runs from that directory.
- Never `git stash`, `git checkout <file>`, `git reset`, `git rebase`. `git add` explicit paths only.
- Run frontend tests with `npx vitest run <path>` (plain `npm run test` also picks up other worktrees). Full suite: `npx vitest run --dir src`.
- Never run `npm run tauri dev` / `npm run tauri build`. Browser checks: `npm run dev`. Tauri checks: `npm run dev:app -- --features mcp-bridge`.
- Before using any Tauri 2 / Svelte 5 / CM6 API that this plan does not spell out, check it with context7 (`resolve-library-id` + `query-docs`).
- Svelte 5 runes only, strict TypeScript, no `any`. `tsconfig` targets ES2020: no `Array.prototype.at`, `String.prototype.replaceAll`, `??=`.
- Conventional commits, each ending with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Decisions this plan takes (beyond the spec)

| # | Decision | Why |
|---|---|---|
| P1 | `LinkControl` has no `docPath()`. The router reads the path from the view's own `documentPathField`. | `documentPathField` belongs to the state being shown; a per-window callback would answer for whatever `fileState` says, which lags a tab swap. |
| P2 | A new Rust command `path_kinds(paths)` → `file \| dir \| missing \| other` replaces `file_exists` for links. | D2 needs "regular file, not a folder"; `file_exists` (`Path::exists`) says yes to folders. One batched call also serves D4's existence check. |
| P3 | On window focus the existence cache is **re-checked and replaced in one effect**, not dropped. | Dropping turns every known-missing link into an ordinary one until the answer comes back — the flicker D4 forbids. |
| P4 | «Create» is offered only for a target couplet would open as a document (`opensAsDocument`). A missing `.png` gets the toast without the button and the title «File not found». | Creating an empty text file named `diagram.png` is never what the click meant. |
| P5 | `navigateToHeading` falls back to a fully parsed tree when the slug index misses. | A file opened by `plan.md#risks` is a fresh state whose index was built from a partial parse; without the fallback every heading below the parsed part is unreachable. |
| P6 | No capability change for the two commands. | App commands are not ACL-gated here: `src-tauri/build.rs` calls plain `tauri_build::build()` (no `AppManifest`), so every `generate_handler!` command is invokable — like the existing `file_exists`, `tab_*`, `stash_*`. |
| P7 | Missing-link styling is not drawn inside table cells (cells get the hover title only). | A table widget's `eq()` does not see the existence cache; adding it would rebuild every table on every answer. |
| P8 | Known limitation (review M7): a table cell's link title is computed when the widget is built, so after Save As moves the document it can name the old relative target until the table is rebuilt (an edit in it, a tab switch). The ⌘-click itself is resolved at click time and is correct. | Same `eq()` reason as P7: putting the document path into the table widget's `eq()` would rebuild every table on every path change for a tooltip. |

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/lib/links/link-target.ts` | new | `resolveLinkTarget`, `splitFragment`, `stripAngle`, path helpers (pure) |
| `src/lib/links/link-kind.ts` | new | `opensAsDocument(path)` (pure) |
| `src/lib/links/types.ts` | new | `PathKind` (extended by plan 02) |
| `src/lib/links/ipc.ts` | new | `pathKinds`, `revealInFinder` wrappers |
| `src/lib/editor/links/open-link.ts` | new | `LinkControl`, `linkControlFacet`, `resolveInState`, `linkActionFor`, `openLink`, `openButtonLabel`, `openExternalUrl` |
| `src/lib/editor/links/fake-link-control.ts` | new | Recording `LinkControl` for tests (extended by plan 02) |
| `src/lib/editor/links/link-existence.ts` | new | `linkExistenceField`, effects, batching checker plugin, `fileLinkPaths` |
| `src/lib/editor/links/link-presentation.ts` | new | Hover title + missing flag for a link |
| `src/lib/editor/heading-slugs.ts` | modify | Full-parse fallback in `navigateToHeading` |
| `src/lib/editor/preview/inline.ts` | modify | Title via `t()`, `cm-md-link-missing` class |
| `src/lib/editor/preview/plugin.ts` | modify | Rebuild on existence / document path change |
| `src/lib/editor/preview/tables.ts` | modify | `routeLinkClick` uses `openLink` for file links; cell link title |
| `src/lib/editor/live-render/inspector.ts` | modify | Open button label/aria per target, routes through `openLink` |
| `src/lib/editor/setup.ts` | modify | `EditorDeps.linkControl`, facet + checker, ⌘-click → `openLink` |
| `src/lib/editor/Editor.svelte` | modify | `linkControl` prop into the state factory |
| `src/styles/editor.css` | modify | `.cm-md-link-missing` |
| `src/lib/toasts.svelte.ts` / `src/lib/ToastStack.svelte` | modify | `link-missing` toast with «Create» |
| `src/lib/tabs/controller.ts` | modify | `openPath` resolves with its `OpenPathResult` |
| `src/App.svelte` | modify | Builds `LinkControl`; home folder; toast «Create» |
| `src-tauri/src/links.rs` | new | `path_kind`, `path_kinds` command |
| `src-tauri/src/reveal.rs` | new | `reveal_in_finder` command (objc runtime) — plan 03 adds `current_modifiers` |
| `src-tauri/src/lib.rs` | modify | `mod links; mod reveal;` + `generate_handler!` entries |
| `locales/*/app.json` | modify | D9 strings for this part, six languages |

---

### Task 1: Strings (D9)

Every later task renders through `t()`; the completeness test in `src/lib/i18n.test.ts` fails unless all six catalogs carry exactly the English key set, so the keys land first.

**Files:**
- Modify: `locales/en/app.json`, `locales/ru/app.json`, `locales/de/app.json`, `locales/es/app.json`, `locales/fr/app.json`, `locales/zh/app.json`
- Test: `src/lib/i18n.test.ts` (existing)

- [ ] **Step 1: Insert the keys**

Run this once (it inserts after an existing anchor line in each catalog and re-parses the file):

```bash
node --input-type=module <<'EOF'
import fs from 'node:fs';

const BLOCKS = [
  {
    anchor: 'editor.inspector.plain_text',
    keys: {
      en: {
        'editor.inspector.open_file': 'Open file',
        'editor.inspector.show_in_finder': 'Show in Finder',
        'editor.inspector.jump': 'Jump to heading',
        'editor.links.click_mac': '⌘-click',
        'editor.links.click_other': 'Ctrl+click',
        'editor.links.hint_open_link': '{click} to open link',
        'editor.links.hint_open_file': '{click} to open {name}',
        'editor.links.hint_reveal': '{click} to show in Finder',
        'editor.links.hint_heading': '{click} to jump to the heading',
        'editor.links.hint_missing': 'File not found — {click} to create',
        'editor.links.hint_missing_plain': 'File not found',
      },
      ru: {
        'editor.inspector.open_file': 'Открыть файл',
        'editor.inspector.show_in_finder': 'Показать в Finder',
        'editor.inspector.jump': 'К заголовку',
        'editor.links.click_mac': '⌘-клик',
        'editor.links.click_other': 'Ctrl+клик',
        'editor.links.hint_open_link': '{click} — открыть ссылку',
        'editor.links.hint_open_file': '{click} — открыть {name}',
        'editor.links.hint_reveal': '{click} — показать в Finder',
        'editor.links.hint_heading': '{click} — перейти к заголовку',
        'editor.links.hint_missing': 'Файла нет — {click}, чтобы создать',
        'editor.links.hint_missing_plain': 'Файла нет',
      },
      de: {
        'editor.inspector.open_file': 'Datei öffnen',
        'editor.inspector.show_in_finder': 'Im Finder zeigen',
        'editor.inspector.jump': 'Zur Überschrift',
        'editor.links.click_mac': '⌘-Klick',
        'editor.links.click_other': 'Strg+Klick',
        'editor.links.hint_open_link': '{click} öffnet den Link',
        'editor.links.hint_open_file': '{click} öffnet {name}',
        'editor.links.hint_reveal': '{click} zeigt die Datei im Finder',
        'editor.links.hint_heading': '{click} springt zur Überschrift',
        'editor.links.hint_missing': 'Datei nicht gefunden — {click} erstellt sie',
        'editor.links.hint_missing_plain': 'Datei nicht gefunden',
      },
      es: {
        'editor.inspector.open_file': 'Abrir archivo',
        'editor.inspector.show_in_finder': 'Mostrar en el Finder',
        'editor.inspector.jump': 'Ir al encabezado',
        'editor.links.click_mac': '⌘-clic',
        'editor.links.click_other': 'Ctrl+clic',
        'editor.links.hint_open_link': '{click} para abrir el enlace',
        'editor.links.hint_open_file': '{click} para abrir {name}',
        'editor.links.hint_reveal': '{click} para mostrar en el Finder',
        'editor.links.hint_heading': '{click} para ir al encabezado',
        'editor.links.hint_missing': 'Archivo no encontrado — {click} para crearlo',
        'editor.links.hint_missing_plain': 'Archivo no encontrado',
      },
      fr: {
        'editor.inspector.open_file': 'Ouvrir le fichier',
        'editor.inspector.show_in_finder': 'Afficher dans le Finder',
        'editor.inspector.jump': 'Aller au titre',
        'editor.links.click_mac': '⌘-clic',
        'editor.links.click_other': 'Ctrl+clic',
        'editor.links.hint_open_link': '{click} pour ouvrir le lien',
        'editor.links.hint_open_file': '{click} pour ouvrir {name}',
        'editor.links.hint_reveal': '{click} pour afficher dans le Finder',
        'editor.links.hint_heading': '{click} pour aller au titre',
        'editor.links.hint_missing': 'Fichier introuvable — {click} pour le créer',
        'editor.links.hint_missing_plain': 'Fichier introuvable',
      },
      zh: {
        'editor.inspector.open_file': '打开文件',
        'editor.inspector.show_in_finder': '在访达中显示',
        'editor.inspector.jump': '跳到标题',
        'editor.links.click_mac': '⌘-点击',
        'editor.links.click_other': 'Ctrl+点击',
        'editor.links.hint_open_link': '{click}打开链接',
        'editor.links.hint_open_file': '{click}打开 {name}',
        'editor.links.hint_reveal': '{click}在访达中显示',
        'editor.links.hint_heading': '{click}跳转到标题',
        'editor.links.hint_missing': '找不到文件 — {click}创建',
        'editor.links.hint_missing_plain': '找不到文件',
      },
    },
  },
  {
    anchor: 'toast.window_number.missing',
    keys: {
      en: {
        'toast.link_missing.headline': 'No file {fileName}',
        'toast.link_missing.create': 'Create',
        'toast.link_unresolvable.headline': 'Save this document first — {fileName} is relative to it',
      },
      ru: {
        'toast.link_missing.headline': 'Нет файла {fileName}',
        'toast.link_missing.create': 'Создать',
        'toast.link_unresolvable.headline': 'Сначала сохраните документ — {fileName} указан относительно него',
      },
      de: {
        'toast.link_missing.headline': 'Keine Datei {fileName}',
        'toast.link_missing.create': 'Erstellen',
        'toast.link_unresolvable.headline': 'Speichern Sie das Dokument zuerst — {fileName} ist relativ dazu',
      },
      es: {
        'toast.link_missing.headline': 'No existe el archivo {fileName}',
        'toast.link_missing.create': 'Crear',
        'toast.link_unresolvable.headline': 'Guarde primero el documento — {fileName} es relativo a él',
      },
      fr: {
        'toast.link_missing.headline': 'Aucun fichier {fileName}',
        'toast.link_missing.create': 'Créer',
        'toast.link_unresolvable.headline': 'Enregistrez d’abord le document — {fileName} est relatif à celui-ci',
      },
      zh: {
        'toast.link_missing.headline': '没有文件 {fileName}',
        'toast.link_missing.create': '创建',
        'toast.link_unresolvable.headline': '请先保存文档 — {fileName} 是相对于它的路径',
      },
    },
  },
];

for (const { anchor, keys } of BLOCKS) {
  for (const [lang, entries] of Object.entries(keys)) {
    const file = `locales/${lang}/app.json`;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const at = lines.findIndex((l) => l.trimStart().startsWith(`"${anchor}":`));
    if (at < 0) throw new Error(`${file}: anchor ${anchor} not found`);
    const add = Object.entries(entries).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
    lines.splice(at + 1, 0, ...add);
    fs.writeFileSync(file, lines.join('\n'));
    JSON.parse(fs.readFileSync(file, 'utf8'));
  }
}
console.log('ok');
EOF
```

Expected output: `ok`.

- [ ] **Step 2: Run the catalog completeness test**

Run: `npx vitest run src/lib/i18n.test.ts`
Expected: PASS (every `<lang>_HasExactlyTheEnKeySet` green).

- [ ] **Step 3: Commit**

```bash
git add locales/en/app.json locales/ru/app.json locales/de/app.json locales/es/app.json locales/fr/app.json locales/zh/app.json
git commit -m "feat(links): strings for opening file links

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `resolveLinkTarget` (D1)

**Files:**
- Create: `src/lib/links/link-target.ts`
- Test: `src/lib/links/link-target.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/links/link-target.test.ts
import { describe, it, expect } from 'vitest';
import {
  basename,
  dirOf,
  isExternalUrl,
  normalizePath,
  resolveLinkTarget,
  splitFragment,
  stripAngle,
} from './link-target';

const DOC = '/Users/me/proj/docs/a.md';
const HOME = '/Users/me';

describe('resolveLinkTarget — the D1 table', () => {
  it('#slug is an anchor', () => {
    expect(resolveLinkTarget('#risks', DOC, HOME)).toEqual({ kind: 'anchor', slug: 'risks' });
  });

  it('a scheme other than file: is external, unchanged', () => {
    expect(resolveLinkTarget('https://x.test/p#s', DOC, HOME)).toEqual({ kind: 'external', url: 'https://x.test/p#s' });
    expect(resolveLinkTarget('mailto:a@b.c', DOC, HOME)).toEqual({ kind: 'external', url: 'mailto:a@b.c' });
  });

  it('file:///abs/path is a file', () => {
    expect(resolveLinkTarget('file:///tmp/x.md', DOC, HOME)).toEqual({ kind: 'file', path: '/tmp/x.md', fragment: null });
    expect(resolveLinkTarget('file://localhost/tmp/x.md', DOC, HOME)).toEqual({ kind: 'file', path: '/tmp/x.md', fragment: null });
  });

  it('/abs/path is a file', () => {
    expect(resolveLinkTarget('/etc/hosts', DOC, HOME)).toEqual({ kind: 'file', path: '/etc/hosts', fragment: null });
  });

  it('~/path expands the home folder', () => {
    expect(resolveLinkTarget('~/notes/b.md', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/notes/b.md', fragment: null });
  });

  it('~/path with no known home is unresolvable', () => {
    expect(resolveLinkTarget('~/b.md', DOC, null)).toEqual({ kind: 'unresolvable', reason: 'no-home' });
  });

  it('anything else is relative to the document folder', () => {
    expect(resolveLinkTarget('plan.md', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/docs/plan.md', fragment: null });
    expect(resolveLinkTarget('./plan.md', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/docs/plan.md', fragment: null });
    expect(resolveLinkTarget('../README.md', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/README.md', fragment: null });
  });

  it('a relative link in an untitled document is unresolvable', () => {
    expect(resolveLinkTarget('plan.md', null, HOME)).toEqual({ kind: 'unresolvable', reason: 'untitled' });
  });

  it('an empty destination is unresolvable', () => {
    expect(resolveLinkTarget('  ', DOC, HOME)).toEqual({ kind: 'unresolvable', reason: 'empty' });
  });
});

describe('resolveLinkTarget — encodings and fragments', () => {
  it('strips <…> and percent-decodes the path', () => {
    expect(resolveLinkTarget('<my plan.md>', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/docs/my plan.md', fragment: null });
    expect(resolveLinkTarget('my%20plan.md', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/docs/my plan.md', fragment: null });
  });

  it('keeps a #fragment after a file path, raw', () => {
    expect(resolveLinkTarget('plan.md#risks', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/docs/plan.md', fragment: 'risks' });
    expect(resolveLinkTarget('plan.md#%D1%80', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/docs/plan.md', fragment: '%D1%80' });
  });

  it('an empty fragment is none', () => {
    expect(resolveLinkTarget('plan.md#', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/docs/plan.md', fragment: null });
  });

  it('%23 and %25 decode back to # and % (the picker writes them, plan 02)', () => {
    expect(resolveLinkTarget('a%23b%25.md', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/docs/a#b%.md', fragment: null });
  });

  it('a malformed escape is kept as written', () => {
    expect(resolveLinkTarget('100%.md', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/docs/100%.md', fragment: null });
  });

  it('honours CommonMark backslash escapes inside <…>', () => {
    expect(resolveLinkTarget('<a\\>b.md>', DOC, HOME)).toEqual({ kind: 'file', path: '/Users/me/proj/docs/a>b.md', fragment: null });
  });
});

describe('helpers', () => {
  it('splitFragment', () => {
    expect(splitFragment('a.md#x')).toEqual({ path: 'a.md', fragment: 'x' });
    expect(splitFragment('a.md')).toEqual({ path: 'a.md', fragment: null });
  });

  it('stripAngle', () => {
    expect(stripAngle(' <a b> ')).toBe('a b');
    expect(stripAngle('a')).toBe('a');
  });

  it('isExternalUrl', () => {
    expect(isExternalUrl('https://x')).toBe(true);
    expect(isExternalUrl('file:///x')).toBe(false);
    expect(isExternalUrl('plan.md')).toBe(false);
    expect(isExternalUrl('#x')).toBe(false);
  });

  it('normalizePath resolves . and .. and never climbs above /', () => {
    expect(normalizePath('/a/./b/../c//d')).toBe('/a/c/d');
    expect(normalizePath('/../../x')).toBe('/x');
  });

  it('dirOf and basename', () => {
    expect(dirOf('/a/b/c.md')).toBe('/a/b');
    expect(dirOf('/c.md')).toBe('/');
    expect(basename('/a/b/c.md')).toBe('c.md');
    expect(basename('/a/b/')).toBe('b');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/links/link-target.test.ts`
Expected: FAIL — `Failed to resolve import "./link-target"`.

- [ ] **Step 3: Implement**

```ts
// src/lib/links/link-target.ts
/**
 * Where a markdown link goes (file-links spec D1). Pure: no I/O, no CM6.
 *
 * Every gesture asks this one function — ⌘-click, the inspector's Open, a
 * table cell's link, the hover title, the existence check — so they can never
 * disagree about where a link points.
 */

export type ResolvedLink =
  | { kind: 'anchor'; slug: string }
  | { kind: 'external'; url: string }
  | { kind: 'file'; path: string; fragment: string | null }
  | { kind: 'unresolvable'; reason: 'empty' | 'untitled' | 'no-home' };

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const FILE_SCHEME = /^file:/i;
/** CommonMark: a backslash before ASCII punctuation is an escape. */
const ESCAPED = /\\([!-/:-@[-`{-~])/g;

/** `<my plan.md>` → `my plan.md` (CommonMark's angle-bracket destination). */
export function stripAngle(raw: string): string {
  const s = raw.trim();
  return s.length >= 2 && s.startsWith('<') && s.endsWith('>') ? s.slice(1, -1) : s;
}

function unescapeDestination(s: string): string {
  return s.replace(ESCAPED, '$1');
}

/** `decodeURIComponent`, or the input itself when it is not valid percent-encoding (`100%.md`). */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** `plan.md#risks` → path `plan.md`, fragment `risks`; an empty fragment is none. */
export function splitFragment(dest: string): { path: string; fragment: string | null } {
  const hash = dest.indexOf('#');
  if (hash < 0) return { path: dest, fragment: null };
  const fragment = dest.slice(hash + 1);
  return { path: dest.slice(0, hash), fragment: fragment === '' ? null : fragment };
}

/** A destination with a scheme other than `file:` — handed to the OS, never resolved here. */
export function isExternalUrl(url: string): boolean {
  const dest = unescapeDestination(stripAngle(url));
  return SCHEME.test(dest) && !FILE_SCHEME.test(dest);
}

/** `/a/./b/../c` → `/a/c`. `..` at the root stays at the root. */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return `/${out.join('/')}`;
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

/**
 * Resolve a link destination as written in the document. `docPath` is the
 * document's own path (`null` for an untitled buffer), `home` the user's home
 * folder for `~/` (`null` while unknown).
 *
 * The fragment is returned raw: `navigateToHeading` decodes and slugifies it
 * with the same rules an in-document `#anchor` uses.
 */
export function resolveLinkTarget(url: string, docPath: string | null, home: string | null): ResolvedLink {
  const dest = unescapeDestination(stripAngle(url));
  if (dest === '') return { kind: 'unresolvable', reason: 'empty' };
  if (dest.startsWith('#')) return { kind: 'anchor', slug: dest.slice(1) };
  if (FILE_SCHEME.test(dest)) {
    const { path, fragment } = splitFragment(dest.replace(/^file:(\/\/(localhost)?)?/i, ''));
    return { kind: 'file', path: normalizePath(safeDecode(path)), fragment };
  }
  if (SCHEME.test(dest)) return { kind: 'external', url: dest };

  const split = splitFragment(dest);
  const path = safeDecode(split.path);
  const fragment = split.fragment;
  if (path.startsWith('/')) return { kind: 'file', path: normalizePath(path), fragment };
  if (path === '~' || path.startsWith('~/')) {
    if (!home) return { kind: 'unresolvable', reason: 'no-home' };
    return { kind: 'file', path: normalizePath(home + path.slice(1)), fragment };
  }
  if (!docPath) return { kind: 'unresolvable', reason: 'untitled' };
  return { kind: 'file', path: normalizePath(`${dirOf(docPath)}/${path}`), fragment };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/links/link-target.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/links/link-target.ts src/lib/links/link-target.test.ts
git commit -m "feat(links): resolve a link destination against its document

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `opensAsDocument` (D2)

**Files:**
- Create: `src/lib/links/link-kind.ts`
- Test: `src/lib/links/link-kind.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/links/link-kind.test.ts
import { describe, it, expect } from 'vitest';
import { opensAsDocument } from './link-kind';

describe('opensAsDocument', () => {
  it.each([
    '/p/plan.md',
    '/p/PLAN.MARKDOWN',
    '/p/notes.txt',
    '/p/data.csv',
    '/p/data.tsv',
    '/p/.env',
    '/p/.env.local',
    '/p/prod.env',
    '/p/.zshrc',
    '/p/main.py',
    '/p/config.json',
    '/p/run.sh',
    '/p/page.html',
  ])('%s opens as a document', (path) => {
    expect(opensAsDocument(path)).toBe(true);
  });

  it.each([
    '/p/diagram.png',
    '/p/spec.pdf',
    '/p/run.command',
    '/p/Couplet.app',
    '/p/archive.zip',
    '/p/LICENSE',
    '/p/folder',
  ])('%s is shown in Finder instead', (path) => {
    expect(opensAsDocument(path)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/links/link-kind.test.ts`
Expected: FAIL — `Failed to resolve import "./link-kind"`.

- [ ] **Step 3: Implement**

```ts
// src/lib/links/link-kind.ts
import { findCodeLanguage, isShellConfig, MARKDOWN_EXTENSIONS } from '../editor/file-language';
import { extOf, isCsvPath } from '../csv/csv-path';
import { basename } from './link-target';

/**
 * Does couplet open `path` as a document (file-links D2)? By name only: the
 * caller has already asked the disk that it is a regular file.
 *
 * Yes for every kind couplet already renders — markdown/txt, csv/tsv, env
 * files, shell configs, and a code language `findCodeLanguage` knows. No for
 * everything else — images, PDFs, bundles, `.command` scripts, files with no
 * extension — which a ⌘-click shows in Finder and never opens: a markdown file
 * is untrusted input, and a link must not be a way to run something.
 */
export function opensAsDocument(path: string): boolean {
  const name = basename(path).toLowerCase();
  const ext = extOf(path);
  if (name.startsWith('.env') || ext === 'env') return true;
  if (isCsvPath(path)) return true;
  if (ext !== '' && MARKDOWN_EXTENSIONS.has(ext)) return true;
  if (isShellConfig(name)) return true;
  return ext !== '' && findCodeLanguage(name, ext) !== null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/links/link-kind.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/links/link-kind.ts src/lib/links/link-kind.test.ts
git commit -m "feat(links): decide which link targets open as documents

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Heading jump survives a fresh state (P5)

**Files:**
- Modify: `src/lib/editor/heading-slugs.ts`
- Test: `src/lib/editor/heading-slugs.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/editor/heading-slugs.test.ts` (the file already imports `EditorState`, `markdown`, `markdownLanguage`, `languages`, `Strikethrough`, `Table`, `navigateToHeading` and defines `makeView`):

```ts
describe('navigateToHeading — slug index that does not know the heading', () => {
  it('finds the heading from a full parse when the index misses it', () => {
    // No headingSlugsField at all: the index lookup misses, exactly as it does
    // for a heading below the part of a freshly opened file that was parsed
    // when its state was created.
    const state = EditorState.create({
      doc: '# Intro\n\ntext\n\n## Risks\n\nmore\n',
      extensions: [markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Strikethrough, Table] })],
    });
    const { view, calls } = makeView(state);
    navigateToHeading(view, 'risks');
    expect(calls).toHaveLength(1);
  });

  it('is still a no-op for a slug no heading has', () => {
    const state = EditorState.create({
      doc: '# Intro\n',
      extensions: [markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Strikethrough, Table] })],
    });
    const { view, calls } = makeView(state);
    navigateToHeading(view, 'nope');
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/editor/heading-slugs.test.ts`
Expected: FAIL — `finds the heading from a full parse…` expected length 1, received 0.

- [ ] **Step 3: Implement**

In `src/lib/editor/heading-slugs.ts`:

Replace the imports at the top:

```ts
import { StateField, type EditorState, type StateEffect } from '@codemirror/state';
import { syntaxTree, foldedRanges, unfoldEffect } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
```

with:

```ts
import { StateField, type EditorState, type StateEffect } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree, foldedRanges, unfoldEffect } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import type { Tree } from '@lezer/common';
```

Replace the head of `buildIndex`:

```ts
function buildIndex(state: EditorState): Map<string, number> {
  const map = new Map<string, number>();
  const counts = new Map<string, number>();
  const tree = syntaxTree(state);
  const doc = state.doc;
```

with:

```ts
function buildIndex(state: EditorState, tree: Tree = syntaxTree(state)): Map<string, number> {
  const map = new Map<string, number>();
  const counts = new Map<string, number>();
  const doc = state.doc;
```

Add this function right after `getHeadingPos`:

```ts
/**
 * The slug index is rebuilt only on a document change, from whatever tree the
 * state had then. A state created a moment ago — a file just opened by a link
 * with `#fragment` (file-links D2) — may hold a tree parsed only part of the
 * way, and its index misses every heading below that part. A miss is asked
 * again against a tree parsed to the end (bounded, like every other forced
 * parse in the editor).
 */
function headingPosFromFullParse(state: EditorState, slug: string): number | null {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  return buildIndex(state, tree).get(slug) ?? null;
}
```

In `navigateToHeading`, replace:

```ts
  const pos = getHeadingPos(view.state, slug);
  if (pos === null) return;
```

with:

```ts
  const pos = getHeadingPos(view.state, slug) ?? headingPosFromFullParse(view.state, slug);
  if (pos === null) return;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/editor/heading-slugs.test.ts src/lib/editor/preview/tables.test.ts`
Expected: PASS (the existing `routeLinkClick` anchor tests still pass: `#nope` still dispatches nothing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/editor/heading-slugs.ts src/lib/editor/heading-slugs.test.ts
git commit -m "fix(headings): jump to a heading the slug index has not seen yet

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Rust — `path_kinds` and `reveal_in_finder`

**Files:**
- Create: `src-tauri/src/links.rs`
- Create: `src-tauri/src/reveal.rs`
- Modify: `src-tauri/src/lib.rs` (module list near line 10–40; `generate_handler!` near line 162)

- [ ] **Step 1: Write `links.rs` with its failing tests**

```rust
// src-tauri/src/links.rs
//! File links (docs/superpowers/specs/2026-10-24-file-links-design.md): what a
//! linked path is on disk. Plan 02 adds the picker's candidates here.

use std::path::Path;

use serde::Serialize;

/// What a path is, as a link router needs to know it (D2): a regular file
/// may open as a document, anything else is shown in Finder, a missing one
/// gets the «Create» toast. Symlinks are followed; a dangling one is `Other`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PathKind {
    File,
    Dir,
    Missing,
    Other,
}

/// `metadata` only — never opens the file, so a FIFO or a dataless iCloud
/// file cannot hang the call. A relative path is refused as missing: the
/// webview always sends an absolute one, and a relative one would resolve
/// against the app's working directory.
pub fn path_kind(path: &Path) -> PathKind {
    if !path.is_absolute() {
        return PathKind::Missing;
    }
    match std::fs::metadata(path) {
        Ok(m) if m.is_file() => PathKind::File,
        Ok(m) if m.is_dir() => PathKind::Dir,
        Ok(_) => PathKind::Other,
        Err(_) if std::fs::symlink_metadata(path).is_ok() => PathKind::Other,
        Err(_) => PathKind::Missing,
    }
}

/// One call answers at most this many paths (the existence check batches the
/// links in the viewport; the router asks for one).
pub const MAX_PATH_KINDS: usize = 256;

#[tauri::command]
pub async fn path_kinds(paths: Vec<String>) -> Result<Vec<PathKind>, String> {
    if paths.len() > MAX_PATH_KINDS {
        return Err(format!("at most {MAX_PATH_KINDS} paths per call"));
    }
    tauri::async_runtime::spawn_blocking(move || paths.iter().map(|p| path_kind(Path::new(p))).collect())
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("couplet-links-{}-{}", tag, crate::session::new_tab_id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_regular_file_is_a_file_and_a_folder_is_a_dir() {
        let dir = scratch("kinds");
        fs::write(dir.join("a.md"), "x").unwrap();
        assert_eq!(path_kind(&dir.join("a.md")), PathKind::File);
        assert_eq!(path_kind(&dir), PathKind::Dir);
    }

    #[test]
    fn a_missing_or_relative_path_is_missing() {
        let dir = scratch("missing");
        assert_eq!(path_kind(&dir.join("nope.md")), PathKind::Missing);
        assert_eq!(path_kind(Path::new("relative.md")), PathKind::Missing);
    }

    #[test]
    fn a_symlink_is_followed_and_a_dangling_one_is_other() {
        let dir = scratch("links");
        fs::write(dir.join("real.md"), "x").unwrap();
        std::os::unix::fs::symlink(dir.join("real.md"), dir.join("alias.md")).unwrap();
        std::os::unix::fs::symlink(dir.join("gone.md"), dir.join("dangling.md")).unwrap();
        assert_eq!(path_kind(&dir.join("alias.md")), PathKind::File);
        assert_eq!(path_kind(&dir.join("dangling.md")), PathKind::Other);
    }

    #[test]
    fn kinds_serialize_lowercase() {
        assert_eq!(serde_json::to_string(&PathKind::Missing).unwrap(), "\"missing\"");
    }
}
```

- [ ] **Step 2: Write `reveal.rs` with its failing tests**

```rust
// src-tauri/src/reveal.rs
//! Show a file in Finder (file-links D2) — never open it. Plan 03 adds
//! `current_modifiers` here: both are thin `objc` runtime calls.
//!
//! Plain `objc` runtime calls (`Class::get`, `Sel::register`, `send_message`)
//! rather than `cocoa` + `msg_send!`, for the reason `keep_behind_key_window`
//! in `window.rs` gives: every `cocoa` item is deprecated, and `objc` 0.2's
//! `sel!` expands to a `cfg` this crate does not declare.

use std::path::{Path, PathBuf};

use tauri::AppHandle;

/// The path `reveal_in_finder` may select: absolute and present (a dangling
/// symlink counts — Finder shows the link itself).
pub fn reveal_target(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(format!("not an absolute path: {path}"));
    }
    if std::fs::symlink_metadata(p).is_err() {
        return Err(format!("no such file: {path}"));
    }
    Ok(p.to_path_buf())
}

/// `NSWorkspace activateFileViewerSelectingURLs:` on the main thread. No
/// shell, no `open`: the shell plugin's scope stays `http(s)`/`mailto`/`tel`.
#[tauri::command]
pub async fn reveal_in_finder(app: AppHandle, path: String) -> Result<(), String> {
    let target = reveal_target(&path)?;
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(select_in_finder(&target));
    })
    .map_err(|e| e.to_string())?;
    let outcome = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?;
    match outcome {
        Ok(result) => result,
        Err(_) => Err("Finder did not answer".to_string()),
    }
}

#[cfg(target_os = "macos")]
fn select_in_finder(path: &Path) -> Result<(), String> {
    use objc::runtime::{Class, Object, Sel};
    use objc::Message;
    use std::os::unix::ffi::OsStrExt;

    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| "the path contains a NUL byte".to_string())?;
    let class = |name: &str| Class::get(name).ok_or_else(|| format!("{name} is not available"));
    unsafe {
        let ns_path: *mut Object = class("NSString")?
            .send_message(Sel::register("stringWithUTF8String:"), (c_path.as_ptr(),))
            .map_err(|e| format!("{e:?}"))?;
        if ns_path.is_null() {
            return Err("the path is not valid UTF-8".to_string());
        }
        let url: *mut Object = class("NSURL")?
            .send_message(Sel::register("fileURLWithPath:"), (ns_path,))
            .map_err(|e| format!("{e:?}"))?;
        if url.is_null() {
            return Err("could not make a file URL".to_string());
        }
        let urls: *mut Object = class("NSArray")?
            .send_message(Sel::register("arrayWithObject:"), (url,))
            .map_err(|e| format!("{e:?}"))?;
        let workspace: *mut Object = class("NSWorkspace")?
            .send_message(Sel::register("sharedWorkspace"), ())
            .map_err(|e| format!("{e:?}"))?;
        if urls.is_null() || workspace.is_null() {
            return Err("Finder is not available".to_string());
        }
        (*workspace)
            .send_message::<(*mut Object,), ()>(Sel::register("activateFileViewerSelectingURLs:"), (urls,))
            .map_err(|e| format!("{e:?}"))?;
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn select_in_finder(_path: &Path) -> Result<(), String> {
    Err("Show in Finder is available on macOS only".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn an_existing_absolute_path_may_be_revealed() {
        let dir = std::env::temp_dir().join(format!("couplet-reveal-{}", crate::session::new_tab_id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.png"), "x").unwrap();
        assert_eq!(reveal_target(dir.join("a.png").to_str().unwrap()).unwrap(), dir.join("a.png"));
    }

    #[test]
    fn a_relative_or_missing_path_is_refused() {
        assert!(reveal_target("a.png").is_err());
        assert!(reveal_target("/definitely/not/here/a.png").is_err());
    }
}
```

- [ ] **Step 3: Register the modules and commands**

In `src-tauri/src/lib.rs`, in the alphabetical module list, insert `mod links;` between `mod i18n;` and `mod locale;`, and `mod reveal;` between `mod recovery;` and `mod routing;`:

```rust
mod i18n;
mod links;
mod locale;
```

```rust
mod recovery;
mod reveal;
mod routing;
```

In `tauri::generate_handler![`, right after `commands::file_exists,` add:

```rust
            links::path_kinds,
            reveal::reveal_in_finder,
```

- [ ] **Step 4: Run the Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml links::tests`
Expected: PASS — 4 tests.

Run: `cargo test --manifest-path src-tauri/Cargo.toml reveal::tests`
Expected: PASS — 2 tests.

- [ ] **Step 5: Lint and the Intel guard**

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml`
Expected: no new warnings in `links.rs` / `reveal.rs`.

Run: `npm run check:x86`
Expected: `Finished` — no `BOOL` is involved, but `c_char` differs per arch and this proves it compiles on both.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/links.rs src-tauri/src/reveal.rs src-tauri/src/lib.rs
git commit -m "feat(links): path_kinds and reveal_in_finder commands

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Frontend IPC wrappers

**Files:**
- Create: `src/lib/links/types.ts`
- Create: `src/lib/links/ipc.ts`
- Test: `src/lib/links/ipc.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/links/ipc.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import { invoke } from '@tauri-apps/api/core';
import { PATH_KINDS_MAX, pathKinds, revealInFinder } from './ipc';

beforeEach(() => vi.mocked(invoke).mockClear());

describe('links ipc', () => {
  it('pathKinds sends the paths as they are', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(['file', 'missing']);
    await expect(pathKinds(['/a.md', '/b.md'])).resolves.toEqual(['file', 'missing']);
    expect(invoke).toHaveBeenCalledWith('path_kinds', { paths: ['/a.md', '/b.md'] });
  });

  it('revealInFinder names the path', async () => {
    await revealInFinder('/a.png');
    expect(invoke).toHaveBeenCalledWith('reveal_in_finder', { path: '/a.png' });
  });

  it('mirrors the Rust batch limit', () => {
    expect(PATH_KINDS_MAX).toBe(256);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/links/ipc.test.ts`
Expected: FAIL — `Failed to resolve import "./ipc"`.

- [ ] **Step 3: Implement**

```ts
// src/lib/links/types.ts
/** What a path is on disk — `PathKind` in `src-tauri/src/links.rs`. */
export type PathKind = 'file' | 'dir' | 'missing' | 'other';

/**
 * `MAX_PATH_KINDS` in `src-tauri/src/links.rs`: a larger batch is refused.
 * Lives here, not in `ipc.ts`, so the editor code that batches by it never
 * imports `@tauri-apps/api` (the landing bundles that editor code).
 */
export const PATH_KINDS_MAX = 256;
```

```ts
// src/lib/links/ipc.ts
import { invoke } from '@tauri-apps/api/core';
import type { PathKind } from './types';

export { PATH_KINDS_MAX } from './types';

/** What each path is, in order. Rejects when the IPC fails. */
export function pathKinds(paths: readonly string[]): Promise<PathKind[]> {
  return invoke<PathKind[]>('path_kinds', { paths });
}

/** Select `path` in a Finder window. Rejects with Rust's reason (no such file…). */
export function revealInFinder(path: string): Promise<void> {
  return invoke<void>('reveal_in_finder', { path });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/links/ipc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/links/types.ts src/lib/links/ipc.ts src/lib/links/ipc.test.ts
git commit -m "feat(links): ipc wrappers for path kinds and reveal

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `LinkControl` and the `openLink` router (D2, D3)

**Files:**
- Create: `src/lib/editor/links/open-link.ts`
- Create: `src/lib/editor/links/fake-link-control.ts`
- Test: `src/lib/editor/links/open-link.test.ts`

The interface defined here is the one every plan uses. Plan 02 adds three members (`candidates`, `project`, `chooseFile`) to this same interface and to the fake; nothing else changes it.

- [ ] **Step 1: Write the fake control (test support, imported by tests only)**

```ts
// src/lib/editor/links/fake-link-control.ts
import type { LinkControl } from './open-link';
import type { PathKind } from '../../links/types';

export interface FakeLinkControl extends LinkControl {
  /** Every call, as `name:argument`. */
  readonly calls: string[];
  /** What `pathKinds` answers per path; a path not listed is a regular file. */
  readonly kinds: Map<string, PathKind>;
}

/**
 * A recording `LinkControl` for tests — no vitest import, so any test file can
 * use it. `overrides` replace single members (e.g. a rejecting `pathKinds`).
 */
export function fakeLinkControl(overrides: Partial<LinkControl> = {}): FakeLinkControl {
  const calls: string[] = [];
  const kinds = new Map<string, PathKind>();
  const base: LinkControl = {
    home: () => '/Users/me',
    pathKinds: async (paths) => {
      calls.push(`pathKinds:${paths.join(',')}`);
      return paths.map((p) => kinds.get(p) ?? 'file');
    },
    openFile: async (path, fragment) => {
      calls.push(`openFile:${path}#${fragment ?? ''}`);
    },
    reveal: async (path) => {
      calls.push(`reveal:${path}`);
    },
    missing: (path) => {
      calls.push(`missing:${path}`);
    },
    unresolvable: (url) => {
      calls.push(`unresolvable:${url}`);
    },
  };
  return Object.assign(base, overrides, { calls, kinds });
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/lib/editor/links/open-link.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn(() => Promise.resolve()) }));

import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { markdownExtension } from '../markdown-language';
import { headingSlugsField } from '../heading-slugs';
import { documentPathField, setDocumentPath } from '../json-fence';
import {
  linkActionFor,
  linkControlFacet,
  openButtonLabel,
  openLink,
  resolveInState,
  type LinkControl,
} from './open-link';
import { fakeLinkControl } from './fake-link-control';

function viewFor(doc: string, docPath: string | null, control: LinkControl | null) {
  let state = EditorState.create({
    doc,
    extensions: [
      markdownExtension(),
      headingSlugsField,
      documentPathField,
      ...(control ? [linkControlFacet.of(control)] : []),
    ],
  });
  state = state.update({ effects: setDocumentPath.of(docPath) }).state;
  const dispatch = vi.fn();
  return { view: { state, dispatch } as unknown as EditorView, dispatch };
}

beforeEach(() => vi.mocked(shellOpen).mockClear());

describe('openLink', () => {
  it('jumps to a heading for #slug and never asks the control', async () => {
    const control = fakeLinkControl();
    const { view, dispatch } = viewFor('# Risks\n', '/r/a.md', control);
    await openLink(view, '#risks');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(control.calls).toEqual([]);
  });

  it('hands an external URL to the shell', async () => {
    const { view } = viewFor('', '/r/a.md', fakeLinkControl());
    await openLink(view, 'https://x.test');
    expect(shellOpen).toHaveBeenCalledWith('https://x.test');
  });

  it('opens a markdown file relative to the document, with its fragment', async () => {
    const control = fakeLinkControl();
    const { view } = viewFor('', '/r/docs/a.md', control);
    await openLink(view, 'plan.md#risks');
    expect(control.calls).toEqual(['pathKinds:/r/docs/plan.md', 'openFile:/r/docs/plan.md#risks']);
  });

  it('resolves ../ and ~/', async () => {
    const control = fakeLinkControl();
    const { view } = viewFor('', '/r/docs/a.md', control);
    await openLink(view, '../notes/b.md');
    await openLink(view, '~/c.md');
    expect(control.calls).toContain('openFile:/r/notes/b.md#');
    expect(control.calls).toContain('openFile:/Users/me/c.md#');
  });

  it('shows a non-document in Finder', async () => {
    const control = fakeLinkControl();
    const { view } = viewFor('', '/r/a.md', control);
    await openLink(view, 'diagram.png');
    expect(control.calls).toContain('reveal:/r/diagram.png');
  });

  it('shows a folder in Finder, even one named like a document', async () => {
    const control = fakeLinkControl();
    control.kinds.set('/r/docs.md', 'dir');
    const { view } = viewFor('', '/r/a.md', control);
    await openLink(view, 'docs.md');
    expect(control.calls).toContain('reveal:/r/docs.md');
  });

  it('reports a missing file instead of creating it', async () => {
    const control = fakeLinkControl();
    control.kinds.set('/r/gone.md', 'missing');
    const { view } = viewFor('', '/r/a.md', control);
    await openLink(view, 'gone.md');
    expect(control.calls).toEqual(['pathKinds:/r/gone.md', 'missing:/r/gone.md']);
  });

  it('a relative link in an untitled document is unresolvable', async () => {
    const control = fakeLinkControl();
    const { view } = viewFor('', null, control);
    await openLink(view, 'plan.md');
    expect(control.calls).toEqual(['unresolvable:plan.md']);
  });

  it('opens the document anyway when the kind cannot be asked', async () => {
    const control = fakeLinkControl({ pathKinds: () => Promise.reject(new Error('ipc down')) });
    const { view } = viewFor('', '/r/a.md', control);
    await openLink(view, 'plan.md');
    expect(control.calls).toEqual(['openFile:/r/plan.md#']);
  });

  it('without a control keeps the old behaviour: the URL goes to the shell', async () => {
    const { view } = viewFor('', '/r/a.md', null);
    await openLink(view, 'plan.md');
    expect(shellOpen).toHaveBeenCalledWith('plan.md');
  });
});

describe('linkActionFor and openButtonLabel', () => {
  it('names what a click will do', () => {
    const { view } = viewFor('', '/r/a.md', fakeLinkControl());
    const action = (url: string) => linkActionFor(resolveInState(view.state, url), true);
    expect(action('#x')).toBe('heading');
    expect(action('https://x')).toBe('external');
    expect(action('plan.md')).toBe('open-file');
    expect(action('a.png')).toBe('reveal');
    expect(linkActionFor(resolveInState(viewFor('', null, fakeLinkControl()).view.state, 'plan.md'), true)).toBe('unresolvable');
  });

  it('without a control every non-anchor is external', () => {
    const { view } = viewFor('', '/r/a.md', null);
    expect(linkActionFor(resolveInState(view.state, 'plan.md'), false)).toBe('external');
  });

  it('labels the inspector button per action', () => {
    expect(openButtonLabel('external')).toEqual({ text: 'Open', aria: 'Open link in browser' });
    expect(openButtonLabel('open-file')).toEqual({ text: 'Open file', aria: 'Open file' });
    expect(openButtonLabel('reveal')).toEqual({ text: 'Show in Finder', aria: 'Show in Finder' });
    expect(openButtonLabel('heading')).toEqual({ text: 'Jump to heading', aria: 'Jump to the heading' });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/lib/editor/links/open-link.test.ts`
Expected: FAIL — `Failed to resolve import "./open-link"`.

- [ ] **Step 4: Implement**

```ts
// src/lib/editor/links/open-link.ts
import { Facet, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { documentPathField } from '../json-fence';
import { navigateToHeading } from '../heading-slugs';
import { resolveLinkTarget, type ResolvedLink } from '../../links/link-target';
import { opensAsDocument } from '../../links/link-kind';
import type { PathKind } from '../../links/types';
import { t } from '../../i18n';

/**
 * What a link needs from the app (file-links D3). Injected through
 * `linkControlFacet` like `stashControl`: `createExtensions()` is shared with
 * the couplet.pro landing's demo cards, which get no control and keep the old
 * external-only behaviour. Pass ONE object per window.
 *
 * Plan 02 adds `candidates`, `project` and `chooseFile` for the picker.
 */
export interface LinkControl {
  /** The home folder for `~/` links; `null` while unknown (or outside Tauri). */
  home(): string | null;
  /** What each path is on disk, in order. Rejects when the IPC fails. */
  pathKinds(paths: readonly string[]): Promise<PathKind[]>;
  /** Open `path` as a document — the tab/window that holds it, or a new tab — then jump to `fragment`. */
  openFile(path: string, fragment: string | null): Promise<void>;
  /** Select `path` in Finder. Never opens it. */
  reveal(path: string): Promise<void>;
  /** The link's target does not exist: the `link-missing` toast with «Create». */
  missing(path: string): void;
  /** A relative link in a document with no path. */
  unresolvable(url: string): void;
}

export const linkControlFacet = Facet.define<LinkControl, LinkControl | null>({
  combine: (values) => values[0] ?? null,
});

export function linkControlOf(state: EditorState): LinkControl | null {
  return state.facet(linkControlFacet);
}

/** `resolveLinkTarget` against this state's document path and the control's home. */
export function resolveInState(state: EditorState, url: string): ResolvedLink {
  const control = linkControlOf(state);
  return resolveLinkTarget(url, state.field(documentPathField, false) ?? null, control?.home() ?? null);
}

/** What a click on the link will do, judged by name — no disk access. */
export type LinkAction = 'heading' | 'external' | 'open-file' | 'reveal' | 'unresolvable';

export function linkActionFor(target: ResolvedLink, hasControl: boolean): LinkAction {
  if (target.kind === 'anchor') return 'heading';
  if (target.kind === 'external' || !hasControl) return 'external';
  if (target.kind === 'unresolvable') return 'unresolvable';
  return opensAsDocument(target.path) ? 'open-file' : 'reveal';
}

/** The inspector's Open button for `action` (D3): visible text and aria-label. */
export function openButtonLabel(action: LinkAction): { text: string; aria: string } {
  switch (action) {
    case 'heading':
      return { text: t('editor.inspector.jump'), aria: t('editor.inspector.jump_to_heading') };
    case 'open-file':
    case 'unresolvable':
      return { text: t('editor.inspector.open_file'), aria: t('editor.inspector.open_file') };
    case 'reveal':
      return { text: t('editor.inspector.show_in_finder'), aria: t('editor.inspector.show_in_finder') };
    case 'external':
      return { text: t('editor.inspector.open'), aria: t('editor.inspector.open_in_browser') };
  }
}

/**
 * Opens a URL outside the app. Uses the Tauri shell plugin in the app; falls
 * back to a browser tab when that plugin has no backend (the landing page
 * embeds this same editor). The plugin call must be returned so its rejection
 * reaches the catch — otherwise the fallback never runs.
 */
export function openExternalUrl(url: string): Promise<void> {
  return import('@tauri-apps/plugin-shell')
    .then(({ open }) => open(url))
    .catch(() => {
      window.open(url, '_blank');
    });
}

/**
 * The one router behind every link gesture (D3): ⌘-click in either engine,
 * the inspector's Open, a click on a link in a table cell.
 *
 * - `#slug` → the heading in this document.
 * - a URL with a scheme → the OS (`openExternalUrl`), as before.
 * - a file → asked on disk first: missing → `control.missing`; a regular file
 *   couplet renders → `control.openFile` (with the fragment); anything else
 *   — a folder, an image, `run.command` — → `control.reveal`. Never executed.
 *
 * Without a control (the landing) a non-anchor goes to `openExternalUrl`
 * unchanged.
 */
export async function openLink(view: EditorView, url: string): Promise<void> {
  const control = linkControlOf(view.state);
  const target = resolveInState(view.state, url);
  if (target.kind === 'anchor') {
    navigateToHeading(view, target.slug);
    return;
  }
  if (target.kind === 'external') {
    await openExternalUrl(target.url);
    return;
  }
  if (!control) {
    await openExternalUrl(url);
    return;
  }
  if (target.kind === 'unresolvable') {
    control.unresolvable(url);
    return;
  }
  let kind: PathKind;
  try {
    const kinds = await control.pathKinds([target.path]);
    kind = kinds[0] ?? 'file';
  } catch (err) {
    console.warn('path_kinds failed, opening by name:', err);
    kind = 'file';
  }
  if (kind === 'missing') {
    control.missing(target.path);
    return;
  }
  if (kind === 'file' && opensAsDocument(target.path)) {
    await control.openFile(target.path, target.fragment);
    return;
  }
  await control.reveal(target.path);
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/lib/editor/links/open-link.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/editor/links/open-link.ts src/lib/editor/links/fake-link-control.ts src/lib/editor/links/open-link.test.ts
git commit -m "feat(links): LinkControl and the openLink router

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Existence cache — StateField + batching checker (D4)

**Files:**
- Create: `src/lib/editor/links/link-existence.ts`
- Test: `src/lib/editor/links/link-existence.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/editor/links/link-existence.test.ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdownExtension } from '../markdown-language';
import { documentPathField, setDocumentPath } from '../json-fence';
import { linkControlFacet, type LinkControl } from './open-link';
import { fakeLinkControl } from './fake-link-control';
import {
  LINK_CHECK_DELAY_MS,
  fileLinkPaths,
  linkExistence,
  linkExistenceField,
  setLinkExistence,
} from './link-existence';

const DOC = '[a](plan.md) [b](gone.md) [c](https://x.test) [d](#top) see [1]';

function stateFor(control: LinkControl, doc = DOC, path: string | null = '/r/a.md'): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [markdownExtension(), documentPathField, linkControlFacet.of(control), linkExistence],
  });
  return state.update({ effects: setDocumentPath.of(path) }).state;
}

let view: EditorView | null = null;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  view?.destroy();
  view = null;
  vi.useRealTimers();
});

describe('fileLinkPaths', () => {
  it('lists the resolved file targets of rendered links only', () => {
    const state = stateFor(fakeLinkControl());
    expect(fileLinkPaths(state, 0, state.doc.length)).toEqual(['/r/plan.md', '/r/gone.md']);
  });
});

describe('linkExistenceField', () => {
  it('merges answers and forgets them when the document path changes', () => {
    let state = stateFor(fakeLinkControl());
    state = state.update({ effects: setLinkExistence.of(new Map([['/r/plan.md', true]])) }).state;
    expect(state.field(linkExistenceField).get('/r/plan.md')).toBe(true);
    state = state.update({ effects: setDocumentPath.of('/other/b.md') }).state;
    expect(state.field(linkExistenceField).size).toBe(0);
  });
});

describe('the checker', () => {
  it('asks once for the links in view after a quiet period, then caches', async () => {
    const control = fakeLinkControl();
    control.kinds.set('/r/gone.md', 'missing');
    view = new EditorView({ state: stateFor(control) });
    expect(control.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(LINK_CHECK_DELAY_MS + 1);
    expect(control.calls).toEqual(['pathKinds:/r/plan.md,/r/gone.md']);
    const known = view.state.field(linkExistenceField);
    expect(known.get('/r/plan.md')).toBe(true);
    expect(known.get('/r/gone.md')).toBe(false);

    view.dispatch({ changes: { from: view.state.doc.length, insert: ' more' } });
    await vi.advanceTimersByTimeAsync(LINK_CHECK_DELAY_MS + 1);
    expect(control.calls).toHaveLength(1);
  });

  it('a failed ask leaves the links unknown and is retried on the next change', async () => {
    let fail = true;
    const control = fakeLinkControl();
    const pathKinds = control.pathKinds;
    control.pathKinds = (paths) => (fail ? Promise.reject(new Error('down')) : pathKinds(paths));
    view = new EditorView({ state: stateFor(control) });
    await vi.advanceTimersByTimeAsync(LINK_CHECK_DELAY_MS + 1);
    expect(view.state.field(linkExistenceField).size).toBe(0);
    fail = false;
    view.dispatch({ changes: { from: 0, insert: ' ' } });
    await vi.advanceTimersByTimeAsync(LINK_CHECK_DELAY_MS + 1);
    expect(view.state.field(linkExistenceField).get('/r/plan.md')).toBe(true);
  });

  it('on window focus re-checks what it knows and replaces it in one go', async () => {
    const control = fakeLinkControl();
    control.kinds.set('/r/gone.md', 'missing');
    view = new EditorView({ state: stateFor(control) });
    await vi.advanceTimersByTimeAsync(LINK_CHECK_DELAY_MS + 1);
    expect(view.state.field(linkExistenceField).get('/r/gone.md')).toBe(false);

    control.kinds.delete('/r/gone.md'); // created elsewhere
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(LINK_CHECK_DELAY_MS + 1);
    expect(view.state.field(linkExistenceField).get('/r/gone.md')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/editor/links/link-existence.test.ts`
Expected: FAIL — `Failed to resolve import "./link-existence"`.

- [ ] **Step 3: Implement**

```ts
// src/lib/editor/links/link-existence.ts
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { documentPathField } from '../json-fence';
import { isRenderedLink } from '../preview/link-refs';
import { linkControlOf, resolveInState } from './open-link';
import { PATH_KINDS_MAX } from '../../links/types';

/**
 * Does each linked file exist (file-links D4)? Resolved path → `true`/`false`.
 * A path not in the map is unknown and renders as an ordinary link — a link
 * never flickers to "missing" before an answer.
 */
const EMPTY: ReadonlyMap<string, boolean> = new Map();

/** Answers to merge into the cache. */
export const setLinkExistence = StateEffect.define<ReadonlyMap<string, boolean>>();
/** A fresh cache that replaces the old one whole (the focus re-check). */
export const replaceLinkExistence = StateEffect.define<ReadonlyMap<string, boolean>>();

function docPathOf(state: EditorState): string | null {
  return state.field(documentPathField, false) ?? null;
}

export const linkExistenceField = StateField.define<ReadonlyMap<string, boolean>>({
  create: () => EMPTY,
  update(value, tr) {
    let next = docPathOf(tr.startState) === docPathOf(tr.state) ? value : EMPTY;
    for (const effect of tr.effects) {
      if (effect.is(replaceLinkExistence)) {
        next = effect.value;
      } else if (effect.is(setLinkExistence)) {
        const merged = new Map(next);
        for (const [path, exists] of effect.value) merged.set(path, exists);
        next = merged;
      }
    }
    return next;
  },
});

/** Resolved file targets of the rendered links between `from` and `to`, each once, in document order. */
export function fileLinkPaths(state: EditorState, from: number, to: number): string[] {
  const out = new Set<string>();
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.name !== 'Link') return;
      // A bracket pair that is not a link (`see [1]`, #51): descend, a real
      // link may sit inside it.
      if (!isRenderedLink(state.doc, node.node)) return;
      const url = node.node.getChild('URL');
      if (url) {
        const target = resolveInState(state, state.doc.sliceString(url.from, url.to));
        if (target.kind === 'file') out.add(target.path);
      }
      return false;
    },
  });
  return [...out];
}

/** Trailing quiet period before asking: typing a path does not ask per keystroke. */
export const LINK_CHECK_DELAY_MS = 150;

class LinkExistenceChecker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Set<string>();
  private destroyed = false;
  private readonly onFocus = (): void => {
    void this.recheckAll();
  };

  constructor(private readonly view: EditorView) {
    this.schedule();
    window.addEventListener('focus', this.onFocus);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || docPathOf(update.startState) !== docPathOf(update.state)) {
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check();
    }, LINK_CHECK_DELAY_MS);
  }

  private visiblePaths(): string[] {
    const { from, to } = this.view.viewport;
    return fileLinkPaths(this.view.state, from, to);
  }

  private async check(): Promise<void> {
    const control = linkControlOf(this.view.state);
    if (!control) return;
    const known = this.view.state.field(linkExistenceField, false) ?? EMPTY;
    const unknown = this.visiblePaths().filter((p) => !known.has(p) && !this.pending.has(p));
    if (unknown.length === 0) return;
    const batch = unknown.slice(0, PATH_KINDS_MAX);
    for (const p of batch) this.pending.add(p);
    try {
      const kinds = await control.pathKinds(batch);
      if (this.destroyed) return;
      const answers = new Map<string, boolean>();
      batch.forEach((p, i) => {
        const kind = kinds[i];
        if (kind !== undefined) answers.set(p, kind !== 'missing');
      });
      this.view.dispatch({ effects: setLinkExistence.of(answers) });
    } catch (err) {
      // Unknown stays unknown (an ordinary link); the next change asks again.
      console.warn('link existence check failed:', err);
    } finally {
      for (const p of batch) this.pending.delete(p);
    }
    if (unknown.length > batch.length) this.schedule();
  }

  /** A file may have been created or deleted while the window was away. */
  private async recheckAll(): Promise<void> {
    const control = linkControlOf(this.view.state);
    if (!control) return;
    const known = this.view.state.field(linkExistenceField, false) ?? EMPTY;
    const paths = [...new Set([...known.keys(), ...this.visiblePaths()])].slice(0, PATH_KINDS_MAX);
    if (paths.length === 0) return;
    try {
      const kinds = await control.pathKinds(paths);
      if (this.destroyed) return;
      const fresh = new Map<string, boolean>();
      paths.forEach((p, i) => {
        const kind = kinds[i];
        if (kind !== undefined) fresh.set(p, kind !== 'missing');
      });
      this.view.dispatch({ effects: replaceLinkExistence.of(fresh) });
    } catch (err) {
      console.warn('link existence re-check failed:', err);
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    window.removeEventListener('focus', this.onFocus);
  }
}

export const linkExistenceChecker = ViewPlugin.fromClass(LinkExistenceChecker);

/** Installed by `createExtensions` only together with a `LinkControl`. */
export const linkExistence: Extension = [linkExistenceField, linkExistenceChecker];
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/editor/links/link-existence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/editor/links/link-existence.ts src/lib/editor/links/link-existence.test.ts
git commit -m "feat(links): cache whether linked files exist, asked in batches

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: How a link looks — title via `t()`, `cm-md-link-missing` (D4, D9)

**Files:**
- Create: `src/lib/editor/links/link-presentation.ts`
- Modify: `src/lib/editor/preview/inline.ts:1-16` (hint) and `decorateLink`
- Modify: `src/lib/editor/preview/plugin.ts` (rebuild conditions)
- Modify: `src/styles/editor.css` (after the `.cm-md-link` rule, ~line 162)
- Test: `src/lib/editor/links/link-presentation.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/editor/links/link-presentation.test.ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdownExtension } from '../markdown-language';
import { documentPathField, setDocumentPath } from '../json-fence';
import { livePreviewPlugin } from '../preview/plugin';
import { LIVE_PREVIEW, flavourFacet } from '../preview/flavour';
import { linkControlFacet } from './open-link';
import { fakeLinkControl } from './fake-link-control';
import { linkExistenceField, setLinkExistence } from './link-existence';
import { linkPresentation } from './link-presentation';

function state(withControl: boolean, known: [string, boolean][] = []): EditorState {
  let s = EditorState.create({
    doc: '',
    extensions: [documentPathField, linkExistenceField, ...(withControl ? [linkControlFacet.of(fakeLinkControl())] : [])],
  });
  s = s.update({ effects: [setDocumentPath.of('/r/a.md'), setLinkExistence.of(new Map(known))] }).state;
  return s;
}

describe('linkPresentation', () => {
  it('says which file a document link opens', () => {
    expect(linkPresentation(state(true), 'plan.md').title).toMatch(/to open plan\.md$/);
  });

  it('says Finder for a non-document', () => {
    expect(linkPresentation(state(true), 'a.png').title).toMatch(/to show in Finder$/);
  });

  it('says heading for an anchor and link for a URL', () => {
    expect(linkPresentation(state(true), '#x').title).toMatch(/to jump to the heading$/);
    expect(linkPresentation(state(true), 'https://x').title).toMatch(/to open link$/);
  });

  it('marks a known-missing document link and offers to create it', () => {
    const look = linkPresentation(state(true, [['/r/gone.md', false]]), 'gone.md');
    expect(look.missing).toBe(true);
    expect(look.title).toMatch(/^File not found — .* to create$/);
  });

  it('a missing non-document says only that it is not there', () => {
    expect(linkPresentation(state(true, [['/r/x.png', false]]), 'x.png')).toEqual({ title: 'File not found', missing: true });
  });

  it('unknown is never missing', () => {
    expect(linkPresentation(state(true), 'gone.md').missing).toBe(false);
  });

  it('without a control every link keeps the old hint', () => {
    expect(linkPresentation(state(false), 'plan.md').title).toMatch(/to open link$/);
  });
});

describe('decorateLink', () => {
  it('adds cm-md-link-missing and the title to a known-missing link', () => {
    const doc = '[gone](gone.md) [ok](plan.md)\n\npark the caret here';
    let s = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        markdownExtension(),
        flavourFacet.of(LIVE_PREVIEW),
        documentPathField,
        linkExistenceField,
        linkControlFacet.of(fakeLinkControl()),
        livePreviewPlugin,
      ],
    });
    s = s.update({ effects: [setDocumentPath.of('/r/a.md'), setLinkExistence.of(new Map([['/r/gone.md', false]]))] }).state;
    ensureSyntaxTree(s, doc.length, 5000);
    const view = new EditorView({ state: s });
    const marks: { from: number; cls: string; title: string }[] = [];
    view.plugin(livePreviewPlugin)!.decorations.between(0, 30, (from, _to, value) => {
      const spec = value.spec as { class?: string; attributes?: { title?: string } };
      if (spec.class) marks.push({ from, cls: spec.class, title: spec.attributes?.title ?? '' });
    });
    view.destroy();
    expect(marks.find((m) => m.from === 0)?.cls).toBe('cm-md-link cm-md-link-missing');
    expect(marks.find((m) => m.from === 16)?.cls).toBe('cm-md-link');
    expect(marks.find((m) => m.from === 16)?.title).toMatch(/to open plan\.md$/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/editor/links/link-presentation.test.ts`
Expected: FAIL — `Failed to resolve import "./link-presentation"`.

- [ ] **Step 3: Implement `link-presentation.ts`**

```ts
// src/lib/editor/links/link-presentation.ts
import type { EditorState } from '@codemirror/state';
import { isMacPlatform } from '../hotkey-label';
import { linkActionFor, linkControlOf, resolveInState } from './open-link';
import { linkExistenceField } from './link-existence';
import { basename, stripAngle } from '../../links/link-target';
import { t } from '../../i18n';

export interface LinkPresentation {
  /** The hover title — the only place the app says how to open a link (#32). */
  title: string;
  /** The target is known not to exist: `cm-md-link-missing`. */
  missing: boolean;
}

/** How a link with destination `url` looks in this state (file-links D4). */
export function linkPresentation(state: EditorState, url: string): LinkPresentation {
  const click = t(isMacPlatform() ? 'editor.links.click_mac' : 'editor.links.click_other');
  const plain = (key: string, params: Record<string, unknown> = {}): LinkPresentation => ({
    title: t(key, { click, ...params }),
    missing: false,
  });
  // A reference link (`[foo]` with `[foo]: …` elsewhere) has no URL child.
  if (stripAngle(url) === '') return plain('editor.links.hint_open_link');

  const control = linkControlOf(state);
  const target = resolveInState(state, url);
  const action = linkActionFor(target, control !== null);
  if (target.kind === 'file' && control && state.field(linkExistenceField, false)?.get(target.path) === false) {
    return {
      title: action === 'open-file' ? t('editor.links.hint_missing', { click }) : t('editor.links.hint_missing_plain'),
      missing: true,
    };
  }
  switch (action) {
    case 'heading':
      return plain('editor.links.hint_heading');
    case 'open-file':
      return plain('editor.links.hint_open_file', { name: basename(target.kind === 'file' ? target.path : url) });
    case 'reveal':
      return plain('editor.links.hint_reveal');
    case 'unresolvable':
      return plain('editor.links.hint_open_file', { name: basename(stripAngle(url)) });
    case 'external':
      return plain('editor.links.hint_open_link');
  }
}
```

- [ ] **Step 4: Use it in `decorateLink`**

In `src/lib/editor/preview/inline.ts`, replace lines 1–16:

```ts
import { Decoration } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import type { RangeSetBuilder } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { shouldReveal } from './flavour';
import { isRenderedLink } from './link-refs';
import { isMacPlatform } from '../hotkey-label';

/** Tooltip on every rendered link — computed once, it cannot change at runtime. */
let openHint: string | null = null;
function linkOpenHint(): string {
  if (openHint === null) {
    openHint = isMacPlatform() ? '⌘-click to open link' : 'Ctrl+click to open link';
  }
  return openHint;
}
```

with:

```ts
import { Decoration } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import type { RangeSetBuilder } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { shouldReveal } from './flavour';
import { isRenderedLink } from './link-refs';
import { linkPresentation } from '../links/link-presentation';
```

In `decorateLink`, replace:

```ts
  builder.add(
    node.from,
    node.to,
    Decoration.mark({ class: 'cm-md-link', attributes: { title: linkOpenHint() } })
  );
```

with:

```ts
  // The title says where the link goes (file-links D4), and a file link whose
  // target is known not to exist is drawn dashed and muted.
  const look = linkPresentation(view.state, url ? view.state.doc.sliceString(url.from, url.to) : '');
  builder.add(
    node.from,
    node.to,
    Decoration.mark({
      class: look.missing ? 'cm-md-link cm-md-link-missing' : 'cm-md-link',
      attributes: { title: look.title },
    })
  );
```

(`RangeSetBuilder` is imported but unused there already — leave it.)

- [ ] **Step 5: Rebuild when the cache or the document path changes**

In `src/lib/editor/preview/plugin.ts`, add imports after `import { isRenderedLink } from './link-refs';`:

```ts
import { linkExistenceField } from '../links/link-existence';
import { documentPathField } from '../json-fence';
```

In `update(update: ViewUpdate)`, right after the `commentsChanged` constant add:

```ts
      // File links (D4): a missing-file answer restyles a link, and a new
      // document path re-resolves every relative one (title, missing state).
      const linksChanged =
        update.state.field(linkExistenceField, false) !== update.startState.field(linkExistenceField, false) ||
        update.state.field(documentPathField, false) !== update.startState.field(documentPathField, false);
```

and add `|| linksChanged` to the big `if (update.docChanged || viewDriven || …)` condition, after `rebuildConfigChanged`.

- [ ] **Step 6: Style**

In `src/styles/editor.css`, right after the `.cm-md-link { … }` rule (ends `cursor: pointer;\n}`), add:

```css
/* A file link whose target does not exist (file-links D4): dashed and muted,
 * so a typo in a path is visible before anyone ⌘-clicks it. Two classes, so
 * it outranks `.cm-md-link` without `!important`. */
.cm-md-link.cm-md-link-missing {
  color: var(--text-subtle);
  text-decoration-style: dashed;
  text-decoration-color: var(--text-subtle);
}
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/lib/editor/links/link-presentation.test.ts src/lib/editor/preview/link-refs.test.ts src/lib/editor/preview/blockquote.test.ts`
Expected: PASS (`link-refs` still sees `cm-md-link` as the exact class of an ordinary link).

Run: `npx vitest run src/lib/theme`
Expected: PASS (`theme-tokens.test.ts` accepts `--text-subtle`, a token every theme defines).

- [ ] **Step 8: Commit**

```bash
git add src/lib/editor/links/link-presentation.ts src/lib/editor/links/link-presentation.test.ts src/lib/editor/preview/inline.ts src/lib/editor/preview/plugin.ts src/styles/editor.css
git commit -m "feat(links): hover titles per target and a missing-file style

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Wire the control into the editor; ⌘-click → `openLink` (D3)

**Files:**
- Modify: `src/lib/editor/setup.ts`
- Modify: `src/lib/editor/Editor.svelte`
- Test: `src/lib/editor/state-factory.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/editor/state-factory.test.ts`:

```ts
import { linkControlFacet } from './links/open-link';
import { linkExistenceField } from './links/link-existence';
import { fakeLinkControl } from './links/fake-link-control';

describe('createDocumentState — link control', () => {
  it('installs the facet and the existence cache only when a control is given', () => {
    const control = fakeLinkControl();
    const withControl = createDocumentState('x', 0, [], { linkControl: control });
    expect(withControl.facet(linkControlFacet)).toBe(control);
    expect(withControl.field(linkExistenceField, false)).toBeDefined();

    const without = createDocumentState('x', 0, []);
    expect(without.facet(linkControlFacet)).toBeNull();
    expect(without.field(linkExistenceField, false)).toBeUndefined();
  });
});
```

(The file already imports `describe`/`it`/`expect` and `createDocumentState`; ES `import` lines are valid anywhere at the top level, so appending them is fine — or move them up to the other imports.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/editor/state-factory.test.ts`
Expected: FAIL — TS/runtime error: `linkControl` is not in `EditorDeps`, facet is `null`.

- [ ] **Step 3: Implement in `setup.ts`**

Replace the import line

```ts
import { headingSlugsField, isAnchor, navigateToHeading } from './heading-slugs';
```

with:

```ts
import { headingSlugsField } from './heading-slugs';
import { linkControlFacet, openLink, type LinkControl } from './links/open-link';
import { linkExistence } from './links/link-existence';
```

Replace the whole `openExternalUrl` function and its doc comment (the block starting `/**\n * Opens a rendered link. Uses the Tauri shell plugin` through its closing `}`) with:

```ts
// Moved to `links/open-link.ts`, where the link router lives; re-exported for
// existing importers.
export { openExternalUrl } from './links/open-link';
```

In `EditorDeps`, after `stashControl?: StashControl;` add:

```ts
  /**
   * File links (file-links D3): ⌘-click on `[x](plan.md)` opens the file, the
   * existence check marks missing targets. Omitted by the landing's demo
   * cards, which keep the old external-only behaviour.
   */
  linkControl?: LinkControl;
```

In `createExtensions`, replace

```ts
  const { themeControl, stashControl } = deps;
```

with

```ts
  const { themeControl, stashControl, linkControl } = deps;
```

and right after the line `previewCompartment.of(livePreviewPlugin),` add:

```ts
    ...(linkControl ? [linkControlFacet.of(linkControl), linkExistence] : []),
```

In the `mousedown` handler, replace:

```ts
        if (url) {
          event.preventDefault();
          event.stopPropagation();
          if (isAnchor(url)) {
            navigateToHeading(view, url.slice(1));
            return true;
          }
          openExternalUrl(url);
          return true;
        }
```

with:

```ts
        if (url) {
          event.preventDefault();
          event.stopPropagation();
          // One router for every gesture (file-links D3): anchors, URLs,
          // files, missing files — see `links/open-link.ts`.
          void openLink(view, url);
          return true;
        }
```

- [ ] **Step 4: Pass the prop through `Editor.svelte`**

In `src/lib/editor/Editor.svelte`:

After `import type { StashControl } from './slash-stash';` add:

```ts
  import type { LinkControl } from './links/open-link';
```

In the `$props()` destructuring, after `stashControl,` add `linkControl,`; in its type literal, after `stashControl?: StashControl;` add:

```ts
    /** File links (⌘-click opens files). Omitted by the landing's demo cards. */
    linkControl?: LinkControl;
```

Replace both occurrences of `{ themeControl, stashControl }` (in `createState` and in `onMount`) with `{ themeControl, stashControl, linkControl }`.

- [ ] **Step 5: Run the tests and the type check**

Run: `npx vitest run src/lib/editor/state-factory.test.ts src/lib/editor/links`
Expected: PASS.

Run: `npm run check`
Expected: `svelte-check found 0 errors`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/editor/setup.ts src/lib/editor/Editor.svelte src/lib/editor/state-factory.test.ts
git commit -m "feat(links): cmd-click routes through openLink with a LinkControl dep

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Inspector Open button (D3)

**Files:**
- Modify: `src/lib/editor/live-render/inspector.ts:16` (import) and `buildLinkPanel` (`syncOpenLabel`, the Open `mousedown`)

The label logic is `openButtonLabel` (tested in Task 7); this task only wires it.

- [ ] **Step 1: Replace the import**

Replace:

```ts
import { isAnchor, navigateToHeading } from '../heading-slugs';
```

with:

```ts
import { linkActionFor, linkControlOf, openButtonLabel, openLink, resolveInState } from '../links/open-link';
```

- [ ] **Step 2: Label follows the target**

Replace the `syncOpenLabel` function body:

```ts
  function syncOpenLabel(): void {
    openBtn.setAttribute(
      'aria-label',
      isAnchor(input.value) ? t('editor.inspector.jump_to_heading') : t('editor.inspector.open_in_browser')
    );
  }
```

with:

```ts
  function actionNow() {
    return linkActionFor(resolveInState(view.state, input.value.trim()), linkControlOf(view.state) !== null);
  }

  function syncOpenLabel(): void {
    const label = openButtonLabel(actionNow());
    openBtn.textContent = label.text;
    openBtn.setAttribute('aria-label', label.aria);
  }
```

(The earlier `openBtn.textContent = t('editor.inspector.open');` line may stay: `syncOpenLabel()` runs right after and overwrites it.)

- [ ] **Step 3: One router**

Replace the Open button's `mousedown` listener:

```ts
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
```

with:

```ts
  openBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url) return;
    // The same router as ⌘-click (file-links D3). Anything that moves the
    // view — a heading, another tab, Finder — takes the panel down first; a
    // browser URL leaves the editor as it was, as before.
    if (actionNow() !== 'external') {
      hidePanel();
      view.focus();
    }
    void openLink(view, url);
  });
```

- [ ] **Step 4: Type check and the live-render tests**

Run: `npm run check`
Expected: 0 errors (no remaining `isAnchor` / `navigateToHeading` references in `inspector.ts`).

Run: `npx vitest run src/lib/editor/live-render`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/editor/live-render/inspector.ts
git commit -m "feat(links): inspector Open follows the link target

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Links in table cells (D3)

**Files:**
- Modify: `src/lib/editor/preview/tables.ts:35` (import), `routeLinkClick` (~856), cell link (~1027)
- Test: `src/lib/editor/preview/tables.test.ts` (append inside / after the `routeLinkClick` describe)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/editor/preview/tables.test.ts`:

```ts
import { documentPathField, setDocumentPath } from '../json-fence';
import { linkControlFacet } from '../links/open-link';
import { fakeLinkControl } from '../links/fake-link-control';

describe('routeLinkClick with a LinkControl', () => {
  function viewWithControl() {
    const control = fakeLinkControl();
    let state = EditorState.create({
      doc: '# Hello\n',
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Strikethrough, Table] }),
        headingSlugsField,
        documentPathField,
        linkControlFacet.of(control),
      ],
    });
    state = state.update({ effects: setDocumentPath.of('/r/a.md') }).state;
    const view = { state, dispatch: vi.fn() } as unknown as EditorView;
    return { view, control };
  }

  it('File_GoesThroughOpenLink_NotTheExternalOpener', async () => {
    const { view, control } = viewWithControl();
    const openExternal = vi.fn();
    routeLinkClick('plan.md', view, openExternal);
    await new Promise((r) => setTimeout(r, 0));
    expect(control.calls).toContain('openFile:/r/plan.md#');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('External_StillUsesTheInjectedOpener', () => {
    const { view, control } = viewWithControl();
    const openExternal = vi.fn();
    routeLinkClick('https://x.test', view, openExternal);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://x.test');
    expect(control.calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/editor/preview/tables.test.ts`
Expected: FAIL — `File_GoesThroughOpenLink…`: `openExternal` was called with `plan.md`.

- [ ] **Step 3: Implement**

Replace the import

```ts
import { isAnchor, navigateToHeading } from '../heading-slugs';
```

with:

```ts
import { isAnchor, navigateToHeading } from '../heading-slugs';
import { linkControlOf, openLink } from '../links/open-link';
import { isExternalUrl } from '../../links/link-target';
import { linkPresentation } from '../links/link-presentation';
```

Replace `routeLinkClick`'s body:

```ts
  if (isAnchor(url)) {
    navigateToHeading(view, url.slice(1));
  } else {
    openExternal(url);
  }
```

with:

```ts
  if (isAnchor(url)) {
    navigateToHeading(view, url.slice(1));
  } else if (linkControlOf(view.state) && !isExternalUrl(url)) {
    // A file link (file-links D3): the same router as ⌘-click.
    void openLink(view, url);
  } else {
    openExternal(url);
  }
```

and add one sentence to its doc comment, after "everything else is opened externally…":

```ts
 * With a `LinkControl` (the app, not the landing) a file link goes through
 * `openLink` instead — the same router as ⌘-click.
```

In the `case 'link':` branch of the cell renderer, after `a.rel = 'noopener noreferrer';` add:

```ts
        // Where it goes (file-links D4). No missing-file style here: the
        // table widget's `eq()` does not see the existence cache.
        a.title = linkPresentation(view.state, token.url).title;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/editor/preview/tables.test.ts`
Expected: PASS (old `routeLinkClick` tests unchanged and green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/editor/preview/tables.ts src/lib/editor/preview/tables.test.ts
git commit -m "feat(links): table-cell links open files through openLink

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: `link-missing` toast with «Create» (D2)

**Files:**
- Modify: `src/lib/toasts.svelte.ts` (payload union + `ORDER`)
- Modify: `src/lib/ToastStack.svelte` (prop + branch)
- Test: `src/lib/ToastStack.svelte.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/ToastStack.svelte.test.ts`:

```ts
describe('ToastStack: a link to a missing file (file-links D2)', () => {
  function renderLink(payload: { path: string | null; fileName: string; canCreate: boolean }) {
    const store = createToastStore();
    store.push({ kind: 'link-missing', ...payload });
    const onCreateLink = vi.fn();
    const target = document.createElement('div');
    document.body.appendChild(target);
    const component = mount(ToastStack, { target, props: { store, onCreateLink } });
    flushSync();
    cleanup = () => {
      unmount(component);
      target.remove();
    };
    return { root: target, store, onCreateLink };
  }

  it('NamesTheFile_AndCreateOpensItAsANewTab', () => {
    const { root, store, onCreateLink } = renderLink({ path: '/r/gone.md', fileName: 'gone.md', canCreate: true });
    expect(root.querySelector('.md-toast-text')?.textContent?.trim()).toBe('No file gone.md');
    root.querySelector<HTMLButtonElement>('.md-toast-action')!.click();
    expect(onCreateLink).toHaveBeenCalledWith('/r/gone.md');
    expect(store.hasKind('link-missing')).toBe(false);
  });

  it('OffersNoCreate_ForANonDocument', () => {
    const { root } = renderLink({ path: '/r/x.png', fileName: 'x.png', canCreate: false });
    expect(root.querySelector('.md-toast-action')).toBeNull();
  });

  it('AnUntitledDocumentSaysToSaveFirst', () => {
    const { root } = renderLink({ path: null, fileName: 'plan.md', canCreate: false });
    expect(root.querySelector('.md-toast-text')?.textContent?.trim()).toBe(
      'Save this document first — plan.md is relative to it'
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/ToastStack.svelte.test.ts`
Expected: FAIL — no `.md-toast-text` rendered for the unknown kind (falls into the last `{:else}` branch).

- [ ] **Step 3: Add the payload**

In `src/lib/toasts.svelte.ts`, in `ToastPayload`, right before `| { kind: 'update'; latest: string; current: string; highlight?: string }` add:

```ts
  /**
   * A file link (file-links D2) whose target is not there — or, with `path:
   * null`, a relative link in a document that has no path yet (`fileName` is
   * then the link as written). «Create» opens the missing path as a new
   * unsaved tab, saved where the link points; it is never created on the
   * click itself, so a typo in an agent's link cannot litter the disk.
   * `canCreate` is false for a target couplet would not open as a document.
   */
  | { kind: 'link-missing'; path: string | null; fileName: string; canCreate: boolean }
```

In `ORDER`, after `'stash-standing': 4,` add:

```ts
  // Answers the ⌘-click the user just made.
  'link-missing': 4,
```

- [ ] **Step 4: Render it**

In `src/lib/ToastStack.svelte`, add to the props destructuring after `onRevealWindow,`:

```ts
    /** «Create» on a `link-missing` toast: open that path as a new tab. */
    onCreateLink,
```

and to the props type after `onRevealWindow?: (label: string) => void;`:

```ts
    onCreateLink?: (path: string) => void;
```

Add a branch right before `{:else if toast.payload.kind === 'reload-error'}`:

```svelte
        {:else if toast.payload.kind === 'link-missing'}
          {@const link = toast.payload}
          {@const createPath = link.canCreate ? link.path : null}
          <span class="md-toast-text">
            <strong
              >{link.path === null
                ? t('toast.link_unresolvable.headline', { fileName: link.fileName })
                : t('toast.link_missing.headline', { fileName: link.fileName })}</strong
            >
          </span>
          {#if createPath !== null}
            <button
              class="md-toast-cmd md-toast-action"
              onclick={() => {
                if (createPath !== null) onCreateLink?.(createPath);
                dismiss(toast);
              }}
            >
              {t('toast.link_missing.create')}
            </button>
          {/if}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/lib/ToastStack.svelte.test.ts src/lib/toasts.svelte.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/toasts.svelte.ts src/lib/ToastStack.svelte src/lib/ToastStack.svelte.test.ts
git commit -m "feat(links): link-missing toast with Create

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: App wiring — `openTab` result, fragment jump, the control

**Files:**
- Modify: `src/lib/tabs/controller.ts` (`openPath`, ~1581)
- Modify: `src/App.svelte` (imports, `openTab` ~959, `openStashEntry` ~1106, `linkControl` after `stashControl` ~2165, `onMount` ~2778, `<Editor>` ~3110, `<ToastStack>` ~3165)
- Test: `src/lib/tabs/controller.test.ts` (append)

- [ ] **Step 1: Write the failing controller test**

Append at the end of the file (`started` and `fileTab` are module-level helpers there):

```ts
describe('openPath result (file links)', () => {
  it('ResolvesWithWhereTheFileEndedUp', async () => {
    const h = await started({ '/a.md': 'AAAA', '/b.md': 'BBBB' }, [fileTab('a', '/a.md')]);
    expect(await h.controller.openPath('/b.md')).toEqual({ kind: 'opened', tabId: 't1' });
    expect(await h.controller.openPath('/b.md')).toEqual({ kind: 'shown', tabId: 't1' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/tabs/controller.test.ts -t "ResolvesWithWhereTheFileEndedUp"`
Expected: FAIL — received `undefined`.

- [ ] **Step 3: Return the result from `openPath`**

In `src/lib/tabs/controller.ts`, replace:

```ts
    openPath: (path: string, position?: Position) =>
      queue.run(async () => {
        await openNow(path, position ?? null);
      }),
```

with:

```ts
    /** Resolves with where the file ended up — a link's `#fragment` jumps only if it is shown here. */
    openPath: (path: string, position?: Position) => queue.run(() => openNow(path, position ?? null)),
```

Run: `npx vitest run src/lib/tabs/controller.test.ts`
Expected: PASS.

- [ ] **Step 4: App — imports**

In `src/App.svelte`:

Replace

```ts
  import { createTabController, type DiskOptions, type MoveDone, type OpenAnswer, type Stranded } from './lib/tabs/controller';
```

with

```ts
  import { createTabController, type DiskOptions, type MoveDone, type OpenAnswer, type OpenPathResult, type Stranded } from './lib/tabs/controller';
```

After `import type { StashControl } from './lib/editor/slash-stash';` add:

```ts
  import type { LinkControl } from './lib/editor/links/open-link';
  import { navigateToHeading } from './lib/editor/heading-slugs';
  import { pathKinds, revealInFinder } from './lib/links/ipc';
  import { opensAsDocument } from './lib/links/link-kind';
  import { basename } from './lib/links/link-target';
```

- [ ] **Step 5: App — `openTab` returns the result**

Replace:

```ts
  function openTab(path: string, position?: { cursor: number; topLine: number }): Promise<void> {
    return tabSourcesReady.then(() => tabs.openPath(path, position));
  }
```

with:

```ts
  function openTab(path: string, position?: { cursor: number; topLine: number }): Promise<OpenPathResult | undefined> {
    return tabSourcesReady.then(() => tabs.openPath(path, position));
  }
```

`openStashEntry` hands `tabs.openPath` to `openFromStash`, whose dep is typed `Promise<void>`; keep it void. Replace

```ts
      openPath: (path, position) => tabs.openPath(path, position),
```

with

```ts
      openPath: async (path, position) => {
        await tabs.openPath(path, position);
      },
```

- [ ] **Step 6: App — the control**

Right after `const stashControl: StashControl = { putAway: putAwayActive };` add:

```ts
  /** The home folder for `~/` links; filled once in `onMount`, `null` in the browser. */
  let linkHome: string | null = null;

  /**
   * File links (file-links D2/D3). One object: the editor's facet holds it for
   * every state this window shows.
   */
  const linkControl: LinkControl = {
    home: () => linkHome,
    pathKinds: (paths) => pathKinds(paths),
    async openFile(path, fragment) {
      const result = await openTab(path);
      // The fragment applies only when the file is now this window's active
      // tab; a file shown in another window loses it (spec D2).
      if (!fragment || !result || (result.kind !== 'opened' && result.kind !== 'shown')) return;
      const view = editorHandle?.view;
      if (view) navigateToHeading(view, fragment);
    },
    reveal: (path) =>
      revealInFinder(path).catch((err: unknown) => {
        reportOpenError(path, err);
      }),
    missing: (path) =>
      toasts.push({ kind: 'link-missing', path, fileName: basename(path), canCreate: opensAsDocument(path) }),
    unresolvable: (url) => toasts.push({ kind: 'link-missing', path: null, fileName: url, canCreate: false }),
  };
```

- [ ] **Step 7: App — home folder**

Right after `window.addEventListener('focus', handleWindowFocus);` (inside `onMount`) add:

```ts
    // `~/` in a link (agents write these): the home folder, asked once. Stays
    // `null` in the browser dev build, where such links are unresolvable.
    import('@tauri-apps/api/path')
      .then(({ homeDir }) => homeDir())
      .then((home) => {
        linkHome = home.replace(/\/+$/, '');
      })
      .catch(() => {});
```

- [ ] **Step 8: App — props**

In `<Editor …>` after `{stashControl}` add `{linkControl}`.

In `<ToastStack …>` after `onFormatJson={() => formatJson(true)}` add:

```svelte
  onCreateLink={(path) => void openTab(path)}
```

- [ ] **Step 9: Type check and the full frontend suite**

Run: `npm run check`
Expected: 0 errors.

Run: `npx vitest run --dir src`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/lib/tabs/controller.ts src/lib/tabs/controller.test.ts src/App.svelte
git commit -m "feat(links): app LinkControl — open, jump to fragment, reveal, missing

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Verification

**Files:** none changed (fix-forward commits only if a check fails).

- [ ] **Step 1: Frontend**

Run: `npx vitest run --dir src`
Expected: all green.

Run: `npm run check`
Expected: `svelte-check found 0 errors and 0 warnings` (warnings that existed on `main` before this plan are acceptable; no new ones).

- [ ] **Step 2: The landing still builds without a `LinkControl`**

Run: `npx vite build --config vite.config.site.ts --outDir /tmp/couplet-site-check --emptyOutDir`
Expected: `✓ built in …` and nothing written under `docs/` (`git status --short docs/` prints nothing).

- [ ] **Step 3: Rust**

Run: `cd src-tauri && cargo test`
Expected: all green.

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml`
Expected: no new warnings.

Run: `npm run check:x86`
Expected: `Finished`.

- [ ] **Step 4: Live check (dev identity — never `npm run tauri dev`)**

```bash
lsof -ti:1420 | xargs kill -9 2>/dev/null; npm run dev:app -- --features mcp-bridge \
  --config '{"app":{"windows":[{"title":"file-links 01 · local"}]}}'
```

Prepare a folder:

```bash
mkdir -p /tmp/fl/docs && cd /tmp/fl && git init -q && \
printf '# Plan\n\n## Risks\n\nhere\n' > docs/plan.md && \
printf 'png' > docs/diagram.png && \
printf '[plan](docs/plan.md) · [risks](docs/plan.md#risks) · [gone](docs/gone.md) · [img](docs/diagram.png) · [folder](docs) · [web](https://example.com)\n\n| a |\n|---|\n| [plan](docs/plan.md) |\n' > index.md
```

Open `/tmp/fl/index.md` in the dev app (File → Open). Check, in both engines (View → engine):

- [ ] Hover each link: titles say «⌘-click to open plan.md», «⌘-click to show in Finder», «⌘-click to open link».
- [ ] Within ~150 ms `[gone]` turns dashed/muted; its title is «File not found — ⌘-click to create».
- [ ] ⌘-click `[plan]` → `plan.md` opens as a new tab after `index.md`; ⌘-click it again from `index.md` → switches to that tab (no second tab).
- [ ] ⌘-click `[risks]` → opens/switches and scrolls to «Risks».
- [ ] Open `plan.md` in a second window (File → New Window, open it there); back in the first window ⌘-click `[plan]` → the second window comes forward.
- [ ] ⌘-click `[gone]` → toast «No file gone.md» with «Create» → a new unsaved tab `gone.md`; type, wait for autosave → `/tmp/fl/docs/gone.md` exists. Before clicking «Create» the file does not exist (`ls /tmp/fl/docs`).
- [ ] ⌘-click `[img]` and `[folder]` → Finder comes forward with the item selected; nothing opens in couplet.
- [ ] ⌘-click `[web]` → the browser opens.
- [ ] In a new untitled tab type `[x](plan.md)` and ⌘-click → «Save this document first — plan.md is relative to it».
- [ ] Live render: put the caret in `[plan]`, the inspector shows «Open file»; for `[img]` «Show in Finder»; for `[web]` «Open»; Open on `[plan]` opens the file.
- [ ] Click the link inside the table cell → opens `plan.md`.
- [ ] `touch /tmp/fl/docs/gone.md` while couplet is in the background, focus the window → `[gone]` stops being dashed without flicker.
- [ ] In the browser build (`npm run dev`, http://localhost:1420): ⌘-click a URL still opens a browser tab; no console errors from the link code.

- [ ] **Step 5: Commit any fixes**

If a live check needed a fix, commit it with explicit paths and a `fix(links): …` message ending with the `Co-Authored-By` line. Otherwise nothing to commit.
