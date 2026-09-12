// @vitest-environment jsdom
/**
 * The highlight of a comment anchored to text inside a table (#62).
 *
 * The document-level `Decoration.mark` that marks a commented fragment in
 * prose is still there for a table — but every row's source line below the
 * header is drawn at zero height, so the mark is painted onto nothing and the
 * reader sees no sign that a comment is attached to anything. The card carries
 * the quote; the text carries no answer to "which words?".
 *
 * So the widget draws the highlight itself, on the characters that are on
 * screen. These tests go through a real `EditorView`, because the interesting
 * part is not the mapping function — that is unit-tested next to its inverse in
 * `live-render/cell-anchor.test.ts` — but whether the mark reaches the DOM at
 * all: it has to survive the widget's `eq()`, the plugin's rebuild conditions
 * and the token split that renders the cell.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { Strikethrough, Table } from '@lezer/markdown';
import { livePreviewPlugin } from './plugin';
import { LIVE_PREVIEW, LIVE_RENDER, flavourFacet, type Flavour } from './flavour';
import {
  addAiComment,
  aiCommentField,
  removeAiComment,
  type CommentActions,
} from '../ai-comment';
import type { CommentThread } from '../../comment-format';

const markdownExt = markdown({
  base: markdownLanguage,
  extensions: [Strikethrough, Table],
});

function noopActions(): CommentActions {
  return {
    save: () => {},
    flush: () => {},
    sendNow: () => {},
    resolve: () => {},
    handoff: () => {},
    insertIntoText: () => {},
  };
}

function thread(id: string, quote: string): CommentThread {
  return { id, status: 'open', line: 1, quote, replies: [] };
}

/** A view over `doc`, caret parked on the last line, tree parsed up front. */
function makeView(doc: string, flavour: Flavour = LIVE_PREVIEW): EditorView {
  const padded = `${doc}\n\npark the caret here`;
  const state = EditorState.create({
    doc: padded,
    selection: { anchor: padded.length },
    extensions: [markdownExt, flavourFacet.of(flavour), aiCommentField, livePreviewPlugin],
  });
  ensureSyntaxTree(state, padded.length, 5000);
  return new EditorView({ state });
}

/** Anchor a comment over `[from, to)`, the way `App.svelte` does. */
function comment(view: EditorView, id: string, from: number, to: number): void {
  view.dispatch({
    effects: addAiComment.of({
      thread: thread(id, view.state.sliceDoc(from, to)),
      pos: from,
      to,
      orphaned: false,
      actions: noopActions(),
    }),
  });
}

/** Highlights drawn inside the rendered table, as {id, text}. */
function cellMarks(view: EditorView): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  for (const el of view.dom.querySelectorAll('.cm-md-table-celltext [data-comment-anchor]')) {
    out.push({
      id: el.getAttribute('data-comment-anchor') ?? '',
      text: el.textContent ?? '',
    });
  }
  return out;
}

const TABLE = ['| один | два |', '| --- | --- |', '| как дела | всё хорошо |'].join('\n');

describe('a comment on text inside a table cell', () => {
  it('marks the commented word in the rendered cell, not the hidden source line', () => {
    // The reported case: a comment on "как" left the document with no mark at
    // all, because the line it lives on is `height: 0`.
    const view = makeView(TABLE);
    const at = view.state.doc.toString().indexOf('как');
    comment(view, 'c-aaaaaa', at, at + 3);

    expect(cellMarks(view)).toEqual([{ id: 'c-aaaaaa', text: 'как' }]);
    view.destroy();
  });

  it('marks a header cell the same way', () => {
    const view = makeView(TABLE);
    const at = view.state.doc.toString().indexOf('два');
    comment(view, 'c-bbbbbb', at, at + 3);

    expect(cellMarks(view)).toEqual([{ id: 'c-bbbbbb', text: 'два' }]);
    view.destroy();
  });

  it('keeps two threads in one table apart', () => {
    const view = makeView(TABLE);
    const doc = view.state.doc.toString();
    const first = doc.indexOf('как');
    comment(view, 'c-aaaaaa', first, first + 8); // "как дела"
    const second = doc.indexOf('всё');
    comment(view, 'c-bbbbbb', second, second + 3);

    expect(cellMarks(view)).toEqual([
      { id: 'c-aaaaaa', text: 'как дела' },
      { id: 'c-bbbbbb', text: 'всё' },
    ]);
    view.destroy();
  });

  it('marks the rendered word of a formatted span, markers and all', () => {
    // The anchor stores `**дела**` — that is what a re-anchor search can find
    // again — but only "дела" is on screen, and that is what gets marked.
    const doc = ['| один | два |', '| --- | --- |', '| как **дела** | всё |'].join('\n');
    const view = makeView(doc);
    const at = view.state.doc.toString().indexOf('**дела**');
    comment(view, 'c-cccccc', at, at + '**дела**'.length);

    expect(cellMarks(view)).toEqual([{ id: 'c-cccccc', text: 'дела' }]);
    // Drawn inside the <strong>, so the word keeps its weight.
    const mark = view.dom.querySelector('.cm-md-table-celltext [data-comment-anchor]');
    expect(mark?.parentElement?.tagName).toBe('STRONG');
    view.destroy();
  });

  it('still marks the same word after an edit above the table', () => {
    // Positions map through the comment field, and the table re-reads them on
    // every rebuild — a copy kept anywhere else would be stale by now.
    const view = makeView(`заголовок\n\n${TABLE}`);
    const at = view.state.doc.toString().indexOf('как');
    comment(view, 'c-aaaaaa', at, at + 3);

    view.dispatch({ changes: { from: 0, insert: '# ' } });
    expect(cellMarks(view)).toEqual([{ id: 'c-aaaaaa', text: 'как' }]);

    view.dispatch({ changes: { from: 0, to: 2, insert: '' } });
    expect(cellMarks(view)).toEqual([{ id: 'c-aaaaaa', text: 'как' }]);
    view.destroy();
  });

  it('takes the mark away with the thread', () => {
    const view = makeView(TABLE);
    const at = view.state.doc.toString().indexOf('как');
    comment(view, 'c-aaaaaa', at, at + 3);
    expect(cellMarks(view)).toHaveLength(1);

    view.dispatch({ effects: removeAiComment.of('c-aaaaaa') });
    expect(cellMarks(view)).toEqual([]);
    view.destroy();
  });

  it('reads the same in live-render', () => {
    const view = makeView(TABLE, LIVE_RENDER);
    const at = view.state.doc.toString().indexOf('как');
    comment(view, 'c-aaaaaa', at, at + 3);

    expect(cellMarks(view)).toEqual([{ id: 'c-aaaaaa', text: 'как' }]);
    view.destroy();
  });

  it('leaves the cell text itself untouched', () => {
    // The mark splits text nodes; what the cell reads, and therefore what a
    // copy out of it yields, must not change.
    const view = makeView(TABLE);
    const at = view.state.doc.toString().indexOf('как');
    comment(view, 'c-aaaaaa', at, at + 3);

    const cells = [...view.dom.querySelectorAll('.cm-md-table-celltext')].map(
      (el) => el.textContent
    );
    expect(cells).toContain('как дела');
    view.destroy();
  });
});
