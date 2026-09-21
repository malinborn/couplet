import { describe, it, expect } from 'vitest';
import {
  resolveTheme,
  loadSelection,
  concreteTheme,
  familyOf,
  halfOf,
  isDarkTheme,
  isConcreteTheme,
  THEME_FAMILIES,
} from './theme-resolve';

describe('resolveTheme', () => {
  it('WithoutFollowSystem_ReturnsTheChosenTheme', () => {
    expect(resolveTheme({ theme: 'light', followSystem: false }, true)).toBe('light');
    expect(resolveTheme({ theme: 'blueprint-dark', followSystem: false }, false)).toBe(
      'blueprint-dark'
    );
  });

  // Галочка перебивает только половину: семья остаётся выбранной человеком.
  it('WithFollowSystem_KeepsFamily_TakesHalfFromOs', () => {
    expect(resolveTheme({ theme: 'phosphor-light', followSystem: true }, true)).toBe(
      'phosphor-dark'
    );
    expect(resolveTheme({ theme: 'phosphor-dark', followSystem: true }, false)).toBe(
      'phosphor-light'
    );
    expect(resolveTheme({ theme: 'dark', followSystem: true }, false)).toBe('light');
    expect(resolveTheme({ theme: 'light', followSystem: true }, true)).toBe('dark');
  });
});

describe('concreteTheme', () => {
  // У classic идентификатор без префикса — так он записан в настройках у всех,
  // кто уже пользуется приложением, и так его читают селекторы `$='light'`.
  it('ClassicHasNoPrefix', () => {
    expect(concreteTheme('classic', 'light')).toBe('light');
    expect(concreteTheme('classic', 'dark')).toBe('dark');
  });

  it('OtherFamiliesArePrefixed', () => {
    expect(concreteTheme('aurora', 'light')).toBe('aurora-light');
    expect(concreteTheme('blueprint', 'dark')).toBe('blueprint-dark');
    expect(concreteTheme('phosphor', 'light')).toBe('phosphor-light');
  });

  it('RoundTripsThroughFamilyAndHalf', () => {
    for (const family of THEME_FAMILIES) {
      for (const half of ['light', 'dark'] as const) {
        const theme = concreteTheme(family, half);
        expect(isConcreteTheme(theme)).toBe(true);
        expect(familyOf(theme)).toBe(family);
        expect(halfOf(theme)).toBe(half);
      }
    }
  });
});

describe('isDarkTheme', () => {
  it('DetectsDarkVariants', () => {
    expect(isDarkTheme('dark')).toBe(true);
    expect(isDarkTheme('blueprint-dark')).toBe(true);
    expect(isDarkTheme('light')).toBe(false);
    expect(isDarkTheme('phosphor-light')).toBe(false);
  });
});

/**
 * Старый формат держал `'system'` в самом ключе темы, и это был дефолт — то
 * есть так записано у большинства. Без чтения этого формата у всех, кто не
 * трогал тему, она сбрасывалась бы на обновлении.
 */
describe('loadSelection', () => {
  it('LegacySystem_BecomesFollowSystemInStoredFamily', () => {
    expect(loadSelection('system', 'aurora')).toEqual({
      theme: 'aurora-light',
      followSystem: true,
    });
    expect(loadSelection('system', 'classic')).toEqual({ theme: 'light', followSystem: true });
  });

  it('LegacySystem_WithoutFamily_FallsBackToClassic', () => {
    expect(loadSelection('system', null)).toEqual({ theme: 'light', followSystem: true });
    expect(loadSelection('system', 'nonsense')).toEqual({ theme: 'light', followSystem: true });
  });

  // Явно выбранная тема означала «не следовать системе» и в старом формате.
  it('LegacyExplicitTheme_KeepsItAndDoesNotFollow', () => {
    expect(loadSelection('aurora-dark', 'aurora')).toEqual({
      theme: 'aurora-dark',
      followSystem: false,
    });
    expect(loadSelection('light', 'classic')).toEqual({ theme: 'light', followSystem: false });
  });

  it('FirstRun_FollowsSystemInClassic', () => {
    expect(loadSelection(null, null)).toEqual({ theme: 'light', followSystem: true });
    expect(loadSelection('какая-то ерунда', null)).toEqual({ theme: 'light', followSystem: true });
  });

  // Ключ галочки читается первым, иначе она не переживает перезапуск —
  // именно это и было сломано, пока тест стора не поймал.
  it('CurrentFormat_ReadsTheCheckboxAlongsideTheTheme', () => {
    expect(loadSelection('blueprint-light', null, true)).toEqual({
      theme: 'blueprint-light',
      followSystem: true,
    });
    expect(loadSelection('blueprint-light', null, false)).toEqual({
      theme: 'blueprint-light',
      followSystem: false,
    });
  });

  it('NewFamilies_LoadAsThemselves', () => {
    expect(loadSelection('blueprint-dark', null)).toEqual({
      theme: 'blueprint-dark',
      followSystem: false,
    });
    expect(loadSelection('phosphor-light', null)).toEqual({
      theme: 'phosphor-light',
      followSystem: false,
    });
  });
});
