import { describe, expect, it } from 'vitest';
import {
  anchorContextAt,
  anchorPosition,
  buildHandoffPrompt,
  buildWatchPrompt,
  documentDir,
  escapeAttr,
  parseComments,
  quotePreview,
  unescapeAttr,
} from './comment-format';

const SAMPLE = `<!-- mdmini:comments v=1 doc=spec.md -->

<!-- mdmini:c id=c-7f3a2c status=open line=3 -->
> We ship via Caddy

**Макс** · 2026-08-24 14:02
Почему не nginx?

**agent** · 2026-08-24 14:05
Он был сломан.
`;

describe('parseComments', () => {
  it('reads threads, status, quote and replies', () => {
    const threads = parseComments(SAMPLE);
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe('c-7f3a2c');
    expect(threads[0].status).toBe('open');
    expect(threads[0].line).toBe(3);
    expect(threads[0].quote).toBe('We ship via Caddy');
    expect(threads[0].replies).toHaveLength(2);
    expect(threads[0].replies[1].author).toBe('agent');
    expect(threads[0].replies[1].text).toBe('Он был сломан.');
  });

  it('returns an empty list for an empty file', () => {
    expect(parseComments('')).toEqual([]);
  });

  it('skips a thread whose marker has no id', () => {
    expect(parseComments('<!-- mdmini:c status=open line=1 -->\n> q\n')).toEqual([]);
  });

  it('parses a reply header with a Cyrillic author name', () => {
    const text = `<!-- mdmini:c id=c-1 status=open line=1 -->
> anchor

**Максим Ковалевский** · 2026-08-24 14:02
Текст реплики.
`;
    const threads = parseComments(text);
    expect(threads).toHaveLength(1);
    expect(threads[0].replies).toHaveLength(1);
    expect(threads[0].replies[0].author).toBe('Максим Ковалевский');
    expect(threads[0].replies[0].at).toBe('2026-08-24 14:02');
    expect(threads[0].replies[0].text).toBe('Текст реплики.');
  });

  it('does not mistake a "> " line inside reply text for the anchor quote', () => {
    const text = `<!-- mdmini:c id=c-1 status=open line=1 -->
> anchor quote

**Макс** · 2026-08-24 14:02
See this:
> quoted from elsewhere
end of reply.
`;
    const threads = parseComments(text);
    expect(threads).toHaveLength(1);
    expect(threads[0].quote).toBe('anchor quote');
    expect(threads[0].replies).toHaveLength(1);
    expect(threads[0].replies[0].text).toBe('See this:\n> quoted from elsewhere\nend of reply.');
  });
});

describe('anchorPosition', () => {
  const doc = 'first\nWe ship via Caddy\nthird\n';

  it('finds the quote and returns its offset', () => {
    expect(anchorPosition(doc, 'We ship via Caddy', 2)).toEqual({
      pos: 6,
      to: 23,
      orphaned: false,
    });
  });

  it('bounds the range to the quoted fragment so it can be highlighted', () => {
    const { pos, to } = anchorPosition(doc, 'We ship via Caddy', 2);
    expect(doc.slice(pos, to)).toBe('We ship via Caddy');
  });

  it('returns an empty range for a detached thread — nothing to highlight', () => {
    const { pos, to } = anchorPosition(doc, 'absent text', 3);
    expect(to).toBe(pos);
  });

  it('bounds the range to the first quote line only, never across a newline', () => {
    const multi = 'first\nWe ship via Caddy\nthird\n';
    const { pos, to } = anchorPosition(multi, 'We ship via Caddy\nthird', 2);
    expect(multi.slice(pos, to)).toBe('We ship via Caddy');
    expect(multi.slice(pos, to)).not.toContain('\n');
  });

  it('falls back to the stored line when the quote is gone', () => {
    const result = anchorPosition(doc, 'nothing like this', 3);
    expect(result.orphaned).toBe(true);
    expect(result.pos).toBe(24);
  });

  it('clamps a stored line beyond the end of the document', () => {
    const result = anchorPosition(doc, 'absent', 999);
    expect(result.orphaned).toBe(true);
    expect(result.pos).toBeLessThanOrEqual(doc.length);
  });
});


/**
 * Real misses, collected by running both candidate strategies over this
 * repository's own markdown (~21k generated cases — see the #20 research in
 * the PR). Every document below is an excerpt of a real file, kept verbatim
 * so the ambiguity is the one that actually occurs, not a constructed one.
 */
