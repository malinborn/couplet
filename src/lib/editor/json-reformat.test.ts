import { describe, it, expect } from 'vitest';
import { reformatJson } from './json-reformat';

/**
 * Strip every whitespace character that sits **outside** a string literal.
 *
 * Written from scratch here, not reused from the implementation, on purpose:
 * the property below is only evidence if the two sides were derived
 * independently. This one is a two-state machine over characters and knows
 * nothing about JSON structure.
 */
function stripInsignificantWhitespace(source: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += source[i + 1] ?? '';
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
    out += c;
  }
  return out;
}

/**
 * The property #46 is about: formatting is re-indentation, so the two texts
 * must be identical once indentation is taken away again.
 *
 * This is strictly stronger than "the values round-trip" — it is byte
 * equality, which is what catches `1e5` → `100000` and `3.0` → `3`.
 */
function expectOnlyWhitespaceChanged(source: string): string {
  const result = reformatJson(source);
  expect(result, `reformatJson rejected: ${source.slice(0, 80)}`).not.toBeNull();
  expect(stripInsignificantWhitespace(result!.text)).toBe(
    stripInsignificantWhitespace(source)
  );
  return result!.text;
}

describe('the six number literals from #46 survive byte for byte', () => {
  const cases: Array<[string, string]> = [
    ['{"id":12345678901234567890}', '12345678901234567890'],
    ['{"v":1e5}', '1e5'],
    ['{"v":0.1234567890123456789}', '0.1234567890123456789'],
    ['{"v":3.0}', '3.0'],
    ['{"v":-0}', '-0'],
    ['{"v":1.500}', '1.500'],
  ];

  for (const [input, literal] of cases) {
    it(`${input} keeps ${literal}`, () => {
      const out = expectOnlyWhitespaceChanged(input);
      expect(out).toContain(literal);
      // And the shape of the damage the old implementation did is gone.
      expect(out).toBe(`{\n  ${input.slice(1, input.indexOf(':'))}: ${literal}\n}`);
    });
  }

  it('the whole table at once, in one document', () => {
    const input =
      '{"id":12345678901234567890,"a":1e5,"b":0.1234567890123456789,' +
      '"c":3.0,"d":-0,"e":1.500,"f":-1.2E+10,"g":0}';
    const out = expectOnlyWhitespaceChanged(input);
    for (const literal of [
      '12345678901234567890',
      '1e5',
      '0.1234567890123456789',
      '3.0',
      '-0',
      '1.500',
      '-1.2E+10',
    ]) {
      expect(out).toContain(literal);
    }
  });

  it('shows what the old JSON.parse round-trip would have done', () => {
    // Not a test of our code — a record of why this file exists. If any of
    // these ever stop differing, the corresponding case above stops proving
    // anything and should be replaced.
    expect(JSON.stringify(JSON.parse('{"id":12345678901234567890}'))).not.toBe(
      '{"id":12345678901234567890}'
    );
    expect(JSON.stringify(JSON.parse('{"v":3.0}'))).toBe('{"v":3}');
    expect(JSON.stringify(JSON.parse('{"v":1e5}'))).toBe('{"v":100000}');
  });
});

describe('strings are copied, never re-escaped', () => {
  it('keeps \\u escapes as written instead of collapsing them', () => {
    const out = expectOnlyWhitespaceChanged('{"k":"\\u0041\\u00e9"}');
    expect(out).toContain('\\u0041');
    expect(out).not.toContain('"A');
  });

  it('keeps the optional \\/ escape', () => {
    expect(expectOnlyWhitespaceChanged('{"p":"a\\/b"}')).toContain('a\\/b');
  });

  it('keeps literal characters that JSON.stringify would escape back', () => {
    expect(expectOnlyWhitespaceChanged('{"k":"\\t\\n\\r\\b\\f\\\\\\""}')).toContain(
      '\\t\\n\\r\\b\\f\\\\\\"'
    );
  });

  it('leaves whitespace inside string values completely alone', () => {
    const out = expectOnlyWhitespaceChanged('{"k":"  spaced\\tout  "}');
    expect(out).toContain('"  spaced\\tout  "');
  });

  it('handles unicode and emoji', () => {
    expect(expectOnlyWhitespaceChanged('{"ru":"привет мир","e":"🎉"}')).toContain('привет мир');
  });
});

