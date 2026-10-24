# Inline Arithmetic Ghost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the human types `338 * 1.3 =`, show `439.4` as grey ghost text after the caret; Tab writes it in, Esc hides it.

**Architecture:** Three pure modules (`evaluate` → `format` → `trigger`) under `src/lib/editor/math/`, and one CM6 extension (`ghost.ts`): a `StateField` that recomputes the candidate on every human edit, provides a widget decoration, and a `Prec.highest` Tab/Esc keymap that only acts while a ghost is shown. No `eval`, no new dependency, no Rust.

**Tech Stack:** TypeScript, CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@codemirror/commands`), Vitest (+ jsdom for the view test).

**Spec:** `docs/superpowers/specs/2026-10-24-math-ghost-design.md`

**Ground rules for every task**

- Work in `/Users/maximkovalevskij/playground/md-mini/.claude/worktrees/math-ghost`. Never `git stash`, `checkout`, `reset`. `git add` explicit paths only.
- Run tests with `npx vitest run <file>`; the full suite is `npx vitest run --dir src` (baseline: 152 files, 3254 tests, all green).
- Strict TypeScript, no `any`. Conventional commits, ending with the line
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Never run `npm run tauri dev` / `tauri build`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| Create `src/lib/editor/math/evaluate.ts` | Tokenizer + recursive-descent parser → `MathResult \| null`. Pure |
| Create `src/lib/editor/math/evaluate.test.ts` | Table tests for the grammar |
| Create `src/lib/editor/math/format.ts` | `formatResult(value, style)` → `string \| null`. Pure |
| Create `src/lib/editor/math/format.test.ts` | Rounding, style mirroring, refusals |
| Create `src/lib/editor/math/trigger.ts` | `findExpression(state, pos)` → `Candidate \| null`: the `expr =` rules on an `EditorState` |
| Create `src/lib/editor/math/trigger.test.ts` | Prefixes, code, tables, comparison operators |
| Create `src/lib/editor/math/ghost.ts` | `mathGhost()` extension: field, widget, keymap, blur |
| Create `src/lib/editor/math/ghost.test.ts` | jsdom `EditorView`: typing, Tab, Esc, undo, bring-back |
| Modify `src/lib/editor/setup.ts` | Add `mathGhost()` to `createExtensions` |
| Modify `src/styles/editor.css` | `.cm-math-ghost` style |
| Modify `CLAUDE.md` | Architecture line for `math/` |

---

### Task 1: The evaluator

**Files:**
- Create: `src/lib/editor/math/evaluate.ts`
- Test: `src/lib/editor/math/evaluate.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/editor/math/evaluate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { evaluate, MAX_EXPRESSION_LENGTH } from './evaluate';

function valueOf(expr: string): number | undefined {
  return evaluate(expr)?.value;
}

