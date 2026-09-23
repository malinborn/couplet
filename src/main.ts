import { mount } from 'svelte';
import App from './App.svelte';
import { installCatalog, isSupportedLanguage, resolveFromNavigatorLanguage } from './lib/i18n';

/**
 * Rust resolves the language once, at `setup` — stored preference, else the
 * system locale, else `en` — and persists it, so the frontend never repeats
 * that chain. In browser dev (`npm run dev`) there is no Tauri at all, so
 * `invoke` throws immediately; the catch falls back to `navigator.language`,
 * mirrored in `lib/i18n.ts`.
 */
async function resolveLanguage(): Promise<import('./lib/i18n').SupportedLanguage> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const resolved = await invoke<string>('resolved_language');
    if (isSupportedLanguage(resolved)) return resolved;
  } catch {
    // No Tauri (browser dev), or the command isn't wired up yet.
  }
  return resolveFromNavigatorLanguage(typeof navigator !== 'undefined' ? navigator.language : undefined);
}

async function boot(): Promise<void> {
  const language = await resolveLanguage();
  // Installed before mount() so nothing renders in English before the
  // catalog is ready — no flash of the fallback language.
  installCatalog(language);
  mount(App, { target: document.getElementById('app')! });
}

void boot();
