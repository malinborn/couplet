import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRASH_DAYS, TRASH_HELD_ERROR, filterTrash, sortTrash, trashDaysLeft } from './trash-view';
import { formatWhen, whenOf } from './stash-view';
import type { StashEntry } from './types';

const RUST = fileURLToPath(new URL('../../../src-tauri/src/stash/trash.rs', import.meta.url));

// Local time, like the drawer: the day math is calendar days at local midnight.
const NOW = new Date(2026, 8, 26, 10, 30).getTime();
const MIN = 60_000;

function entry(over: Partial<StashEntry>): StashEntry {
  return {
    id: 'x',
    kind: 'note',
    path: '/n/.trash/x.md',
    title: null,
    repo: null,
    branch: null,
    tags: [],
    createdAt: 0,
    modifiedAt: 0,
    stashedAt: null,
    openedAt: null,
    deletedAt: NOW,
    caret: 0,
    topLine: 1,
    preview: '',
    ...over,
  };
}

describe('TRASH_DAYS', () => {
  it('matches the Rust retention', () => {
    const rust = readFileSync(RUST, 'utf8');
    const m = /pub(?:\(crate\))? const TRASH_RETENTION_DAYS: i64 = (\d+);/.exec(rust);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBe(TRASH_DAYS);
  });
});

describe('trashDaysLeft', () => {
  it('is 30 on the day of deletion and counts calendar days down, never below 1', () => {
    expect(trashDaysLeft(NOW, NOW)).toBe(30);
    expect(trashDaysLeft(new Date(2026, 8, 26, 0, 5).getTime(), NOW)).toBe(30);
    expect(trashDaysLeft(new Date(2026, 8, 25, 23, 55).getTime(), NOW)).toBe(29);
    expect(trashDaysLeft(NOW - 4400 * MIN, NOW)).toBe(27); // mockup t1: «удалена 3 дня назад»
    expect(trashDaysLeft(NOW - 17900 * MIN, NOW)).toBe(18); // mockup t2
    expect(trashDaysLeft(NOW - 37500 * MIN, NOW)).toBe(4); // mockup t3
    expect(trashDaysLeft(new Date(2026, 7, 28, 12, 0).getTime(), NOW)).toBe(1); // 29 days ago
    expect(trashDaysLeft(new Date(2026, 7, 20, 12, 0).getTime(), NOW)).toBe(1); // overdue: the purge runs daily
  });

  it('a moment ahead of now (another clock) still reads the full retention', () => {
    expect(trashDaysLeft(NOW + 5 * MIN, NOW)).toBe(30);
  });

  it('pairs with «удалена N дней назад»: the two numbers always add up to TRASH_DAYS', () => {
    const at = NOW - 4400 * MIN;
    expect(formatWhen(whenOf(at, NOW))).toMatch(/3/);
    expect(trashDaysLeft(at, NOW)).toBe(TRASH_DAYS - 3);
  });
});

describe('sortTrash', () => {
  it('puts the newest deletion first and never mutates its input', () => {
    const input = [entry({ id: 'a', deletedAt: 1 }), entry({ id: 'b', deletedAt: 3 }), entry({ id: 'c', deletedAt: 2 })];
    expect(sortTrash(input).map((e) => e.id)).toEqual(['b', 'c', 'a']);
    expect(input.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('filterTrash', () => {
  const list = [
    entry({ id: 'vpn', title: 'Черновик поста про VPN', preview: 'Почему мы ушли с OpenVPN на Xray', tags: ['infra'] }),
    entry({ id: 'shop', title: 'Список покупок в офис', preview: 'Список покупок в офис\nHDMI-кабели ×3' }),
    entry({ id: 'ideas', title: 'Старые идеи для тем', repo: 'shelf-design', tags: ['couplet', 'ideas'] }),
    entry({ id: 'blank', title: null, preview: '' }),
  ];
  const untitled = 'Без названия';

  it('keeps everything for an empty query', () => {
    expect(filterTrash(list, '', untitled).map((e) => e.id)).toEqual(['vpn', 'shop', 'ideas', 'blank']);
  });

  it('matches text in title or preview, case-insensitively', () => {
    expect(filterTrash(list, 'vpn', untitled).map((e) => e.id)).toEqual(['vpn']);
    expect(filterTrash(list, 'hdmi', untitled).map((e) => e.id)).toEqual(['shop']);
    expect(filterTrash(list, 'без назв', untitled).map((e) => e.id)).toEqual(['blank']);
  });

  it('matches #tag by prefix over tags and the repo, whatever the repo chip says elsewhere', () => {
    expect(filterTrash(list, '#inf', untitled).map((e) => e.id)).toEqual(['vpn']);
    expect(filterTrash(list, '#shelf', untitled).map((e) => e.id)).toEqual(['ideas']);
    expect(filterTrash(list, '#ideas тем', untitled).map((e) => e.id)).toEqual(['ideas']);
    expect(filterTrash(list, '#nope', untitled)).toEqual([]);
  });

  it('keeps the input order (the trash is sorted before it is filtered)', () => {
    expect(filterTrash(list, 'с', untitled).map((e) => e.id)).toEqual(['vpn', 'shop', 'ideas']);
  });
});

describe('TRASH_HELD_ERROR', () => {
  it('is the exact string stash_restore / stash_purge reject with while a tab holds the note', () => {
    const rust = readFileSync(RUST, 'utf8');
    const m = /pub(?:\(crate\))? const HELD_ERROR: &str = "([^"]*)";/.exec(rust);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe(TRASH_HELD_ERROR);
  });
});
