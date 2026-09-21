import { describe, it, expect } from 'vitest';
import { TABLE_CELL_BINDINGS, matchCellBinding, type CellAction } from './table-keys';
import { hotkeyLabel } from '../hotkey-label';

const ev = (
  key: string,
  mods: { shift?: boolean; meta?: boolean; ctrl?: boolean; alt?: boolean } = {}
) => ({
  key,
  shiftKey: mods.shift ?? false,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
});

const actionFor = (e: ReturnType<typeof ev>): CellAction | null =>
  matchCellBinding(e)?.action ?? null;

describe('matchCellBinding', () => {
  it('resolves the plain keys', () => {
    expect(actionFor(ev('Enter'))).toBe('row-next');
    expect(actionFor(ev('Tab'))).toBe('col-next');
    expect(actionFor(ev('Escape'))).toBe('cancel');
  });

  it('keeps the four Enters apart', () => {
    expect(actionFor(ev('Enter'))).toBe('row-next');
    expect(actionFor(ev('Enter', { shift: true }))).toBe('break');
    expect(actionFor(ev('Enter', { meta: true }))).toBe('commit');
    expect(actionFor(ev('Enter', { meta: true, shift: true }))).toBe('new-row');
  });

  it('reads Mod as Command OR Control, as CM6 does', () => {
    expect(actionFor(ev('Enter', { ctrl: true }))).toBe('commit');
    expect(actionFor(ev('Enter', { ctrl: true, shift: true }))).toBe('new-row');
  });

  it('separates Tab from Shift+Tab', () => {
    expect(actionFor(ev('Tab'))).toBe('col-next');
    expect(actionFor(ev('Tab', { shift: true }))).toBe('col-prev');
  });

  it('answers null for a key the cell does not claim — the textarea keeps it', () => {
    expect(actionFor(ev('a'))).toBeNull();
    expect(actionFor(ev('ArrowDown'))).toBeNull();
    expect(actionFor(ev('b', { meta: true }))).toBeNull();
  });

  it('does not match a declared key carrying an extra modifier', () => {
    // Option+Enter is nobody's binding; swallowing it would be a silent
    // no-op key in the middle of a cell edit.
    expect(actionFor(ev('Enter', { alt: true }))).toBeNull();
    expect(actionFor(ev('Tab', { meta: true }))).toBeNull();
  });

  it('every declared binding matches the event it declares, and only it', () => {
    for (const binding of TABLE_CELL_BINDINGS) {
      const parts = binding.key.split('-');
      const base = parts.pop() as string;
      const e = ev(base, {
        meta: parts.includes('Mod'),
        shift: parts.includes('Shift'),
        alt: parts.includes('Alt'),
      });
      expect(matchCellBinding(e)).toBe(binding);
    }
  });
});

/**
 * The point of #69: the cheatsheet is not a second list. These assertions fail
 * if a binding is added without something for the panel to print, or if the key
 * notation stops being the one `hotkeyLabel` can render.
 */
describe('the cheatsheet is generated from the bindings', () => {
  it('every binding carries a description key the panel can show', () => {
    for (const binding of TABLE_CELL_BINDINGS) {
      expect(binding.descriptionKey.trim().length).toBeGreaterThan(0);
    }
  });

  it('every key renders to a non-empty caption on both platforms', () => {
    for (const binding of TABLE_CELL_BINDINGS) {
      expect(hotkeyLabel(binding.key, true)).not.toBe('');
      expect(hotkeyLabel(binding.key, false)).not.toBe('');
    }
  });

  it('renders the macOS glyphs the menu bar uses', () => {
    const labels = Object.fromEntries(
      TABLE_CELL_BINDINGS.map((b) => [b.action, hotkeyLabel(b.key, true)])
    );
    expect(labels['commit']).toBe('⌘Enter');
    expect(labels['new-row']).toBe('⌘⇧Enter');
    expect(labels['col-prev']).toBe('⇧Tab');
    expect(labels['row-next']).toBe('Enter');
  });

  it('covers exactly the actions the cell editor implements', () => {
    const actions = new Set(TABLE_CELL_BINDINGS.map((b) => b.action));
    expect([...actions].sort()).toEqual(
      ['break', 'cancel', 'col-next', 'col-prev', 'commit', 'new-row', 'row-next'].sort()
    );
  });

  it('no two bindings claim the same key', () => {
    const keys = TABLE_CELL_BINDINGS.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
