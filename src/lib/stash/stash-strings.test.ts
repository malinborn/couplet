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
