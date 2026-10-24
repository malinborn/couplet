import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { languages } from '@codemirror/language-data';
import { markdownExtension } from '../markdown-language';
import { MAX_EXPRESSION_LENGTH } from './evaluate';
import { findExpression } from './trigger';

/**
 * The LAST `|` marks the caret; it is removed from the document. Last, not
 * first: a table's own pipes come before the caret.
 */
function at(docWithCaret: string) {
  const pos = docWithCaret.lastIndexOf('|');
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
    // The case above is already refused by rule 1 (the closing backtick is
    // right of the caret); only an inline span across a line break reaches
    // the syntax-tree check with nothing right of the caret.
    ['`5 + 3 =|\n`', 'inline code across a line break'],
    ['| a | b |\n|---|---|\n| 1 | 5 + 3 =|', 'table row'],
  ])('nothing for %j (%s)', (doc) => {
    expect(at(doc)).toBeNull();
  });

  it('refuses a run of expression characters longer than the limit, never truncates it', () => {
    const doc = '1000+'.repeat(50) + '1000 =|';
    expect(doc.length - 3).toBeGreaterThan(MAX_EXPRESSION_LENGTH);
    expect(at(doc)).toBeNull();
    // Exactly at the limit is fine.
    const atLimit = '1+'.repeat(99) + '11';
    expect(atLimit.length).toBe(MAX_EXPRESSION_LENGTH);
    expect(at('итого ' + atLimit + ' =|')?.answer).toBe('110');
    // Same length budget, but text stops the run: the tail is short enough.
    expect(at('1000+'.repeat(50) + 'итого 1000 + 1 =|')?.answer).toBe('1001');
  });

  it.each([
    ['.5 + 1 =|', 'starts inside a number after `.`'],
    ['1e5 + 1 =|', 'exponent'],
    ['0x10 + 1 =|', 'hex'],
    ['1 5000 + 1 =|', 'not a thousands group'],
    ['12 34 + 1 =|', 'two adjacent numbers'],
    ['12345 678 + 1 =|', 'leading group longer than three digits'],
    ['1,5,5 + 1 =|', 'two commas'],
    ['1,500 000 + 1 =|', 'comma then a group'],
    ['v1.2.3 + 1 =|', 'version string'],
    ['1 5000 + 1 =|', 'not a group after a no-break space'],
    ['9007199254740993 - 9007199254740992 =|', 'more than 15 significant digits'],
    ['шаг 2 (3+4) =|', 'right after a number, only spaces between'],
  ])('starts only at a token boundary: nothing for %j (%s)', (doc) => {
    expect(at(doc)).toBeNull();
  });

  it.each([
    ['шаг 2) (3+4) =|', '7'],
    ['Итого: 338 * 1.3 =|', '439.4'],
    ['x = 5 + 3 =|', '8'],
    ['Например, 5 + 3 =|', '8'],
    ['1 500 + 1 =|', '1 501'],
    ['1 500 + 1 =|', '1 501'],
  ])('still finds %j → %s', (doc, answer) => {
    expect(at(doc)?.answer).toBe(answer);
  });

  it('only in markdown documents', async () => {
    expect(at('5 + 3 =|')?.answer).toBe('8');
    const plain = EditorState.create({ doc: '5 + 3 =' });
    expect(findExpression(plain, 7)).toBeNull();
    const description = languages.find((l) => l.name === 'JSON');
    if (!description) throw new Error('JSON missing from @codemirror/language-data');
    const code = EditorState.create({ doc: '5 + 3 =', extensions: [await description.load()] });
    expect(findExpression(code, 7)).toBeNull();
  });
});
