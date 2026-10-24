import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdownExtension } from '../markdown-language';
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
});
