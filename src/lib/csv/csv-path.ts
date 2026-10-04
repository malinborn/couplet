/**
 * Is this path a CSV file — by name only. Dependency-free on purpose: both the
 * codec (`csv-codec.ts`) and `editor/file-language.ts` ask it, and the codec
 * itself imports `file-language`, so this answer must live below both.
 */

/** The lowercased extension of the basename; `''` for none and for a dotfile like `.csv`. */
export function extOf(path: string): string {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function isCsvPath(path: string | null | undefined): boolean {
  if (!path) return false;
  const ext = extOf(path);
  return ext === 'csv' || ext === 'tsv';
}
