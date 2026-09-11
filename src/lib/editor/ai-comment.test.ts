import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import {
  addAiComment,
  removeAiComment,
  clearAiComments,
  aiCommentField,
  CommentWidget,
  type CommentActions,
} from './ai-comment';
import type { CommentThread } from '../comment-format';

function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 'c-7f3a2c',
    status: 'open',
    line: 1,
    quote: 'первая',
    replies: [{ author: 'Макс', at: '14:02', text: 'Почему?' }],
    ...overrides,
  };
}

function makeActions(overrides: Partial<CommentActions> = {}): CommentActions {
  return {
    save: vi.fn(),
    flush: vi.fn(),
    resolve: vi.fn(),
    handoff: vi.fn(),
    insertIntoText: vi.fn(),
    ...overrides,
  };
}

function makeState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [aiCommentField] });
}

/** All comment widgets currently in the field, as {pos, widget}. */
function collectWidgets(state: EditorState): Array<{ pos: number; widget: CommentWidget }> {
  const set = state.field(aiCommentField, false);
  const out: Array<{ pos: number; widget: CommentWidget }> = [];
  if (set) {
    set.between(0, state.doc.length, (from, _to, value) => {
      const widget = (value.spec as { widget: unknown }).widget;
      if (widget instanceof CommentWidget) out.push({ pos: from, widget });
    });
  }
  return out;
}

describe('aiCommentField', () => {
  it('adds one widget per thread', () => {
    const state = makeState('первая\nвторая\n');
    const tr = state.update({
      effects: addAiComment.of({ thread: thread(), pos: 0, to: 0, orphaned: false, actions: makeActions() }),
    });
    expect(collectWidgets(tr.state)).toHaveLength(1);
  });

  it('installs a widget decoration anchored at the end of the target line', () => {
    const state = makeState('line1\nline2\n');
    const pos = state.doc.line(1).from + 2; // mid line1
    const tr = state.update({
      effects: addAiComment.of({ thread: thread(), pos, to: pos, orphaned: false, actions: makeActions() }),
    });
    expect(collectWidgets(tr.state)[0].pos).toBe(state.doc.line(1).to);
  });

  it('keeps two concurrent threads, each with its own widget', () => {
    let state = makeState('line1\nline2\nline3\n');
    state = state.update({
      effects: addAiComment.of({
        thread: thread({ id: 'c-aaaaaa' }),
        pos: state.doc.line(1).from,
        to: state.doc.line(1).from,
        orphaned: false,
        actions: makeActions(),
      }),
    }).state;
    state = state.update({
      effects: addAiComment.of({
        thread: thread({ id: 'c-bbbbbb' }),
        pos: state.doc.line(3).from,
        to: state.doc.line(3).from,
        orphaned: false,
        actions: makeActions(),
      }),
    }).state;

    expect(collectWidgets(state)).toHaveLength(2);
  });

  it('removes a widget by id', () => {
    let state = makeState('первая\nвторая\n');
    state = state.update({
      effects: addAiComment.of({ thread: thread(), pos: 0, to: 0, orphaned: false, actions: makeActions() }),
    }).state;
    state = state.update({ effects: removeAiComment.of('c-7f3a2c') }).state;
    expect(collectWidgets(state)).toHaveLength(0);
  });

  it('removing an absent id is a no-op', () => {
    let state = makeState('первая\n');
    state = state.update({
      effects: addAiComment.of({ thread: thread(), pos: 0, to: 0, orphaned: false, actions: makeActions() }),
    }).state;
    state = state.update({ effects: removeAiComment.of('c-nope00') }).state;
    expect(collectWidgets(state)).toHaveLength(1);
  });

  it('clearAiComments removes every widget', () => {
    let state = makeState('line1\nline2\n');
    state = state.update({
      effects: [
        addAiComment.of({
          thread: thread({ id: 'c-aaaaaa' }),
          pos: state.doc.line(1).from,
          to: state.doc.line(1).from,
          orphaned: false,
          actions: makeActions(),
        }),
        addAiComment.of({
          thread: thread({ id: 'c-bbbbbb' }),
          pos: state.doc.line(2).from,
          to: state.doc.line(2).from,
          orphaned: false,
          actions: makeActions(),
        }),
      ],
    }).state;
    state = state.update({ effects: clearAiComments.of(null) }).state;
    expect(collectWidgets(state)).toHaveLength(0);
  });

  it('maps the widget position through an edit above it', () => {
    let state = makeState('line1\nline2\nline3\n');
    const targetLineStart = state.doc.line(3).from;
    state = state.update({
      effects: addAiComment.of({ thread: thread(), pos: targetLineStart, to: targetLineStart, orphaned: false, actions: makeActions() }),
    }).state;
    const before = collectWidgets(state)[0].pos;

    const tr = state.update({ changes: { from: 0, to: 0, insert: 'XXXX\n' } });

    const after = collectWidgets(tr.state)[0].pos;
    expect(after).toBe(before + 'XXXX\n'.length);
    expect(collectWidgets(tr.state)).toHaveLength(1);
  });
});

