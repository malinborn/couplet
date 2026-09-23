import {
  ViewPlugin,
  Decoration,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
  type EditorView,
} from '@codemirror/view';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { cursorInRange } from './utils';
import { t } from '../../i18n';

// --- Secret detection heuristic ---

const SECRET_PREFIXES = [
  'sk-',
  'pk-',
  'ghp_',
  'ghs_',
  'eyJ',
  'xox',
  'AKIA',
  'token-',
  'secret-',
];

const SHORT_SAFE_PATTERNS = [
  /^https?:\/\//i,   // URLs without embedded auth
  /^localhost$/i,
  /^true$/i,
  /^false$/i,
  /^\d+$/,           // pure numbers (ports, counts)
];

const SECRET_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /key$/i,
  /api_key/i,
  /apikey/i,
  /auth/i,
  /credential/i,
  /private/i,
];

export function isSecret(value: string, key?: string): boolean {
  if (!value) return false;

  // Check if the key name suggests a secret
  if (key) {
    for (const pattern of SECRET_KEY_PATTERNS) {
      if (pattern.test(key)) return true;
    }
  }

  for (const prefix of SECRET_PREFIXES) {
    if (value.startsWith(prefix)) return true;
  }

  if (value.length > 20 && /[A-Za-z]/.test(value) && /[0-9]/.test(value)) {
    for (const pattern of SHORT_SAFE_PATTERNS) {
      if (pattern.test(value)) return false;
    }
    return true;
  }

  return false;
}

export function maskSecret(value: string): string {
  // If fewer than 14 chars would be hidden, mask everything — too easy to bruteforce
  if (value.length < 20) return '••••••';
  const hidden = value.length - 6; // 3 shown at start + 3 at end
  if (hidden < 14) return '••••••';
  return value.slice(0, 3) + '…' + value.slice(-3);
}

export function stripQuotes(raw: string): string {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

// --- Widget ---

class EnvLineWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly rawValue: string,
    readonly lineFrom: number,
    readonly lineTo: number
  ) {
    super();
  }

  eq(other: EnvLineWidget): boolean {
    return (
      this.key === other.key &&
      this.rawValue === other.rawValue &&
      this.lineFrom === other.lineFrom &&
      this.lineTo === other.lineTo
    );
  }

  toDOM(): HTMLElement {
    const unquoted = stripQuotes(this.rawValue);
    const isEmpty = !unquoted;
    const secret = !isEmpty && isSecret(unquoted, this.key);
    const displayValue = isEmpty ? t('editor.env.empty_value') : secret ? maskSecret(unquoted) : unquoted;

    const span = document.createElement('span');
    span.className = 'cm-env-line';

    const keyEl = document.createElement('span');
    keyEl.className = 'cm-env-key';
    keyEl.textContent = this.key;

    const eqEl = document.createElement('span');
    eqEl.className = 'cm-env-eq';
    eqEl.textContent = '=';

    const valCls = isEmpty ? 'cm-env-value cm-env-value-empty' : secret ? 'cm-env-value cm-env-value-masked' : 'cm-env-value';
    const valEl = document.createElement('span');
    valEl.className = valCls;
    valEl.textContent = displayValue;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'cm-env-copy';
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

    span.appendChild(keyEl);
    span.appendChild(eqEl);
    span.appendChild(valEl);
    span.appendChild(copyBtn);

    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// --- Line parsing ---

const COMMENT_RE = /^(\s*)(#.*)$/;
const KV_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

// --- Decoration builder ---

function buildEnvDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc } = view.state;

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text;

    if (!text.trim()) continue;

    if (COMMENT_RE.test(text)) {
      builder.add(line.from, line.from, Decoration.line({ class: 'cm-env-comment' }));
      continue;
    }

    const kvMatch = KV_RE.exec(text);
    if (kvMatch) {
      // Skip decoration when cursor is on this line (allow editing)
      if (cursorInRange(view, line.from, line.to)) continue;

      const key = kvMatch[2];
      const rawValue = kvMatch[3];

      const widget = new EnvLineWidget(key, rawValue, line.from, line.to);
      builder.add(
        line.from,
        line.to,
        Decoration.replace({ widget })
      );
    }
  }

  return builder.finish();
}

// --- ViewPlugin ---

export const envPreviewPlugin: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      try {
        this.decorations = buildEnvDecorations(view);
      } catch (e) {
        console.warn('Env preview decoration error:', e);
        this.decorations = Decoration.none;
      }
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        try {
          this.decorations = buildEnvDecorations(update.view);
        } catch (e) {
          console.warn('Env preview decoration error:', e);
          this.decorations = Decoration.none;
        }
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);
