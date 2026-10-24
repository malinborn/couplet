// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdownExtension } from '../markdown-language';
import { documentPathField, setDocumentPath } from '../json-fence';
import { livePreviewPlugin } from '../preview/plugin';
import { LIVE_PREVIEW, flavourFacet } from '../preview/flavour';
import { linkControlFacet } from './open-link';
import { fakeLinkControl } from './fake-link-control';
import { linkExistenceField, setLinkExistence } from './link-existence';
import { linkPresentation } from './link-presentation';

function state(withControl: boolean, known: [string, boolean][] = []): EditorState {
  let s = EditorState.create({
    doc: '',
    extensions: [documentPathField, linkExistenceField, ...(withControl ? [linkControlFacet.of(fakeLinkControl())] : [])],
  });
  s = s.update({ effects: [setDocumentPath.of('/r/a.md'), setLinkExistence.of(new Map(known))] }).state;
  return s;
}

describe('linkPresentation', () => {
  it('says which file a document link opens', () => {
    expect(linkPresentation(state(true), 'plan.md').title).toMatch(/to open plan\.md$/);
  });

  it('says Finder for a non-document', () => {
    expect(linkPresentation(state(true), 'a.png').title).toMatch(/to show in Finder$/);
  });

  it('says heading for an anchor and link for a URL', () => {
    expect(linkPresentation(state(true), '#x').title).toMatch(/to jump to the heading$/);
    expect(linkPresentation(state(true), 'https://x').title).toMatch(/to open link$/);
  });

  it('marks a known-missing document link and offers to create it', () => {
    const look = linkPresentation(state(true, [['/r/gone.md', false]]), 'gone.md');
    expect(look.missing).toBe(true);
    expect(look.title).toMatch(/^File not found — .* to create$/);
  });

  it('a missing non-document says only that it is not there', () => {
    expect(linkPresentation(state(true, [['/r/x.png', false]]), 'x.png')).toEqual({ title: 'File not found', missing: true });
  });

  it('unknown is never missing', () => {
    expect(linkPresentation(state(true), 'gone.md').missing).toBe(false);
  });

  it('without a control every link keeps the old hint', () => {
    expect(linkPresentation(state(false), 'plan.md').title).toMatch(/to open link$/);
  });
});

describe('decorateLink', () => {
  it('adds cm-md-link-missing and the title to a known-missing link', () => {
    const doc = '[gone](gone.md) [ok](plan.md)\n\npark the caret here';
    let s = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        markdownExtension(),
        flavourFacet.of(LIVE_PREVIEW),
        documentPathField,
        linkExistenceField,
        linkControlFacet.of(fakeLinkControl()),
        livePreviewPlugin,
      ],
    });
    s = s.update({ effects: [setDocumentPath.of('/r/a.md'), setLinkExistence.of(new Map([['/r/gone.md', false]]))] }).state;
    ensureSyntaxTree(s, doc.length, 5000);
    const view = new EditorView({ state: s });
    const marks: { from: number; cls: string; title: string }[] = [];
    view.plugin(livePreviewPlugin)!.decorations.between(0, 30, (from, _to, value) => {
      const spec = value.spec as { class?: string; attributes?: { title?: string } };
      if (spec.class) marks.push({ from, cls: spec.class, title: spec.attributes?.title ?? '' });
    });
    view.destroy();
    expect(marks.find((m) => m.from === 0)?.cls).toBe('cm-md-link cm-md-link-missing');
    expect(marks.find((m) => m.from === 16)?.cls).toBe('cm-md-link');
    expect(marks.find((m) => m.from === 16)?.title).toMatch(/to open plan\.md$/);
  });
});
