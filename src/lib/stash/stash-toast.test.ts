import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCatalog } from '../i18n';
import { stashToastText, type StashToastNote } from './stash-toast';

beforeEach(() => installCatalog('ru'));
afterEach(() => installCatalog('en'));

type PutAway = Extract<StashToastNote, { what: 'put-away' }>;

const put = (over: Partial<PutAway>): StashToastNote => ({
  what: 'put-away',
  count: 1,
  dup: 0,
  lead: 'report.md',
  leadIsNote: false,
  hidden: 0,
  hiddenBy: null,
  onlyEmpty: false,
  emptyToo: false,
  ...over,
});

describe('stashToastText', () => {
  it('one file, new', () => {
    expect(stashToastText(put({}))).toEqual({ text: 'report.md → тайник', dim: '· отложено' });
  });

  it('one file already in the stash', () => {
    expect(stashToastText(put({ dup: 1 }))).toEqual({
      text: 'report.md → тайник',
      dim: '· запись уже была — вторая не создана',
    });
  });

  it('one note', () => {
    expect(stashToastText(put({ lead: 'Планы', leadIsNote: true }))).toEqual({
      text: 'Заметка Планы → тайник',
      dim: '· отложена',
    });
  });

  it('several, with duplicates, hidden by the chip, and an empty note', () => {
    expect(stashToastText(put({ count: 3, dup: 1, hidden: 2, hiddenBy: 'infra', emptyToo: true }))).toEqual({
      text: 'Отложено в тайник: 3',
      dim: '· для 1 запись уже была — дублей нет · скрыты фильтром #infra · пустая заметка просто закрыта',
    });
  });

  it('one hidden entry takes the singular; no chip means nothing is said about hiding', () => {
    expect(stashToastText(put({ hidden: 1, hiddenBy: 'infra' })).dim).toBe('· отложено · скрыт фильтром #infra');
    expect(stashToastText(put({ hidden: 1, hiddenBy: null })).dim).toBe('· отложено');
  });

  it('only an empty note', () => {
    expect(stashToastText(put({ count: 0, onlyEmpty: true }))).toEqual({
      text: 'Пустая заметка закрыта',
      dim: '· хранить нечего',
    });
  });

  it('opened, moved, removed, widened, failed, error', () => {
    expect(stashToastText({ what: 'opened', title: 'Планы', isNote: true, from: null })).toEqual({
      text: 'Планы открыта вкладкой',
      dim: '· из тайника',
    });
    expect(stashToastText({ what: 'opened', title: 'a.md', isNote: false, from: 12 }).dim).toBe('· переехал из #12');
    expect(stashToastText({ what: 'removed', title: 'a.md' })).toEqual({
      text: 'a.md убран из тайника',
      dim: '· файл остался на месте',
    });
    expect(stashToastText({ what: 'widened' }).dim).toBe('· вернётся, когда тайник закроется');
    expect(stashToastText({ what: 'pull-failed', number: 19, label: 'editor-19' }).text).toBe(
      'Не получилось перенести из #19'
    );
    expect(stashToastText({ what: 'pull-failed', number: null, label: 'editor-19' }).text).toBe(
      'Не получилось перенести из #?'
    );
    expect(stashToastText({ what: 'error', message: 'database is locked' })).toEqual({
      text: 'Тайник не ответил',
      dim: 'database is locked',
    });
  });

  describe('the trash (stage 06)', () => {
    it('a note went to the trash', () => {
      expect(stashToastText({ what: 'trashed', title: 'Черновик' })).toEqual({
        text: 'Заметка Черновик в удалённых',
        dim: '· 30 дней можно вернуть',
      });
    });

    it('a note came back — and says when the repo chip hides it', () => {
      expect(stashToastText({ what: 'restored', title: 'Идеи', hiddenBy: null })).toEqual({
        text: 'Заметка Идеи вернулась в тайник',
        dim: '· с тегами, наверху',
      });
      expect(stashToastText({ what: 'restored', title: 'Идеи', hiddenBy: 'infra' }).dim).toBe(
        '· с тегами, наверху · скрыта фильтром #infra'
      );
    });

    it('a note was purged', () => {
      expect(stashToastText({ what: 'purged', title: 'Идеи' })).toEqual({
        text: 'Заметка Идеи удалена навсегда',
        dim: '',
      });
    });

    it('a note stayed, and why; an unknown window number reads «?»', () => {
      const kept = (reason: 'unsaved' | 'timeout' | 'open', number: number | null) =>
        stashToastText({ what: 'kept', reason, title: 'Планы', label: 'editor-2', number }).text;
      expect(kept('unsaved', 2)).toBe('Заметка Планы открыта в #2 и ещё не сохранена — не удалена');
      expect(kept('timeout', 2)).toBe('Окно #2 не ответило — заметка Планы не удалена');
      expect(kept('open', null)).toBe('Заметку Планы снова открыли в #? — не удалена');
    });
  });
});