describe('anchorPosition — the cases that used to land on the wrong copy', () => {
  /** Comment on a word that also appears in a table far above it. */
  const TABS = [
    '| Команда | Что делает |',
    '|---|---|',
    '| Табы | переключают документ |',
    '',
    '## Редактор',
    '',
    'Табы в списке сдвигают пункт на уровень глубже.',
    '',
  ].join('\n');

  it('does not jump to an earlier duplicate in a table (the live repro in #20)', () => {
    const from = TABS.indexOf('Табы в списке');
    const context = anchorContextAt(TABS, from, from + 4);
    const { pos } = anchorPosition(TABS, 'Табы', 7, context);
    expect(pos).toBe(from);
  });

  it('still lands right when the recorded line has drifted', () => {
    const from = TABS.indexOf('Табы в списке');
    const context = anchorContextAt(TABS, from, from + 4);
    // The agent inserted a section above: the stored line is now wrong by 40,
    // and the only thing left pointing at the right copy is the context.
    const { pos } = anchorPosition(TABS, 'Табы', 47, context);
    expect(pos).toBe(from);
  });

  it('with no stored context falls back to the occurrence nearest the line', () => {
    const from = TABS.indexOf('Табы в списке');
    expect(anchorPosition(TABS, 'Табы', 7).pos).toBe(from);
    // …and the first occurrence when the line points there instead.
    expect(anchorPosition(TABS, 'Табы', 3).pos).toBe(TABS.indexOf('| Табы |') + 2);
  });

  /** An identical line three lines above — line distance alone cannot decide. */
  const DUPLICATE = [
    '- `npm run dev` — Vite',
    '',
    'Ниже описано то же самое подробнее.',
    '',
    '- `npm run dev` — Vite',
    '',
  ].join('\n');

  it('tells two identical lines apart by what surrounds them', () => {
    const second = DUPLICATE.lastIndexOf('- `npm run dev`');
    const quote = '- `npm run dev` — Vite';
    const context = anchorContextAt(DUPLICATE, second, second + quote.length);
    expect(anchorPosition(DUPLICATE, quote, 5, context).pos).toBe(second);
    const first = DUPLICATE.indexOf('- `npm run dev`');
    const firstContext = anchorContextAt(DUPLICATE, first, first + quote.length);
    expect(anchorPosition(DUPLICATE, quote, 1, firstContext).pos).toBe(first);
  });

  /** A word that repeats dozens of times — `mdmini` in docs/ai-interface.md. */
  const REPEATED = [
    '# AI Interface — `mdmini show`',
    '',
    'The `mdmini` CLI speaks to a running window.',
    '',
    '## Protocol',
    '',
    'Every `mdmini` verb returns JSON on stdout.',
    '',
  ].join('\n');

  it('picks the occurrence whose surroundings match, not the first in the file', () => {
    const third = REPEATED.lastIndexOf('`mdmini`') + 1;
    const context = anchorContextAt(REPEATED, third, third + 6);
    expect(anchorPosition(REPEATED, 'mdmini', 7, context).pos).toBe(third);
  });

  it('survives the neighbouring line being rewritten by the agent', () => {
    const third = REPEATED.lastIndexOf('`mdmini`') + 1;
    const context = anchorContextAt(REPEATED, third, third + 6);
    const edited = REPEATED.replace('## Protocol', '## Протокол, переписанный агентом');
    const moved = edited.lastIndexOf('`mdmini`') + 1;
    expect(anchorPosition(edited, 'mdmini', 7, context).pos).toBe(moved);
  });

  it('marks a thread detached rather than showing it confidently in the wrong place', () => {
    const result = anchorPosition(REPEATED, 'текст, которого тут нет', 3);
    expect(result.orphaned).toBe(true);
    expect(result.to).toBe(result.pos);
  });
});

describe('anchorContextAt', () => {
  it('takes text from both sides of the fragment', () => {
    const doc = 'слева фрагмент справа';
    const from = doc.indexOf('фрагмент');
    const { prefix, suffix } = anchorContextAt(doc, from, from + 8);
    expect(prefix).toBe('слева ');
    expect(suffix).toBe(' справа');
  });

  it('clips at the document edges instead of going negative', () => {
    const { prefix, suffix } = anchorContextAt('abc', 0, 3);
    expect(prefix).toBe('');
    expect(suffix).toBe('');
  });
});

