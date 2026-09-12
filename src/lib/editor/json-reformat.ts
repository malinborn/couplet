/**
 * Re-indenting JSON **text** (#46). Pure — no CM6, no DOM, no dependency.
 *
 * The first implementation of #30 was `JSON.stringify(JSON.parse(s), null, 2)`.
 * That is not a formatter, it is a re-serialiser: every literal is destroyed
 * and rebuilt from a JS value, so `{"id":12345678901234567890}` came back as
 * `{"id":12345678901234567000}` — a 64-bit id silently changed value, with
 * nothing in the document to say it had happened. `1e5` became `100000`,
 * `3.0` became `3`, `-0` became `0`, `1.500` became `1.5`, and a duplicate
 * key was dropped outright because `JSON.parse` keeps only the last one.
 *
 * So formatting here is **re-indentation of the source text**. The scanner
 * produces tokens that carry their offsets in the input; the emitter writes
 * indentation and separators of its own, but every token's own characters are
 * copied verbatim out of the input. Numbers are byte-identical. String escapes
 * are not normalised (`A` stays `A`, it does not become `A`). Key
 * order and duplicate keys survive because nothing ever becomes an object.
 *
 * A dependency was considered first, as the issue asks. `@lezer/json` is
 * present in `node_modules`, but only as a transitive dependency of
 * `@codemirror/language-data` (via `@codemirror/lang-json`), and it is an
 * error-recovering LR parser: it returns a tree for *any* input, so the
 * "is this actually valid JSON" half of the job would still have to be written
 * by hand on top of it. It buys nothing and adds a version it does not own.
 */

/** What a token is. Punctuation tokens use their own character as the kind. */
type TokenKind = 'string' | 'number' | 'literal' | '{' | '}' | '[' | ']' | ',' | ':';

interface Token {
  kind: TokenKind;
  /** Offset of the token's first character in the source. */
  from: number;
  /** Offset just past the token's last character. */
  to: number;
}

/**
 * Nesting depth beyond which we decline rather than recurse.
 *
 * The emitter is recursive, and a pathological input (`[` a hundred thousand
 * times) would otherwise overflow the stack somewhere unhelpful. `JSON.parse`
 * has the same limit; it just reports it as a `RangeError`. A thousand levels
 * is far past any real document and well inside any engine's stack.
 */
const MAX_DEPTH = 1000;

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isHexDigit(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || (code >= 97 && code <= 102) || (code >= 65 && code <= 70)
  );
}

/**
 * Whitespace, per the JSON grammar — space, tab, LF, CR, and nothing else.
 *
 * Deliberately narrower than `String.prototype.trim`: a NBSP between two
 * tokens is not valid JSON, and accepting it here would mean offering to
 * "format" text that `JSON.parse` rejects.
 */
function isJsonSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

/**
 * Split the source into tokens, or return `null` if it is not lexically JSON.
 *
 * Strictness matches `JSON.parse`, because the offer must never appear for
 * text the user would not call JSON: no trailing commas (the parser catches
 * those), no single quotes, no `01`, no `1.`, no `.5`, no raw control
 * characters inside strings, no escapes outside `"\/bfnrtu`.
 */
function tokenize(src: string): Token[] | null {
  const tokens: Token[] = [];
  const len = src.length;
  let i = 0;

  while (i < len) {
    const code = src.charCodeAt(i);

    if (isJsonSpace(code)) {
      i++;
      continue;
    }

    const punct = src[i];
    if (
      punct === '{' ||
      punct === '}' ||
      punct === '[' ||
      punct === ']' ||
      punct === ',' ||
      punct === ':'
    ) {
      tokens.push({ kind: punct, from: i, to: i + 1 });
      i++;
      continue;
    }

    if (code === 34 /* " */) {
      const end = scanString(src, i);
      if (end === -1) return null;
      tokens.push({ kind: 'string', from: i, to: end });
      i = end;
      continue;
    }

    if (code === 45 /* - */ || isDigit(code)) {
      const end = scanNumber(src, i);
      if (end === -1) return null;
      tokens.push({ kind: 'number', from: i, to: end });
      i = end;
      continue;
    }

    const literal =
      src.startsWith('true', i) ? 4 : src.startsWith('false', i) ? 5 : src.startsWith('null', i) ? 4 : 0;
    if (literal === 0) return null;
    tokens.push({ kind: 'literal', from: i, to: i + literal });
    i += literal;
  }

  return tokens;
}

/** Offset just past the closing quote, or -1 if the string is malformed. */
function scanString(src: string, start: number): number {
  const len = src.length;
  let i = start + 1;
  while (i < len) {
    const code = src.charCodeAt(i);
    if (code === 34 /* " */) return i + 1;
    if (code === 92 /* \ */) {
      const esc = src[i + 1];
      if (esc === undefined) return -1;
      if (esc === 'u') {
        if (i + 6 > len) return -1;
        for (let k = i + 2; k < i + 6; k++) {
          if (!isHexDigit(src.charCodeAt(k))) return -1;
        }
        i += 6;
        continue;
      }
      if (
        esc === '"' ||
        esc === '\\' ||
        esc === '/' ||
        esc === 'b' ||
        esc === 'f' ||
        esc === 'n' ||
        esc === 'r' ||
        esc === 't'
      ) {
        i += 2;
        continue;
      }
      return -1;
    }
    // Raw control characters must be escaped inside a JSON string.
    if (code < 0x20) return -1;
    i++;
  }
  return -1;
}

