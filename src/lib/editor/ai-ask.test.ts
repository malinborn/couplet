import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { addAiAsk, removeAiAsk, clearAiAsks, aiAskField, activeAskIds, AskWidget, type AskSpec } from './ai-ask';

function makeState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [aiAskField] });
}

function makeSpec(overrides: Partial<AskSpec> = {}): AskSpec {
  return {
    id: 1,
    question: 'Continue?',
    options: ['Yes', 'No'],
    multi: false,
    freeText: false,
    onAnswer: vi.fn(),
    ...overrides,
  };
}

/** All ask widgets currently in the field, as {pos, widget}. */
function collectWidgets(state: EditorState): Array<{ pos: number; widget: AskWidget }> {
  const set = state.field(aiAskField, false);
  const out: Array<{ pos: number; widget: AskWidget }> = [];
  if (set) {
    set.between(0, state.doc.length, (from, _to, value) => {
      const widget = (value.spec as { widget: unknown }).widget;
      if (widget instanceof AskWidget) out.push({ pos: from, widget });
    });
  }
  return out;
}

describe('aiAskField', () => {
  it('installs a widget decoration anchored at the end of the target line', () => {
    const state = makeState('line1\nline2\n');
    const pos = state.doc.line(1).from + 2; // mid line1
    const tr = state.update({ effects: addAiAsk.of({ spec: makeSpec(), pos }) });

    const widgets = collectWidgets(tr.state);
    expect(widgets).toHaveLength(1);
    expect(widgets[0].pos).toBe(state.doc.line(1).to);
    expect(activeAskIds(tr.state)).toEqual([1]);
  });

  it('anchors at doc end when pos is doc.length', () => {
    const state = makeState('line1\nline2');
    const tr = state.update({
      effects: addAiAsk.of({ spec: makeSpec(), pos: state.doc.length }),
    });
    expect(collectWidgets(tr.state)[0].pos).toBe(state.doc.length);
  });

  it('keeps two concurrent asks, each with its own widget', () => {
    let state = makeState('line1\nline2\nline3\n');
    state = state.update({
      effects: addAiAsk.of({ spec: makeSpec({ id: 1 }), pos: state.doc.line(1).from }),
    }).state;
    state = state.update({
      effects: addAiAsk.of({ spec: makeSpec({ id: 2, question: 'Second?' }), pos: state.doc.line(3).from }),
    }).state;

    expect(activeAskIds(state).sort()).toEqual([1, 2]);
  });

  it('removes only the widget matching the given id', () => {
    let state = makeState('line1\nline2\n');
    state = state.update({
      effects: addAiAsk.of({ spec: makeSpec({ id: 1 }), pos: state.doc.line(1).from }),
    }).state;
    state = state.update({
      effects: addAiAsk.of({ spec: makeSpec({ id: 2 }), pos: state.doc.line(2).from }),
    }).state;

    state = state.update({ effects: removeAiAsk.of(1) }).state;

    expect(activeAskIds(state)).toEqual([2]);
  });

  it('clearAiAsks removes every ask widget without answering any', () => {
    const first = makeSpec({ id: 1 });
    const second = makeSpec({ id: 2 });
    let state = makeState('line1\nline2\n');
    state = state.update({
      effects: addAiAsk.of({ spec: first, pos: state.doc.line(1).from }),
    }).state;
    state = state.update({
      effects: addAiAsk.of({ spec: second, pos: state.doc.line(2).from }),
    }).state;

    state = state.update({ effects: clearAiAsks.of(null) }).state;

    expect(collectWidgets(state)).toHaveLength(0);
    expect(activeAskIds(state)).toEqual([]);
    expect(first.onAnswer).not.toHaveBeenCalled();
    expect(second.onAnswer).not.toHaveBeenCalled();
  });

  it('removing an absent id is a no-op', () => {
    let state = makeState('hello\n');
    state = state.update({
      effects: addAiAsk.of({ spec: makeSpec({ id: 1 }), pos: 0 }),
    }).state;

    state = state.update({ effects: removeAiAsk.of(999) }).state;

    expect(activeAskIds(state)).toEqual([1]);
  });

  it('maps the widget position through an edit above it', () => {
    let state = makeState('line1\nline2\nline3\n');
    const targetLineStart = state.doc.line(3).from;
    state = state.update({
      effects: addAiAsk.of({ spec: makeSpec(), pos: targetLineStart }),
    }).state;
    const before = collectWidgets(state)[0].pos;

    // Insert a new line before line 1 — shifts everything below down.
    const tr = state.update({ changes: { from: 0, to: 0, insert: 'XXXX\n' } });

    const after = collectWidgets(tr.state)[0].pos;
    expect(after).toBe(before + 'XXXX\n'.length);
    expect(activeAskIds(tr.state)).toEqual([1]);
  });
});