describe('CommentWidget.eq', () => {
  it('is equal for the same thread content, even with different action identities', () => {
    const a = new CommentWidget({ thread: thread(), orphaned: false, actions: makeActions() });
    const b = new CommentWidget({ thread: thread(), orphaned: false, actions: makeActions() });
    expect(a.eq(b)).toBe(true);
  });

  it('differs when the status changes', () => {
    const a = new CommentWidget({ thread: thread(), orphaned: false, actions: makeActions() });
    const b = new CommentWidget({ thread: thread({ status: 'answered' }), orphaned: false, actions: makeActions() });
    expect(a.eq(b)).toBe(false);
  });

  it('ignores the user\'s own unanswered turn — autosave must not rebuild the card', () => {
    // The box rewrites this reply in the file on every debounce. If it counted
    // towards equality, each save would replace the textarea being typed into.
    const actions = makeActions();
    const a = new CommentWidget({
      thread: thread({ replies: [{ author: 'You', at: '14:02', text: 'поче' }] }),
      orphaned: false,
      actions,
    });
    const b = new CommentWidget({
      thread: thread({ replies: [{ author: 'You', at: '14:03', text: 'почему не nginx' }] }),
      orphaned: false,
      actions,
    });
    expect(a.eq(b)).toBe(true);
  });

  it('differs once an agent answers, which is what freezes the turn above it', () => {
    const actions = makeActions();
    const a = new CommentWidget({
      thread: thread({ replies: [{ author: 'You', at: '14:02', text: 'почему' }] }),
      orphaned: false,
      actions,
    });
    const b = new CommentWidget({
      thread: thread({
        replies: [
          { author: 'You', at: '14:02', text: 'почему' },
          { author: 'agent', at: '14:05', text: 'потому' },
        ],
      }),
      orphaned: false,
      actions,
    });
    expect(a.eq(b)).toBe(false);
  });

  it('ignores the in-flight text — including it would rebuild on every keystroke', () => {
    const actions = makeActions();
    const a = new CommentWidget({ thread: thread(), orphaned: false, actions, draft: 'по' });
    const b = new CommentWidget({ thread: thread(), orphaned: false, actions, draft: 'почему' });
    expect(a.eq(b)).toBe(true);
  });

  it('differs when a reply is added', () => {
    const withReply = thread({
      replies: [
        { author: 'Макс', at: '14:02', text: 'Почему?' },
        { author: 'agent', at: '14:05', text: 'Потому.' },
      ],
    });
    const a = new CommentWidget({ thread: thread(), orphaned: false, actions: makeActions() });
    const b = new CommentWidget({ thread: withReply, orphaned: false, actions: makeActions() });
    expect(a.eq(b)).toBe(false);
  });

  it('differs when the anchor became orphaned', () => {
    const a = new CommentWidget({ thread: thread(), orphaned: false, actions: makeActions() });
    const b = new CommentWidget({ thread: thread(), orphaned: true, actions: makeActions() });
    expect(a.eq(b)).toBe(false);
  });

  it('differs when the quote text changes', () => {
    const a = new CommentWidget({ thread: thread(), orphaned: false, actions: makeActions() });
    const b = new CommentWidget({ thread: thread({ quote: 'другая' }), orphaned: false, actions: makeActions() });
    expect(a.eq(b)).toBe(false);
  });
});

describe('CommentWidget.ignoreEvent', () => {
  it('always returns true, so CM6 does not turn clicks into selection changes', () => {
    const widget = new CommentWidget({ thread: thread(), orphaned: false, actions: makeActions() });
    expect(widget.ignoreEvent()).toBe(true);
  });
});

// --- toDOM click wiring ------------------------------------------------
//
// This project's test env has no DOM (no jsdom/happy-dom dependency — see
// ai-ask.test.ts, which solves the same problem). Stub a minimal `document`
// with just enough surface for `toDOM()` to run, and fire the recorded
// listeners directly.

