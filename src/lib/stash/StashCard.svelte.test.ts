// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { installCatalog } from '../i18n';
import StashCard from './StashCard.svelte';
import StashGlyph from './StashGlyph.svelte';
import { STASH_ICONS } from './icons';
import { TAG_MAX } from './stash-query';
import type { StashEntry, TabHolder } from './types';

const NOW = new Date(2026, 8, 26, 10, 30).getTime();

function entry(over: Partial<StashEntry> = {}): StashEntry {
  return {
    id: 'f1',
    kind: 'file',
    path: '/Users/x/dev/infra/oncall/rota.md',
    title: 'rota.md',
    repo: 'infra',
    branch: 'main',
    tags: ['ops'],
    createdAt: NOW - 9_000_000,
    modifiedAt: NOW - 8_000_000,
    stashedAt: NOW - 3_600_000,
    openedAt: null,
    deletedAt: null,
    caret: 0,
    topLine: 1,
    preview: '# Rota\n- week 40 — Alex',
    ...over,
  };
}

let target: HTMLElement;
let component: ReturnType<typeof mount> | null = null;
const spies = {
  onremove: vi.fn(),
  onfilter: vi.fn(),
  onsettag: vi.fn(),
  ondone: vi.fn(),
  onhoverstart: vi.fn(),
  onhoverend: vi.fn(),
};

function render(e: StashEntry, holder: TabHolder | null = null, compact = false): HTMLElement {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(StashCard, {
    target,
    props: {
      entry: e,
      title: e.title ?? 'Без названия',
      match: { rank: 0 },
      query: '',
      holder,
      kb: false,
      expanded: false,
      dragging: false,
      compact,
      pulse: false,
      newTags: [],
      now: NOW,
      ...spies,
    },
  });
  flushSync();
  return target.querySelector<HTMLElement>('.card')!;
}

function q(card: HTMLElement, sel: string): HTMLElement | null {
  return card.querySelector<HTMLElement>(sel);
}

beforeEach(() => installCatalog('ru'));
afterEach(() => {
  if (component) unmount(component);
  component = null;
  target?.remove();
  for (const s of Object.values(spies)) s.mockClear();
  installCatalog('en');
});

