import { describe, it, expect } from 'vitest';
import { EditorState, Text } from '@codemirror/state';
import { tableConfig, DEFAULT_TABLE_CONFIG } from './table-config';
import { buildTableContext } from './tables';
import { newRowMarkdown } from './table-navigation';

function table(dataRows: number): string {
  const lines = ['| a | b |', '| - | - |'];
  for (let i = 0; i < dataRows; i++) lines.push(`| ${i} | x |`);
  return lines.join('\n');
}

describe('tableConfig facet', () => {
  it('defaults to today: 500 lines, "-" placeholder', () => {
    const state = EditorState.create({ doc: '' });
    expect(state.facet(tableConfig)).toEqual({ maxLines: 500, placeholder: '-' });
    expect(DEFAULT_TABLE_CONFIG).toEqual({ maxLines: 500, placeholder: '-' });
  });

  it('freezes the default, so no caller can change markdown tables by mutating it', () => {
    expect(Object.isFrozen(DEFAULT_TABLE_CONFIG)).toBe(true);
  });

  it('takes the last provided value', () => {
    const state = EditorState.create({
      extensions: [tableConfig.of({ maxLines: 1, placeholder: 'a' }), tableConfig.of({ maxLines: 2, placeholder: 'b' })],
    });
    expect(state.facet(tableConfig)).toEqual({ maxLines: 2, placeholder: 'b' });
  });
});

describe('buildTableContext cap', () => {
  it('keeps the 500-line cap by default', () => {
    const doc = Text.of(table(499).split('\n')); // 501 lines
    expect(buildTableContext(doc, 0, doc.length)).toBeNull();
  });

  it('draws a 501-line table when the cap is raised', () => {
    const doc = Text.of(table(499).split('\n'));
    expect(buildTableContext(doc, 0, doc.length, Infinity)).not.toBeNull();
  });
});

describe('newRowMarkdown placeholder', () => {
  it('defaults to "-"', () => {
    expect(newRowMarkdown([1, 3])).toBe('| - | -   |');
  });

  it('uses the given placeholder, including an empty one', () => {
    expect(newRowMarkdown([1, 3], 'x')).toBe('| x | x   |');
    expect(newRowMarkdown([1, 3], '')).toBe('|   |     |');
  });
});
