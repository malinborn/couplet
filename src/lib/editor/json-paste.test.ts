// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import {
  jsonOfferField,
  jsonPasteNotifier,
  setJsonOffer,
  clearJsonOffer,
  applyJsonOffer,
  dismissJsonOffer,
  formatJsonCommand,
  canFormatJson,
  offeredText,
} from './json-paste';

const MINIFIED = '{"a":1,"b":[2,3]}';
const EXPANDED = '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}';

function makeView(
  doc: string,
  callbacks?: { onOffer: () => void; onWithdraw: () => void }
): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        jsonOfferField,
        ...(callbacks ? [jsonPasteNotifier(callbacks)] : []),
      ],
    }),
  });
}

/** Simulate what CodeMirror itself dispatches for a paste. */
function paste(view: EditorView, text: string, at?: { from: number; to: number }): void {
  const from = at?.from ?? view.state.selection.main.from;
  const to = at?.to ?? view.state.selection.main.to;
  view.dispatch({ changes: { from, to, insert: text }, userEvent: 'input.paste' });
}

const flush = () => new Promise<void>((r) => queueMicrotask(() => r()));

describe('jsonOfferField', () => {
  it('starts empty', () => {
    const view = makeView('');
    expect(view.state.field(jsonOfferField)).toBeNull();
    view.destroy();
  });

  it('holds a range set by effect, and clears on the clear effect', () => {
    const view = makeView('hello');
    view.dispatch({ effects: setJsonOffer.of({ from: 0, to: 5 }) });
    expect(view.state.field(jsonOfferField)).toEqual({ from: 0, to: 5 });
    view.dispatch({ effects: clearJsonOffer.of(null) });
    expect(view.state.field(jsonOfferField)).toBeNull();
    view.destroy();
  });

  it('maps the range through an insertion ABOVE it', () => {
    // The whole reason this is a StateField: the user pastes JSON, then types
    // a sentence above it, and the offer must still point at the JSON.
    const view = makeView(`intro\n${MINIFIED}`);
    const from = 6;
    view.dispatch({ effects: setJsonOffer.of({ from, to: from + MINIFIED.length }) });
    view.dispatch({ changes: { from: 0, insert: 'a longer heading\n' } });

    const offer = view.state.field(jsonOfferField)!;
    expect(view.state.sliceDoc(offer.from, offer.to)).toBe(MINIFIED);
    view.destroy();
  });

  it('grows the range when text is typed INSIDE it', () => {
    const view = makeView(MINIFIED);
    view.dispatch({ effects: setJsonOffer.of({ from: 0, to: MINIFIED.length }) });
    view.dispatch({ changes: { from: 6, insert: '99' } });

    const offer = view.state.field(jsonOfferField)!;
    expect(view.state.sliceDoc(offer.from, offer.to)).toBe(view.state.doc.toString());
    view.destroy();
  });

  it('drops the offer when its whole range is deleted', () => {
    const view = makeView(MINIFIED);
    view.dispatch({ effects: setJsonOffer.of({ from: 0, to: MINIFIED.length }) });
    view.dispatch({ changes: { from: 0, to: MINIFIED.length, insert: '' } });
    expect(view.state.field(jsonOfferField)).toBeNull();
    view.destroy();
  });
});

