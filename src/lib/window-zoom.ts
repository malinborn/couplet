import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

/**
 * Масштаб окна — вся вёрстка целиком, а не только текст документа.
 *
 * Раньше зум был инлайновым `font-size` на `<main>`, и это не работало по двум
 * причинам сразу: внутри редактора его перебивал жёсткий
 * `.md-editor-host .cm-scroller { font-size: 16px }`
 * (`src/styles/editor-metrics.css`), а тосты, бейджи и панель недавних файлов
 * вообще живут вне `<main>`. Масштабировался ровно один элемент: тултип
 * слэш-меню — он внутри `.cm-editor`, но снаружи скроллера, поэтому наследовал
 * `font-size` от `<main>`.
 *
 * Поэтому здесь не каскад шрифта, а зум страницы самого webview — то же, что
 * Cmd +/− в браузере. Движок пересчитывает раскладку сам, а CodeMirror при
 * этом продолжает видеть неизменённые CSS-пиксели, так что его геометрию
 * править не нужно. На macOS это `WKWebView.setPageZoom` (wry), то есть
 * полноценный зум с перевёрсткой, а не `magnification` — текст переносится по
 * ширине окна и горизонтальной прокрутки не появляется.
 *
 * Есть соблазн включить вместо этого `zoom_hotkeys_enabled` в билдере окна:
 * Tauri тогда сам вешает Cmd +/− и Cmd+колесо. Делать так нельзя дважды.
 * Во-первых, его счётчик зума не виден отсюда, и настройка с пунктами меню
 * разъехались бы с реальным масштабом. Во-вторых, Cmd+колесо в этом
 * приложении уже занято — им зумят mermaid-диаграмму (`preview/mermaid-*`).
 */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.0;
export const ZOOM_STEP = 0.1;

/** Шаг кратен 0.1, поэтому округление до десятых убирает дрейф float. */
function round(level: number): number {
  return Math.round(level * 10) / 10;
}

/** Чинит и настройку с диска, и любой шаг: наружу выходит только валидный зум. */
export function clampZoom(level: unknown): number {
  const value = typeof level === 'number' && Number.isFinite(level) ? level : 1;
  return round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)));
}

export function stepZoom(level: number, direction: 1 | -1): number {
  return clampZoom(clampZoom(level) + direction * ZOOM_STEP);
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Применяет масштаб к текущему окну.
 *
 * В браузере (`npm run dev`, где Tauri-IPC нет) откатывается на CSS `zoom` у
 * корня — визуально тот же результат, и вёрстку можно проверять без сборки
 * приложения. Пользователь этот путь не видит: в браузере масштабом занимается
 * сам браузер.
 */
export function applyWindowZoom(level: number): void {
  const value = clampZoom(level);
  if (inTauri()) {
    getCurrentWebviewWindow()
      .setZoom(value)
      .catch(() => {});
    return;
  }
  // В node (unit-тесты) применять нечего — состояние стора всё равно проверяемо.
  if (typeof document === 'undefined') return;
  document.documentElement.style.zoom = value === 1 ? '' : String(value);
}
