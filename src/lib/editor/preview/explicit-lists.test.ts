import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { Strikethrough, Table } from '@lezer/markdown';
import type { Decoration } from '@codemirror/view';
import {
  DEFAULT_LIST_LAYOUT,
  applyListPreset,
  layoutExplicitList,
  listLayoutFromMenu,
  listPresetOf,
  normalizeListLayout,
  ownsListGeometry,
  type ListLayout,
} from './explicit-lists.js';
import { listMarkColumns } from './lists.js';

const EXPLICIT: ListLayout = { ...DEFAULT_LIST_LAYOUT, guides: true, strict: true };

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [Strikethrough, Table] })],
  });
}

/** The inline style of each list line, by line number. */
function lineStyles(doc: string, layout: ListLayout): Map<number, string> {
  const state = makeState(doc);
  const out = new Map<number, string>();
  const sink = {
    add(from: number, _to: number, value: Decoration) {
      const style = (value.spec as { attributes?: { style?: string } }).attributes?.style;
      if (style) out.set(state.doc.lineAt(from).number, style);
    },
  };
  syntaxTree(state).iterate({
    enter(node) {
      if ((node.name === 'BulletList' || node.name === 'OrderedList') && node.node.parent?.name !== 'ListItem') {
        layoutExplicitList(state.doc, node.node, layout, (item) => listMarkColumns(item, state.doc), sink);
        return false;
      }
    },
  });
  return out;
}

const guideCount = (style: string | undefined): number =>
  (style?.match(/var\(--xl-guide\)/g) ?? []).length;

describe('presets', () => {
  it('explicit turns both switches on, standard both off, and leave the looks alone', () => {
    const start: ListLayout = { guides: false, strict: true, guideStyle: 'dotted', density: 'sparse' };
    expect(applyListPreset(start, 'explicit')).toEqual({ ...start, guides: true, strict: true });
    expect(applyListPreset(start, 'standard')).toEqual({ ...start, guides: false, strict: false });
  });

  it('names the preset the switches match, and none when they are mixed', () => {
    expect(listPresetOf(DEFAULT_LIST_LAYOUT)).toBe('standard');
    expect(listPresetOf(EXPLICIT)).toBe('explicit');
    expect(listPresetOf({ ...EXPLICIT, strict: false })).toBeNull();
  });

  it('the default layout leaves list geometry to the classic code', () => {
    expect(ownsListGeometry(DEFAULT_LIST_LAYOUT)).toBe(false);
    expect(ownsListGeometry({ ...DEFAULT_LIST_LAYOUT, guides: true })).toBe(true);
    expect(ownsListGeometry({ ...DEFAULT_LIST_LAYOUT, strict: true })).toBe(true);
  });
});

describe('listLayoutFromMenu', () => {
  it('applies every View → Lists id with its value', () => {
    const l = DEFAULT_LIST_LAYOUT;
    expect(listLayoutFromMenu(l, 'list_preset_explicit')).toMatchObject({ guides: true, strict: true });
    expect(listLayoutFromMenu(EXPLICIT, 'list_preset_standard')).toMatchObject({ guides: false, strict: false });
    expect(listLayoutFromMenu(l, 'toggle_list_guides:on')).toMatchObject({ guides: true, strict: false });
    expect(listLayoutFromMenu(EXPLICIT, 'toggle_list_strict:off')).toMatchObject({ guides: true, strict: false });
    expect(listLayoutFromMenu(l, 'list_guide_dashed')?.guideStyle).toBe('dashed');
    expect(listLayoutFromMenu(l, 'list_density_compact')?.density).toBe('compact');
  });

  it('is idempotent, so N windows applying one event agree', () => {
    const once = listLayoutFromMenu(DEFAULT_LIST_LAYOUT, 'toggle_list_guides:on')!;
    expect(listLayoutFromMenu(once, 'toggle_list_guides:on')).toEqual(once);
  });

  it('ignores ids that are not list actions, and unknown values', () => {
    expect(listLayoutFromMenu(DEFAULT_LIST_LAYOUT, 'toggle_ocd_alignment:on')).toBeNull();
    expect(listLayoutFromMenu(DEFAULT_LIST_LAYOUT, 'list_guide_wavy')).toBeNull();
    expect(listLayoutFromMenu(DEFAULT_LIST_LAYOUT, 'list_density_huge')).toBeNull();
    expect(listLayoutFromMenu(DEFAULT_LIST_LAYOUT, 'toggle_list_guides')).toBeNull();
  });
});

describe('normalizeListLayout', () => {
  it('falls back field by field', () => {
    expect(normalizeListLayout(null)).toEqual(DEFAULT_LIST_LAYOUT);
    expect(normalizeListLayout('explicit')).toEqual(DEFAULT_LIST_LAYOUT);
    expect(normalizeListLayout({ guides: true, guideStyle: 'wavy', density: 'sparse' })).toEqual({
      ...DEFAULT_LIST_LAYOUT,
      guides: true,
      density: 'sparse',
    });
  });
});

describe('layoutExplicitList', () => {
  it('draws no guide for an item with one line under its marker', () => {
    const styles = lineStyles(['- parent', '  - only child', '- next'].join('\n'), EXPLICIT);
    expect(guideCount(styles.get(2))).toBe(0);
  });

  it('draws a guide from two lines under the marker on, through every line it covers', () => {
    const doc = ['- parent', '  - one', '  - two', '- next'].join('\n');
    const styles = lineStyles(doc, EXPLICIT);
    expect(guideCount(styles.get(1))).toBe(1); // starts below the marker's first visual line
    expect(guideCount(styles.get(2))).toBe(1);
    expect(guideCount(styles.get(3))).toBe(1);
    expect(guideCount(styles.get(4))).toBe(0);
  });

  it('does not count blank lines toward the two', () => {
    const doc = ['- parent', '', '  continuation', '- next'].join('\n');
    expect(guideCount(lineStyles(doc, EXPLICIT).get(3))).toBe(0);
  });

  it('passes every ancestor guide through a deep line', () => {
    const doc = ['- a', '  - b', '    - c', '      - d', '      - e', '    - f', '  - g'].join('\n');
    // d sits under a, b and c — all three span two lines or more.
    expect(guideCount(lineStyles(doc, EXPLICIT).get(4))).toBe(3);
  });

  it('hangs the marker line only under strict', () => {
    const doc = ['- parent', '  - child'].join('\n');
    expect(lineStyles(doc, EXPLICIT).get(2)).toContain('text-indent');
    expect(lineStyles(doc, { ...EXPLICIT, strict: false }).get(2)).not.toContain('text-indent');
  });

  it('steps a child from the parent marker by the classic step when not strict', () => {
    const doc = ['- parent', '  - child'].join('\n');
    expect(lineStyles(doc, { ...EXPLICIT, strict: false }).get(2)).toContain('var(--list-indent-step)');
    expect(lineStyles(doc, EXPLICIT).get(2)).not.toContain('var(--list-indent-step)');
  });

  it('draws no guides with the switch off', () => {
    const doc = ['- parent', '  - one', '  - two'].join('\n');
    const styles = lineStyles(doc, { ...EXPLICIT, guides: false });
    for (const n of [1, 2, 3]) expect(guideCount(styles.get(n))).toBe(0);
  });
});
