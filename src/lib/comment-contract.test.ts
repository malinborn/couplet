import { describe, expect, it } from 'vitest';
import FIXTURE from './__fixtures__/comments-contract.md?raw';
import { parseComments } from './comment-format';

/**
 * Межъязыковой контракт формата файла комментариев.
 *
 * В файл пишет Rust (`src-tauri/src/comments.rs`), а читает и рисует его
 * TypeScript. Round-trip внутри каждого языка ничего об этом не говорит:
 * Rust может отрендерить то, что фронтовый парсер не поймёт, и наоборот —
 * и оба набора тестов останутся зелёными. Ломаться это будет молча, в виде
 * «комментарии перестали показываться», без единой упавшей проверки.
 *
 * Поэтому фикстура одна на две стороны. Здесь TypeScript обязан её разобрать;
 * зеркальный тест в `comments.rs` обязан её сгенерировать байт в байт. Правка
 * формата, сделанная в одном языке, роняет тест в другом — именно этого и надо.
 *
 * Фикстура втягивается Vite-суффиксом `?raw`, а не `node:fs`: в проекте нет
 * `@types/node`, и тащить его ради одного чтения файла — лишняя зависимость.
 */

describe('comment file format — cross-language contract', () => {
  it('parses every thread the fixture declares', () => {
    const threads = parseComments(FIXTURE);
    expect(threads.map((t) => t.id)).toEqual(['c-aaaaaa', 'c-bbbbbb', 'c-cccccc']);
  });

  it('reads the status written by the Rust side', () => {
    const [answered, open] = parseComments(FIXTURE);
    expect(answered.status).toBe('answered');
    expect(open.status).toBe('open');
  });

  it('keeps the anchor line number from the marker', () => {
    const [first, second] = parseComments(FIXTURE);
    expect(first.line).toBe(12);
    expect(second.line).toBe(27);
  });

  it('joins a multi-line blockquote anchor with newlines', () => {
    const [, second] = parseComments(FIXTURE);
    expect(second.quote).toBe('первая строка цитаты\nвторая строка цитаты');
  });

  it('reads a thread that already has an agent reply', () => {
    const [first] = parseComments(FIXTURE);
    expect(first.replies).toHaveLength(2);
    expect(first.replies[0].author).toBe('Вы');
    expect(first.replies[1].author).toBe('agent');
    // The zone marker is part of the contract: the file is human-read and may
    // be committed, so a bare local-looking time would be misread by anyone
    // outside UTC.
    expect(first.replies[1].at).toBe('2026-08-24 14:05:00 UTC');
  });

  it('preserves a multi-line reply body without swallowing the second line', () => {
    const [first] = parseComments(FIXTURE);
    expect(first.replies[1].text).toBe(
      'Nginx на этом хосте был сломан.\nПоэтому переехали на Caddy.'
    );
  });

  it('reads the anchor context Rust escaped into the marker', () => {
    // The third thread is the one carrying `pre=`/`suf=`. Escaping is part of
    // the contract: Rust writes percent-escaped values because a raw space
    // would be parsed as the start of another attribute, and TypeScript has to
    // unescape them the same way or anchoring silently loses its context.
    const [, , contextual] = parseComments(FIXTURE);
    expect(contextual.prefix).toBe('в таблице горячих клавиш: ');
    expect(contextual.suffix).toBe(' и отступы в списках');
  });

  it('does not leak the file header into the first thread', () => {
    const [first] = parseComments(FIXTURE);
    expect(first.quote).toBe('We ship via Caddy on the host');
    expect(first.replies[0].text).toBe('Почему не nginx? Разверни абзац.');
  });
});