describe('AskWidget.eq', () => {
  it('is true for widgets with the same id, question, and options', () => {
    const a = new AskWidget(makeSpec());
    const b = new AskWidget(makeSpec()); // different onAnswer identity, same data
    expect(a.eq(b)).toBe(true);
  });

  it('is false when the id differs', () => {
    const a = new AskWidget(makeSpec({ id: 1 }));
    const b = new AskWidget(makeSpec({ id: 2 }));
    expect(a.eq(b)).toBe(false);
  });

  it('is false when the question differs', () => {
    const a = new AskWidget(makeSpec({ question: 'A?' }));
    const b = new AskWidget(makeSpec({ question: 'B?' }));
    expect(a.eq(b)).toBe(false);
  });

  it('is false when the options differ', () => {
    const a = new AskWidget(makeSpec({ options: ['Yes', 'No'] }));
    const b = new AskWidget(makeSpec({ options: ['Yes', 'Maybe'] }));
    expect(a.eq(b)).toBe(false);
  });

  it('is false when the option count differs', () => {
    const a = new AskWidget(makeSpec({ options: ['Yes', 'No'] }));
    const b = new AskWidget(makeSpec({ options: ['Yes'] }));
    expect(a.eq(b)).toBe(false);
  });

  it('is false when multi differs', () => {
    const a = new AskWidget(makeSpec({ multi: false }));
    const b = new AskWidget(makeSpec({ multi: true }));
    expect(a.eq(b)).toBe(false);
  });

  it('is false when freeText differs', () => {
    const a = new AskWidget(makeSpec({ freeText: false }));
    const b = new AskWidget(makeSpec({ freeText: true }));
    expect(a.eq(b)).toBe(false);
  });
});

describe('AskWidget.ignoreEvent', () => {
  it('always returns true, so CM6 does not turn clicks into selection changes', () => {
    const widget = new AskWidget(makeSpec());
    expect(widget.ignoreEvent()).toBe(true);
  });
});

// --- toDOM click wiring ------------------------------------------------
//
// This project's test env has no DOM (no jsdom/happy-dom dependency — see
// tables.test.ts, which likewise never calls TableWidget.toDOM()). Rather
// than skip the click wiring entirely, stub a minimal `document` with just
// enough surface (createElement/appendChild/addEventListener/setAttribute)
// for `toDOM()` to run, and fire the recorded listeners directly.

/** Event shape the widget's listeners actually call methods on: mouse
 * listeners call `preventDefault`, keyboard listeners on the free-text input
 * call `stopPropagation` and read `key`. */
interface FakeEvent {
  preventDefault(): void;
  stopPropagation(): void;
  key?: string;
}

interface FakeElement {
  tagName: string;
  className: string;
  type: string;
  textContent: string;
  /** Only meaningful for the free-text `<input>`. */
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

/** Fires all listeners registered for `type`, with spy `preventDefault`/
 * `stopPropagation` so a test can assert on whether they were called, plus
 * any extra event fields (e.g. `{ key: 'Enter' }`) the handler reads. */
function fire(
  el: FakeElement,
  type: string,
  extra: Partial<Pick<FakeEvent, 'key'>> = {}
): { preventDefault: ReturnType<typeof vi.fn>; stopPropagation: ReturnType<typeof vi.fn> } {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  const event: FakeEvent = { preventDefault, stopPropagation, ...extra };
  for (const handler of el.listeners[type] ?? []) {
    handler(event);
  }
  return { preventDefault, stopPropagation };
}

/** `className` is a real DOM space-separated token list (e.g. a checked chip
 * is `'cm-ai-ask-option cm-ai-ask-chip-checked'`) — match by word, not by
 * exact string, so a single class name finds it regardless of what else is
 * set alongside it. */
function findByClass(root: FakeElement, className: string): FakeElement[] {
  const out: FakeElement[] = [];
  if (root.className.split(' ').includes(className)) out.push(root);
  for (const child of root.children) out.push(...findByClass(child, className));
  return out;
}

describe('AskWidget.toDOM root element', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a cm-ai-ask-wrap root with the card nested one level inside', () => {
    // Regression: `.cm-ai-ask-wrap` carries the widget's vertical spacing as
    // padding. If that spacing ever moves back onto `.cm-ai-ask` as margin,
    // CM6's block-widget height map (measured from the DOM box, which
    // excludes margin) desyncs from the real line positions — margin still
    // pushes lines below the widget down on screen, but CM6 doesn't count
    // it, so `posAtCoords`'s vertical scan walks past every line below the
    // widget. See the fix commit for a full repro.
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new AskWidget(makeSpec());

    const dom = widget.toDOM() as unknown as FakeElement;
    expect(dom.className).toBe('cm-ai-ask-wrap');
    expect(dom.children).toHaveLength(1);
    expect(dom.children[0].className).toBe('cm-ai-ask');
  });
});

