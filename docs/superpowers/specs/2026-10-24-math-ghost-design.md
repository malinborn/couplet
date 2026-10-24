# Inline arithmetic: a ghost answer after `=`

## Goal

The human types `338 * 1.3 =` and sees `439.4` in grey right after the caret.
Tab writes it into the document; anything else leaves the text as typed. Like
Math Notes in Apple Notes — never in the way of typing.

## Principle: a parser, never an evaluator

No `eval`, no `Function`, no dependency. A tokenizer plus a recursive-descent
parser accept exactly numbers, the operators below and parentheses; any other
character means "not an expression" and there is no answer. A pure function,
tested as a table of input → output.

Rejected alternatives:

- **`mathjs` / `expr-eval`.** ~600 KB for five operators (mathjs); expr-eval
  has had prototype-pollution CVEs. Too much surface for the job.
- **Evaluate in Rust over IPC.** Latency on every keystroke, nothing gained.
- **Completion popup (CM6 autocomplete).** Enter conflicts with a new line, and
  a popup is louder than the feature deserves (owner chose the ghost).
- **Always-visible result widget (Soulver).** The answer would never reach the
  file and is invisible outside couplet.

## Scope decisions (agreed)

| Question | Decision |
|----------|----------|
| Presentation | Ghost text after the caret, Tab accepts |
| Decimal comma | Yes: `1,5 * 2 =` → `3`. A comma is **always** decimal — `1,000` is 1 |
| Thousands | Space only: `1 500 000 / 12 =` → `125 000` |
| Percent | Calculator semantics (below) |
| Power, `×` `÷` | Yes |
| Settings toggle | None for now; Esc hides an answer |
| Bring back a dismissed answer | Any human edit re-evaluates: type a space after `=`, or delete `=` and type it again |

## Modules

| File | Purpose |
|------|---------|
| `src/lib/editor/math/evaluate.ts` | `evaluate(expr: string): MathResult \| null` — tokenizer, parser, value. Pure |
| `src/lib/editor/math/format.ts` | `formatResult(value, style): string \| null` — rounding and the input's number style. Pure |
| `src/lib/editor/math/trigger.ts` | `findExpression(state, pos): Candidate \| null` — is there an `expr =` ending at the caret, and where does the expression start. Pure over `EditorState` |
| `src/lib/editor/math/ghost.ts` | `mathGhost()` extension: `StateField` holding the current answer, the widget decoration, the Tab/Esc keymap, the update listener |

`setup.ts` adds `mathGhost()` to the extension list. No Svelte, no stores, no
Rust.

## Grammar and semantics

```
expr    := term (('+' | '-') term)*
term    := unary (('*' | '/') unary)*
unary   := '-' unary | power
power   := postfix ('^' unary)?          -- right-associative; -2^2 = -4
postfix := primary '%'?
primary := number | '(' expr ')'
number  := digits ((' ' digits{3})*) ([.,] digits)?
```

- Synonyms, normalised by the tokenizer: `×` `·` → `*`; `÷` → `/`;
  `−` (U+2212) `–` (U+2013) → `-`.
- Whitespace between tokens is ignored. Inside a number a single space is a
  thousands separator only when followed by exactly three digits that are not
  followed by a fourth (`1 500` is 1500; `15 + 2` stays two numbers).
- Percent (calculator rules):
  - `a + b%` = a·(1 + b/100), `a - b%` = a·(1 − b/100) — when the right
    operand of `+`/`-` is a `%` postfix;
  - `a * b%` = a·b/100, `a / b%` = a / (b/100) — `%` is just ÷100;
  - a lone `b%` = b/100.
- An expression must contain at least one binary operator or `%`: `2024 =`
  gives nothing.
- Implementation limits: input length ≤ 200 characters, nesting depth ≤ 32.
  Past either → `null` (no answer), never an exception.

`MathResult` = `{ value: number, style: { decimalComma: boolean, thousandsSpace: boolean } }`,
where the style records how the **input** wrote its numbers.

## Formatting the answer

- `null` (no answer) for `NaN`, `±Infinity` (division by zero), |x| ≥ 1e15
  and 0 < |x| < 1e-10: no exponent notation is ever shown.
- Round to 10 significant digits (`toPrecision(10)`), then drop trailing zeros
  and a trailing separator: `0.1 + 0.2 =` → `0.3`, `10 / 3 =` → `3.333333333`.
  `-0` prints as `0`.
