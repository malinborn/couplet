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
number  := digit{1,3} (SP digit{3})* ([.,] digit+)?
         | digit+ ([.,] digit+)?
SP      := ' ' | U+00A0 (no-break space) | U+202F (narrow no-break space)
```

- Synonyms, normalised by the tokenizer: `×` `·` → `*`; `÷` → `/`;
  `−` (U+2212) `–` (U+2013) → `-`.
- Whitespace between tokens (`SP`) is ignored. Inside a number an `SP` is a
  thousands separator only when followed by exactly three digits that are not
  followed by a fourth, and only after a leading group of one to three digits
  (`1 500` is 1500; `15 + 2` stays two numbers; `12345 678` is two adjacent
  numbers, so no answer). The no-break spaces count exactly like a space; the
  answer always uses a plain space.
- A number literal with more than 15 significant digits is refused (leading
  zeros and trailing fraction zeros do not count): a double cannot hold it
  exactly, so `9007199254740993 - 9007199254740992 =` gives nothing rather
  than a wrong `0`.
- Percent (calculator rules):
  - `a + b%` = a·(1 + b/100), `a - b%` = a·(1 − b/100) — only when the
    **direct** right operand of `+`/`-` is a `%` postfix;
  - `a * b%` = a·b/100, `a / b%` = a / (b/100) — `%` is just ÷100;
  - a lone `b%` = b/100.
  - In any other context `%` is just ÷100: `100 + (10%)` = 100.1 (the
    parentheses make it a plain operand), `200 + 10% * 2` = 200.2 (the right
    operand of `+` is the product, not the percent).
- An expression must contain at least one binary operator or `%`: `2024 =`
  gives nothing.
- Implementation limits: input length ≤ 200 characters, nesting depth ≤ 32
  (one unit per paren level and per unary minus). Past either → `null` (no
  answer), never an exception.

`MathResult` = `{ value: number, style: { decimalComma: boolean, thousandsSpace: boolean } }`,
where the style records how the **input** wrote its numbers.

## Formatting the answer

- `null` (no answer) for `NaN`, `±Infinity` (division by zero), |x| ≥ 1e15
  and 0 < |x| < 1e-10: no exponent notation is ever shown.
- The integer part is never rounded: `1234567890123 + 1 =` → `1234567890124`.
  Only the fraction is rounded, so that the answer has at most 10 significant
  digits (`toFixed(max(0, 9 − magnitude))`), then trailing zeros and a
  trailing separator are dropped: `0.1 + 0.2 =` → `0.3`, `10 / 3 =` →
  `3.333333333`. An answer that reads as zero prints as `0` (never `-0`); a
  fraction rounded up into 1e15 is refused like any other |x| ≥ 1e15.
- Mirror the input: decimal comma if any input number used one; thousands
  spaces (groups of three in the integer part) if any input number used them.
  `1 500,5 * 2 =` → `3 001`.

## When the ghost appears

Evaluated on every update where `isHumanEdit(update)` is true (keys, paste,
undo/redo — not an agent's edit, not a reload) and the selection is a single
empty cursor, not during IME composition. The answer shows only if **all** hold:

0. The document is markdown (`state.facet(language)?.name === 'markdown'`).
   A code file, JSON, `.env` or a state with no language never gets a ghost:
   there `=` is assignment, not a question.
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
   made of allowed characters (digits, the three `SP` spaces,
   `.,+-*/^%()×·÷−–`), trimmed, that `evaluate` accepts. In
   `Итого: 338 * 1.3 =` it is `338 * 1.3`. Scanning stops at the first
   disallowed character, then shrinks from the left until it parses (so
   `шаг 2) (3+4) =` still finds `(3+4)`).
   - If that run, without spaces at its ends, is longer than 200 characters
     there is no answer — it is never cut to its last 200. The scan back stops
     as soon as the run passes the limit.
   - Only the last 512 characters before the caret are looked at. On a longer
     line that tail is used as is (no block-prefix stripping: a run of at most
     200 characters cannot reach the line start), and a run that reaches the
     start of the tail is no answer, since it may go on past it. So the
     string work per keystroke — the `=` regex, the scan, the `evaluate`
     calls — is bounded by 512 characters whatever the line length. Taking
     the caret's line out of the document is still O(line), and the
     syntax-tree lookup is CodeMirror's normal incremental parse
     (`ensureSyntaxTree` up to the caret's line).
   - Shrinking tries only starts at a **token boundary**:
     - the character right before the start (inside or outside the run) is
       not a digit, `.`, `,`, a letter or a non-ASCII space — the two no-break
       spaces excepted, they count as spaces;
     - the nearest non-space character before the start is not a digit
       (two adjacent numbers);
     - if that nearest character is inside the run, it is `)`, `,` or `.` —
       after an operator, `(` or `%` the start would be the tail of an
       unfinished expression. After `)` at least one space must separate it
       from the start: `(1+2)3 + 1 =` gives nothing, `(1+2) 3 + 1 =` → `4`.

     So `1e5 + 1 =`, `0x10 + 1 =`, `v1.2.3 + 1 =`, `.5 + 1 =`, `1,5,5 + 1 =`,
     `12 34 + 1 =`, `1 5000 + 1 =`, `1,500 000 + 1 =`, `шаг 2 (3+4) =`,
     `5 * (3 + 4 =`, `10 / (2 + 3 =`, `(1 + 2) * (3 + 4 =`,
     `100 - (20 + 5 =`, `2 + + 3 + 4 =` and `x-5 + 3 =` all give nothing
     instead of an answer for their tail; `шаг 2) (3+4) =` → `7`,
     `Например, 5 + 3 =` → `8`, `(см. 5 + 3 =` → `8`, `x = 5 + 3 =` → `8`
     and `Итого:` + no-break space + `5 + 3 =` → `8` still work.
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
  percent rule and percent in context, comma decimal, thousands spaces
  (`1 500` vs `15 + 2`, no-break spaces, leading group of 1–3 digits), the
  15-significant-digit refusal, Unicode operators, garbage / letters / empty /
  unbalanced parens → `null`, length and depth limits.
- `format.test.ts` — rounding noise, trailing zeros, `-0`, exact integers,
  ±∞/NaN/≥1e15 → `null`, comma and thousands mirroring.
- `trigger.test.ts` — every list/quote/heading/task prefix, code (fenced,
  indented, inline), table, `==`/`>=`/`<=`/`!=`, text right of caret, longest
  valid suffix, `Итого: 338 * 1.3 =`, token boundaries, a run past the length
  limit, markdown only.
- `ghost.test.ts` — an `EditorView` in jsdom: typing `=` shows the field's
  answer; a caret move clears it; Tab inserts `= 439.4` and is one undo step;
  Tab without a ghost falls through (list indent still works); Esc clears;
  a space after `=` brings it back; an `aiEditTransaction` never shows a ghost.
- Visual check in `npm run dev` (both preview modes, a light and a dark theme).

## Out of scope

Variables (`x = 5`), units/currencies, functions (`sqrt`), multi-line sums,
a settings toggle. Each can come later without changing the parser's
contract.