describe('AskWidget.toDOM click wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('clicking an option button calls onAnswer with (id, option text)', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const onAnswer = vi.fn();
    const widget = new AskWidget(makeSpec({ id: 42, options: ['Yes', 'No'], onAnswer }));

    const dom = widget.toDOM() as unknown as FakeElement;
    const [yesButton] = findByClass(dom, 'cm-ai-ask-option');
    fire(yesButton, 'click');

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith(42, 'Yes');
  });

  it('clicking the dismiss button calls onAnswer with (id, null)', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const onAnswer = vi.fn();
    const widget = new AskWidget(makeSpec({ id: 7, onAnswer }));

    const dom = widget.toDOM() as unknown as FakeElement;
    const [dismissButton] = findByClass(dom, 'cm-ai-ask-dismiss');
    fire(dismissButton, 'click');

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith(7, null);
  });

  it('renders one option button per option, plus the question text', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new AskWidget(makeSpec({ question: 'Pick one', options: ['A', 'B', 'C'] }));

    const dom = widget.toDOM() as unknown as FakeElement;
    expect(findByClass(dom, 'cm-ai-ask-option')).toHaveLength(3);
    expect(findByClass(dom, 'cm-ai-ask-question')[0].textContent).toBe('Pick one');
  });

  it('renders no confirm button (single-choice has nothing to confirm)', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new AskWidget(makeSpec({ multi: false }));

    const dom = widget.toDOM() as unknown as FakeElement;
    expect(findByClass(dom, 'cm-ai-ask-confirm')).toHaveLength(0);
  });
});