describe('structure is preserved, not rebuilt', () => {
  it('keeps duplicate keys, which JSON.parse drops', () => {
    const out = expectOnlyWhitespaceChanged('{"a":1,"a":2,"a":3}');
    expect(out).toBe('{\n  "a": 1,\n  "a": 2,\n  "a": 3\n}');
    // The loss the old implementation caused, for the record.
    expect(Object.keys(JSON.parse('{"a":1,"a":2,"a":3}'))).toHaveLength(1);
  });

  it('keeps key order exactly, including numeric-looking keys', () => {
    // JSON.parse + stringify reorders integer-like keys to the front.
    const input = '{"b":1,"2":2,"a":3,"1":4}';
    const out = expectOnlyWhitespaceChanged(input);
    expect(out.indexOf('"b"')).toBeLessThan(out.indexOf('"2"'));
    expect(out.indexOf('"a"')).toBeLessThan(out.indexOf('"1"'));
    expect(JSON.stringify(JSON.parse(input))).not.toBe(input);
  });

  it('collapses empty containers the way JSON.stringify does', () => {
    expect(reformatJson('{"a":{},"b":[]}')?.text).toBe('{\n  "a": {},\n  "b": []\n}');
  });

  it('matches JSON.stringify layout for ordinary data', () => {
    const value = { a: 1, b: [1, 2, { c: true }], d: null, e: 'x' };
    expect(reformatJson(JSON.stringify(value))?.text).toBe(JSON.stringify(value, null, 2));
  });

  it('honours a custom indent', () => {
    expect(reformatJson('{"a":1}', '    ')?.text).toBe('{\n    "a": 1\n}');
    expect(reformatJson('{"a":1}', '\t')?.text).toBe('{\n\t"a": 1\n}');
  });

  it('reports the outer shape', () => {
    expect(reformatJson('{"a":1}')?.shape).toBe('object');
    expect(reformatJson('[1]')?.shape).toBe('array');
    expect(reformatJson('42')?.shape).toBe('scalar');
    expect(reformatJson('"s"')?.shape).toBe('scalar');
  });

  it('is idempotent', () => {
    const once = reformatJson('{"a":[1,2],"b":{"c":3.0}}')!.text;
    expect(reformatJson(once)!.text).toBe(once);
  });
});

describe('invalid input is refused, exactly where JSON.parse refuses it', () => {
  const invalid = [
    '',
    '   ',
    '{',
    '}',
    '{"a":1,}',
    '[1,]',
    "{'a':1}",
    '{a:1}',
    '{"a" 1}',
    '{"a":}',
    '{"a":1}{"b":2}',
    '[1 2]',
    '01',
    '{"v":01}',
    '{"v":1.}',
    '{"v":.5}',
    '{"v":+1}',
    '{"v":1e}',
    '{"v":1e+}',
    '{"v":0x10}',
    '{"v":Infinity}',
    '{"v":NaN}',
    '{"v":undefined}',
    '{"v":True}',
    '{"a":"unterminated}',
    '{"a":"bad \\q escape"}',
    '{"a":"short \\u12"}',
    '{"a":"bad \\uZZZZ"}',
    '[1,2',
    'null null',
    '{"a":1,"b"}',
  ];

  for (const source of invalid) {
    it(`refuses ${JSON.stringify(source)}`, () => {
      expect(reformatJson(source)).toBeNull();
      // And JSON.parse agrees, which is the standard we are matching.
      let parseThrew = false;
      try {
        JSON.parse(source);
      } catch {
        parseThrew = true;
      }
      expect(parseThrew).toBe(true);
    });
  }

  it('refuses a raw control character inside a string, as JSON.parse does', () => {
    expect(reformatJson('{"a":"x\ny"}')).toBeNull();
    expect(() => JSON.parse('{"a":"x\ny"}')).toThrow();
  });

  it('refuses nesting past the depth cap instead of overflowing the stack', () => {
    const deep = '['.repeat(5000) + ']'.repeat(5000);
    expect(reformatJson(deep)).toBeNull();
  });

  it('still accepts nesting a real document could contain', () => {
    const deep = '['.repeat(200) + ']'.repeat(200);
    expect(reformatJson(deep)).not.toBeNull();
  });
});

