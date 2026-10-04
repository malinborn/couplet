// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ToastStack from './ToastStack.svelte';
import { createToastStore } from './toasts.svelte';
import { installCatalog } from './i18n';

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  installCatalog('en');
});

function render(payload: Parameters<ReturnType<typeof createToastStore>['push']>[0]): HTMLElement {
  const store = createToastStore();
  store.push(payload);
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(ToastStack, { target, props: { store } });
  flushSync();
  cleanup = () => {
    unmount(component);
    target.remove();
  };
  return target;
}

describe('ToastStack: tabs that stayed after "to new windows"', () => {
  it('SaysTheyStayedInThisWindow_WithTheError', () => {
    const root = render({ kind: 'tabs-stranded', fileNames: 'a.md, b.md', count: 2, message: 'no window' });
    expect(root.querySelector('.md-toast-text')?.textContent?.trim()).toBe('a.md, b.md stayed in this window');
    expect(root.querySelector('.md-toast-highlight')?.textContent).toBe('no window');
  });

  it('HasNoEmptyHighlightLineWhenThereIsNoError', () => {
    const root = render({ kind: 'tabs-stranded', fileNames: 'a.md', count: 1, message: null });
    expect(root.querySelector('.md-toast-text')?.textContent?.trim()).toBe('a.md stayed in this window');
    expect(root.querySelector('.md-toast-highlight')).toBeNull();
  });

  it('AgreesInNumberInRussian', () => {
    installCatalog('ru');
    const one = render({ kind: 'tabs-stranded', fileNames: 'a.md', count: 1, message: null });
    expect(one.querySelector('.md-toast-text')?.textContent?.trim()).toBe('a.md остался в этом окне');
    cleanup?.();
    const two = render({ kind: 'tabs-stranded', fileNames: 'a.md, b.md', count: 2, message: null });
    expect(two.querySelector('.md-toast-text')?.textContent?.trim()).toBe('a.md, b.md остались в этом окне');
    cleanup?.();
    // 21 is "one" to CLDR, but the line names many files.
    const many = render({ kind: 'tabs-stranded', fileNames: 'a.md, b.md, c.md +18', count: 21, message: null });
    expect(many.querySelector('.md-toast-text')?.textContent?.trim()).toBe('a.md, b.md, c.md +18 остались в этом окне');
  });
});

describe('ToastStack: a CSV opened as text', () => {
  const dim = (root: HTMLElement) => root.querySelector('.md-toast-dim')?.textContent?.trim();
  const head = (root: HTMLElement) => root.querySelector('.md-toast-text')?.textContent?.trim();

  const big = (rows: number) =>
    ({ kind: 'csv-as-text', path: '/t/big.csv', fileName: 'big.csv', refusal: { reason: 'too-large', rows } }) as const;

  it('TooLarge_SaysReadOnly_TheRowCountAndTheLimit', () => {
    const root = render(big(100000));
    expect(head(root)).toBe('big.csv opened as text, read-only');
    expect(dim(root)).toBe('Too large for the table view (100,000 rows, limit 20,000)');
  });

  it('Unparseable_SaysItCouldNotBeReadAsATable_AndIsNotReadOnly', () => {
    const root = render({ kind: 'csv-as-text', path: '/t/x.csv', fileName: 'x.csv', refusal: { reason: 'unparseable' } });
    expect(head(root)).toBe('x.csv opened as text');
    expect(dim(root)).toBe('Could not read it as a table');
  });

  it('AgreesInNumberInRussian_WithRussianDigitGrouping', () => {
    installCatalog('ru');
    const one = render(big(20001));
    expect(head(one)).toBe('big.csv открыт как текст, только для чтения');
    expect(dim(one)?.replace(/\s/g, ' ')).toBe('Слишком большой для таблицы (20 001 строка, лимит 20 000)');
    cleanup?.();
    const many = render(big(100000));
    expect(dim(many)?.replace(/\s/g, ' ')).toBe('Слишком большой для таблицы (100 000 строк, лимит 20 000)');
  });
});

describe('ToastStack: tabs moved to another window (plan 05)', () => {
  function renderMoved(numbers: (number | null)[]) {
    const store = createToastStore();
    store.push({ kind: 'tabs-moved', label: 'editor-4', numbers });
    const onRevealWindow = vi.fn();
    const target = document.createElement('div');
    document.body.appendChild(target);
    const component = mount(ToastStack, { target, props: { store, onRevealWindow } });
    flushSync();
    cleanup = () => {
      unmount(component);
      target.remove();
    };
    return { root: target, store, onRevealWindow };
  }

  it('SaysWhereTheTabsWent_AndGoesThereOnClick', () => {
    const { root, store, onRevealWindow } = renderMoved([18]);
    expect(root.querySelector('.md-toast-text')?.textContent?.trim()).toBe('Moved to #18');
    root.querySelector<HTMLButtonElement>('.md-toast-action')!.click();
    expect(onRevealWindow).toHaveBeenCalledWith('editor-4');
    expect(store.hasKind('tabs-moved')).toBe(false);
  });

  it('NamesEveryNewWindow_InRussianToo', () => {
    installCatalog('ru');
    const { root } = renderMoved([19, 20]);
    expect(root.querySelector('.md-toast-text')?.textContent?.trim()).toBe('Перенесено в #19, #20');
  });
});

describe('ToastStack: stash errors', () => {
  it('ABirthFailureSaysTheTextIsSafeInTheTab', () => {
    installCatalog('ru');
    const root = render({ kind: 'stash-error', message: 'EPERM' });
    expect(root.querySelector('.md-toast-text')?.textContent?.trim()).toBe('Заметка не создалась');
  });

  it('AFailedPutAwaySaysTheDocumentWasNotPutAway', () => {
    installCatalog('ru');
    const root = render({ kind: 'stash-error', message: 'stash unavailable: locked', notPutAway: true });
    expect(root.querySelector('.md-toast-text')?.textContent?.trim()).toBe('Не отложено в тайник');
    const dim = root.querySelector('.md-toast-dim')?.textContent ?? '';
    expect(dim).toContain('в тайник не попал');
    expect(dim).toContain('stash unavailable: locked');
    expect(dim).not.toContain('во вкладке');
  });
});
