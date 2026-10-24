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
