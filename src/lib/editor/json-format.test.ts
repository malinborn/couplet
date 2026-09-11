import { describe, it, expect } from 'vitest';
import { analyzeJson, shouldOfferFormat, formatJsonText, MAX_JSON_INPUT } from './json-format';

describe('analyzeJson — accepts', () => {
  it('a minified object', () => {
    const a = analyzeJson('{"a":1,"b":"two"}');
    expect(a).not.toBeNull();
    expect(a?.shape).toBe('object');
    expect(a?.alreadyFormatted).toBe(false);
    expect(a?.formatted).toBe('{\n  "a": 1,\n  "b": "two"\n}');
  });

  it('a minified array', () => {
    const a = analyzeJson('[1,2,3]');
    expect(a?.shape).toBe('array');
    expect(a?.formatted).toBe('[\n  1,\n  2,\n  3\n]');
  });

  it('the real scenario — a nested blob out of a database column', () => {
    const raw =
      '{"id":42,"user":{"name":"Ann","roles":["admin","dev"]},"meta":{"ok":true,"n":null}}';
    const a = analyzeJson(raw);
    expect(a).not.toBeNull();
    expect(a?.formatted.split('\n').length).toBeGreaterThan(5);
    // Round-trips: expanding must not change the data.
    expect(JSON.parse(a!.formatted)).toEqual(JSON.parse(raw));
  });

  it('input padded with surrounding whitespace and newlines', () => {
    expect(analyzeJson('  \n {"a":1} \n\t ')?.formatted).toBe('{\n  "a": 1\n}');
  });

  it('an empty object and an empty array, flagged as already formatted', () => {
    expect(analyzeJson('{}')?.alreadyFormatted).toBe(true);
    expect(analyzeJson('[]')?.alreadyFormatted).toBe(true);
  });

  it('deeply nested input without blowing up', () => {
    const deep = '['.repeat(200) + ']'.repeat(200);
    expect(analyzeJson(deep)).not.toBeNull();
  });

  it('unicode and escaped content intact', () => {
    const a = analyzeJson('{"ru":"привет","esc":"a\\"b","emoji":"🎉"}');
    expect(JSON.parse(a!.formatted)).toEqual({ ru: 'привет', esc: 'a"b', emoji: '🎉' });
  });
});

describe('analyzeJson — rejects', () => {
  it('plain prose', () => {
    expect(analyzeJson('just some notes about the release')).toBeNull();
  });

  it('the empty string and whitespace', () => {
    expect(analyzeJson('')).toBeNull();
    expect(analyzeJson('   \n  ')).toBeNull();
  });

  it('broken JSON — a trailing comma', () => {
    expect(analyzeJson('{"a":1,}')).toBeNull();
  });

  it('broken JSON — single quotes, i.e. a JS object literal', () => {
    expect(analyzeJson("{'a': 1}")).toBeNull();
  });

  it('broken JSON — an unclosed brace', () => {
    expect(analyzeJson('{"a":1')).toBeNull();
  });

  it('JSON-looking but not JSON — a Python dict', () => {
    expect(analyzeJson("{'a': True, 'b': None}")).toBeNull();
  });

  it('scalars, which are valid JSON but nothing to expand', () => {
    expect(analyzeJson('42')).toBeNull();
    expect(analyzeJson('"hello"')).toBeNull();
    expect(analyzeJson('true')).toBeNull();
    expect(analyzeJson('null')).toBeNull();
  });

  it('a markdown fence wrapping JSON — the fence is not JSON', () => {
    expect(analyzeJson('```json\n{"a":1}\n```')).toBeNull();
  });

  it('JSON embedded mid-paragraph', () => {
    // The candidate must be JSON end to end. Note this is a statement about
    // the *text*, not about where a paste lands — see the paste tests.
    expect(analyzeJson('the payload was {"a":1} when it failed')).toBeNull();
    expect(analyzeJson('prefix {"a":1}')).toBeNull();
    expect(analyzeJson('{"a":1} suffix')).toBeNull();
  });

  it('text that merely opens and closes with the right brackets', () => {
    expect(analyzeJson('{ not json at all }')).toBeNull();
    expect(analyzeJson('[see the appendix]')).toBeNull();
  });

  it('a markdown link, which starts with [ and ends with )', () => {
    expect(analyzeJson('[docs](https://example.com)')).toBeNull();
  });

  it('a markdown task line', () => {
    expect(analyzeJson('[x] done')).toBeNull();
  });

  it('input larger than the cap, without attempting to parse it', () => {
    const huge = '[' + '1,'.repeat(MAX_JSON_INPUT) + '1]';
    expect(huge.length).toBeGreaterThan(MAX_JSON_INPUT);
    expect(analyzeJson(huge)).toBeNull();
  });

  it('a large but under-cap document, which is still accepted', () => {
    const big = JSON.stringify(Array.from({ length: 5000 }, (_, i) => ({ i })));
    expect(big.length).toBeLessThan(MAX_JSON_INPUT);
    expect(analyzeJson(big)).not.toBeNull();
  });
});

describe('analyzeJson — already formatted', () => {
  it('flags two-space-indented output as already formatted', () => {
    const pretty = JSON.stringify({ a: 1, b: [1, 2] }, null, 2);
    expect(analyzeJson(pretty)?.alreadyFormatted).toBe(true);
  });

  it('does NOT flag four-space indentation — that is a real reformat', () => {
    const four = JSON.stringify({ a: 1, b: [1, 2] }, null, 4);
    const a = analyzeJson(four);
    expect(a?.alreadyFormatted).toBe(false);
    expect(a?.formatted).toBe(JSON.stringify({ a: 1, b: [1, 2] }, null, 2));
  });

  it('does not care about surrounding whitespace when comparing', () => {
    expect(analyzeJson('\n' + JSON.stringify({ a: 1 }, null, 2) + '\n')?.alreadyFormatted).toBe(
      true
    );
  });
});

describe('shouldOfferFormat', () => {
  it('offers for minified JSON', () => {
    expect(shouldOfferFormat('{"a":1,"b":2}')).toBe(true);
  });

  it('stays quiet for already-expanded JSON', () => {
    expect(shouldOfferFormat(JSON.stringify({ a: 1 }, null, 2))).toBe(false);
  });

  it('stays quiet for prose, scalars and broken JSON', () => {
    expect(shouldOfferFormat('hello world')).toBe(false);
    expect(shouldOfferFormat('42')).toBe(false);
    expect(shouldOfferFormat('{"a":}')).toBe(false);
  });
});

describe('formatJsonText', () => {
  it('returns the expanded text', () => {
    expect(formatJsonText('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it('returns null when there is nothing to do', () => {
    expect(formatJsonText('{\n  "a": 1\n}')).toBeNull();
    expect(formatJsonText('not json')).toBeNull();
  });

  it('is idempotent — formatting twice changes nothing the second time', () => {
    const once = formatJsonText('{"a":[1,2],"b":{"c":3}}');
    expect(once).not.toBeNull();
    expect(formatJsonText(once!)).toBeNull();
  });
});