/** Offset just past the number, or -1 if it does not match the JSON grammar. */
function scanNumber(src: string, start: number): number {
  const len = src.length;
  let i = start;

  if (src.charCodeAt(i) === 45 /* - */) i++;

  if (i >= len) return -1;
  if (src.charCodeAt(i) === 48 /* 0 */) {
    i++;
  } else if (isDigit(src.charCodeAt(i))) {
    while (i < len && isDigit(src.charCodeAt(i))) i++;
  } else {
    return -1;
  }

  if (i < len && src.charCodeAt(i) === 46 /* . */) {
    i++;
    if (i >= len || !isDigit(src.charCodeAt(i))) return -1;
    while (i < len && isDigit(src.charCodeAt(i))) i++;
  }

  const expo = i < len ? src.charCodeAt(i) : 0;
  if (expo === 101 /* e */ || expo === 69 /* E */) {
    i++;
    const sign = i < len ? src.charCodeAt(i) : 0;
    if (sign === 43 /* + */ || sign === 45 /* - */) i++;
    if (i >= len || !isDigit(src.charCodeAt(i))) return -1;
    while (i < len && isDigit(src.charCodeAt(i))) i++;
  }

  return i;
}

/** The outermost shape of a document. Scalars are valid JSON but never offered. */
export type JsonShape = 'object' | 'array' | 'scalar';

export interface JsonReformat {
  /** Re-indented text. Every token is a verbatim copy of the input's. */
  text: string;
  shape: JsonShape;
}

/**
 * Re-indent a JSON document, or return `null` when it is not valid JSON.
 *
 * The output layout matches what `JSON.stringify(value, null, indent)` would
 * produce — two-space indent, `": "` after a key, one element per line, `{}`
 * and `[]` collapsed when empty — so the change a user sees is the one they
 * expected. What it does *not* share with `JSON.stringify` is where the
 * characters come from.
 */
export function reformatJson(source: string, indent = '  '): JsonReformat | null {
  const tokens = tokenize(source);
  if (tokens === null || tokens.length === 0) return null;

  const out: string[] = [];
  let pos = 0;

  const emitValue = (depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    const token = tokens[pos];
    if (!token) return false;
    switch (token.kind) {
      case 'string':
      case 'number':
      case 'literal':
        out.push(source.slice(token.from, token.to));
        pos++;
        return true;
      case '{':
        return emitObject(depth);
      case '[':
        return emitArray(depth);
      default:
        return false;
    }
  };

  const emitObject = (depth: number): boolean => {
    pos++; // consume '{'
    if (tokens[pos]?.kind === '}') {
      pos++;
      out.push('{}');
      return true;
    }
    out.push('{');
    const inner = indent.repeat(depth + 1);
    for (;;) {
      const key = tokens[pos];
      // Duplicate keys are not checked for on purpose: `JSON.parse` silently
      // keeps only the last one, which is data loss of exactly the kind #46
      // is about. Here every member is simply copied through.
      if (!key || key.kind !== 'string') return false;
      out.push('\n', inner, source.slice(key.from, key.to));
      pos++;
      if (tokens[pos]?.kind !== ':') return false;
      pos++;
      out.push(': ');
      if (!emitValue(depth + 1)) return false;
      const next = tokens[pos];
      if (next?.kind === ',') {
        out.push(',');
        pos++;
        continue;
      }
      if (next?.kind === '}') {
        pos++;
        out.push('\n', indent.repeat(depth), '}');
        return true;
      }
      return false;
    }
  };

  const emitArray = (depth: number): boolean => {
    pos++; // consume '['
    if (tokens[pos]?.kind === ']') {
      pos++;
      out.push('[]');
      return true;
    }
    out.push('[');
    const inner = indent.repeat(depth + 1);
    for (;;) {
      out.push('\n', inner);
      if (!emitValue(depth + 1)) return false;
      const next = tokens[pos];
      if (next?.kind === ',') {
        out.push(',');
        pos++;
        continue;
      }
      if (next?.kind === ']') {
        pos++;
        out.push('\n', indent.repeat(depth), ']');
        return true;
      }
      return false;
    }
  };

  const first = tokens[0].kind;
  const shape: JsonShape = first === '{' ? 'object' : first === '[' ? 'array' : 'scalar';

  if (!emitValue(0)) return null;
  // Trailing junk after a complete value — `{"a":1} {"b":2}` is not one
  // document, and offering to "format" it would silently drop the second half.
  if (pos !== tokens.length) return null;

  return { text: out.join(''), shape };
}