interface FakeEvent {
  preventDefault(): void;
  stopPropagation(): void;
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

interface FakeElement {
  tagName: string;
  className: string;
  type: string;
  textContent: string;
  value: string;
  placeholder: string;
  children: FakeElement[];
  attributes: Record<string, string>;
  listeners: Record<string, Array<(event: FakeEvent) => void>>;
  appendChild(child: FakeElement): void;
  addEventListener(type: string, handler: (event: FakeEvent) => void): void;
  setAttribute(name: string, value: string): void;
}

function createFakeElement(tagName: string): FakeElement {
  const el: FakeElement = {
    tagName,
    className: '',
    type: '',
    textContent: '',
    value: '',
    placeholder: '',
    children: [],
    attributes: {},
    listeners: {},
    appendChild(child) {
      el.children.push(child);
    },
    addEventListener(type, handler) {
      (el.listeners[type] ??= []).push(handler);
    },
    setAttribute(name, value) {
      el.attributes[name] = value;
    },
  };
  return el;
}

function fire(
  el: FakeElement,
  type: string,
  extra: Partial<Pick<FakeEvent, 'key' | 'metaKey' | 'ctrlKey'>> = {}
): { preventDefault: ReturnType<typeof vi.fn>; stopPropagation: ReturnType<typeof vi.fn> } {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  const event: FakeEvent = { preventDefault, stopPropagation, ...extra };
  for (const handler of el.listeners[type] ?? []) {
    handler(event);
  }
  return { preventDefault, stopPropagation };
}

/** `className` is a real DOM space-separated token list — match by word, not
 * exact string, so a single class name finds it regardless of what else is
 * set alongside it (e.g. `cm-ai-comment cm-ai-comment-orphaned`). */
function findByClass(root: FakeElement, className: string): FakeElement[] {
  const out: FakeElement[] = [];
  if (root.className.split(' ').includes(className)) out.push(root);
  for (const child of root.children) out.push(...findByClass(child, className));
  return out;
}

describe('CommentWidget.toDOM root element', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a cm-ai-comment-wrap root with a single cm-ai-comment card nested one level inside', () => {
    // Regression: `.cm-ai-comment-wrap` carries the widget's vertical spacing
    // as padding. If that spacing ever moves back onto `.cm-ai-comment` as
    // margin, CM6's block-widget height map (measured from the DOM box,
    // which excludes margin) desyncs from the real line positions — margin
    // still pushes lines below the widget down on screen, but CM6 doesn't
    // count it, so `posAtCoords`'s vertical scan walks past every line below
    // the widget. See ai-ask.ts's AskWidget for the original repro.
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new CommentWidget({ thread: thread(), orphaned: false, actions: makeActions() });

    const dom = widget.toDOM() as unknown as FakeElement;
    expect(dom.className).toBe('cm-ai-comment-wrap');
    expect(dom.children).toHaveLength(1);
    expect(dom.children[0].className).toBe('cm-ai-comment');
  });

  it('marks an orphaned thread with the orphaned class alongside the base class', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new CommentWidget({ thread: thread(), orphaned: true, actions: makeActions() });

    const dom = widget.toDOM() as unknown as FakeElement;
    expect(dom.children[0].className.split(' ')).toEqual(
      expect.arrayContaining(['cm-ai-comment', 'cm-ai-comment-orphaned'])
    );
  });
});

describe('CommentWidget.toDOM replies', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders one reply block per reply, with author/timestamp and text', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const withTwo = thread({
      replies: [
        { author: 'Макс', at: '14:02', text: 'Почему не nginx?' },
        { author: 'agent', at: '14:05', text: 'Он был сломан.' },
      ],
    });
    const widget = new CommentWidget({ thread: withTwo, orphaned: false, actions: makeActions() });

    const dom = widget.toDOM() as unknown as FakeElement;
    const replies = findByClass(dom, 'cm-ai-comment-reply');
    expect(replies).toHaveLength(2);
    expect(findByClass(replies[0], 'cm-ai-comment-author')[0].textContent).toBe('Макс · 14:02');
    expect(findByClass(replies[0], 'cm-ai-comment-text')[0].textContent).toBe('Почему не nginx?');
    expect(findByClass(replies[1], 'cm-ai-comment-author')[0].textContent).toBe('agent · 14:05');
  });
});

