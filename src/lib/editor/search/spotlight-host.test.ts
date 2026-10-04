import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdownExtension } from '../markdown-language';
import { tableConfig } from '../preview/table-config';
import { widgetHostLine } from './spotlight';

function hostOf(doc: string, needle: string, maxLines?: number): number | null {
  const state = EditorState.create({
    doc,
    extensions: [markdownExtension(), ...(maxLines ? [tableConfig.of({ maxLines, placeholder: '-' })] : [])],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  return widgetHostLine(state, doc.indexOf(needle))?.number ?? null;
}

describe('widgetHostLine — where a match inside a table is drawn', () => {
  const doc = 'intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n';

  it('a rendered table: on its header line, where the widget is', () => {
    expect(hostOf(doc, '3 |')).toBe(3);
  });

  it('a table over the cap stays raw: the match is on its own line, no host', () => {
    expect(hostOf(doc, '3 |', 3)).toBeNull();
    expect(hostOf(doc, '3 |', 4)).toBe(3);
  });
});
