// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Strikethrough, Table } from '@lezer/markdown';
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
/** What lands in a markdown document — see the fence decision in json-fence.ts. */
const FENCED = '```json\n' + EXPANDED + '\n```';

/**
 * The editor's real configuration: markdown is the language, so the fence
 * decision is live. Every expectation below is what the user actually gets.
 */
const markdownExtension = (): Extension =>
  markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Strikethrough, Table] });

function makeView(
  doc: string,
  callbacks?: { onOffer: () => void; onWithdraw: () => void },
  language: Extension = markdownExtension()
): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        language,
        history(),
        jsonOfferField,
        ...(callbacks ? [jsonPasteNotifier(callbacks)] : []),
      ],
    }),
  });
  // The fence decision reads the syntax tree; in a headless view nothing has
  // asked for a parse yet, so ask explicitly rather than measure a half-tree.
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  return view;
}

/**
 * A view with no language at all — md-mini's env mode, and the branch a
 * `.json` file opened in code-file mode takes too (there the language is JSON;
 * either way markdown is not active, which is the only thing the fence
 * decision asks).
 */
function makeCodeView(doc: string, callbacks?: { onOffer: () => void; onWithdraw: () => void }) {
  return makeView(doc, callbacks, []);
}

/** Re-parse after an edit, for assertions that depend on the tree. */
function parsed(view: EditorView): EditorView {
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  return view;
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
  it('expands the offered range, fences it, and clears the offer', () => {
    const view = makeView(MINIFIED);
    view.dispatch({ effects: setJsonOffer.of({ from: 0, to: MINIFIED.length }) });

    expect(applyJsonOffer(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(FENCED);
    expect(view.state.field(jsonOfferField)).toBeNull();
    view.destroy();
  });

  it('expands WITHOUT a fence when the document is not markdown', () => {
    const view = makeCodeView(MINIFIED);
    view.dispatch({ effects: setJsonOffer.of({ from: 0, to: MINIFIED.length }) });

    expect(applyJsonOffer(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(EXPANDED);
    view.destroy();
  });

  it('leaves surrounding markdown untouched', () => {
    const doc = `# Notes\n\n${MINIFIED}\n\ntrailing text\n`;
    const view = makeView(doc);
    const from = doc.indexOf(MINIFIED);
    view.dispatch({ effects: setJsonOffer.of({ from, to: from + MINIFIED.length }) });
    applyJsonOffer(view);

    expect(view.state.doc.toString()).toBe(`# Notes\n\n${FENCED}\n\ntrailing text\n`);
    view.destroy();
  });

  it('does not swallow the newline a paste landed against', () => {
    // The offer range can include trailing whitespace; consuming it would join
    // the JSON to the line beneath.
    const doc = `${MINIFIED}\nnext line`;
    const view = makeView(doc);
    view.dispatch({ effects: setJsonOffer.of({ from: 0, to: MINIFIED.length + 1 }) });
    applyJsonOffer(view);

    expect(view.state.doc.toString()).toBe(`${FENCED}\nnext line`);
    view.destroy();
  });

  it('is undone by a single undo', () => {
    // "только по явному действию и под undo" — the issue's hard requirement.
    const view = makeView(MINIFIED);
    view.dispatch({ effects: setJsonOffer.of({ from: 0, to: MINIFIED.length }) });
    applyJsonOffer(view);
    expect(view.state.doc.toString()).toBe(FENCED);

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
    expect(view.state.doc.toString()).toBe(FENCED);
    view.destroy();
  });

  it('formats the whole document with no fence in code-file mode', () => {
    const view = makeCodeView(MINIFIED);
    expect(formatJsonCommand(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(EXPANDED);
    view.destroy();
  });

  it('formats only the selection when there is one, on its own lines', () => {
    // Mid-paragraph: the prose on either side keeps every character it had,
    // but the fence has to own whole lines, so newlines are inserted.
    const doc = `note: ${MINIFIED} end`;
    const view = makeView(doc);
    const from = doc.indexOf('{');
    view.dispatch({ selection: { anchor: from, head: from + MINIFIED.length } });

    expect(formatJsonCommand(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(`note: \n${FENCED}\n end`);
    view.destroy();
  });

  it('tolerates a selection that over-reaches by whitespace', () => {
    const doc = `${MINIFIED}\n`;
    const view = makeView(doc);
    view.dispatch({ selection: { anchor: 0, head: doc.length } });
    formatJsonCommand(view);
    expect(view.state.doc.toString()).toBe(`${FENCED}\n`);
    view.destroy();
  });

  it('is a no-op on a markdown document', () => {
    const view = makeView('# Heading\n\nSome prose.\n');
    expect(formatJsonCommand(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('# Heading\n\nSome prose.\n');
    view.destroy();
  });

  it('is a no-op on already-expanded JSON in code-file mode', () => {
    const view = makeCodeView(EXPANDED);
    expect(formatJsonCommand(view)).toBe(false);
    view.destroy();
  });

  it('still has work to do on already-expanded JSON lying bare in markdown', () => {
    // #47: the indentation is fine, but markdown renders those lines as an
    // indented code block and reads the bracket pairs as links. The fence is
    // the change, and it is the whole change.
    const view = makeView(EXPANDED);
    expect(formatJsonCommand(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(FENCED);
    view.destroy();
  });

  it('is a no-op once the JSON is expanded AND fenced', () => {
    const view = makeView(FENCED);
    expect(formatJsonCommand(view)).toBe(false);
    view.destroy();
  });

  it('re-indents in place, without nesting a second fence, inside a fence', () => {
    const view = makeView('```json\n' + MINIFIED + '\n```\n');
    view.dispatch({ selection: { anchor: 8, head: 8 + MINIFIED.length } });
    expect(formatJsonCommand(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('```json\n' + EXPANDED + '\n```\n');
    view.destroy();
  });

  it('is undone by a single undo', () => {
    const view = makeView(MINIFIED);
    formatJsonCommand(view);
    expect(view.state.doc.toString()).toBe(FENCED);
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

  it('offers inside a fenced code block too — there it re-indents in place', async () => {
    const onOffer = vi.fn();
    const doc = '```json\n\n```\n';
    const view = makeView(doc, { onOffer, onWithdraw: vi.fn() });

    paste(view, MINIFIED, { from: 8, to: 8 });
    await flush();

    expect(onOffer).toHaveBeenCalledTimes(1);
    expect(applyJsonOffer(parsed(view))).toBe(true);
    expect(view.state.doc.toString()).toBe('```json\n' + EXPANDED + '\n```\n');
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

  it('stays silent on a paste of already-expanded JSON in code-file mode', async () => {
    const onOffer = vi.fn();
    const view = makeCodeView('', { onOffer, onWithdraw: vi.fn() });

    paste(view, EXPANDED);
    await flush();

    expect(onOffer).not.toHaveBeenCalled();
    view.destroy();
  });

  it('DOES offer for already-expanded JSON pasted bare into markdown', async () => {
    // Changed by #47a: the indentation needs nothing, the fence does.
    const onOffer = vi.fn();
    const view = makeView('', { onOffer, onWithdraw: vi.fn() });

    paste(view, EXPANDED);
    await flush();

    expect(onOffer).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  it('stays silent on a paste that is already expanded AND fenced', async () => {
    const onOffer = vi.fn();
    const view = makeView('', { onOffer, onWithdraw: vi.fn() });

    paste(view, FENCED);
    await flush();

    // The fence is not JSON end to end, so it is not even a candidate.
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
    expect(applyJsonOffer(parsed(view))).toBe(true);
    expect(view.state.doc.toString()).toBe(`# Doc\n\n${FENCED}`);

    undo(view);
    expect(view.state.doc.toString()).toBe(`# Doc\n\n${MINIFIED}`);
    view.destroy();
  });
});
