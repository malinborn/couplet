/**
 * Тема — это семья и половина, а «система» поверх них галочка, а не пятый
 * вариант выбора.
 *
 * Раньше `ThemeSetting` был union из четырёх конкретных тем и `'system'`, и
 * это ломалось ровно там, где семей стало больше двух: `'system'` не помнит,
 * какую семью пользователь выбрал, поэтому рядом приходилось держать
 * `lastFamily` — вторую половину состояния, которую легко забыть обновить.
 * Теперь состояние одно: конкретная тема (она же семья и половина) плюс флаг
 * «следовать системе», который перебивает только половину.
 */

export type ThemeFamily = 'classic' | 'aurora' | 'blueprint' | 'phosphor' | 'paper' | 'ink' | 'riso';
export type ThemeHalf = 'light' | 'dark';

export const THEME_FAMILIES: readonly ThemeFamily[] = [
  'classic',
  'aurora',
  'blueprint',
  'phosphor',
  'paper',
  'ink',
  'riso',
];

export type ConcreteTheme =
  | 'light'
  | 'dark'
  | 'aurora-light'
  | 'aurora-dark'
  | 'blueprint-light'
  | 'blueprint-dark'
  | 'phosphor-light'
  | 'phosphor-dark'
  | 'paper-light'
  | 'paper-dark'
  | 'ink-light'
  | 'ink-dark'
  | 'riso-light'
  | 'riso-dark';

/**
 * Состояние выбора темы целиком. `followSystem` перебивает `half`, но не
 * стирает его: сняв галочку, пользователь возвращается к своей половине, а не
 * к дефолтной.
 */
export interface ThemeSelection {
  theme: ConcreteTheme;
  followSystem: boolean;
}

/**
 * Идентификатор темы для `data-theme`.
 *
 * У classic он без префикса (`light` / `dark`), а не `classic-light`: эти два
 * значения лежат в настройках у всех, кто уже пользуется приложением, и в
 * селекторах `:root[data-theme$='light']`, которыми выбирается палитра
 * подсветки кода. Переименование стоило бы миграции ради симметрии имени.
 */
export function concreteTheme(family: ThemeFamily, half: ThemeHalf): ConcreteTheme {
  return (family === 'classic' ? half : `${family}-${half}`) as ConcreteTheme;
}

export function familyOf(theme: ConcreteTheme): ThemeFamily {
  const dash = theme.lastIndexOf('-');
  if (dash === -1) return 'classic';
  return theme.slice(0, dash) as ThemeFamily;
}

export function halfOf(theme: ConcreteTheme): ThemeHalf {
  return theme.endsWith('dark') ? 'dark' : 'light';
}

export function isDarkTheme(theme: ConcreteTheme): boolean {
  return halfOf(theme) === 'dark';
}

/** С галочкой «система» половину выбирает ОС, семью — по-прежнему человек. */
export function resolveTheme(selection: ThemeSelection, systemDark: boolean): ConcreteTheme {
  if (!selection.followSystem) return selection.theme;
  return concreteTheme(familyOf(selection.theme), systemDark ? 'dark' : 'light');
}

const CONCRETE: readonly string[] = THEME_FAMILIES.flatMap((f) => [
  concreteTheme(f, 'light'),
  concreteTheme(f, 'dark'),
]);

export function isConcreteTheme(value: unknown): value is ConcreteTheme {
  return typeof value === 'string' && CONCRETE.includes(value);
}

/**
 * Читает то, что лежит в настройках, включая формат до этой перестройки.
 *
 * Старый формат хранил `'system'` в самом ключе темы и семью отдельно, и это
 * был **дефолт** — то есть так записано у большинства. Прочитать его
 * обязательно: иначе у каждого, кто не трогал тему, она молча сбросится, а
 * выглядеть это будет как «после обновления поехали цвета».
 */
export function loadSelection(
  rawTheme: unknown,
  rawFamily: unknown,
  rawFollowSystem?: unknown
): ThemeSelection {
  // Нынешний формат: конкретная тема и галочка порознь. Стоит первым — иначе
  // сохранённая галочка не переживает перезапуск, а выглядит это так, будто
  // приложение «забывает» настройку через раз.
  if (isConcreteTheme(rawTheme) && typeof rawFollowSystem === 'boolean') {
    return { theme: rawTheme, followSystem: rawFollowSystem };
  }
  if (rawTheme === 'system') {
    const family = THEME_FAMILIES.includes(rawFamily as ThemeFamily)
      ? (rawFamily as ThemeFamily)
      : 'classic';
    // Половина здесь неважна — её всё равно перебьёт система; важно, что она
    // осмысленная на случай, если галочку снимут.
    return { theme: concreteTheme(family, 'light'), followSystem: true };
  }
  if (isConcreteTheme(rawTheme)) return { theme: rawTheme, followSystem: false };
  // Первый запуск: как и раньше, следуем системе в classic.
  return { theme: 'light', followSystem: true };
}