describe('AskWidget.toDOM multi-choice click wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders one chip per option, a confirm button, and the dismiss button', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new AskWidget(makeSpec({ multi: true, options: ['A', 'B', 'C'] }));

    const dom = widget.toDOM() as unknown as FakeElement;
    expect(findByClass(dom, 'cm-ai-ask-option')).toHaveLength(3);
    expect(findByClass(dom, 'cm-ai-ask-confirm')).toHaveLength(1);
    expect(findByClass(dom, 'cm-ai-ask-dismiss')).toHaveLength(1);
  });

  it('a chip toggles the checked class and aria-pressed on click, and back off on a second click', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new AskWidget(makeSpec({ multi: true, options: ['A', 'B'] }));

    const dom = widget.toDOM() as unknown as FakeElement;
    const [chipA] = findByClass(dom, 'cm-ai-ask-option');
    expect(chipA.attributes['aria-pressed']).toBe('false');

    fire(chipA, 'click');
    expect(chipA.className.split(' ')).toContain('cm-ai-ask-chip-checked');
    expect(chipA.attributes['aria-pressed']).toBe('true');

    fire(chipA, 'click');
    expect(chipA.className.split(' ')).not.toContain('cm-ai-ask-chip-checked');
    expect(chipA.attributes['aria-pressed']).toBe('false');
  });

  it('confirm calls onAnswer with the selected subset in original option order, regardless of click order', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const onAnswer = vi.fn();
    const widget = new AskWidget(makeSpec({ id: 5, multi: true, options: ['A', 'B', 'C'], onAnswer }));

    const dom = widget.toDOM() as unknown as FakeElement;
    const [chipA, , chipC] = findByClass(dom, 'cm-ai-ask-option');
    const [confirm] = findByClass(dom, 'cm-ai-ask-confirm');

    // Select C, then A — reverse of document order. Result must stay [A, C].
    fire(chipC, 'click');
    fire(chipA, 'click');
    fire(confirm, 'click');

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith(5, ['A', 'C']);
  });

  it('deselecting a chip removes it from the confirmed result', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const onAnswer = vi.fn();
    const widget = new AskWidget(makeSpec({ id: 6, multi: true, options: ['A', 'B'], onAnswer }));

    const dom = widget.toDOM() as unknown as FakeElement;
    const [chipA, chipB] = findByClass(dom, 'cm-ai-ask-option');
    const [confirm] = findByClass(dom, 'cm-ai-ask-confirm');

    fire(chipA, 'click'); // select A
    fire(chipB, 'click'); // select B
    fire(chipA, 'click'); // deselect A
    fire(confirm, 'click');

    expect(onAnswer).toHaveBeenCalledWith(6, ['B']);
  });

  it('confirm with nothing selected calls onAnswer with an empty array (an explicit "none")', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const onAnswer = vi.fn();
    const widget = new AskWidget(makeSpec({ id: 7, multi: true, options: ['A', 'B'], onAnswer }));

    const dom = widget.toDOM() as unknown as FakeElement;
    const [confirm] = findByClass(dom, 'cm-ai-ask-confirm');
    fire(confirm, 'click');

    expect(onAnswer).toHaveBeenCalledWith(7, []);
  });

  it('dismiss in multi mode calls onAnswer with null, not an empty array', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const onAnswer = vi.fn();
    const widget = new AskWidget(makeSpec({ id: 8, multi: true, onAnswer }));

    const dom = widget.toDOM() as unknown as FakeElement;
    const [dismissButton] = findByClass(dom, 'cm-ai-ask-dismiss');
    fire(dismissButton, 'click');

    expect(onAnswer).toHaveBeenCalledWith(8, null);
  });
});