describe('marker attribute escaping', () => {
  it('removes the characters that would split or truncate a marker', () => {
    const escaped = escapeAttr('в таблице: 100% > всего\nи перенос');
    expect(escaped).not.toMatch(/\s/);
    expect(escaped).not.toContain('>');
    // Cyrillic stays literal — the file is read by people.
    expect(escaped).toContain('таблице');
  });

  it('round-trips', () => {
    const raw = 'в таблице: 100% > всего\nи перенос';
    expect(unescapeAttr(escapeAttr(raw))).toBe(raw);
  });

  it('leaves a hand-written stray percent alone instead of throwing', () => {
    expect(unescapeAttr('100%')).toBe('100%');
    expect(unescapeAttr('%zz')).toBe('%zz');
  });
});

describe('parseComments — anchor context', () => {
  it('reads pre= and suf= off the marker', () => {
    const text =
      '<!-- mdmini:c id=c-1 status=open line=3 pre=в%20таблице:%20 suf=%20и%20отступы -->\n> Табы\n';
    const [thread] = parseComments(text);
    expect(thread.prefix).toBe('в таблице: ');
    expect(thread.suffix).toBe(' и отступы');
  });

  it('leaves them undefined on a thread written without them', () => {
    const [thread] = parseComments('<!-- mdmini:c id=c-1 status=open line=3 -->\n> Табы\n');
    expect(thread.prefix).toBeUndefined();
    expect(thread.suffix).toBeUndefined();
  });
});

describe('quotePreview', () => {
  it('shows a short quote whole', () => {
    expect(quotePreview('Почему не nginx?')).toBe('Почему не nginx?');
  });

  it('shows exactly 30 characters whole', () => {
    const thirty = 'x'.repeat(30);
    expect(quotePreview(thirty)).toBe(thirty);
  });

  it('keeps both ends of a longer quote', () => {
    const quote = 'Сайт обслуживается Caddy на хосте 147.45.146.94 и это важно';
    const preview = quotePreview(quote);
    // Asserted against slices of the input rather than hand-counted literals:
    // both ends have to survive, and which exact characters those are is the
    // function's business, not the test's.
    expect(preview.startsWith(quote.slice(0, 15))).toBe(true);
    expect(preview.endsWith(quote.slice(-15))).toBe(true);
    expect(preview).toContain('…');
  });

  it('distinguishes two fragments that begin identically', () => {
    const a = 'Конфиг ставится фрагментом в /etc/caddy/Caddyfile.d/';
    const b = 'Конфиг ставится фрагментом в /etc/nginx/conf.d/';
    // The reason both ends are kept: with only the head, these two would
    // produce the same header and the cards would be indistinguishable.
    expect(quotePreview(a)).not.toBe(quotePreview(b));
  });

  it('never exceeds 31 characters — 15 plus 15 plus the ellipsis', () => {
    expect(quotePreview('y'.repeat(500))).toHaveLength(31);
  });

  it('collapses newlines so the header stays one line', () => {
    expect(quotePreview('первая\nвторая')).toBe('первая вторая');
  });

  it('collapses runs of whitespace', () => {
    expect(quotePreview('a    b')).toBe('a b');
  });
});

describe('documentDir', () => {
  it('returns the containing directory', () => {
    expect(documentDir('/repo/docs/spec.md')).toBe('/repo/docs');
  });

  it('returns the root for a file directly in it', () => {
    expect(documentDir('/spec.md')).toBe('/');
  });
});

describe('buildWatchPrompt', () => {
  it('names the directory, not the file — watch is tree-scoped', () => {
    const prompt = buildWatchPrompt('/repo/docs/spec.md');
    expect(prompt).toContain('mdmini watch /repo/docs');
  });

  it('spells out persistent: true, the flag whose absence fails silently', () => {
    expect(buildWatchPrompt('/repo/spec.md')).toContain('persistent: true');
  });

  it('offers a fallback for agents with no event stream', () => {
    expect(buildWatchPrompt('/repo/spec.md')).toContain('mdmini question');
  });

  it('says how to answer, not only how to listen', () => {
    expect(buildWatchPrompt('/repo/spec.md')).toContain('mdmini answer');
  });
});

describe('buildHandoffPrompt', () => {
  it('names the comment file, the document and the thread id', () => {
    const prompt = buildHandoffPrompt('/repo/spec.md', 'c-7f3a2c');
    expect(prompt).toContain('/repo/.mdmini_comments_spec.md');
    expect(prompt).toContain('/repo/spec.md');
    expect(prompt).toContain('c-7f3a2c');
    expect(prompt).toContain('mdmini answer');
  });
});
