import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { indentUnit, getIndentUnit } from '@codemirror/language';
import { insertNewlineAndIndent } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { defaultIndentUnit, detectIndentUnit, indentUnitFor } from './code-indent';

const lines = (s: string) => s.split('\n');

describe('detectIndentUnit', () => {
  it('reads four spaces from a Python file', () => {
    const src = 'def f(x):\n    return x + 1\n\nclass Dog:\n    def __init__(self):\n        self.a = 1\n';
    expect(detectIndentUnit(lines(src))).toBe('    ');
  });

  it('reads two spaces from a JavaScript file', () => {
    const src = 'function f() {\n  if (a) {\n    b();\n  }\n}\n';
    expect(detectIndentUnit(lines(src))).toBe('  ');
  });

  it('reads tabs', () => {
    const src = 'func main() {\n\tif a {\n\t\tb()\n\t}\n}\n';
    expect(detectIndentUnit(lines(src))).toBe('\t');
  });

  it('is not fooled by C comment stars or one aligned continuation line', () => {
    const src = [
      '/**',
      ' * Doc.',
      ' */',
      'int f(int a,',
      '      int b) {',
      '    if (a) {',
      '        return b;',
      '    }',
      '    while (b) {',
      '        b--;',
      '    }',
      '}',
    ].join('\n');
    expect(detectIndentUnit(lines(src))).toBe('    ');
  });

  it('has nothing to say about a flat or empty file', () => {
    expect(detectIndentUnit(lines(''))).toBeNull();
    expect(detectIndentUnit(lines('a = 1\nb = 2\n'))).toBeNull();
  });
});

describe('defaultIndentUnit / indentUnitFor', () => {
  it('follows the language convention when the file has no indentation', () => {
    expect(defaultIndentUnit('Python')).toBe('    ');
    expect(defaultIndentUnit('Go')).toBe('\t');
    expect(defaultIndentUnit('YAML')).toBe('  ');
    expect(indentUnitFor(lines(''), 'Python')).toBe('    ');
  });

  it("prefers the file's own unit over the convention", () => {
    expect(indentUnitFor(lines('def f():\n  pass\n'), 'Python')).toBe('  ');
  });
});

describe('Enter in a Python file', () => {
  it('indents a new block by the detected unit (the reported +2 instead of +4)', () => {
    const doc = 'class Dog:\n    def __init__(self):';
    let state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [python(), indentUnit.of(indentUnitFor(lines(doc), 'Python'))],
    });
    expect(getIndentUnit(state)).toBe(4);
    insertNewlineAndIndent({ state, dispatch: (tr) => (state = tr.state) });
    expect(state.doc.line(3).text).toBe('        ');
  });
});