describe('the property: formatting only ever moves whitespace', () => {
  it('holds for the owner document from the report', () => {
    expectOnlyWhitespaceChanged(OWNER_DOCUMENT);
  });

  it('holds for a large nested real-world document', () => {
    const rows = Array.from({ length: 400 }, (_, i) =>
      `{"id":${10_000_000_000_000_000_000n + BigInt(i)},"name":"строка ${i}",` +
      `"tags":["a","b"],"score":${i}.0,"nested":{"deep":{"deeper":[${i},[${i}],[]]}},` +
      `"phone":"+7 900 000-00-${String(i % 100).padStart(2, '0')}"}`
    );
    expectOnlyWhitespaceChanged(`{"rows":[${rows.join(',')}]}`);
  });

  it('holds for a generated corpus', () => {
    const rng = mulberry32(0x5eed);
    for (let i = 0; i < 400; i++) {
      expectOnlyWhitespaceChanged(randomJson(rng, 0));
    }
  });

  it('holds for a corpus that was already pretty-printed at a different indent', () => {
    const rng = mulberry32(0xc0ffee);
    for (let i = 0; i < 120; i++) {
      const source = randomJson(rng, 0);
      const wide = reformatJson(source, '      ')!.text;
      expectOnlyWhitespaceChanged(wide);
      // Re-indenting a re-indented document lands back on the canonical form.
      expect(reformatJson(wide)!.text).toBe(reformatJson(source)!.text);
    }
  });
});

/** Deterministic PRNG — a failing corpus case must be reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * JSON **source text**, not a JS value — the point is to generate literals a
 * `JSON.stringify` round-trip could not reproduce: exponents, trailing zeros,
 * negative zero, integers past 2^53, and escape sequences left as written.
 */
const NUMBER_LITERALS = [
  '0', '-0', '3.0', '1.500', '1e5', '1E5', '1e+5', '1e-5', '-1.2E+10',
  '12345678901234567890', '-12345678901234567890', '0.1234567890123456789',
  '9007199254740993', '1234', '-7', '0.0', '2.0000000000000004',
];

const STRING_LITERALS = [
  '"plain"', '""', '"привет"', '"🎉 emoji"', '"\\u0041\\u00e9"', '"a\\/b"',
  '"tab\\there"', '"quote\\"inside"', '"back\\\\slash"', '"  padded  "',
  '"+7 900 123-45-67"', '"{\\"nested\\": \\"json\\"}"', '"[1,2]"',
];

function randomJson(rng: () => number, depth: number): string {
  const roll = rng();
  if (depth >= 4 || roll < 0.4) {
    const pick = rng();
    if (pick < 0.4) return NUMBER_LITERALS[Math.floor(rng() * NUMBER_LITERALS.length)];
    if (pick < 0.8) return STRING_LITERALS[Math.floor(rng() * STRING_LITERALS.length)];
    return ['true', 'false', 'null'][Math.floor(rng() * 3)];
  }
  const size = Math.floor(rng() * 4);
  const separator = [',', ',\n', ', ', ',\n\t  '][Math.floor(rng() * 4)];
  if (roll < 0.7) {
    const members = Array.from({ length: size }, (_, i) => {
      // Duplicate keys on purpose: they are part of the property.
      const key = i % 3 === 2 ? '"dup"' : `"k${i}"`;
      return `${key}${rng() < 0.5 ? ':' : ': '}${randomJson(rng, depth + 1)}`;
    });
    return `{${members.join(separator)}}`;
  }
  const items = Array.from({ length: size }, () => randomJson(rng, depth + 1));
  return `[${items.join(separator)}]`;
}

/**
 * The document from the #46/#47 report: deep nesting, a `3.0` inside a mixed
 * list, Cyrillic values and phone numbers.
 */
const OWNER_DOCUMENT = `{
  "id": 12345678901234567890,
  "name": "Иван Петров",
  "phone": "+7 900 123-45-67",
  "list": [[1,2],[3,4],[]],
  "mixed_list": [1, 2.5, 3.0, "три", true, null, {"k": "v"}, [ ]],
  "meta": { "ok": true, "n": null, "ratio": 0.1234567890123456789, "exp": 1e5 },
  "deep": { "a": { "b": { "c": { "d": [ { "e": 1.500 } ] } } } }
}`;
