import { basename, dirOf, normalizePath } from './link-target';

/**
 * What a picked or dropped file becomes in the document (file-links D6):
 * plain CommonMark `[label](destination)`, readable by GitHub, agents and
 * every other editor.
 */

export function isInside(root: string, path: string): boolean {
  const r = normalizePath(root);
  const p = normalizePath(path);
  return r === '/' || p === r || p.startsWith(`${r}/`);
}

/** `to` relative to the directory `fromDir`; `''` for the directory itself. */
export function relativePath(fromDir: string, to: string): string {
  const a = normalizePath(fromDir).split('/').filter(Boolean);
  const b = normalizePath(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

const NEEDS_ANGLE = /[\s()<>]/;

/** CommonMark's `<…>` form when the destination has spaces, parentheses or `<`; `<`/`>` inside are escaped. */
export function wrapDestination(dest: string): string {
  return NEEDS_ANGLE.test(dest) ? `<${dest.replace(/[<>]/g, (c) => `\\${c}`)}>` : dest;
}

/**
 * A file path as a destination. Only `%` and `#` are encoded: `#` would start
 * a fragment and `%` an escape when the link is read back
 * (`resolveLinkTarget`). A backslash is doubled, or `a\[b].md` would read back
 * as `a[b].md` (CommonMark escapes). Everything else stays readable.
 */
export function formatPathDestination(path: string): string {
  return wrapDestination(path.replace(/\\/g, '\\\\').replace(/%/g, '%25').replace(/#/g, '%23'));
}

/** `resolveLinkTarget`'s URL scheme test: `note:draft.md` would read back as a URL. */
const SCHEME_LIKE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * A relative path that would read back as something else — a URL scheme
 * (`note:draft.md`; `:` is legal in a macOS file name) or the home folder
 * (`~/x.md`) — keeps a leading `./`. The only case `./` is written.
 */
function guardRelative(rel: string): string {
  return SCHEME_LIKE.test(rel) || rel === '~' || rel.startsWith('~/') ? `./${rel}` : rel;
}

/**
 * Relative to the document's folder when the document has a path and the
 * target is inside the same project root (Rust's `project_root`: the git
 * toplevel, or the document's folder outside git); absolute otherwise.
 * `./` is written only where the bare path would mean something else
 * (`guardRelative`); `../` is.
 */
export function destinationFor(target: string, docPath: string | null, projectRoot: string | null): string {
  if (docPath && projectRoot && isInside(projectRoot, docPath) && isInside(projectRoot, target)) {
    return formatPathDestination(guardRelative(relativePath(dirOf(docPath), target)));
  }
  return formatPathDestination(normalizePath(target));
}

/** A stash note's title; a markdown file's name without `.md`/`.markdown`; any other file's full name. */
export function labelFor(item: { path: string; title: string | null }): string {
  const title = item.title?.trim();
  if (title) return title;
  const name = basename(item.path);
  return name.replace(/\.(md|markdown)$/i, '');
}

/** Brackets and backslashes in a label are escaped, so the label cannot end the link early. */
export function escapeLabel(label: string): string {
  return label.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

export function linkMarkdownFor(
  item: { path: string; title: string | null },
  docPath: string | null,
  projectRoot: string | null
): string {
  return `[${escapeLabel(labelFor(item))}](${destinationFor(item.path, docPath, projectRoot)})`;
}
