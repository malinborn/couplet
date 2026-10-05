/**
 * The indent unit of a code file: what Enter after `def f():` adds.
 *
 * CM6's default `indentUnit` is two spaces, and nothing in couplet set one, so
 * a Python block opened two spaces deeper than the file around it. The unit now
 * comes from the file itself when it has indented lines, and from the
 * language's convention when it does not (an empty or flat file). Markdown is
 * not affected: this is installed only by `setCodeMode`.
 */

/** Lines read to detect the unit — enough for any real file, cheap on a huge one. */
export const DETECT_LINES = 2000;

/** Languages (by `@codemirror/language-data` name) conventionally indented by four spaces. */
const FOUR_SPACES = new Set([
  'Python',
  'Cython',
  'Rust',
  'Java',
  'C',
  'C++',
  'C#',
  'Objective-C',
  'Objective-C++',
  'PHP',
  'Kotlin',
  'Swift',
  'Scala',
  'Groovy',
  'Julia',
  'Perl',
  'PowerShell',
  'VB.NET',
]);

/** Languages conventionally indented by tabs. */
const TABS = new Set(['Go']);

/**
 * The unit the file's own indentation uses, or `null` when it has none to read.
 *
 * Tabs win when more lines start with a tab than with spaces. Otherwise the
 * unit is the most frequent step by which indentation *grows* from one
 * non-blank line to the next, between 2 and 8 spaces: steps of 1 (` * ` in a
 * C comment) and odd alignment of continuation lines are outvoted by the
 * blocks. A tie goes to the smaller step.
 */
export function detectIndentUnit(lines: Iterable<string>): string | null {
  let tabLines = 0;
  let spaceLines = 0;
  let prev = 0;
  const steps = new Map<number, number>();
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (line.startsWith('\t')) {
      tabLines++;
      prev = 0;
      continue;
    }
    const width = line.length - line.trimStart().length;
    if (width > 0) spaceLines++;
    const step = width - prev;
    if (step >= 2 && step <= 8) steps.set(step, (steps.get(step) ?? 0) + 1);
    prev = width;
  }
  if (tabLines > spaceLines) return '\t';
  let best = 0;
  let bestCount = 0;
  for (const [step, count] of steps) {
    if (count > bestCount || (count === bestCount && step < best)) {
      best = step;
      bestCount = count;
    }
  }
  return best ? ' '.repeat(best) : null;
}

/** The language's conventional unit; two spaces (CM6's default) when it has none here. */
export function defaultIndentUnit(languageName: string): string {
  if (TABS.has(languageName)) return '\t';
  return FOUR_SPACES.has(languageName) ? '    ' : '  ';
}

/** The file's own unit, else its language's. */
export function indentUnitFor(lines: Iterable<string>, languageName: string): string {
  return detectIndentUnit(lines) ?? defaultIndentUnit(languageName);
}
