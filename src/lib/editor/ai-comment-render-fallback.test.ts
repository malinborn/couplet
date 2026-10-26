// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

// The renderer failing on a message — whatever the cause — must cost that
// message its formatting, never the card (and every card rebuilt with it).
vi.mock('./comment-markdown', () => ({
  COMMENT_MD_CLASS: 'cm-ai-comment-md',
  renderCommentMarkdown: () => {
    throw new RangeError('Maximum call stack size exceeded');
  },
}));

import { CommentWidget, type CommentActions } from './ai-comment';

const noop = () => {};
const actions: CommentActions = {
  save: noop,
  flush: noop,
  sendNow: noop,
  resolve: noop,
  handoff: noop,
  insertIntoText: noop,
  compose: noop,
  send: () => Promise.resolve(false),
  edit: () => Promise.resolve(false),
  editing: noop,
};

describe('CommentWidget — a message the renderer cannot handle', () => {
  it('shows it as plain text and still builds the card, in both modes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const mode of ['chat', 'live'] as const) {
      const widget = new CommentWidget({
        thread: {
          id: 'c-aaaaaa',
          status: 'answered',
          line: 1,
          quote: 'q',
          replies: [{ author: 'agent', at: '17:00', text: '>>>> **deep**' }],
        },
        orphaned: false,
        actions,
        mode,
      });
      const root = widget.toDOM();
      const body = root.querySelector('.cm-ai-comment-text');
      expect(body?.textContent).toBe('>>>> **deep**');
      expect(root.querySelector('.cm-ai-comment-head')).not.toBeNull();
    }
  });
});