describe('applyJsonOffer', () => {
  it('expands the offered range and clears the offer', () => {
    const view = makeView(MINIFIED);
    view.dispatch({ effects: setJsonOffer.of({ from: 0, to: MINIFIED.length }) });

    expect(applyJsonOffer(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(EXPANDED);
    expect(view.state.field(jsonOfferField)).toBeNull();
    view.destroy();
  });

  it('leaves surrounding markdown untouched', () => {
    const doc = `# Notes\n\n${MINIFIED}\n\ntrailing text\n`;
    const view = makeView(doc);
    const from = doc.indexOf(MINIFIED);
    view.dispatch({ effects: setJsonOffer.of({ from, to: from + MINIFIED.length }) });
    applyJsonOffer(view);

    expect(view.state.doc.toString()).toBe(`# Notes\n\n${EXPANDED}\n\ntrailing text\n`);
    view.destroy();
  });

  it('does not swallow the newline a paste landed against', () => {
    // The offer range can include trailing whitespace; consuming it would join
    // the JSON to the line beneath.
    const doc = `${MINIFIED}\nnext line`;
    const view = makeView(doc);
    view.dispatch({ effects: setJsonOffer.of({ from: 0, to: MINIFIED.length + 1 }) });
    applyJsonOffer(view);

    expect(view.state.doc.toString()).toBe(`${EXPANDED}\nnext line`);
    view.destroy();
  });

  it('is undone by a single undo', () => {
    // "только по явному действию и под undo" — the issue's hard requirement.
    const view = makeView(MINIFIED);
    view.dispatch({ effects: setJsonOffer.of({ from: 0, to: MINIFIED.length }) });
    applyJsonOffer(view);
    expect(view.state.doc.toString()).toBe(EXPANDED);

    undo(view);
    expect(view.state.doc.toString()).toBe(MINIFIED);
    view.destroy();
  });

  it('returns false with no offer pending', () => {
    const view = makeView(MINIFIED);
    expect(applyJsonOffer(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(MINIFIED);
    view.destroy();
  });

  it('refuses and self-clears when the range stopped being JSON', () => {
    const view = makeView(MINIFIED);
    view.dispatch({ effects: setJsonOffer.of({ from: 0, to: MINIFIED.length }) });
    // Break it from inside the range.
    view.dispatch({ changes: { from: 5, insert: 'zzz' } });

    expect(applyJsonOffer(view)).toBe(false);
    expect(view.state.field(jsonOfferField)).toBeNull();
    view.destroy();
  });
});

describe('offeredText and dismissJsonOffer', () => {
  it('reports the covered text', () => {
    const view = makeView(`x\n${MINIFIED}`);
    view.dispatch({ effects: setJsonOffer.of({ from: 2, to: 2 + MINIFIED.length }) });
    expect(offeredText(view)).toBe(MINIFIED);
    view.destroy();
  });

  it('reports null with no offer', () => {
    const view = makeView(MINIFIED);
    expect(offeredText(view)).toBeNull();
    view.destroy();
  });

  it('dismisses without changing the document', () => {
    const view = makeView(MINIFIED);
    view.dispatch({ effects: setJsonOffer.of({ from: 0, to: MINIFIED.length }) });
    dismissJsonOffer(view);
    expect(view.state.field(jsonOfferField)).toBeNull();
    expect(view.state.doc.toString()).toBe(MINIFIED);
    view.destroy();
  });
});

describe('formatJsonCommand — the hotkey and menu path', () => {
  it('formats the whole document when nothing is selected', () => {
    // The originating scenario: a .json file that is one long line on disk.
    const view = makeView(MINIFIED);
    expect(formatJsonCommand(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(EXPANDED);
    view.destroy();
  });

  it('formats only the selection when there is one', () => {
    const doc = `note: ${MINIFIED} end`;
    const view = makeView(doc);
    const from = doc.indexOf('{');
    view.dispatch({ selection: { anchor: from, head: from + MINIFIED.length } });

    expect(formatJsonCommand(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(`note: ${EXPANDED} end`);
    view.destroy();
  });

  it('tolerates a selection that over-reaches by whitespace', () => {
    const doc = `${MINIFIED}\n`;
    const view = makeView(doc);
    view.dispatch({ selection: { anchor: 0, head: doc.length } });
    formatJsonCommand(view);
    expect(view.state.doc.toString()).toBe(`${EXPANDED}\n`);
    view.destroy();
  });

  it('is a no-op on a markdown document', () => {
    const view = makeView('# Heading\n\nSome prose.\n');
    expect(formatJsonCommand(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('# Heading\n\nSome prose.\n');
    view.destroy();
  });

  it('is a no-op on already-expanded JSON', () => {
    const view = makeView(EXPANDED);
    expect(formatJsonCommand(view)).toBe(false);
    view.destroy();
  });

  it('is undone by a single undo', () => {
    const view = makeView(MINIFIED);
    formatJsonCommand(view);
    undo(view);
    expect(view.state.doc.toString()).toBe(MINIFIED);
    view.destroy();
  });

  it('canFormatJson agrees with what the command would do', () => {
    const json = makeView(MINIFIED);
    expect(canFormatJson(json)).toBe(true);
    json.destroy();

    const md = makeView('# not json');
    expect(canFormatJson(md)).toBe(false);
    md.destroy();
  });
});

describe('jsonPasteNotifier', () => {
  it('offers on a paste of minified JSON', async () => {
    const onOffer = vi.fn();
    const onWithdraw = vi.fn();
    const view = makeView('', { onOffer, onWithdraw });

    paste(view, MINIFIED);
    await flush();

    expect(onOffer).toHaveBeenCalledTimes(1);
    expect(view.state.field(jsonOfferField)).toEqual({ from: 0, to: MINIFIED.length });
    view.destroy();
  });

  it('offers when JSON is pasted into the MIDDLE of a markdown document', async () => {
    // The decision taken for #30: the offer depends on the pasted content
    // only, never on where it lands. A false positive costs one ignored toast.
    const onOffer = vi.fn();
    const view = makeView('# Notes\n\nSee below:\n\n\n\nand more prose.\n', {
      onOffer,
      onWithdraw: vi.fn(),
    });
    const at = view.state.doc.toString().indexOf('\n\nand more');

    paste(view, MINIFIED, { from: at, to: at });
    await flush();

    expect(onOffer).toHaveBeenCalledTimes(1);
    const offer = view.state.field(jsonOfferField)!;
    expect(view.state.sliceDoc(offer.from, offer.to)).toBe(MINIFIED);
    view.destroy();
  });

  it('offers even inside a fenced code block — the known, accepted false positive', async () => {
    const onOffer = vi.fn();
    const doc = '```json\n\n```\n';
    const view = makeView(doc, { onOffer, onWithdraw: vi.fn() });

    paste(view, MINIFIED, { from: 8, to: 8 });
    await flush();

    expect(onOffer).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  it('stays silent on a paste of prose', async () => {
    const onOffer = vi.fn();
    const view = makeView('', { onOffer, onWithdraw: vi.fn() });

    paste(view, 'just some ordinary sentence about the release');
    await flush();

    expect(onOffer).not.toHaveBeenCalled();
    expect(view.state.field(jsonOfferField)).toBeNull();
    view.destroy();
  });

  it('stays silent on a paste of already-expanded JSON', async () => {
    const onOffer = vi.fn();
    const view = makeView('', { onOffer, onWithdraw: vi.fn() });

    paste(view, EXPANDED);
    await flush();

    expect(onOffer).not.toHaveBeenCalled();
    view.destroy();
  });

  it('stays silent on ordinary typing', async () => {
    const onOffer = vi.fn();
    const view = makeView('', { onOffer, onWithdraw: vi.fn() });

    // Same text, but as input rather than a paste.
    view.dispatch({ changes: { from: 0, insert: MINIFIED }, userEvent: 'input.type' });
    await flush();

    expect(onOffer).not.toHaveBeenCalled();
    view.destroy();
  });

  it('withdraws the offer when the pasted JSON is edited into something else', async () => {
    const onWithdraw = vi.fn();
    const view = makeView('', { onOffer: vi.fn(), onWithdraw });

    paste(view, MINIFIED);
    await flush();
    expect(view.state.field(jsonOfferField)).not.toBeNull();

    view.dispatch({ changes: { from: 4, insert: 'oops' }, userEvent: 'input.type' });
    await flush();

    expect(onWithdraw).toHaveBeenCalled();
    expect(view.state.field(jsonOfferField)).toBeNull();
    view.destroy();
  });

  it('replaces an earlier offer when a second JSON paste arrives', async () => {
    const onOffer = vi.fn();
    const view = makeView('', { onOffer, onWithdraw: vi.fn() });

    paste(view, MINIFIED);
    await flush();
    const first = view.state.field(jsonOfferField);

    view.dispatch({ selection: { anchor: view.state.doc.length } });
    paste(view, '\n[9,8,7]');
    await flush();

    expect(onOffer).toHaveBeenCalledTimes(2);
    expect(view.state.field(jsonOfferField)).not.toEqual(first);
    view.destroy();
  });

  it('applies cleanly end to end: paste, then accept the offer', async () => {
    const view = makeView('# Doc\n\n', { onOffer: vi.fn(), onWithdraw: vi.fn() });
    view.dispatch({ selection: { anchor: view.state.doc.length } });

    paste(view, MINIFIED);
    await flush();
    expect(applyJsonOffer(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(`# Doc\n\n${EXPANDED}`);

    undo(view);
    expect(view.state.doc.toString()).toBe(`# Doc\n\n${MINIFIED}`);
    view.destroy();
  });
});