describe('AskWidget.toDOM free-text input', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders no input when freeText is false', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new AskWidget(makeSpec({ freeText: false }));

    const dom = widget.toDOM() as unknown as FakeElement;
    expect(findByClass(dom, 'cm-ai-ask-input')).toHaveLength(0);
  });

  it('renders one input, below the option row, when freeText is true', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new AskWidget(makeSpec({ freeText: true }));

    const dom = widget.toDOM() as unknown as FakeElement;
    const [card] = findByClass(dom, 'cm-ai-ask');
    const [input] = findByClass(dom, 'cm-ai-ask-input');
    expect(findByClass(dom, 'cm-ai-ask-input')).toHaveLength(1);
    expect(input.placeholder).toBe('Your own answer…');
    // Card children, in DOM order: dismiss, question, options row, input.
    expect(card.children[card.children.length - 1]).toBe(input);
  });

  it('single-choice: Enter in the input with non-empty trimmed text calls onAnswer with { custom }', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const onAnswer = vi.fn();
    const widget = new AskWidget(makeSpec({ id: 10, freeText: true, onAnswer }));

    const dom = widget.toDOM() as unknown as FakeElement;
    const [input] = findByClass(dom, 'cm-ai-ask-input');
    input.value = '  hello there  ';
    fire(input, 'keydown', { key: 'Enter' });

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith(10, { custom: 'hello there' });
  });

  it('single-choice: Enter with only whitespace is a no-op', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const onAnswer = vi.fn();
    const widget = new AskWidget(makeSpec({ id: 11, freeText: true, onAnswer }));

    const dom = widget.toDOM() as unknown as FakeElement;
    const [input] = findByClass(dom, 'cm-ai-ask-input');
    input.value = '   ';
    fire(input, 'keydown', { key: 'Enter' });

    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('single-choice: a non-Enter keydown in the input never calls onAnswer', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const onAnswer = vi.fn();
    const widget = new AskWidget(makeSpec({ id: 12, freeText: true, onAnswer }));

    const dom = widget.toDOM() as unknown as FakeElement;
    const [input] = findByClass(dom, 'cm-ai-ask-input');
    input.value = 'hello';
    fire(input, 'keydown', { key: 'a' });

    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('multi-choice: Enter in the input never calls onAnswer — only the confirm button does', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const onAnswer = vi.fn();
    const widget = new AskWidget(makeSpec({ id: 13, multi: true, freeText: true, options: ['A'], onAnswer }));

    const dom = widget.toDOM() as unknown as FakeElement;
    const [input] = findByClass(dom, 'cm-ai-ask-input');
    input.value = 'text';
    fire(input, 'keydown', { key: 'Enter' });

    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('multi-choice: confirm with typed text sends { answers, custom }', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const onAnswer = vi.fn();
    const widget = new AskWidget(
      makeSpec({ id: 20, multi: true, freeText: true, options: ['A', 'B'], onAnswer })
    );

    const dom = widget.toDOM() as unknown as FakeElement;
    const [chipA] = findByClass(dom, 'cm-ai-ask-option');
    const [input] = findByClass(dom, 'cm-ai-ask-input');
    const [confirm] = findByClass(dom, 'cm-ai-ask-confirm');

    fire(chipA, 'click');
    input.value = '  extra detail  ';
    fire(confirm, 'click');

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith(20, { answers: ['A'], custom: 'extra detail' });
  });

  it('multi-choice: confirm with an empty text field sends the plain array (no custom key)', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const onAnswer = vi.fn();
    const widget = new AskWidget(
      makeSpec({ id: 21, multi: true, freeText: true, options: ['A', 'B'], onAnswer })
    );

    const dom = widget.toDOM() as unknown as FakeElement;
    const [chipA] = findByClass(dom, 'cm-ai-ask-option');
    const [confirm] = findByClass(dom, 'cm-ai-ask-confirm');

    fire(chipA, 'click');
    fire(confirm, 'click');

    expect(onAnswer).toHaveBeenCalledWith(21, ['A']);
  });

  it('keydown, keypress, and keyup on the input stop propagation, so CM6 keymaps never see them', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new AskWidget(makeSpec({ freeText: true }));

    const dom = widget.toDOM() as unknown as FakeElement;
    const [input] = findByClass(dom, 'cm-ai-ask-input');

    expect(fire(input, 'keydown', { key: 'Escape' }).stopPropagation).toHaveBeenCalledTimes(1);
    expect(fire(input, 'keypress').stopPropagation).toHaveBeenCalledTimes(1);
    expect(fire(input, 'keyup').stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('mousedown on the input stops propagation but does not preventDefault, so focus/caret placement still works', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new AskWidget(makeSpec({ freeText: true }));

    const dom = widget.toDOM() as unknown as FakeElement;
    const [input] = findByClass(dom, 'cm-ai-ask-input');
    const { stopPropagation, preventDefault } = fire(input, 'mousedown');

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe('AskWidget.toDOM multi-choice visual affordance', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks the options container with cm-ai-ask-multi in multi mode', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new AskWidget(makeSpec({ multi: true, options: ['A', 'B'] }));

    const dom = widget.toDOM() as unknown as FakeElement;
    expect(findByClass(dom, 'cm-ai-ask-multi')).toHaveLength(1);
  });

  it('does not mark the options container in single-choice mode', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new AskWidget(makeSpec({ multi: false, options: ['A', 'B'] }));

    const dom = widget.toDOM() as unknown as FakeElement;
    expect(findByClass(dom, 'cm-ai-ask-multi')).toHaveLength(0);
  });

  it('renders the mode hint span only in multi mode', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const multiWidget = new AskWidget(makeSpec({ multi: true, options: ['A', 'B'] }));
    const singleWidget = new AskWidget(makeSpec({ multi: false, options: ['A', 'B'] }));

    const multiDom = multiWidget.toDOM() as unknown as FakeElement;
    const singleDom = singleWidget.toDOM() as unknown as FakeElement;

    const [hint] = findByClass(multiDom, 'cm-ai-ask-mode');
    expect(hint.textContent).toContain('select any');
    expect(hint.textContent).toContain('OK');
    expect(findByClass(singleDom, 'cm-ai-ask-mode')).toHaveLength(0);
  });

  it('the multi-mode chips still carry the plain cm-ai-ask-option class the checkbox CSS keys off of', () => {
    vi.stubGlobal('document', { createElement: createFakeElement });
    const widget = new AskWidget(makeSpec({ multi: true, options: ['A', 'B', 'C'] }));

    const dom = widget.toDOM() as unknown as FakeElement;
    expect(findByClass(dom, 'cm-ai-ask-option')).toHaveLength(3);
  });
});
