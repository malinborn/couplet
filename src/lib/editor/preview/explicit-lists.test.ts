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
  markerKind,
  planExplicitList,
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
    expect(lineStyles(doc, { ...EXPLICIT, strict: false }).get(2)).toContain('var(--xl-step)');
    expect(lineStyles(doc, EXPLICIT).get(2)).not.toContain('var(--xl-step)');
  });

  it('draws no guides with the switch off', () => {
    const doc = ['- parent', '  - one', '  - two'].join('\n');
    const styles = lineStyles(doc, { ...EXPLICIT, guides: false });
    for (const n of [1, 2, 3]) expect(guideCount(styles.get(n))).toBe(0);
  });
});

/** The collapsed ranges of the first top-level list, as `[line, width]`. */
function collapsedByLine(doc: string): [number, number][] {
  const state = makeState(doc);
  let out: [number, number][] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'BulletList' && node.name !== 'OrderedList') return;
      const plan = planExplicitList(state.doc, node.node, EXPLICIT, (item) => listMarkColumns(item, state.doc));
      out = [...plan.hidden, ...plan.gaps]
        .filter((r) => r.to > r.from)
        .sort((a, b) => a.from - b.from)
        .map((r) => [state.doc.lineAt(r.from).number, r.to - r.from]);
      return false;
    },
  });
  return out;
}

describe('planExplicitList — collapsed whitespace', () => {
  it('hides a continuation indent only up to the item content column', () => {
    const doc = ['- item', '  ```python', '  def f():', '      return 1', '  ```'].join('\n');
    const widths = new Map(collapsedByLine(doc));
    expect(widths.get(3)).toBe(2);
    expect(widths.get(4)).toBe(2); // the four spaces of `return` stay on screen
  });

  it('hides the gap after a marker, after the checkbox for a task', () => {
    expect(collapsedByLine('- a')).toEqual([[1, 1]]);
    expect(collapsedByLine('- [ ]  todo')).toEqual([[1, 2]]);
  });
});

/** Every non-line decoration the layout pass emits, with its spec. */
function layoutSpecs(doc: string): { from: number; to: number; spec: Record<string, unknown> }[] {
  const state = makeState(doc);
  const out: { from: number; to: number; spec: Record<string, unknown> }[] = [];
  const sink = {
    add(from: number, to: number, value: Decoration) {
      const spec = value.spec as Record<string, unknown>;
      if (!(spec.attributes as { style?: string } | undefined)?.style) out.push({ from, to, spec });
    },
  };
  syntaxTree(state).iterate({
    enter(node) {
      if ((node.name === 'BulletList' || node.name === 'OrderedList') && node.node.parent?.name !== 'ListItem') {
        layoutExplicitList(state.doc, node.node, EXPLICIT, (item) => listMarkColumns(item, state.doc), sink);
        return false;
      }
    },
  });
  return out;
}

describe('layoutExplicitList — no zero-size text in a line', () => {
  // A `font-size: 0` span between the marker and the text made CM6 map a click
  // right of the line to the marker's end, and drew the caret there 0px tall.
  it('hides whitespace by replacing it, never by shrinking its font', () => {
    const specs = layoutSpecs(['- a', '  - b', '  continued'].join('\n'));
    expect(specs.some((s) => s.spec.class === 'cm-md-list-indent')).toBe(false);
    // `  ` before the nested marker and before the continuation: replaced.
    expect(specs.filter((s) => s.to - s.from === 2 && !s.spec.widget)).toHaveLength(2);
  });

  it('turns the gap after a marker into a widget of its own width', () => {
    const specs = layoutSpecs('- a');
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ from: 1, to: 2 });
    expect(specs[0].spec.widget).toBeDefined();
  });
});

describe('markerKind', () => {
  const kindOf = (doc: string) => {
    const state = makeState(doc);
    let kind: ReturnType<typeof markerKind> | null = null;
    syntaxTree(state).iterate({
      enter(node) {
        if (node.name === 'ListItem' && !kind) kind = markerKind(node.node, state.doc, listMarkColumns(node.node, state.doc));
      },
    });
    return kind!;
  };

  it('treats `[X]` as text, like the classic path and atomic.ts', () => {
    expect(kindOf('- [x] done').kind).toBe('task');
    expect(kindOf('- [X] done').kind).toBe('bullet');
  });

  it('widens the box for a marker past four columns', () => {
    expect(kindOf('1000. far').kind === 'ordered' && kindOf('1000. far')).toMatchObject({ columns: 5 });
  });
});

describe('guide threshold', () => {
  it('does not count fence lines as lines under the marker', () => {
    const doc = ['- item', '  ```', '  one line of code', '  ```', '- next'].join('\n');
    expect(guideCount(lineStyles(doc, EXPLICIT).get(3))).toBe(0);
  });
});