describe('StashCard', () => {
  it('a file ref: remove action, «отложено», repo/branch, path, a dashed repo chip', () => {
    const card = render(entry());
    expect(q(card, '.card-rm')?.textContent).toBe('убрать из тайника');
    expect(q(card, '.card-meta .aw')?.textContent).toBe('отложено сегодня 09:30');
    expect(q(card, '.card-meta')?.textContent).toContain('infra');
    expect(q(card, '.card-meta .br')?.textContent).toBe('⎇ main');
    expect(q(card, '.card-path')?.textContent).toBe('oncall/rota.md');
    expect(q(card, '.tag.repo')?.textContent).toContain('infra');
    expect(q(card, '.tag.repo .tag-x')).toBeNull();
    expect(q(card, '.tag:not(.repo) .tag-b')?.textContent).toBe('#ops');
  });

  it('a note: no remove action (stage 06), the note line, the title line dropped from the preview', () => {
    const card = render(entry({ kind: 'note', title: 'Rota', repo: null, branch: null, path: '/d/n.md' }));
    expect(q(card, '.card-rm')).toBeNull();
    expect(q(card, '.card-path')).toBeNull();
    expect(q(card, '.card-meta')?.textContent).toContain('заметка ·');
    expect(q(card, '.card-preview')?.textContent).not.toContain('Rota');
    expect(q(card, '.card-preview')?.textContent).toContain('week 40');
  });

  it('the hover actions sit in one overlay, not in the head row beside the name', () => {
    // In the row, invisible, they kept their width and cut a file's name to «stash-de…».
    const card = render(entry(), { label: 'editor-19', number: 19 });
    const head = q(card, '.card-head')!;
    const row = [...head.children].map((el) => el.className.split(' ')[0]);
    expect(row).toEqual(['kind-ico', 'card-name', 'open-mark', 'card-acts']);
    const acts = q(card, '.card-acts')!;
    expect([...acts.children].map((el) => el.className.split(' ')[0])).toEqual(['tag-add', 'card-rm']);
  });

  it('a note with its tag input open has no overlay left to show', async () => {
    const card = render(entry({ kind: 'note' }));
    expect(q(card, '.card-acts .tag-add')).not.toBeNull();
    q(card, '.tag-add')!.click();
    await tick();
    expect(q(card, '.card-acts')).toBeNull();
  });

  it('draws the kind icon from the shared icon paths', () => {
    const paths = (card: HTMLElement) => [...card.querySelectorAll('.kind-ico path')].map((p) => p.getAttribute('d'));
    expect(paths(render(entry()))).toEqual([...STASH_ICONS.fref]);
    unmount(component!);
    target.remove();
    expect(paths(render(entry({ kind: 'note' })))).toEqual([...STASH_ICONS.note]);
  });

  it('says which window has it open', () => {
    expect(q(render(entry(), { label: 'editor-19', number: 19 }), '.open-mark')?.textContent).toBe('открыт в #19');
  });

  it('a note open elsewhere reads in the feminine', () => {
    const card = render(entry({ kind: 'note' }), { label: 'editor-19', number: 19 });
    expect(q(card, '.open-mark')?.textContent).toBe('открыта в #19');
  });

  it('compact: one preview line, the «отложено» line kept, the path hidden by the variant', () => {
    const card = render(entry({ preview: '# Rota\n- week 40 — Alex\n- week 41 — Kim' }), null, true);
    expect(card.classList.contains('compact')).toBe(true);
    expect(card.querySelectorAll('.card-preview > div')).toHaveLength(1);
    expect(q(card, '.card-preview')?.textContent).toBe('Rota');
    expect(q(card, '.card-meta .aw')?.textContent).toBe('отложено сегодня 09:30');
  });

  it('adds a normalized tag on Enter', async () => {
    const card = render(entry());
    q(card, '.tag-add')!.click();
    await tick();
    const input = q(card, '.tag-edit') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.maxLength).toBe(TAG_MAX);
    input.value = ' #Deploy Plan ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    flushSync();
    expect(spies.onsettag).toHaveBeenCalledWith({ add: ['deploy-plan'] });
    expect(spies.ondone).toHaveBeenCalled();
    expect(q(card, '.tag-edit')).toBeNull();
  });

  it('a tag the entry already has is not sent again', async () => {
    const card = render(entry());
    q(card, '.tag-add')!.click();
    await tick();
    const input = q(card, '.tag-edit') as HTMLInputElement;
    input.value = '#OPS';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    flushSync();
    expect(spies.onsettag).not.toHaveBeenCalled();
    expect(spies.ondone).toHaveBeenCalled();
  });

  it('Esc cancels the tag and its keys stay in the input', async () => {
    const outside = vi.fn();
    window.addEventListener('keydown', outside);
    const card = render(entry());
    q(card, '.tag-add')!.click();
    await tick();
    const input = q(card, '.tag-edit') as HTMLInputElement;
    input.value = 'x';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })
    );
    flushSync();
    expect(spies.onsettag).not.toHaveBeenCalled();
    expect(outside).not.toHaveBeenCalled();
    expect(q(card, '.tag-edit')).toBeNull();
    window.removeEventListener('keydown', outside);
  });

  it('a chip filters; its × removes the tag; the remove action removes the ref', () => {
    const card = render(entry());
    q(card, '.tag:not(.repo) .tag-b')!.click();
    expect(spies.onfilter).toHaveBeenCalledWith('ops');
    q(card, '.tag:not(.repo) .tag-x')!.click();
    expect(spies.onsettag).toHaveBeenCalledWith({ remove: ['ops'] });
    q(card, '.tag.repo')!.click();
    expect(spies.onfilter).toHaveBeenCalledWith('infra');
    q(card, '.card-rm')!.click();
    expect(spies.onremove).toHaveBeenCalled();
  });
});

describe('StashGlyph', () => {
  it('draws the tray from icons.ts — one copy of the path', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const glyph = mount(StashGlyph, { target: host, props: { size: 13 } });
    flushSync();
    expect([...host.querySelectorAll('path')].map((p) => p.getAttribute('d'))).toEqual([...STASH_ICONS.tray]);
    unmount(glyph);
    host.remove();
  });
});
