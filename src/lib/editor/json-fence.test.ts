import { describe, it, expect } from 'vitest';
import { EditorState, type Extension } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Strikethrough, Table } from '@lezer/markdown';
import { planJsonFormat, shouldFenceAt } from './json-fence';

const MINIFIED = '{"a":1,"b":[2,3]}';
const EXPANDED = '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}';
const FENCED = '```json\n' + EXPANDED + '\n```';

const md = (): Extension =>
  markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Strikethrough, Table] });

/** A parsed state. The fence decision reads the tree, so it must exist. */
function mdState(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [md()] });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

/** No language — md-mini's env mode, and the same branch code-file mode takes. */
function codeState(doc: string): EditorState {
  return EditorState.create({ doc });
}

/** Apply a plan to its own document, so the test reads as before/after. */
function applied(state: EditorState, from = 0, to = state.doc.length): string | null {
  const plan = planJsonFormat(state, from, to);
  if (!plan) return null;
  return (
    state.doc.sliceString(0, plan.from) + plan.insert + state.doc.sliceString(plan.to)
  );
}

describe('shouldFenceAt', () => {
  it('is true in ordinary markdown prose', () => {
    expect(shouldFenceAt(mdState('hello world'), 3)).toBe(true);
  });

  it('is true in an empty document', () => {
    expect(shouldFenceAt(mdState(''), 0)).toBe(true);
  });

  it('is false when markdown is not the active language', () => {
    expect(shouldFenceAt(codeState(MINIFIED), 0)).toBe(false);
  });

  it('is false inside a ```json fence', () => {
    expect(shouldFenceAt(mdState('```json\n{"a":1}\n```'), 9)).toBe(false);
  });

  it('is false inside a fence with no info string', () => {
    expect(shouldFenceAt(mdState('```\n{"a":1}\n```'), 5)).toBe(false);
  });

  it('is false inside a ~~~ fence', () => {
    expect(shouldFenceAt(mdState('~~~\n{"a":1}\n~~~'), 5)).toBe(false);
  });

  it('is false inside an indented code block', () => {
    expect(shouldFenceAt(mdState('para\n\n    {"a":1}\n'), 12)).toBe(false);
  });

  it('is true again after a fence has closed', () => {
    const doc = '```\nx\n```\n\ntail\n';
    expect(shouldFenceAt(mdState(doc), doc.indexOf('tail'))).toBe(true);
  });
});

describe('planJsonFormat — markdown', () => {
  it('wraps the expanded JSON in a ```json fence', () => {
    const state = mdState(MINIFIED);
    const plan = planJsonFormat(state, 0, state.doc.length)!;
    expect(plan.fenced).toBe(true);
    expect(plan.insert).toBe(FENCED);
  });

  it('fences already-expanded JSON that is lying bare — the #47 case', () => {
    expect(applied(mdState(EXPANDED))).toBe(FENCED);
  });

  it('has nothing to do once the JSON is expanded and fenced', () => {
    expect(planJsonFormat(mdState(FENCED), 0, FENCED.length)).toBeNull();
  });

  it('leaves the surrounding document alone', () => {
    const doc = `# Notes\n\n${MINIFIED}\n\ntail\n`;
    const from = doc.indexOf(MINIFIED);
    expect(applied(mdState(doc), from, from + MINIFIED.length)).toBe(
      `# Notes\n\n${FENCED}\n\ntail\n`
    );
  });

  it('swallows whitespace-only text before the JSON on its line', () => {
    const doc = `   ${MINIFIED}`;
    // The fence must start at column 0; the three spaces go, they are not data.
    expect(applied(mdState(doc), 3, doc.length)).toBe(FENCED);
  });

  it('pushes the fence onto its own line when prose precedes it', () => {
    const doc = `payload: ${MINIFIED}`;
    expect(applied(mdState(doc), doc.indexOf('{'), doc.length)).toBe(`payload: \n${FENCED}`);
  });

  it('pushes the following prose onto its own line', () => {
    const doc = `${MINIFIED} ok`;
    expect(applied(mdState(doc), 0, MINIFIED.length)).toBe(`${FENCED}\n ok`);
  });

  it('handles prose on both sides at once', () => {
    const doc = `before ${MINIFIED} after`;
    const from = doc.indexOf('{');
    expect(applied(mdState(doc), from, from + MINIFIED.length)).toBe(
      `before \n${FENCED}\n after`
    );
  });

  it('trims a range that over-reaches by whitespace instead of moving it', () => {
    const doc = `\n\n${MINIFIED}\n\n`;
    expect(applied(mdState(doc), 0, doc.length)).toBe(`\n\n${FENCED}\n\n`);
  });
});

describe('planJsonFormat — inside code, where a fence would be wrong', () => {
  it('re-indents inside an existing fence without nesting another', () => {
    const doc = '```json\n' + MINIFIED + '\n```\n';
    const plan = planJsonFormat(mdState(doc), 8, 8 + MINIFIED.length)!;
    expect(plan.fenced).toBe(false);
    expect(plan.insert).toBe(EXPANDED);
    expect(applied(mdState(doc), 8, 8 + MINIFIED.length)).toBe(
      '```json\n' + EXPANDED + '\n```\n'
    );
  });

  it('never emits a fence when markdown is not the active language', () => {
    const plan = planJsonFormat(codeState(MINIFIED), 0, MINIFIED.length)!;
    expect(plan.fenced).toBe(false);
    expect(plan.insert).toBe(EXPANDED);
  });

  it('has nothing to do for already-expanded JSON in code-file mode', () => {
    expect(planJsonFormat(codeState(EXPANDED), 0, EXPANDED.length)).toBeNull();
  });
});

describe('planJsonFormat — refusals', () => {
  it('refuses prose', () => {
    expect(planJsonFormat(mdState('# Heading\n\nprose'), 0, 16)).toBeNull();
  });

  it('refuses scalars', () => {
    for (const scalar of ['42', '"s"', 'true', 'null']) {
      expect(planJsonFormat(mdState(scalar), 0, scalar.length)).toBeNull();
    }
  });

  it('refuses broken JSON', () => {
    expect(planJsonFormat(mdState('{"a":1,}'), 0, 8)).toBeNull();
  });

  it('refuses a range that is JSON plus surrounding prose', () => {
    const doc = `saw ${MINIFIED} once`;
    expect(planJsonFormat(mdState(doc), 0, doc.length)).toBeNull();
  });

  it('keeps the >2MB guard from #30 — no scan, no plan', () => {
    const huge = '[' + '1,'.repeat(1_100_000) + '1]';
    expect(huge.length).toBeGreaterThan(2_000_000);
    const state = EditorState.create({ doc: huge });
    expect(planJsonFormat(state, 0, huge.length)).toBeNull();
  });
});

describe('planJsonFormat preserves the number literals from #46 all the way through', () => {
  it('carries a 64-bit id into the fenced result unchanged', () => {
    const doc = '{"id":12345678901234567890,"v":3.0,"e":1e5}';
    const out = applied(mdState(doc))!;
    expect(out).toContain('12345678901234567890');
    expect(out).toContain('3.0');
    expect(out).toContain('1e5');
    expect(out.startsWith('```json\n')).toBe(true);
  });
});
