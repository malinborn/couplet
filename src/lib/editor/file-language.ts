import { languages } from '@codemirror/language-data';
import type { LanguageDescription } from '@codemirror/language';

// Extensionless config dotfiles → language name as it appears in @codemirror/language-data.
export const FILENAME_LANGUAGE: Record<string, string> = {
  '.zshrc': 'Shell',
  '.zshenv': 'Shell',
  '.zprofile': 'Shell',
  '.zlogin': 'Shell',
  '.zlogout': 'Shell',
  '.zsh_aliases': 'Shell',
  '.bashrc': 'Shell',
  '.bash_profile': 'Shell',
  '.bash_login': 'Shell',
  '.bash_logout': 'Shell',
  '.bash_aliases': 'Shell',
  '.profile': 'Shell',
  '.aliases': 'Shell',
  '.functions': 'Shell',
  '.exports': 'Shell',
};

/**
 * Returns true if the given basename (lowercase) maps to a shell config dotfile.
 * Used to decide whether to activate shell secret masking.
 */
export function isShellConfig(basename: string): boolean {
  return basename.toLowerCase() in FILENAME_LANGUAGE;
}

/**
 * Resolve a CodeMirror LanguageDescription for a file: special-case basename first
 * (extensionless shell configs), then fall back to extension lookup. Returns null
 * if neither matches. `basename`/`ext` are lowercased defensively.
 */
export function findCodeLanguage(basename: string, ext: string): LanguageDescription | null {
  const name = FILENAME_LANGUAGE[basename.toLowerCase()];
  const byName = name ? languages.find(l => l.name === name) : undefined;
  if (byName) return byName;
  const e = ext.toLowerCase();
  return languages.find(l => l.extensions.includes(e)) ?? null;
}

/**
 * Extensions md-mini opens as a **markdown-flavoured** buffer: live preview on,
 * the document rendered rather than syntax-highlighted.
 *
 * `''` is in the set because a path with no extension lands here. Note the
 * extension is taken the way `App.svelte` takes it — `path.split('.').pop()` —
 * so `.zshrc` yields `zshrc`, not `''`, and a shell config is correctly not
 * markdown.
 *
 * Lives here rather than inline in `App.svelte` so the project has exactly one
 * answer to "what kind of file is this".
 */
export const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'txt', '']);

/**
 * True when this path opens as a markdown buffer. `null` means untitled, which
 * is what a new window is, and a new window is markdown.
 *
 * Mirrors `App.svelte`'s open-file branch exactly — env files first, then the
 * extension set, then everything else is a code buffer — and is tested against
 * all three outcomes so the two cannot drift.
 *
 * The caller that must not get this wrong is the JSON formatter's fence
 * decision (#47): a ``` line inserted into a `.py` or `.cs` buffer is not a
 * cosmetic mistake, it is a syntax error written into the user's source.
 */
export function isMarkdownBuffer(path: string | null | undefined): boolean {
  if (!path) return true;
  const basename = path.split('/').pop()?.toLowerCase() ?? '';
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (basename.startsWith('.env') || ext === 'env') return false;
  return MARKDOWN_EXTENSIONS.has(ext);
}