describe('CommentWidget.toDOM action buttons', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('always renders a handoff button, and clicking it calls actions.handoff(id)', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const actions = makeActions();
    const widget = new CommentWidget({ thread: thread({ id: 'c-aaaaaa' }), orphaned: false, actions });

    const dom = widget.toDOM() as unknown as FakeElement;
    const [handoffButton] = findByClass(dom, 'cm-ai-comment-button').filter(
      (el) => el.textContent === 'send to agent'
    );
    fire(handoffButton, 'click');

    expect(actions.handoff).toHaveBeenCalledTimes(1);
    expect(actions.handoff).toHaveBeenCalledWith('c-aaaaaa');
  });

  it('renders a resolve button for an open thread, and clicking it calls actions.resolve(id)', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const actions = makeActions();
    const widget = new CommentWidget({ thread: thread({ id: 'c-aaaaaa', status: 'open' }), orphaned: false, actions });

    const dom = widget.toDOM() as unknown as FakeElement;
    const [resolveButton] = findByClass(dom, 'cm-ai-comment-button').filter((el) => el.textContent === 'resolve');
    fire(resolveButton, 'click');

    expect(actions.resolve).toHaveBeenCalledWith('c-aaaaaa');
  });

  it('does not render a resolve button once the thread is already resolved', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new CommentWidget({ thread: thread({ status: 'resolved' }), orphaned: false, actions: makeActions() });

    const dom = widget.toDOM() as unknown as FakeElement;
    const resolveButtons = findByClass(dom, 'cm-ai-comment-button').filter((el) => el.textContent === 'resolve');
    expect(resolveButtons).toHaveLength(0);
  });

  it('renders an insert-into-text button only when answered, calling actions.insertIntoText with the last reply', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const actions = makeActions();
    const answered = thread({
      id: 'c-aaaaaa',
      status: 'answered',
      replies: [
        { author: 'Макс', at: '14:02', text: 'Вопрос?' },
        { author: 'agent', at: '14:05', text: 'Ответ.' },
      ],
    });
    const widget = new CommentWidget({ thread: answered, orphaned: false, actions });

    const dom = widget.toDOM() as unknown as FakeElement;
    const [insertButton] = findByClass(dom, 'cm-ai-comment-button').filter(
      (el) => el.textContent === 'insert into text'
    );
    fire(insertButton, 'click');

    expect(actions.insertIntoText).toHaveBeenCalledWith('c-aaaaaa', 'Ответ.');
  });

  it('does not render an insert-into-text button for an open thread', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new CommentWidget({ thread: thread({ status: 'open' }), orphaned: false, actions: makeActions() });

    const dom = widget.toDOM() as unknown as FakeElement;
    const insertButtons = findByClass(dom, 'cm-ai-comment-button').filter(
      (el) => el.textContent === 'insert into text'
    );
    expect(insertButtons).toHaveLength(0);
  });

  it('action buttons call preventDefault on mousedown, so the editor selection never moves', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new CommentWidget({ thread: thread(), orphaned: false, actions: makeActions() });

    const dom = widget.toDOM() as unknown as FakeElement;
    const [handoffButton] = findByClass(dom, 'cm-ai-comment-button');
    const { preventDefault } = fire(handoffButton, 'mousedown');

    expect(preventDefault).toHaveBeenCalledTimes(1);
  });
});

