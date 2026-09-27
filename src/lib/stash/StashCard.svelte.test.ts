// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { installCatalog } from '../i18n';
import StashCard from './StashCard.svelte';
import StashGlyph from './StashGlyph.svelte';
import { STASH_ICONS } from './icons';
import { TAG_MAX, type SearchTerm } from './stash-query';
import type { StashEntry, StashHit, TabHolder } from './types';

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

function render(
  e: StashEntry,
  holder: TabHolder | null = null,
  compact = false,
  pulse: { pulse: boolean; pulseKey?: number } = { pulse: false },
  search: { hit?: StashHit | null; terms?: readonly SearchTerm[] } = {}
): HTMLElement {
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
      ...pulse,
      ...search,
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

  it('a note: «удалить» to the trash (stage 06), the note line, the title line dropped from the preview', () => {
    const card = render(entry({ kind: 'note', title: 'Rota', repo: null, branch: null, path: '/d/n.md' }));
    expect(q(card, '.card-rm')?.textContent).toBe('удалить');
    expect(q(card, '.card-rm')?.title).toBe('Заметка уйдёт в корзину на 30 дней');
    q(card, '.card-rm')!.click();
    expect(spies.onremove).toHaveBeenCalledTimes(1);
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

  it('with its tag input open, a card keeps only its remove action in the overlay', async () => {
    const card = render(entry({ kind: 'note' }));
    expect(q(card, '.card-acts .tag-add')).not.toBeNull();
    q(card, '.tag-add')!.click();
    await tick();
    expect([...q(card, '.card-acts')!.children].map((el) => el.className.split(' ')[0])).toEqual(['card-rm']);
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

  it('Enter or Esc that an IME is composing with leave the tag input alone (M6)', async () => {
    const card = render(entry());
    q(card, '.tag-add')!.click();
    await tick();
    const input = q(card, '.tag-edit') as HTMLInputElement;
    input.value = 'деплой';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const composing = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(composing);
    // WebKit marks some IME keys by keyCode 229 before `isComposing` is set.
    const consumed = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    Object.defineProperty(consumed, 'keyCode', { value: 229 });
    input.dispatchEvent(consumed);
    flushSync();
    expect(composing.defaultPrevented).toBe(false);
    expect(spies.onsettag).not.toHaveBeenCalled();
    expect(q(card, '.tag-edit')).not.toBeNull();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    flushSync();
    expect(spies.onsettag).toHaveBeenCalledWith({ add: ['деплой'] });
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

  it('a repeat pulse switches to the twin animation, so the CSS animation starts over (M7)', () => {
    const odd = render(entry(), null, false, { pulse: true, pulseKey: 1 });
    expect(odd.classList.contains('pulse')).toBe(true);
    expect(odd.classList.contains('pulse-alt')).toBe(true);
    unmount(component!);
    target.remove();
    const even = render(entry(), null, false, { pulse: true, pulseKey: 2 });
    expect(even.classList.contains('pulse')).toBe(true);
    expect(even.classList.contains('pulse-alt')).toBe(false);
    unmount(component!);
    target.remove();
    const off = render(entry(), null, false, { pulse: false, pulseKey: 3 });
    expect(off.classList.contains('pulse-alt')).toBe(false);
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

describe('StashCard with a search hit (stage 05)', () => {
  const note = entry({
    kind: 'note',
    title: 'Тайник для ключей',
    repo: null,
    branch: null,
    tags: [],
    path: '/d/n.md',
    preview: '# Тайник для ключей\nподписать документ',
  });
  const term = (text: string): SearchTerm => ({ text, phrase: false });
  const marks = (el: HTMLElement | null) => [...(el?.querySelectorAll('mark') ?? [])].map((m) => m.textContent);

  it('marks every term in the title, case aside', () => {
    const hit: StashHit = { entry: note, snippet: '', ranges: [], score: 1 };
    const card = render(note, null, false, { pulse: false }, { hit, terms: [term('тайн'), term('ключ')] });
    expect(marks(q(card, '.card-name'))).toEqual(['Тайн', 'ключ']);
  });

  it('shows the snippet with its ranges in place of the preview', () => {
    // A note's snippet is cut from the text below its title line (Rust
    // `hit_snippet`): it never repeats the title.
    const snippet = 'подписать документ';
    const at = snippet.indexOf('мент');
    const hit: StashHit = { entry: note, snippet, ranges: [[at, at + 4]], score: 1 };
    const card = render(note, null, false, { pulse: false }, { hit, terms: [term('мент')] });
    expect(q(card, '.card-preview .hit-l')?.textContent).toBe('в тексте:');
    expect(q(card, '.card-preview .hit')?.textContent).toBe(snippet);
    expect(marks(q(card, '.card-preview .hit'))).toEqual(['мент']);
    expect(card.querySelectorAll('.card-preview')).toHaveLength(1);
  });

  it('a title-only hit (no snippet) keeps the normal preview', () => {
    const hit: StashHit = { entry: note, snippet: '', ranges: [], score: 0 };
    const card = render(note, null, false, { pulse: false }, { hit, terms: [term('ок')] });
    expect(q(card, '.card-preview .hit')).toBeNull();
    expect(q(card, '.card-preview')?.textContent).toContain('подписать документ');
  });

  it('a snippet with nothing marked (a file matched by its title) keeps the normal preview', () => {
    // Rust gives a file ref whose body does not match the start of its body,
    // unmarked: «в тексте:» over it would claim a match that is not there.
    const file = entry();
    const hit: StashHit = { entry: file, snippet: 'Rota - week 40 — Alex', ranges: [], score: 1 };
    const card = render(file, null, false, { pulse: false }, { hit, terms: [term('rot')] });
    expect(q(card, '.card-preview .hit-l')).toBeNull();
    expect(q(card, '.card-preview')?.textContent).toContain('week 40 — Alex');
    expect(marks(q(card, '.card-name'))).toEqual(['rot']);
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

describe('StashCard, trashed (stage 06)', () => {
  const trashedNote = entry({
    id: 't1',
    kind: 'note',
    title: 'Черновик поста про VPN',
    path: '/n/.trash/t1.md',
    repo: 'shelf-design',
    branch: null,
    tags: ['infra'],
    stashedAt: null,
    deletedAt: new Date(2026, 8, 23, 9, 10).getTime(),
    preview: 'Черновик поста про VPN\nПочему мы ушли с OpenVPN на Xray\n- [ ] цифры по handshake',
  });
  const trashSpies = { onrestore: vi.fn(), onpurge: vi.fn() };

  function renderTrashed(e: StashEntry, compact = false): HTMLElement {
    target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(StashCard, {
      target,
      props: {
        entry: e,
        title: e.title ?? 'Без названия',
        match: { rank: 0 },
        query: '',
        holder: null,
        kb: false,
        expanded: false,
        dragging: false,
        compact,
        pulse: false,
        newTags: [],
        now: NOW,
        ...spies,
        trashed: true,
        ...trashSpies,
      },
    });
    flushSync();
    return target.querySelector<HTMLElement>('.card')!;
  }

  afterEach(() => {
    trashSpies.onrestore.mockClear();
    trashSpies.onpurge.mockClear();
  });

  it('is dimmed, marked for the trash, never a stash card (no drag, no open)', () => {
    const card = renderTrashed(trashedNote);
    expect(card.classList.contains('trashed')).toBe(true);
    expect(card.dataset.trashId).toBe('t1');
    expect(card.hasAttribute('data-stash-id')).toBe(false);
  });

  it('head, «удалена …», the preview without its title, plain tags', () => {
    const card = renderTrashed(trashedNote);
    expect(q(card, '.kind-ico')?.title).toBe('Удалённая заметка');
    expect(q(card, '.card-name')?.textContent).toBe('Черновик поста про VPN');
    expect(q(card, '.card-meta')?.textContent?.trim()).toBe('удалена 3 дня назад');
    expect(q(card, '.card-preview')?.textContent).toContain('OpenVPN');
    expect(q(card, '.card-preview')?.textContent).not.toContain('Черновик');
    expect(q(card, '.tag.repo')?.textContent).toContain('shelf-design');
    expect(q(card, '.tag:not(.repo)')?.textContent).toBe('#infra');
    expect(card.querySelectorAll('.card-tags button')).toHaveLength(0);
  });

  it("has none of a stash card's actions", () => {
    const card = renderTrashed(trashedNote);
    expect(q(card, '.card-acts')).toBeNull();
    expect(q(card, '.card-rm')).toBeNull();
    expect(q(card, '.open-mark')).toBeNull();
    expect(q(card, '.card-meta .aw')).toBeNull();
  });

  it('days left, «вернуть» and «удалить навсегда»', () => {
    const card = renderTrashed(trashedNote);
    expect(q(card, '.tr-actions .left')?.textContent).toBe('удалится через 27 дн.');
    const restore = q(card, '.tr-restore') as HTMLButtonElement;
    const purge = q(card, '.tr-purge') as HTMLButtonElement;
    expect(restore.textContent).toBe('вернуть');
    expect(restore.title).toBe('Вернуть в тайник вместе с тегами');
    expect(purge.textContent).toBe('удалить навсегда');
    expect(purge.title).toBe('Без возможности вернуть');
    restore.click();
    purge.click();
    expect(trashSpies.onrestore).toHaveBeenCalledTimes(1);
    expect(trashSpies.onpurge).toHaveBeenCalledTimes(1);
  });

  it('the compact rule that hides the meta line spares trashed cards (mockup `:not(.trashed)`)', () => {
    // `import.meta.url` as a string: jsdom's own `URL` is not one Node's `fileURLToPath` accepts.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'StashCard.svelte'), 'utf8');
    expect(css).toContain('.card.compact:not(.trashed) .card-meta > :not(.aw)');
    expect(css).not.toMatch(/\.card\.compact \.card-meta > :not\(\.aw\)/);
  });

  it("compact keeps «удалена …» (the stash card's rule exempts it) and one preview line", () => {
    const card = renderTrashed(trashedNote, true);
    expect(q(card, '.card-meta span')?.textContent).toBe('удалена 3 дня назад');
    expect(card.querySelectorAll('.card-preview > div')).toHaveLength(1);
    expect(q(card, '.card-preview')?.textContent).toBe('Почему мы ушли с OpenVPN на Xray');
  });
});