- Mirror the input: decimal comma if any input number used one; thousands
  spaces (groups of three in the integer part) if any input number used them.
  `1 500,5 * 2 =` → `3 001`.

## When the ghost appears

Evaluated on every update where `isHumanEdit(update)` is true (keys, paste,
undo/redo — not an agent's edit, not a reload) and the selection is a single
empty cursor, not during IME composition. The answer shows only if **all** hold:

1. The text of the caret's line **right of the caret** is empty or whitespace.
2. The text **left of the caret** ends with `=` followed by zero or more
   spaces, and the character before that `=` is not `=`, `<`, `>`, `!`
   (`a == b`, `x >= 3` are not questions).
3. The caret is not inside `FencedCode`, `CodeBlock`, `InlineCode`, a table
   (`Table`) — checked on the syntax tree (`ensureSyntaxTree`
   for the caret's line).
4. The block prefix of the line is cut off first: indentation, `#…# `, `> `
   (repeated), list markers `- ` `* ` `+ ` `1. ` `1) `, and a task box
   `[ ] ` / `[x] `. Otherwise `- 5 + 3 =` would read as minus five.
5. The expression is the **longest suffix** of the remaining text before `=`
   made of allowed characters (digits, space, `.,+-*/^%()×·÷−–`), trimmed,
   that `evaluate` accepts. In `Итого: 338 * 1.3 =` it is `338 * 1.3`.
   Scanning stops at the first disallowed character, then shrinks from the left
   until it parses (so `шаг 2) (3+4) =` still finds `(3+4)`).
6. `formatResult` returns a string.

Any other update clears the ghost: a selection change without an edit, Esc, a
blur, a human edit after which the rules above no longer hold. An update that
is not a human edit (agent, reload) clears it too.

**Bringing it back** needs no extra mechanism: Esc hides the answer only until
the next human edit. Typing a space after `=` (rule 2 allows trailing spaces),
or deleting `=` and typing it again, re-evaluates — this works on any old line
too: put the caret at the end of `338 * 1.3 =`, press Space.

## Keys

`Prec.highest` keymap, active only while a ghost is shown (the commands return
`false` otherwise, so Tab keeps indenting lists and everything else is
untouched):

- **Tab** — replace everything between the `=` and the caret with
  `' ' + answer` (so `=` + any number of spaces becomes `= 439.4`), put the
  caret after it, clear the ghost. One transaction, its own undo step
  (`isolateHistory`), `userEvent: 'input.complete'`.
- **Esc** — clear the ghost, consume the key. When no ghost is shown Esc is not
  consumed (AI-highlight Esc, search panel, etc. keep working).

Undoing an accepted answer restores `338 * 1.3 = ` — an undo is a human edit,
so the ghost reappears; that is intended.

## Rendering

`Decoration.widget({ widget: GhostWidget(text), side: 1 })` at the caret. The
widget is an inline `<span class="cm-math-ghost" aria-hidden="true">` with
`color: var(--text-muted)`, `pointer-events: none`, no margins — an existing
token, so no theme needs a new colour (`theme-tokens.test.ts` stays green).
`eq()` compares the text. Works in both `live-preview` and `live-render`;
verify in the browser that the live-render caret filter does not move the
caret around the widget.

## Testing

- `evaluate.test.ts` — precedence, associativity of `^`, unary minus, each
  percent rule, comma decimal, thousands spaces (`1 500` vs `15 + 2`), Unicode
  operators, garbage / letters / empty / unbalanced parens → `null`, length and
  depth limits.
- `format.test.ts` — rounding noise, trailing zeros, `-0`, ±∞/NaN/≥1e15 → `null`,
  comma and thousands mirroring.
- `trigger.test.ts` — every list/quote/heading/task prefix, code (fenced,
  indented, inline), table, `==`/`>=`/`<=`/`!=`, text right of caret, longest
  valid suffix, `Итого: 338 * 1.3 =`.
- `ghost.test.ts` — an `EditorView` in jsdom: typing `=` shows the field's
  answer; a caret move clears it; Tab inserts `= 439.4` and is one undo step;
  Tab without a ghost falls through (list indent still works); Esc clears;
  a space after `=` brings it back; an `aiEditTransaction` never shows a ghost.
- Visual check in `npm run dev` (both preview modes, a light and a dark theme).

## Out of scope

Variables (`x = 5`), units/currencies, functions (`sqrt`), multi-line sums,
a settings toggle. Each can come later without changing the parser's
contract.
