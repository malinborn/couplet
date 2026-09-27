/**
 * ⌫ in a drawer's type-to-filter query, with the macOS text-field units:
 * ⌫ one character, ⌥⌫ a word, ⌘⌫ everything. Shared by the tabs drawer and
 * the stash (the query is always edited at its end — there is no caret).
 */
export type BackspaceUnit = 'char' | 'word' | 'all';

/**
 * The query after one ⌫ of `unit`.
 *
 * - `char`: the last code point, so an emoji never leaves half a surrogate pair.
 * - `word`: trailing whitespace first, then back to the previous whitespace
 *   (macOS «delete word backward», with any whitespace as the only separator:
 *   `#tag`, `vpn-conf` and emoji are one word each). Only spaces → empty.
 * - `all`: empty.
 */
export function deleteBackward(query: string, unit: BackspaceUnit): string {
  switch (unit) {
    case 'all':
      return '';
    case 'word': {
      const kept = query.trimEnd();
      let i = kept.length;
      while (i > 0 && !/\s/u.test(kept[i - 1])) i--;
      return kept.slice(0, i);
    }
    case 'char': {
      const points = Array.from(query);
      points.pop();
      return points.join('');
    }
  }
}
