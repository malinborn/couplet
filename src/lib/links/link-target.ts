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
  | { kind: 'unresolvable'; reason: UnresolvableReason };

/**
 * Why a destination resolves to nothing: an empty one (`[x](<>)`), a relative
 * path in a document with no path yet, or `~/` before the home folder is known.
 */
export type UnresolvableReason = 'empty' | 'untitled' | 'no-home';

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
