import { describe, it, expect } from 'vitest';
import { ChangeSet, EditorSelection, EditorState, Text } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Strikethrough, Table } from '@lezer/markdown';
import { markupModelField, type MarkupPair } from './atomic';
import { whitespaceCorrections, isDelimiterRunPair } from './markup-whitespace';

function pairsOf(doc: string): readonly MarkupPair[] {
  return EditorState.create({
    doc,
    extensions: [
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        extensions: [Strikethrough, Table],
      }),
      markupModelField,
    ],
  }).field(markupModelField).pairs;
}

/**
 * Run the guard the way the filter does: take the pairs of `before`, apply
 * `change`, then correct the result. Returns the final document — which is the
 * only thing #66 is actually about.
 */
function guard(before: string, change: { from: number; to?: number; insert?: string }): string {
  const changes = ChangeSet.of(
    [{ from: change.from, to: change.to ?? change.from, insert: change.insert ?? '' }],
    before.length
  );
  const newDoc = Text.of(changes.apply(Text.of(before.split('\n'))).toString().split('\n'));
  const result = whitespaceCorrections(
    pairsOf(before),
    (pos, assoc) => changes.mapPos(pos, assoc),
    newDoc
  );
  if (!result) return newDoc.toString();
  return ChangeSet.of(result.changes, newDoc.length).apply(newDoc).toString();
}

describe('isDelimiterRunPair', () => {
  it('covers the three kinds CommonMark flanking rules apply to', () => {
    const kinds = pairsOf('**a** *b* ~~c~~ `d` [e](f)')
      .filter(isDelimiterRunPair)
      .map((p) => p.kind)
      .sort();
    expect(kinds).toEqual(['emphasis', 'strikethrough', 'strong']);
  });
});

describe('whitespaceCorrections — the three gestures measured broken on dev-preview', () => {
  // `ПРивет **как**`: open 7..9, content 9..12, close 12..14.
  it('a space typed at the content end moves outside the closing marker', () => {
    expect(guard('ПРивет **как**', { from: 12, insert: ' ' })).toBe('ПРивет **как** ');
  });

  it('Backspace that would strand whitespace against the marker moves it out too', () => {
    // `ПРивет **как x**`: deleting `x` leaves `**как **`.
    expect(guard('ПРивет **как x**', { from: 13, to: 14 })).toBe('ПРивет **как** ');
  });

  it('a programmatic insert with a trailing space is corrected the same way', () => {
    expect(guard('ПРивет **как**', { from: 12, insert: ' мир ' })).toBe('ПРивет **как мир** ');
  });
});

describe('whitespaceCorrections — the opening edge', () => {
  it('a space after the opening marker moves outside it, to the left', () => {
    expect(guard('ПРивет **как**', { from: 9, insert: ' ' })).toBe('ПРивет  **как**');
  });

  it('handles both edges in one change', () => {
    expect(guard('ПРивет **как**', { from: 9, to: 12, insert: ' мир ' })).toBe('ПРивет  **мир** ');
  });
});

describe('whitespaceCorrections — what it must not touch', () => {
  it('leaves a well-formed span alone', () => {
    expect(
      whitespaceCorrections(pairsOf('ПРивет **как**'), (p) => p, Text.of(['ПРивет **как**']))
    ).toBeNull();
  });

  it('leaves inline code alone — a trailing space there is valid content', () => {
    expect(guard('ПРивет `как`', { from: 11, insert: ' ' })).toBe('ПРивет `как `');
  });

  it('leaves internal whitespace alone', () => {
    expect(guard('**как мир**', { from: 5, insert: ' ' })).toBe('**как  мир**');
  });

  it('never drops or rewrites the characters it moves — a two-space hard break survives', () => {
    // `**жир**` at end of line, then the two spaces markdown reads as `<br>`.
    expect(guard('**жир**  \nдальше', { from: 5, insert: 'x' })).toBe('**жирx**  \nдальше');
  });

  it('drops the markers when the content becomes all whitespace — `** **` is literal text', () => {
    expect(guard('a **b** c', { from: 4, to: 5, insert: ' ' })).toBe('a   c');
  });

  it('skips a pair whose markers were rewritten by another layer', () => {
    // The whole span is replaced: the mapped marker slices no longer read as
    // the markers, so the pair is somebody else's business.
    expect(guard('ПРивет **как**', { from: 7, to: 14, insert: 'plain ' })).toBe('ПРивет plain ');
  });
});

describe('whitespaceCorrections — the caret follows the whitespace it moved', () => {
  it('reports the move so the filter can put the caret past the relocated space', () => {
    const before = 'ПРивет **как**';
    const changes = ChangeSet.of([{ from: 12, to: 12, insert: ' ' }], before.length);
    const newDoc = Text.of([changes.apply(Text.of([before])).toString()]);
    const result = whitespaceCorrections(pairsOf(before), (p, a) => changes.mapPos(p, a), newDoc);
    expect(result).not.toBeNull();

    // The typed space sits at [12,13) of the post-change document and lands after 15.
    const move = result!.moves[0];
    expect([move.from, move.to, move.landsAfter]).toEqual([12, 13, 15]);

    const corrective = ChangeSet.of(result!.changes, newDoc.length);
    const caret = EditorSelection.cursor(corrective.mapPos(move.landsAfter, 1));
    expect(corrective.apply(newDoc).toString()).toBe('ПРивет **как** ');
    expect(caret.head).toBe(15); // end of the document, past the space
  });
});