describe('evaluate', () => {
  it.each([
    ['338 * 1.3', 439.4],
    ['2 + 3 * 4', 14],
    ['(2 + 3) * 4', 20],
    ['10 / 4', 2.5],
    ['7 - 10', -3],
    ['-(3 + 4) * 2', -14],
    ['2^3^2', 512],
    ['-2^2', -4],
    ['2^-1', 0.5],
    ['3 - -2', 5],
    ['((1))+1', 2],
  ])('%s = %d', (expr, expected) => {
    expect(valueOf(expr)).toBeCloseTo(expected, 9);
  });

  it.each([
    ['1200 + 10%', 1320],
    ['1200 - 10%', 1080],
    ['338 * 15%', 50.7],
    ['50 / 10%', 500],
    ['15%', 0.15],
    ['100 + 10% + 10%', 121],
    ['100 + -10%', 90],
  ])('percent: %s = %d', (expr, expected) => {
    expect(valueOf(expr)).toBeCloseTo(expected, 9);
  });

  it.each([
    ['6 × 7', 42],
    ['6 · 7', 42],
    ['10 ÷ 4', 2.5],
    ['10 − 3', 7],
    ['10 – 3', 7],
  ])('unicode operator: %s = %d', (expr, expected) => {
    expect(valueOf(expr)).toBeCloseTo(expected, 9);
  });

  it('reads a decimal comma and records it', () => {
    const result = evaluate('1,5 * 2');
    expect(result?.value).toBe(3);
    expect(result?.style).toEqual({ decimalComma: true, thousandsSpace: false });
  });

  it('a comma is always decimal: 1,000 is one', () => {
    expect(valueOf('1,000 + 1')).toBe(2);
  });

  it('reads thousands spaces and records them', () => {
    const result = evaluate('1 500 000 / 12');
    expect(result?.value).toBe(125000);
    expect(result?.style).toEqual({ decimalComma: false, thousandsSpace: true });
  });

  it('a space is a separator only before exactly three digits', () => {
    expect(evaluate('15 + 2')?.style.thousandsSpace).toBe(false);
    expect(valueOf('15 + 2')).toBe(17);
    expect(evaluate('1 5000 + 1')).toBeNull();
    expect(evaluate('12 34 + 1')).toBeNull();
  });

  it('mixes thousands spaces and a decimal comma', () => {
    const result = evaluate('1 500,5 * 2');
    expect(result?.value).toBe(3001);
    expect(result?.style).toEqual({ decimalComma: true, thousandsSpace: true });
  });

  it('plain input has a plain style', () => {
    expect(evaluate('2 + 2')?.style).toEqual({ decimalComma: false, thousandsSpace: false });
  });

  it('returns Infinity for division by zero (formatting refuses it)', () => {
    expect(valueOf('1 / 0')).toBe(Infinity);
  });

  it.each([
    [''],
    ['   '],
    ['abc'],
    ['2 + x'],
    ['2 +'],
    ['(2 + 3'],
    ['2 + 3)'],
    ['2 3'],
    ['5'],
    ['-5'],
    ['(5)'],
    ['2 ** 3'],
    ['1e5 + 1'],
    ['.5 + 1'],
    ['5. + 1'],
    ['2 + 3 = 5'],
    ['%'],
    ['2 %% 3'],
  ])('rejects %j', (expr) => {
    expect(evaluate(expr)).toBeNull();
  });

  it('rejects input longer than the limit', () => {
    const long = '1+'.repeat(100) + '1';
    expect(long.length).toBeGreaterThan(MAX_EXPRESSION_LENGTH);
    expect(evaluate(long)).toBeNull();
  });

  it('rejects nesting deeper than the limit, accepts shallow nesting', () => {
    expect(evaluate('('.repeat(40) + '1' + ')'.repeat(40) + '+1')).toBeNull();
    expect(evaluate('-'.repeat(40) + '1+1')).toBeNull();
    expect(valueOf('('.repeat(10) + '1' + ')'.repeat(10) + '+1')).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/editor/math/evaluate.test.ts`
Expected: FAIL — `Failed to resolve import "./evaluate"`.

- [ ] **Step 3: Write the implementation**

`src/lib/editor/math/evaluate.ts`:

```ts
/**
 * Arithmetic for the ghost answer after `=` (see `ghost.ts`). A parser, never
 * an evaluator: the tokenizer accepts digits, `+ - * / ^ % ( )`, their Unicode
 * synonyms and spaces, and anything else means "not an expression". No `eval`,
 * no `Function`, no dependency.
 *
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/') unary)*
 *   unary   := '-' unary | power
 *   power   := postfix ('^' unary)?      right-associative; -2^2 = -4
 *   postfix := primary '%'?
 *   primary := number | '(' expr ')'
 */

/** How the input wrote its numbers — the answer is written the same way. */
export interface NumberStyle {
  decimalComma: boolean;
  thousandsSpace: boolean;
}

export interface MathResult {
  value: number;
  style: NumberStyle;
}

export const MAX_EXPRESSION_LENGTH = 200;
export const MAX_DEPTH = 32;

type Op = '+' | '-' | '*' | '/' | '^' | '%' | '(' | ')';
type Token = { kind: 'num'; value: number } | { kind: 'op'; op: Op };

const OPERATORS = '+-*/^%()';
const SYNONYMS: Readonly<Record<string, string>> = {
  '×': '*',
  '·': '*',
  '÷': '/',
  '−': '-',
  '–': '-',
};

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

/**
 * A number from `start`: digits, then groups of " ddd" (a space followed by
 * exactly three digits and no fourth), then an optional `.`/`,` fraction.
 */
function readNumber(
  src: string,
  start: number,
  style: NumberStyle
): { value: number; end: number } {
  let i = start;
  let digits = '';
  while (isDigit(src[i])) digits += src[i++];
  while (
    src[i] === ' ' &&
    isDigit(src[i + 1]) &&
    isDigit(src[i + 2]) &&
    isDigit(src[i + 3]) &&
    !isDigit(src[i + 4])
  ) {
    digits += src.slice(i + 1, i + 4);
    style.thousandsSpace = true;
    i += 4;
  }
  if ((src[i] === '.' || src[i] === ',') && isDigit(src[i + 1])) {
    if (src[i] === ',') style.decimalComma = true;
    i++;
    let fraction = '';
    while (isDigit(src[i])) fraction += src[i++];
    digits += '.' + fraction;
  }
  return { value: Number(digits), end: i };
}

function tokenize(src: string, style: NumberStyle): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = SYNONYMS[src[i]] ?? src[i];
    if (ch === ' ') {
      i++;
    } else if (OPERATORS.includes(ch)) {
      tokens.push({ kind: 'op', op: ch as Op });
      i++;
    } else if (isDigit(ch)) {
      const read = readNumber(src, i, style);
      tokens.push({ kind: 'num', value: read.value });
      i = read.end;
    } else {
      return null;
    }
  }
  return tokens;
}

/** A parsed operand; `percent` = it was written `b%` (its value is already b/100). */
interface Operand {
  value: number;
  percent: boolean;
}

class ParseError extends Error {}

class Parser {
  private pos = 0;
  private depth = 0;
  /** A binary operator or `%` was seen — `5 =` and `-5 =` are not questions. */
  sawOperator = false;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): number {
    const result = this.expr();
    if (this.pos !== this.tokens.length) throw new ParseError('trailing tokens');
    return result.value;
  }

  private peek(): Op | null {
    const token = this.tokens[this.pos];
    return token?.kind === 'op' ? token.op : null;
  }

  private enter(): void {
    if (++this.depth > MAX_DEPTH) throw new ParseError('too deep');
  }

  private expr(): Operand {
    let left = this.term();
    for (let op = this.peek(); op === '+' || op === '-'; op = this.peek()) {
      this.pos++;
      this.sawOperator = true;
      const right = this.term();
      // Calculator percent: `a + b%` adds b percent of a.
      const delta = right.percent ? left.value * right.value : right.value;
      left = { value: op === '+' ? left.value + delta : left.value - delta, percent: false };
    }
    return left;
  }

  private term(): Operand {
    let left = this.unary();
    for (let op = this.peek(); op === '*' || op === '/'; op = this.peek()) {
      this.pos++;
      this.sawOperator = true;
      const right = this.unary();
      left = { value: op === '*' ? left.value * right.value : left.value / right.value, percent: false };
    }
    return left;
  }

  private unary(): Operand {
    this.enter();
    try {
      if (this.peek() === '-') {
        this.pos++;
        const inner = this.unary();
        return { value: -inner.value, percent: inner.percent };
      }
      return this.power();
    } finally {
      this.depth--;
    }
  }

  private power(): Operand {
    const base = this.postfix();
    if (this.peek() !== '^') return base;
    this.pos++;
    this.sawOperator = true;
    const exponent = this.unary();
    return { value: Math.pow(base.value, exponent.value), percent: false };
  }

  private postfix(): Operand {
    const value = this.primary();
    if (this.peek() !== '%') return { value, percent: false };
    this.pos++;
    this.sawOperator = true;
    return { value: value / 100, percent: true };
  }

  private primary(): number {
    const token = this.tokens[this.pos];
    if (token?.kind === 'num') {
      this.pos++;
      return token.value;
    }
    if (token?.kind === 'op' && token.op === '(') {
      this.pos++;
      this.enter();
      const inner = this.expr();
      this.depth--;
      if (this.peek() !== ')') throw new ParseError('unbalanced');
      this.pos++;
      return inner.value;
    }
    throw new ParseError('operand expected');
  }
}

/**
 * The value of `expr`, or `null` when it is not an arithmetic expression with
 * at least one operator. Never throws. `value` may be ±Infinity or NaN —
 * `formatResult` refuses those.
 */
export function evaluate(expr: string): MathResult | null {
  if (expr.length > MAX_EXPRESSION_LENGTH) return null;
  const style: NumberStyle = { decimalComma: false, thousandsSpace: false };
  const tokens = tokenize(expr, style);
  if (!tokens || tokens.length === 0) return null;
  const parser = new Parser(tokens);
  try {
    const value = parser.parse();
    return parser.sawOperator ? { value, style } : null;
  } catch (error) {
    if (error instanceof ParseError) return null;
    throw error;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/editor/math/evaluate.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/editor/math/evaluate.ts src/lib/editor/math/evaluate.test.ts
git commit -m "feat(math): safe arithmetic evaluator for the ghost answer"
```

---

### Task 2: Formatting the answer

**Files:**
- Create: `src/lib/editor/math/format.ts`
- Test: `src/lib/editor/math/format.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/editor/math/format.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatResult } from './format';
import type { NumberStyle } from './evaluate';

const PLAIN: NumberStyle = { decimalComma: false, thousandsSpace: false };
const COMMA: NumberStyle = { decimalComma: true, thousandsSpace: false };
const SPACES: NumberStyle = { decimalComma: false, thousandsSpace: true };
const BOTH: NumberStyle = { decimalComma: true, thousandsSpace: true };

describe('formatResult', () => {
  it.each([
    [439.40000000000003, '439.4'],
    [0.1 + 0.2, '0.3'],
    [10 / 3, '3.333333333'],
    [42, '42'],
    [-3.5, '-3.5'],
    [-0, '0'],
    [0, '0'],
    [123456789012, '123456789000'],
    [0.0001, '0.0001'],
    [1e-7, '0.0000001'],
    [1e-10, '0.0000000001'],
    [2.5e-10, '0.00000000025'],
  ])('%d → %s', (value, expected) => {
    expect(formatResult(value, PLAIN)).toBe(expected);
  });

  it.each([
    [Infinity],
    [-Infinity],
    [NaN],
    [1e15],
    [-1e15],
    [999999999999999],
    [1e-11],
  ])('refuses %d', (value) => {
    expect(formatResult(value, PLAIN)).toBeNull();
  });

  it('mirrors a decimal comma', () => {
    expect(formatResult(1.5, COMMA)).toBe('1,5');
  });

  it('mirrors thousands spaces', () => {
    expect(formatResult(125000, SPACES)).toBe('125 000');
    expect(formatResult(999, SPACES)).toBe('999');
    expect(formatResult(1234567.25, SPACES)).toBe('1 234 567.25');
  });

  it('mirrors both', () => {
    expect(formatResult(3001, BOTH)).toBe('3 001');
    expect(formatResult(-1234.5, BOTH)).toBe('-1 234,5');
  });

  it('never groups the fraction', () => {
    expect(formatResult(0.123456, SPACES)).toBe('0.123456');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/editor/math/format.test.ts`
Expected: FAIL — `Failed to resolve import "./format"`.

- [ ] **Step 3: Write the implementation**

`src/lib/editor/math/format.ts`:

```ts
import type { NumberStyle } from './evaluate';

/** Significant digits kept: enough for money, few enough to hide float noise. */
export const SIGNIFICANT_DIGITS = 10;
/** At or above this the answer would need an exponent — none is shown. */
export const MAX_ABS = 1e15;
/** Below this (and not zero) the answer would need an exponent — none is shown. */
export const MIN_ABS = 1e-10;

/**
 * The answer as the human would have written it: rounded to
 * `SIGNIFICANT_DIGITS`, no trailing zeros, the input's decimal separator and
 * thousands spaces. `null` when there is nothing honest to show — ±∞ (division
 * by zero), NaN, or a magnitude that would need exponent notation.
 */
export function formatResult(value: number, style: NumberStyle): string | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Number(value.toPrecision(SIGNIFICANT_DIGITS));
  if (rounded === 0) return '0';
  const abs = Math.abs(rounded);
  if (abs >= MAX_ABS || abs < MIN_ABS) return null;

  const magnitude = Math.floor(Math.log10(abs));
  const decimals = Math.min(20, Math.max(0, SIGNIFICANT_DIGITS - 1 - magnitude));
  let text = abs.toFixed(decimals);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');

  const dot = text.indexOf('.');
  let integer = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? '' : text.slice(dot + 1);
  if (style.thousandsSpace) integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const separator = style.decimalComma ? ',' : '.';
  const sign = rounded < 0 ? '-' : '';
  return sign + integer + (fraction ? separator + fraction : '');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/editor/math/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/editor/math/format.ts src/lib/editor/math/format.test.ts
git commit -m "feat(math): format the answer in the input's number style"
```

---

### Task 3: The trigger — is there an `expr =` at the caret

**Files:**
- Create: `src/lib/editor/math/trigger.ts`
- Test: `src/lib/editor/math/trigger.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/editor/math/trigger.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdownExtension } from '../markdown-language';
import { findExpression } from './trigger';

/** `|` marks the caret; it is removed from the document. */
function at(docWithCaret: string) {
  const pos = docWithCaret.indexOf('|');
  const doc = docWithCaret.slice(0, pos) + docWithCaret.slice(pos + 1);
  const state = EditorState.create({ doc, extensions: [markdownExtension()] });
  return findExpression(state, pos);
}

describe('findExpression', () => {
  it('finds the expression right before `=` at the caret', () => {
    expect(at('338 * 1.3 =|')).toEqual({ eq: 11, pos: 11, answer: '439.4' });
  });

  it('allows spaces between `=` and the caret', () => {
    expect(at('338 * 1.3 = |')).toEqual({ eq: 11, pos: 12, answer: '439.4' });
    expect(at('338 * 1.3 =   |')).toEqual({ eq: 11, pos: 14, answer: '439.4' });
  });

  it('takes the expression out of a sentence', () => {
    expect(at('Итого: 338 * 1.3 =|')?.answer).toBe('439.4');
  });

  it('works on any line, not just the first', () => {
    expect(at('# Расчёт\n\nцена 1 200 * 3 =|')?.answer).toBe('3 600');
  });

  it.each([
    ['- 5 + 3 =|'],
    ['* 5 + 3 =|'],
    ['+ 5 + 3 =|'],
    ['1. 5 + 3 =|'],
    ['1) 5 + 3 =|'],
    ['- [ ] 5 + 3 =|'],
    ['- [x] 5 + 3 =|'],
    ['> 5 + 3 =|'],
    ['> > - 5 + 3 =|'],
    ['## 5 + 3 =|'],
    ['- a\n  - 5 + 3 =|'],
  ])('cuts the block prefix off %j', (doc) => {
    expect(at(doc)?.answer).toBe('8');
  });

  it('a minus without a following space is a sign, not a list', () => {
    expect(at('-5 + 3 =|')?.answer).toBe('-2');
  });

  it('shrinks from the left until the rest parses', () => {
    expect(at('шаг 2) (3+4) =|')?.answer).toBe('7');
  });

  it('mirrors the input style', () => {
    expect(at('1 500,5 * 2 =|')?.answer).toBe('3 001');
    expect(at('1,5 * 3 =|')?.answer).toBe('4,5');
  });

  it.each([
    ['2024 =|', 'no operator'],
    ['-5 =|', 'only a sign'],
    ['5 + 3 ==|', '`==`'],
    ['5 >=|', '`>=`'],
    ['5 <=|', '`<=`'],
    ['5 !=|', '`!=`'],
    ['5 + 3 =| x', 'text right of the caret'],
    ['5 + 3 = 8|', 'already answered'],
    ['5 + 3|', 'no `=`'],
    ['1 / 0 =|', 'division by zero'],
    ['hello =|', 'no expression'],
    ['```\n5 + 3 =|\n```', 'fenced code'],
    ['```\n5 + 3 =|', 'unclosed fence'],
    ['    5 + 3 =|', 'indented code'],
    ['`5 + 3 =|`', 'inline code'],
    ['| a | b |\n|---|---|\n| 1 | 5 + 3 =|', 'table row'],
  ])('nothing for %j (%s)', (doc) => {
    expect(at(doc)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/editor/math/trigger.test.ts`
Expected: FAIL — `Failed to resolve import "./trigger"`.

- [ ] **Step 3: Write the implementation**

`src/lib/editor/math/trigger.ts`:

```ts
import type { EditorState } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { evaluate, MAX_EXPRESSION_LENGTH } from './evaluate';
import { formatResult } from './format';

/** An answer to offer: what Tab replaces (`eq`..`pos`) and with what. */
export interface Candidate {
  /** Right after the `=`. */
  eq: number;
  /** The caret, after any spaces typed past the `=`. */
  pos: number;
  /** The formatted answer, without a leading space. */
  answer: string;
}

/** `expr =` with only spaces after it; group 1 is everything before the last `=`. */
const ENDS_WITH_EQUALS = /^([\s\S]*)=( *)$/;
/** `a == b`, `x >= 3`, `x <= 3`, `a != b` are statements, not questions. */
const COMPARISON_BEFORE = /[=<>!]$/;
/**
 * Indentation, quote markers, then a heading or a list marker (with an
 * optional task box). Without this, `- 5 + 3 =` reads as minus five.
 * `-5` (no space) stays a sign, as markdown itself reads it.
 */
const BLOCK_PREFIX =
  /^[ \t]*(?:>[ \t]?)*[ \t]*(?:#{1,6}[ \t]+|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/;
/** Characters an expression may contain — the scan back stops at the first other one. */
const EXPRESSION_CHAR = /[0-9 .,+\-*/^%()×·÷−–]/;
/** Syntax nodes inside which `=` is never a question. */
const EXCLUDED_NODES = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'Table']);
/** Parse budget for the caret's line, ms — a typing-time call. */
const PARSE_BUDGET_MS = 50;

function insideExcludedNode(state: EditorState, pos: number, lineTo: number): boolean {
  const tree = ensureSyntaxTree(state, lineTo, PARSE_BUDGET_MS) ?? syntaxTree(state);
  // Side 1: the node that holds the `=` character itself (`pos` is its start).
  for (let node: SyntaxNode | null = tree.resolveInner(pos, 1); node; node = node.parent) {
    if (EXCLUDED_NODES.has(node.name)) return true;
  }
  return false;
}

/**
 * The longest suffix of `text` made of expression characters that evaluates,
 * shrunk from the left until it does (`шаг 2) (3+4)` → `(3+4)`).
 */
function longestExpression(text: string) {
  let start = text.length;
  while (start > 0 && EXPRESSION_CHAR.test(text[start - 1])) start--;
  start = Math.max(start, text.length - MAX_EXPRESSION_LENGTH);
  for (let from = start; from < text.length; from++) {
    if (text[from] === ' ') continue;
    const result = evaluate(text.slice(from).trim());
    if (result) return result;
  }
  return null;
}

/**
 * Is there a question `expr =` ending at `pos` (spaces after `=` allowed),
 * with nothing to its right on the line, outside code and tables? The rules
 * are the spec's "When the ghost appears", 1–6.
 */
export function findExpression(state: EditorState, pos: number): Candidate | null {
  const line = state.doc.lineAt(pos);
  if (line.text.slice(pos - line.from).trim() !== '') return null;

  const match = ENDS_WITH_EQUALS.exec(line.text.slice(0, pos - line.from));
  if (!match) return null;
  const head = match[1];
  if (COMPARISON_BEFORE.test(head)) return null;

  const eq = line.from + head.length + 1;
  if (insideExcludedNode(state, eq - 1, line.to)) return null;

  const result = longestExpression(head.replace(BLOCK_PREFIX, ''));
  if (!result) return null;
  const answer = formatResult(result.value, result.style);
  return answer === null ? null : { eq, pos, answer };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/editor/math/trigger.test.ts`
Expected: PASS. If `table row` or `indented code` fails, print the tree for that doc
(`syntaxTree(state).toString()`) and adjust `EXCLUDED_NODES` to the node name Lezer actually
produces — do not weaken the test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/editor/math/trigger.ts src/lib/editor/math/trigger.test.ts
git commit -m "feat(math): find an expr = at the caret outside code and tables"
```

---

### Task 4: The ghost extension

**Files:**
- Create: `src/lib/editor/math/ghost.ts`
- Test: `src/lib/editor/math/ghost.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/editor/math/ghost.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { markdownExtension } from '../markdown-language';
import { setAiHighlights } from '../ai-highlight';
import { mathGhost, mathGhostField } from './ghost';

let fellThrough = 0;

function makeView(doc: string): EditorView {
  fellThrough = 0;
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        markdownExtension(),
        history(),
        mathGhost(),
        // Stands in for list indent etc.: what Tab does when no ghost is shown.
        keymap.of([{ key: 'Tab', run: () => (fellThrough++, true) }]),
      ],
    }),
  });
}

/** A human keystroke at the caret. */
function type(view: EditorView, text: string): void {
  const at = view.state.selection.main.head;
  view.dispatch({
    changes: { from: at, insert: text },
    selection: { anchor: at + text.length },
    userEvent: 'input.type',
  });
}

function press(view: EditorView, key: string): boolean {
  return runScopeHandlers(view, new KeyboardEvent('keydown', { key }), 'editor');
}

function ghost(view: EditorView) {
  return view.state.field(mathGhostField);
}

function ghostText(view: EditorView): string | null {
  return view.contentDOM.querySelector('.cm-math-ghost')?.textContent ?? null;
}

describe('math ghost', () => {
  it('typing `=` after an expression offers the answer', () => {
    const view = makeView('338 * 1.3 ');
    type(view, '=');
    expect(ghost(view)?.answer).toBe('439.4');
    expect(ghostText(view)).toBe(' 439.4');
  });

  it('after spaces the ghost carries no leading space', () => {
    const view = makeView('338 * 1.3 =');
    type(view, ' ');
    expect(ghostText(view)).toBe('439.4');
  });

  it('moving the caret without an edit hides it', () => {
    const view = makeView('338 * 1.3 ');
    type(view, '=');
    view.dispatch({ selection: { anchor: 0 } });
    expect(ghost(view)).toBeNull();
    expect(ghostText(view)).toBeNull();
  });

  it('Tab writes the answer with one space and is one undo step', () => {
    const view = makeView('338 * 1.3 ');
    type(view, '=');
    expect(press(view, 'Tab')).toBe(true);
    expect(view.state.doc.toString()).toBe('338 * 1.3 = 439.4');
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    expect(ghost(view)).toBeNull();
    expect(fellThrough).toBe(0);

    undo(view);
    expect(view.state.doc.toString()).toBe('338 * 1.3 =');
  });

  it('Tab collapses the spaces typed after `=`', () => {
    const view = makeView('338 * 1.3 =  ');
    type(view, ' ');
    press(view, 'Tab');
    expect(view.state.doc.toString()).toBe('338 * 1.3 = 439.4');
  });

  it('Tab without a ghost falls through to the next handler', () => {
    const view = makeView('hello');
    type(view, '!');
    press(view, 'Tab');
    expect(fellThrough).toBe(1);
    expect(view.state.doc.toString()).toBe('hello!');
  });

  it('Esc hides the ghost; without one Esc is not taken', () => {
    const view = makeView('338 * 1.3 ');
    type(view, '=');
    expect(press(view, 'Escape')).toBe(true);
    expect(ghost(view)).toBeNull();
    expect(press(view, 'Escape')).toBe(false);
  });

  it('after Esc, a space brings it back', () => {
    const view = makeView('338 * 1.3 ');
    type(view, '=');
    press(view, 'Escape');
    type(view, ' ');
    expect(ghost(view)?.answer).toBe('439.4');
  });

  it('after Esc, deleting `=` and typing it again brings it back', () => {
    const view = makeView('338 * 1.3 ');
    type(view, '=');
    press(view, 'Escape');
    const end = view.state.doc.length;
    view.dispatch({
      changes: { from: end - 1, to: end },
      selection: { anchor: end - 1 },
      userEvent: 'delete.backward',
    });
    expect(ghost(view)).toBeNull();
    type(view, '=');
    expect(ghost(view)?.answer).toBe('439.4');
  });

  it('works on an old line: caret at its end, then a space', () => {
    const view = makeView('338 * 1.3 =\nдальше текст');
    view.dispatch({ selection: { anchor: 11 } });
    type(view, ' ');
    expect(ghost(view)?.answer).toBe('439.4');
  });

  it('an agent edit never offers an answer', () => {
    const view = makeView('338 * 1.3 ');
    view.dispatch({
      changes: { from: 10, insert: '=' },
      selection: { anchor: 11 },
      effects: setAiHighlights.of([{ from: 10, to: 11 }]),
    });
    expect(ghost(view)).toBeNull();
  });

  it('a reload from disk never offers an answer', () => {
    const view = makeView('338 * 1.3 ');
    view.dispatch({
      changes: { from: 10, insert: '=' },
      selection: { anchor: 11 },
      annotations: Transaction.addToHistory.of(false),
    });
    expect(ghost(view)).toBeNull();
  });

  it('an IME composition step never offers an answer', () => {
    const view = makeView('338 * 1.3 ');
    view.dispatch({
      changes: { from: 10, insert: '=' },
      selection: { anchor: 11 },
      userEvent: 'input.type.compose',
    });
    expect(ghost(view)).toBeNull();
  });

  it('a non-empty selection never offers an answer', () => {
    const view = makeView('338 * 1.3 ');
    view.dispatch({
      changes: { from: 10, insert: '=' },
      selection: { anchor: 0, head: 11 },
      userEvent: 'input.type',
    });
    expect(ghost(view)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/editor/math/ghost.test.ts`
Expected: FAIL — `Failed to resolve import "./ghost"`.

- [ ] **Step 3: Write the implementation**

`src/lib/editor/math/ghost.ts`:

```ts
import { Prec, StateEffect, StateField, isolateHistory, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, type Command } from '@codemirror/view';
import { isHumanEdit } from '../human-edit';
import { findExpression, type Candidate } from './trigger';

/**
 * The answer offered after `338 * 1.3 =`: grey text at the caret, Tab writes
 * it in, Esc hides it (spec 2026-10-24-math-ghost-design.md).
 *
 * Recomputed on every human edit and only then — an agent's text, a reload, a
 * caret move or a composition step never shows one. Esc hides it until the
 * next human edit, so a space after `=` (or retyping `=`) brings it back.
 */

const setMathGhost = StateEffect.define<Candidate | null>();

export const mathGhostField = StateField.define<Candidate | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setMathGhost)) return effect.value;
    if (isHumanEdit({ docChanged: tr.docChanged, transactions: [tr] })) {
      if (tr.isUserEvent('input.type.compose')) return null;
      const { ranges, main } = tr.state.selection;
      if (ranges.length !== 1 || !main.empty) return null;
      return findExpression(tr.state, main.head);
    }
    return tr.docChanged || tr.selection ? null : value;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (ghost) =>
      ghost
        ? Decoration.set([
            Decoration.widget({ widget: new GhostWidget(ghostText(ghost)), side: 1 }).range(ghost.pos),
          ])
        : Decoration.none
    ),
});

/** What the ghost shows: a space when the human typed none after `=`. */
function ghostText(ghost: Candidate): string {
  return (ghost.pos === ghost.eq ? ' ' : '') + ghost.answer;
}

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-math-ghost';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = this.text;
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** Tab: `=` plus whatever spaces followed it becomes `= <answer>`. Its own undo step. */
export const acceptMathGhost: Command = (view) => {
  const ghost = view.state.field(mathGhostField, false);
  if (!ghost) return false;
  const insert = ' ' + ghost.answer;
  view.dispatch({
    changes: { from: ghost.eq, to: ghost.pos, insert },
    selection: { anchor: ghost.eq + insert.length },
    effects: setMathGhost.of(null),
    annotations: isolateHistory.of('full'),
    userEvent: 'input.complete',
    scrollIntoView: true,
  });
  return true;
};

/** Esc: hide the ghost. Not taken when there is none (AI highlights, search keep Esc). */
export const dismissMathGhost: Command = (view) => {
  if (!view.state.field(mathGhostField, false)) return false;
  view.dispatch({ effects: setMathGhost.of(null) });
  return true;
};

export function mathGhost(): Extension {
  return [
    mathGhostField,
    // Prec.highest so Tab is ours before list indent — but only while a ghost
    // is shown; the commands return false otherwise and Tab falls through.
    Prec.highest(
      keymap.of([
        { key: 'Tab', run: acceptMathGhost },
        { key: 'Escape', run: dismissMathGhost },
      ])
    ),
    EditorView.focusChangeEffect.of((state, focusing) =>
      !focusing && state.field(mathGhostField, false) ? setMathGhost.of(null) : null
    ),
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/editor/math/ghost.test.ts`
Expected: PASS. Note the undo test: `isolateHistory.of('full')` makes the accept its own
step, so one `undo` returns exactly `338 * 1.3 =`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/editor/math/ghost.ts src/lib/editor/math/ghost.test.ts
git commit -m "feat(math): ghost answer after = with Tab to accept, Esc to hide"
```

---

### Task 5: Wire it into the editor, style, docs

**Files:**
- Modify: `src/lib/editor/setup.ts` (imports; `createExtensions` list, after `jsonFormatKeymap`)
- Modify: `src/styles/editor.css` (append after the `.cm-ai-edit` rules)
- Modify: `CLAUDE.md` (Architecture tree, under `lib/editor/`)

- [ ] **Step 1: Add the extension**

In `src/lib/editor/setup.ts`, add the import next to the other editor imports:

```ts
import { mathGhost } from './math/ghost';
```

and in `createExtensions`, right after `jsonFormatKeymap,`:

```ts
    jsonFormatKeymap,
    // `338 * 1.3 =` → grey `439.4` at the caret, Tab writes it (math/ghost.ts).
    mathGhost(),
```

- [ ] **Step 2: Add the style**

Append to `src/styles/editor.css`:

```css
/* Inline arithmetic: the answer offered after `=` (editor/math/ghost.ts).
   An existing token, so every theme already has it. */
.cm-math-ghost {
  color: var(--text-muted);
  pointer-events: none;
  user-select: none;
}
```

- [ ] **Step 3: Document the module**

In `CLAUDE.md`, in the Architecture tree, after the `human-edit.ts` line under `lib/editor/`, add:

```
    math/               # `338 * 1.3 =` → ghost `439.4`, Tab writes it: evaluate.ts (parser, no eval), format.ts (input's number style), trigger.ts (expr = at the caret, not in code/tables), ghost.ts (field + widget + Tab/Esc)
```

- [ ] **Step 4: Run all checks**

Run: `npx vitest run --dir src`
Expected: all green, 152 + 4 = 156 files.

Run: `npm run check`
Expected: 0 errors.

- [ ] **Step 5: Visual check in the browser**

Run `npm run dev` (port 1420; never alongside `dev:site`). In Chrome at http://localhost:1420
set a theme first (`document.documentElement.dataset.theme = 'light'` — the browser dev has no
theme engine), then in the editor:

1. Type `338 * 1.3 =` → grey ` 439.4` after the caret; Tab → `338 * 1.3 = 439.4`.
2. Type `- 1 200 * 3 =` → `3 600`; Esc hides; Space brings it back.
3. Inside a ```` ``` ```` fence: `5 + 3 =` → nothing.
4. `- [ ] ` list line, then Tab with no ghost → the list still indents.
5. Switch the preview engine to live-render (if reachable in the browser) and repeat 1;
   the caret must stay after the ghost, not jump.
6. Dark theme (`dataset.theme = 'dark'`): the ghost is readable but clearly secondary.

Take one screenshot of step 1 for the report.

- [ ] **Step 6: Commit**

```bash
git add src/lib/editor/setup.ts src/styles/editor.css CLAUDE.md
git commit -m "feat(math): enable the ghost answer in the editor"
```

---

## Self-review notes

- Spec rule 3 mentions `ensureSyntaxTree` for the caret's line → `insideExcludedNode` uses
  `ensureSyntaxTree(state, lineTo, 50)` with a `syntaxTree` fallback.
- Spec "Formatting": added `MIN_ABS = 1e-10` — below it the answer would need an exponent,
  same reason as `MAX_ABS`; the spec is updated to match.
- Blur clearing is covered by `focusChangeEffect`; not unit-tested (jsdom focus is unreliable),
  verified in step 5.
