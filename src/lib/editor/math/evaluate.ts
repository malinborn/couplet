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
 *   number  := d{1,3} (SP ddd)* ([.,] d+)?  |  d+ ([.,] d+)?
 *
 * SP is a space, a no-break space (U+00A0) or a narrow no-break space
 * (U+202F); all three are also ignored between tokens. A literal with more
 * than `MAX_SIGNIFICANT_DIGITS` significant digits is refused: a double
 * cannot hold it exactly, and the answer would be silently wrong.
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
/** Recursion through `unary`: one unit per unary minus and per paren level. */
export const MAX_DEPTH = 32;
/** Per number literal; leading zeros and trailing fraction zeros do not count. */
export const MAX_SIGNIFICANT_DIGITS = 15;

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

/** A space, a no-break space or a narrow no-break space. */
export function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === ' ' || ch === ' ';
}

/**
 * A number from `start`: digits, then — only after a leading group of one to
 * three digits — groups of SP + exactly three digits and no fourth, then an
 * optional `.`/`,` fraction. `null` when it has too many significant digits.
 */
function readNumber(
  src: string,
  start: number,
  style: NumberStyle
): { value: number; end: number } | null {
  let i = start;
  let integer = '';
  while (isDigit(src[i])) integer += src[i++];
  if (integer.length <= 3) {
    while (
      isSpace(src[i]) &&
      isDigit(src[i + 1]) &&
      isDigit(src[i + 2]) &&
      isDigit(src[i + 3]) &&
      !isDigit(src[i + 4])
    ) {
      integer += src.slice(i + 1, i + 4);
      style.thousandsSpace = true;
      i += 4;
    }
  }
  let fraction = '';
  if ((src[i] === '.' || src[i] === ',') && isDigit(src[i + 1])) {
    if (src[i] === ',') style.decimalComma = true;
    i++;
    while (isDigit(src[i])) fraction += src[i++];
  }
  const significant = (integer + fraction.replace(/0+$/, '')).replace(/^0+/, '');
  if (significant.length > MAX_SIGNIFICANT_DIGITS) return null;
  return { value: Number(fraction ? integer + '.' + fraction : integer), end: i };
}

function tokenize(src: string, style: NumberStyle): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = SYNONYMS[src[i]] ?? src[i];
    if (isSpace(ch)) {
      i++;
    } else if (OPERATORS.includes(ch)) {
      tokens.push({ kind: 'op', op: ch as Op });
      i++;
    } else if (isDigit(ch)) {
      const read = readNumber(src, i, style);
      if (!read) return null;
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
      // No enter() here: `expr` reaches `unary`, which counts this level.
      const inner = this.expr();
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
