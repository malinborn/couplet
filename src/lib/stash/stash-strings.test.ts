import { afterEach, describe, expect, it } from 'vitest';
import { installCatalog, plural, t } from '../i18n';

afterEach(() => installCatalog('en'));

describe('stash strings', () => {
  it('Russian carries the mockup copy', () => {
    installCatalog('ru');
    expect(t('stash.bar.button')).toBe('Тайник');
    expect(t('stash.bar.drop')).toBe('Отложить в тайник');
    expect(t('stash.drawer.type_hint')).toBe('печатайте · #тег');
    expect(t('stash.card.open_in_note', { n: 19 })).toBe('открыта в #19');
    expect(plural(3, 'stash.when.days_ago')).toBe('3 дня назад');
    expect(t('toast.stash.widened')).toBe('Окно раздвинулось, чтобы тайник встал рядом');
  });

  it('Russian carries the mockup copy of the trash (stage 06)', () => {
    installCatalog('ru');
    expect(t('stash.trash.button')).toBe('Удалённые');
    expect(t('stash.trash.title')).toBe('Удалённые');
    expect(t('stash.trash.back')).toBe('← в тайник');
    expect(t('stash.trash.back_title')).toBe('Назад в тайник (Esc)');
    expect(t('stash.trash.button_title', { days: 30 })).toBe('Удалённые заметки — 30 дней можно вернуть');
    expect(t('stash.trash.kept_days', { days: 30 })).toBe('хранятся 30 дней');
    expect(t('stash.trash.in_stash')).toBe('в тайнике');
    expect(t('stash.trash.hint', { days: 30 })).toBe(
      'заметки хранятся 30 дней, потом удаляются · Esc — назад в тайник'
    );
    expect(t('stash.trash.empty')).toBe('Удалённых заметок нет');
    expect(t('stash.trash.kind_title')).toBe('Удалённая заметка');
    expect(t('stash.trash.deleted', { when: '3 дня назад' })).toBe('удалена 3 дня назад');
    for (const n of [1, 3, 27, 30]) expect(plural(n, 'stash.trash.days_left')).toBe(`удалится через ${n} дн.`);
    expect(t('stash.trash.restore')).toBe('вернуть');
    expect(t('stash.trash.restore_title')).toBe('Вернуть в тайник вместе с тегами');
    expect(t('stash.trash.purge')).toBe('удалить навсегда');
    expect(t('stash.trash.purge_title')).toBe('Без возможности вернуть');
    expect(t('stash.card.delete')).toBe('удалить');
    expect(t('stash.card.delete_title', { days: 30 })).toBe('Заметка уйдёт в корзину на 30 дней');
  });

  it('English says "trash" for the deleted notes', () => {
    installCatalog('en');
    expect(t('stash.trash.button')).toBe('Trash');
    expect(plural(1, 'stash.trash.days_left')).toBe('removed in 1 day');
    expect(plural(27, 'stash.trash.days_left')).toBe('removed in 27 days');
  });

  it('a compact blank card says just «пустая», as the mockup draws it', () => {
    installCatalog('ru');
    expect(t('stash.card.blank_short')).toBe('пустая');
    installCatalog('en');
    expect(t('stash.card.blank_short')).toBe('empty');
  });

  it('English says "stash"', () => {
    installCatalog('en');
    expect(t('stash.drawer.title')).toBe('Stash');
    expect(t('tabs.selection.to_stash')).toBe('To stash');
  });
});
