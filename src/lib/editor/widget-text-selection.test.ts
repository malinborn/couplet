import { describe, it, expect, vi } from 'vitest';
import {
  makeWidgetTextSelectable,
  eventInside,
  WIDGET_TEXT_HOST_ATTR,
} from './widget-text-selection';

/**
 * There is no jsdom in this project's vitest setup, so these tests use the
 * smallest stand-ins that exercise the real logic: an element that records
 * what was set on it, and node shapes that satisfy the `instanceof` checks
 * through stubbed globals.
 *
 * What this file can prove is the contract: the host is declared editable and
 * every input route is refused, and `eventInside` resolves a text-node target
 * through its parent. What it cannot prove is that Chrome then actually draws
 * a selection there — that was measured in a browser (see the PR for #31).
 */

interface FakeEl {
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  handlers: Record<string, (event: { preventDefault: () => void }) => void>;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, fn: (event: { preventDefault: () => void }) => void): void;
}

function fakeElement(): FakeEl {
  const el: FakeEl = {
    attrs: {},
    dataset: {},
    handlers: {},
    setAttribute(name, value) {
      el.attrs[name] = value;
    },
    addEventListener(type, fn) {
      el.handlers[type] = fn;
    },
  };
  return el;
}

describe('makeWidgetTextSelectable', () => {
  it('declares the element a nested editing host', () => {
    const el = fakeElement();
    makeWidgetTextSelectable(el as unknown as HTMLElement);
    expect(el.attrs.contenteditable).toBe('true');
    expect(el.attrs.spellcheck).toBe('false');
  });

  it('marks the element as a host so focus checks can recognise it', () => {
    const el = fakeElement();
    makeWidgetTextSelectable(el as unknown as HTMLElement);
    // `view.hasFocus` is false while a selection lives in here, so the toolbar
    // has to be able to ask "is the focused element one of mine" (#42).
    expect(el.attrs[WIDGET_TEXT_HOST_ATTR]).toBe('');
  });

  it('carries a source range when the host renders document text', () => {
    const el = fakeElement();
    makeWidgetTextSelectable(el as unknown as HTMLElement, { source: { from: 12, to: 31 } });
    expect(el.dataset.sourceFrom).toBe('12');
    expect(el.dataset.sourceTo).toBe('31');
  });

  it('leaves a host with no document text unannotated', () => {
    // A comment card's quote is copied from elsewhere — nothing to anchor to,
    // which is also how the toolbar knows not to offer a comment on it.
    const el = fakeElement();
    makeWidgetTextSelectable(el as unknown as HTMLElement);
    expect(el.dataset.sourceFrom).toBeUndefined();
  });

  it('refuses every route to an actual edit', () => {
    const el = fakeElement();
    makeWidgetTextSelectable(el as unknown as HTMLElement);

    // `beforeinput` is the single choke point for typing, paste, cut and
    // delete: it fires before the DOM is touched, so nothing has to be undone.
    for (const type of ['beforeinput', 'dragstart']) {
      const preventDefault = vi.fn();
      el.handlers[type]({ preventDefault });
      expect(preventDefault, type).toHaveBeenCalled();
    }
  });
});

describe('eventInside', () => {
  class El {
    constructor(private readonly match: boolean) {}
    closest(_selector: string): El | null {
      return this.match ? this : null;
    }
  }
  class TextNode {
    constructor(readonly parentElement: El | null) {}
  }

  it('matches an element target inside the subtree', () => {
    vi.stubGlobal('Node', El);
    vi.stubGlobal('Element', El);
    expect(eventInside({ target: new El(true) } as unknown as Event, '.x')).toBe(true);
    expect(eventInside({ target: new El(false) } as unknown as Event, '.x')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('resolves a text-node target through its parent element', () => {
    vi.stubGlobal('Node', TextNode);
    vi.stubGlobal('Element', El);
    expect(eventInside({ target: new TextNode(new El(true)) } as unknown as Event, '.x')).toBe(true);
    expect(eventInside({ target: new TextNode(new El(false)) } as unknown as Event, '.x')).toBe(
      false
    );
    expect(eventInside({ target: new TextNode(null) } as unknown as Event, '.x')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('is false for a target that is not a node at all', () => {
    vi.stubGlobal('Node', El);
    vi.stubGlobal('Element', El);
    expect(eventInside({ target: null } as unknown as Event, '.x')).toBe(false);
    vi.unstubAllGlobals();
  });
});
