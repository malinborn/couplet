import { describe, it, expect } from 'vitest';
import { EditorState, type Extension } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Strikethrough, Table } from '@lezer/markdown';
import { documentPathField, planJsonFormat, setDocumentPath, shouldFenceAt } from './json-fence';

const MINIFIED = '{"a":1,"b":[2,3]}';
const EXPANDED = '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}';
const FENCED = '```json\n' + EXPANDED + '\n```';

const md = (): Extension =>
  markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Strikethrough, Table] });

/**
 * A state for a buffer at `path`, with the syntax tree parsed.
 *
 * The markdown language is installed in every case on purpose: for a `.py`
 * buffer that is exactly the state the real editor is in for a moment, because
 * `Editor.svelte` loads a code language asynchronously and never loads one at
 * all for an unrecognised extension. If the fence decision could be reached
 * through the active language, these tests would not catch it.
 */
function stateFor(path: string | null, doc: string): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [md(), documentPathField],
  }).update({ effects: setDocumentPath.of(path) }).state;
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

/** A markdown buffer — the branch that gets a fence. */
function mdState(doc: string): EditorState {
  return stateFor('/Users/me/notes.md', doc);
}

/** A `.json` buffer — bare, exactly as it formats today. */
function codeState(doc: string): EditorState {
  return stateFor('/Users/me/data.json', doc);
}

/** Apply a plan to its own document, so the test reads as before/after. */
function applied(state: EditorState, from = 0, to = state.doc.length): string | null {
  const plan = planJsonFormat(state, from, to);
  if (!plan) return null;
  return (
    state.doc.sliceString(0, plan.from) + plan.insert + state.doc.sliceString(plan.to)
  );
}

describe('the rule, keyed on file type', () => {
  const FENCED_TYPES = [
    null,                       // untitled — a new window
    '/Users/me/notes.md',
    '/Users/me/notes.markdown',
    '/Users/me/notes.txt',
    '/Users/me/NOTES.MD',       // the extension is lowercased before matching
  ];

  const BARE_TYPES = [
    '/Users/me/data.json',
    '/Users/me/script.py',
    '/Users/me/Program.cs',
    '/Users/me/deploy.sh',
    '/Users/me/main.rs',
    '/Users/me/index.ts',
    '/Users/me/config.yml',
    '/Users/me/.zshrc',         // extensionless shell config, not "no extension"
    '/Users/me/.env.local',     // env mode
    '/Users/me/README',         // no extension at all — still a code buffer
  ];

  for (const path of FENCED_TYPES) {
    it(`fences in ${path ?? 'an untitled buffer'}`, () => {
      const state = stateFor(path, MINIFIED);
      expect(shouldFenceAt(state, 0)).toBe(true);
      expect(planJsonFormat(state, 0, MINIFIED.length)?.fenced).toBe(true);
    });
  }

  for (const path of BARE_TYPES) {
    it(`does NOT fence in ${path}`, () => {
      const state = stateFor(path, MINIFIED);
      expect(shouldFenceAt(state, 0)).toBe(false);
      const plan = planJsonFormat(state, 0, MINIFIED.length)!;
      expect(plan.fenced).toBe(false);
      expect(plan.insert).toBe(EXPANDED);
    });
  }

  it('never writes a ``` line into a .py buffer — the corruption case', () => {
    // Three backticks in Python source is a syntax error, not a cosmetic
    // mistake. Checked on the plan and on the resulting document, for a
    // selection, for the whole buffer, and for JSON sitting mid-line among
    // real Python — every route the formatter can be reached by.
    const source = 'payload = ' + MINIFIED + '\nprint(payload)\n';
    const state = stateFor('/Users/me/script.py', source);

    const whole = applied(state);
    const selected = applied(state, source.indexOf('{'), source.indexOf('}') + 1);

    expect(whole).toBeNull(); // the whole file is not JSON end to end
    expect(selected).not.toBeNull();
    expect(selected).not.toContain('```');
    expect(selected!.startsWith('payload = ')).toBe(true);
    expect(selected).toContain('print(payload)');
  });

  it('a .py buffer holding nothing but JSON still gets no fence', () => {
    const state = stateFor('/Users/me/fixture.py', MINIFIED);
    expect(applied(state)).toBe(EXPANDED);
    expect(applied(state)).not.toContain('`');
  });
});

describe('shouldFenceAt', () => {
  it('is true in ordinary markdown prose', () => {
    expect(shouldFenceAt(mdState('hello world'), 3)).toBe(true);
  });

  it('is true in an empty document', () => {
    expect(shouldFenceAt(mdState(''), 0)).toBe(true);
  });

  it('is false in a .json buffer', () => {
    expect(shouldFenceAt(codeState(MINIFIED), 0)).toBe(false);
  });

  it('is false even while markdown is still the active language', () => {
    // The window `Editor.svelte`'s async `lang.load()` leaves open. The state
    // below has the markdown language installed and a `.py` path — which is
    // precisely the real editor one tick after opening a Python file.
    const state = stateFor('/Users/me/script.py', MINIFIED);
    expect(markdownLanguage.isActiveAt(state, 0, 1)).toBe(true);
    expect(shouldFenceAt(state, 0)).toBe(false);
  });

  it('treats a state with no documentPathField as untitled', () => {
    // Editor.svelte always installs it; a bare EditorState in a test has no
    // file, and no file is what an untitled buffer is.
    const bare = EditorState.create({ doc: 'hello', extensions: [md()] });
    expect(shouldFenceAt(bare, 0)).toBe(true);
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

  it('never emits a fence in a .json buffer', () => {
    const plan = planJsonFormat(codeState(MINIFIED), 0, MINIFIED.length)!;
    expect(plan.fenced).toBe(false);
    expect(plan.insert).toBe(EXPANDED);
  });

  it('has nothing to do for already-expanded JSON in a .json buffer', () => {
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