describe('CommentWidget.toDOM comment box', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is a textarea: a comment is prose, and Enter has to make a new line', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new CommentWidget({ thread: thread(), orphaned: false, actions: makeActions() });

    const dom = widget.toDOM() as unknown as FakeElement;
    const [box] = findByClass(dom, 'cm-ai-comment-input');
    expect(box.tagName).toBe('textarea');
  });

  it('reports every keystroke through save — there is no send action', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const actions = makeActions();
    const widget = new CommentWidget({ thread: thread({ id: 'c-aaaaaa' }), orphaned: false, actions });

    const dom = widget.toDOM() as unknown as FakeElement;
    const [box] = findByClass(dom, 'cm-ai-comment-input');
    box.value = 'поче';
    fire(box, 'input');
    box.value = 'почему';
    fire(box, 'input');

    expect(actions.save).toHaveBeenNthCalledWith(1, 'c-aaaaaa', 'поче');
    expect(actions.save).toHaveBeenNthCalledWith(2, 'c-aaaaaa', 'почему');
  });

  it('writes on blur, because clicking away is what used to lose the text', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const actions = makeActions();
    const widget = new CommentWidget({ thread: thread({ id: 'c-aaaaaa' }), orphaned: false, actions });

    const dom = widget.toDOM() as unknown as FakeElement;
    const [box] = findByClass(dom, 'cm-ai-comment-input');
    fire(box, 'blur');

    expect(actions.flush).toHaveBeenCalledWith('c-aaaaaa');
  });

  it('plain Enter does not write — it is a newline, not a send', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const actions = makeActions();
    const widget = new CommentWidget({ thread: thread(), orphaned: false, actions });

    const dom = widget.toDOM() as unknown as FakeElement;
    const [box] = findByClass(dom, 'cm-ai-comment-input');
    const { preventDefault } = fire(box, 'keydown', { key: 'Enter' });

    expect(actions.flush).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('Cmd+Enter writes immediately, for "I am done" without waiting for the debounce', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const actions = makeActions();
    const widget = new CommentWidget({ thread: thread({ id: 'c-aaaaaa' }), orphaned: false, actions });

    const dom = widget.toDOM() as unknown as FakeElement;
    const [box] = findByClass(dom, 'cm-ai-comment-input');
    const { preventDefault } = fire(box, 'keydown', { key: 'Enter', metaKey: true });

    expect(actions.flush).toHaveBeenCalledWith('c-aaaaaa');
    expect(preventDefault).toHaveBeenCalled();
  });

  it('shows the user\'s unanswered turn in the box, not as a finished block', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new CommentWidget({
      thread: thread({ replies: [{ author: 'You', at: '14:02', text: 'Почему не nginx?' }] }),
      orphaned: false,
      actions: makeActions(),
    });

    const dom = widget.toDOM() as unknown as FakeElement;
    const [box] = findByClass(dom, 'cm-ai-comment-input');
    expect(box.value).toBe('Почему не nginx?');
    // …and nothing is rendered as a finished reply above it.
    expect(findByClass(dom, 'cm-ai-comment-reply')).toHaveLength(0);
  });

  it('freezes that turn and comes up empty once an agent has answered', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new CommentWidget({
      thread: thread({
        status: 'answered',
        replies: [
          { author: 'You', at: '14:02', text: 'Почему не nginx?' },
          { author: 'agent', at: '14:05', text: 'Он был сломан.' },
        ],
      }),
      orphaned: false,
      actions: makeActions(),
    });

    const dom = widget.toDOM() as unknown as FakeElement;
    expect(findByClass(dom, 'cm-ai-comment-reply')).toHaveLength(2);
    const [box] = findByClass(dom, 'cm-ai-comment-input');
    expect(box.value).toBe('');
  });

  it('prefers in-flight text over what the file says, so a rebuild swallows nothing', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new CommentWidget({
      thread: thread({ replies: [{ author: 'You', at: '14:02', text: 'сохранённое' }] }),
      orphaned: false,
      actions: makeActions(),
      draft: 'сохранённое и ещё не сохранённое',
    });

    const dom = widget.toDOM() as unknown as FakeElement;
    const [box] = findByClass(dom, 'cm-ai-comment-input');
    expect(box.value).toBe('сохранённое и ещё не сохранённое');
  });

  it('writes what is in the box when its DOM goes away', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const actions = makeActions();
    const widget = new CommentWidget({ thread: thread({ id: 'c-aaaaaa' }), orphaned: false, actions });

    widget.destroy();

    expect(actions.flush).toHaveBeenCalledWith('c-aaaaaa');
  });

  it('carries the thread id on the box, so the app can find it after a rebuild', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new CommentWidget({ thread: thread({ id: 'c-aaaaaa' }), orphaned: false, actions: makeActions() });

    const dom = widget.toDOM() as unknown as FakeElement;
    const [box] = findByClass(dom, 'cm-ai-comment-input');
    expect(box.attributes['data-comment-input']).toBe('c-aaaaaa');
  });

  it('Escape leaves the box alone rather than writing', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const actions = makeActions();
    const widget = new CommentWidget({ thread: thread(), orphaned: false, actions });

    const dom = widget.toDOM() as unknown as FakeElement;
    const [box] = findByClass(dom, 'cm-ai-comment-input');
    fire(box, 'keydown', { key: 'Escape' });

    expect(actions.save).not.toHaveBeenCalled();
  });

  it('keydown, keypress, and keyup on the input stop propagation, so CM6 keymaps never see them', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new CommentWidget({ thread: thread(), orphaned: false, actions: makeActions() });

    const dom = widget.toDOM() as unknown as FakeElement;
    const [input] = findByClass(dom, 'cm-ai-comment-input');

    expect(fire(input, 'keydown', { key: 'Escape' }).stopPropagation).toHaveBeenCalledTimes(1);
    expect(fire(input, 'keypress').stopPropagation).toHaveBeenCalledTimes(1);
    expect(fire(input, 'keyup').stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('mousedown on the input stops propagation but does not preventDefault, so caret placement still works', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new CommentWidget({ thread: thread(), orphaned: false, actions: makeActions() });

    const dom = widget.toDOM() as unknown as FakeElement;
    const [input] = findByClass(dom, 'cm-ai-comment-input');
    const { stopPropagation, preventDefault } = fire(input, 'mousedown');

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
