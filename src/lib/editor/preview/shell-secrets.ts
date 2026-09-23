import {
  ViewPlugin,
  Decoration,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
  type EditorView,
} from '@codemirror/view';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { isSecret, maskSecret, stripQuotes } from './env';
import { cursorInRange } from './utils';
import { t } from '../../i18n';

// ---------------------------------------------------------------------------
// Pure parser
// ---------------------------------------------------------------------------

export interface ShellSecretMatch {
  key: string;
  rawValue: string;  // value token as written in the line (including quotes if any)
  valueFrom: number; // offset within lineText where the value token starts
  valueTo: number;   // offset within lineText where the value token ends
}

/**
 * Shell assignment regex:
 *   optional leading whitespace
 *   optional declaring keyword (export|declare|typeset|local|readonly)
 *   variable name (identifier)
 *   = (no spaces around = in shell)
 *   rest of line
 */
const SHELL_ASSIGNMENT_RE =
  /^(\s*)(?:(?:export|declare|typeset|local|readonly)\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Returns a match only if the line is a shell assignment AND the value is
 * a secret per env's isSecret heuristic. Otherwise returns null.
 *
 * The VALUE TOKEN is the shortest token starting the value portion:
 *   - double-quoted: from opening " to next unescaped " (inclusive), or EOL
 *   - single-quoted: from opening ' to next ' (inclusive), or EOL
 *   - unquoted: up to first whitespace or #, or EOL
 *
 * Trailing inline comments (# ...) are NOT included in the token.
 */
export function matchShellSecret(lineText: string): ShellSecretMatch | null {
  const m = SHELL_ASSIGNMENT_RE.exec(lineText);
  if (!m) return null;

  const key = m[2];
  const valueRest = m[3]; // everything after the =

  // Offset where valueRest starts within lineText
  // = prefix length (indent + optional keyword + key) + 1 for '='
  const valueRestOffset = lineText.length - valueRest.length;

  if (!valueRest) return null;

  let tokenEnd: number;

  const firstChar = valueRest[0];

  if (firstChar === '"') {
    // Find next unescaped "
    let i = 1;
    while (i < valueRest.length) {
      if (valueRest[i] === '\\') {
        i += 2; // skip escaped char
        continue;
      }
      if (valueRest[i] === '"') {
        i += 1;
        break;
      }
      i++;
    }
    tokenEnd = i; // may be EOL if unterminated
  } else if (firstChar === "'") {
    // Single-quoted: find next '
    const close = valueRest.indexOf("'", 1);
    tokenEnd = close === -1 ? valueRest.length : close + 1;
  } else {
    // Unquoted: stop at first whitespace or #
    let i = 0;
    while (i < valueRest.length && valueRest[i] !== ' ' && valueRest[i] !== '\t' && valueRest[i] !== '#') {
      i++;
    }
    tokenEnd = i;
  }

  const rawValue = valueRest.slice(0, tokenEnd);
  if (!rawValue) return null;

  const unquoted = stripQuotes(rawValue);
  if (!unquoted) return null;

  // Shell expansions/substitutions ($VAR, ${...}, $(...), `...`) are references,
  // not literal secrets — leave them visible even when the key name looks secret.
  if (unquoted.startsWith('$') || unquoted.startsWith('`')) return null;

  if (!isSecret(unquoted, key)) return null;

  return {
    key,
    rawValue,
    valueFrom: valueRestOffset,
    valueTo: valueRestOffset + tokenEnd,
  };
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

class ShellSecretWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly rawValue: string,
    readonly from: number,
    readonly to: number
  ) {
    super();
  }

  eq(other: ShellSecretWidget): boolean {
    return (
      this.key === other.key &&
      this.rawValue === other.rawValue &&
      this.from === other.from &&
      this.to === other.to
    );
  }

  toDOM(): HTMLElement {
    const unquoted = stripQuotes(this.rawValue);
    const masked = maskSecret(unquoted);

    const pill = document.createElement('span');
    pill.className = 'cm-shell-secret';
    pill.textContent = masked;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'cm-shell-secret-copy';
    copyBtn.textContent = t('ui.copy');
    copyBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      navigator.clipboard.writeText(unquoted).then(() => {
        copyBtn.textContent = t('ui.copied');
        setTimeout(() => {
          copyBtn.textContent = t('ui.copy');
        }, 1500);
      }).catch(() => {
        // Clipboard API may fail in certain contexts — fail silently
      });
    });

    const wrapper = document.createElement('span');
    wrapper.className = 'cm-shell-secret-wrapper';
    wrapper.appendChild(pill);
    wrapper.appendChild(copyBtn);

    return wrapper;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Decoration builder
// ---------------------------------------------------------------------------

function buildShellSecretDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc } = view.state;

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (cursorInRange(view, line.from, line.to)) continue;

    const match = matchShellSecret(line.text);
    if (!match) continue;

    const from = line.from + match.valueFrom;
    const to = line.from + match.valueTo;

    builder.add(
      from,
      to,
      Decoration.replace({
        widget: new ShellSecretWidget(match.key, match.rawValue, from, to),
      })
    );
  }

  return builder.finish();
}

// ---------------------------------------------------------------------------
// ViewPlugin (Extension)
// ---------------------------------------------------------------------------

export const shellSecretsPlugin: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      try {
        this.decorations = buildShellSecretDecorations(view);
      } catch (e) {
        console.warn('Shell secret decoration error:', e);
        this.decorations = Decoration.none;
      }
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        try {
          this.decorations = buildShellSecretDecorations(update.view);
        } catch (e) {
          console.warn('Shell secret decoration error:', e);
          this.decorations = Decoration.none;
        }
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);
