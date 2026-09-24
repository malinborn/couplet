// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import TransientBar from './TransientBar.svelte';

let app: ReturnType<typeof mount> | null = null;

function render(visible: boolean) {
  const onclose = vi.fn();
  const onkeep = vi.fn();
  app = mount(TransientBar, { target: document.body, props: { visible, onclose, onkeep } });
  flushSync();
  return { onclose, onkeep };
}

afterEach(() => {
  if (app) unmount(app);
  app = null;
  document.body.innerHTML = '';
});

describe('TransientBar', () => {
  it('IsAbsentUnlessTheActiveTabIsAQuickLook', () => {
    render(false);
    expect(document.querySelector('.transient-bar')).toBeNull();
  });

  it('AsksCloseOrKeep_AndSaysWhatItIsInWords', () => {
    const { onclose, onkeep } = render(true);
    const bar = document.querySelector('.transient-bar');
    expect(bar?.getAttribute('role')).toBe('status');
    expect(bar?.textContent).toContain('Quick look from AI');
    (document.querySelector('.transient-bar .close') as HTMLButtonElement).click();
    (document.querySelector('.transient-bar .keep') as HTMLButtonElement).click();
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(onkeep).toHaveBeenCalledTimes(1);
  });
});
