/**
 * Manual verification script for the *built* landing page (`docs/`). Not a
 * vitest suite — it drives a real browser end to end and is meant to be run
 * by hand after `npm run build:site`, against a static file server:
 *
 *   npx --yes http-server docs -p 8901 --silent &
 *   node site/__tests__/landing.manual.ts
 *   kill %1
 *
 * Named `landing.manual.ts`, not `landing.spec.ts`: vitest's default include
 * glob is `**\/*.{test,spec}.?(c|m)[jt]s?(x)`, matched purely by filename —
 * directory doesn't matter. A `.spec.ts` file here would still be collected
 * by a bare `vitest` / `npm run test` run (only `npx vitest run --dir src`
 * is scoped past it structurally), and vitest would then fail the file for
 * containing zero `describe`/`it` blocks rather than skipping it. `.manual.ts`
 * doesn't match that glob anywhere in the repo, so both stay clean.
 *
 * Runs on Node directly (Node 22.6+/25 strips TypeScript types natively —
 * no ts-node/tsx needed) and drives the installed Google Chrome via
 * `playwright`'s `channel: 'chrome'`, because this repo's cached Playwright
 * browser build lags the installed CLI (see CLAUDE.md).
 */
import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = 'http://localhost:8901';
const SCREENSHOT_DIR = path.join(process.env.CLAUDE_JOB_DIR ?? process.cwd(), 'tmp');

const SLIDE_HEADINGS = [
  'Your agent can point.',
  'Your agent can edit.',
  'Your agent can ask.',
  'You can ask your agent.',
  'It can be used any way.',
  // Matched against raw served HTML (no entity decoding) — the source markup
  // spells the apostrophe as the numeric/named entity, not U+2019 directly.
  'And it&rsquo;s basically just a good markdown editor.',
] as const;

const CHANGELOG_VERSIONS = [
  'v1.1.0', 'v1.0.1', 'v1.0.0', 'v0.5.1', 'v0.5.0', 'v0.4.0', 'v0.3.5', 'v0.3.4', 'v0.3.3', 'v0.3.2',
  'v0.3.1', 'v0.3.0', 'v0.2.2', 'v0.2.1', 'v0.2.0', 'v0.1.6', 'v0.1.5',
  'v0.1.4', 'v0.1.3', 'v0.1.0',
] as const;

let failureCount = 0;

function report(label: string, passed: boolean, detail = ''): void {
  if (passed) {
    console.log(`  PASS  ${label}`);
  } else {
    failureCount += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function checkRawHtmlNoJs(): Promise<void> {
  console.log('\nCheck 7 — no-JS: raw served HTML has all copy');
  const html = await fetch(`${BASE_URL}/`).then((res) => res.text());

  for (const heading of SLIDE_HEADINGS) {
    report(`slide heading present: "${heading}"`, html.includes(heading));
  }

  const missingVersions = CHANGELOG_VERSIONS.filter((v) => !html.includes(v));
  report(
    `all ${CHANGELOG_VERSIONS.length} changelog versions present`,
    missingVersions.length === 0,
    missingVersions.join(', ')
  );
}

async function gotoSlide(page: Page, index: number): Promise<void> {
  await page.locator('#ai-carousel').scrollIntoViewIfNeeded();
  await page.click(`#carousel-dots .carousel-dot[data-index="${index}"]`);
}

async function checkConsoleAndPageErrors(page: Page): Promise<void> {
  console.log('\nCheck 1 — zero console/page errors across load + 8s dwell');
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err: Error) => pageErrors.push(String(err)));

  await page.goto(`${BASE_URL}/`, { waitUntil: 'load' });
  await page.waitForTimeout(8000);

  report('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  report('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
}

async function checkNoHorizontalScroll(page: Page, label: string): Promise<void> {
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1
  );
  report(`no horizontal page scroll at ${label}`, !overflows);
}

async function checkEditDemo(page: Page): Promise<void> {
  console.log('\nCheck 4 — slide 2 (edit) shows a real AI-edit highlight');
  await gotoSlide(page, 1);
  try {
    // The edit slide performs a whole sequence before the highlight lands: the
    // terminal types a command, the agent's mdmini call appears, then the new
    // paragraph types itself in character by character. Budget for the full
    // performance, not just a render.
    await page.waitForSelector('.demo[data-demo="edit"] .cm-ai-edit-line', { timeout: 30000 });
    report('.cm-ai-edit-line present', true);
  } catch {
    report('.cm-ai-edit-line present', false, 'not found within 30s');
  }
}

async function checkAskDemo(page: Page): Promise<void> {
  console.log('\nCheck 3 — slide 3 (ask) has real, answerable ask cards');
  await gotoSlide(page, 2);
  try {
    await page.waitForSelector('.cm-ai-ask', { timeout: 5000 });
  } catch {
    report('ask cards mounted', false, '.cm-ai-ask not found within 5s');
    return;
  }

  // The demo performs itself now: one question at a time, auto-answered, then
  // the next. So the old "exactly 2 cards, click one, 1 remains" shape no longer
  // holds. What still proves the widget is the app's real component and not a
  // mockup is that a human's click runs its own onAnswer path — the card leaves
  // and the document underneath changes.
  const question = await page.locator('.cm-ai-ask-question').first().innerText();
  report('a question card is present', question.trim().length > 0, `got "${question}"`);

  const docBefore = await page.locator('.demo[data-demo="ask"] .cm-content').innerText();

  // Hovering first makes the auto-loop yield to the visitor, so our click is the
  // one that lands rather than racing a scripted press.
  await page.locator('.demo[data-demo="ask"]').hover();
  await page.waitForTimeout(200);
  await page.locator('.cm-ai-ask-option').first().click();
  await page.waitForTimeout(500);

  const stillThere = await page
    .locator('.cm-ai-ask-question')
    .filter({ hasText: question.trim() })
    .count();
  report('answering removes the card that was answered', stillThere === 0, `got ${stillThere}`);

  const docAfter = await page.locator('.demo[data-demo="ask"] .cm-content').innerText();
  report('the answer edits the document', docAfter !== docBefore, 'document text unchanged');
}

/**
 * Slide 4 tells a round trip: a question is asked in a comment card and the
 * agent's answer comes back into the same thread. Asserting on the *end* of
 * that sequence is what makes this check meaningful — a card that appears but
 * never gains an answer would still satisfy a check for "a card exists".
 *
 * The wait is generous because the sequence is long by design (arm the watch,
 * select, type the question, get woken, answer) and three other demos are
 * animating concurrently by the time this runs.
 */
async function checkCommentRoundTrip(page: Page): Promise<void> {
  console.log('\nCheck 9 — slide 4 (comment) completes a question → answer round trip');
  await gotoSlide(page, 3);

  const demo = '.demo[data-demo="comment"]';
  try {
    await page.waitForSelector(`${demo} .cm-editor`, { timeout: 5000 });
  } catch {
    report('.cm-editor mounted in comment demo', false, 'not found within 5s');
    return;
  }
  report('.cm-editor mounted in comment demo', true);

  // The terminal is the delivery half of the story: without the Monitor line
  // the card would look like it answered itself.
  try {
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('.cmt-term-row--tool .cmt-term-text')).some((el) =>
          (el.textContent ?? '').includes('Monitor(')
        ),
      undefined,
      { timeout: 20000 }
    );
    report('terminal shows the Monitor call that arms the watch', true);
  } catch {
    report('terminal shows the Monitor call that arms the watch', false, 'not found within 20s');
  }

  try {
    await page.waitForSelector(`${demo} .cm-ai-comment`, { timeout: 25000 });
    report('a real comment card appears', true);
  } catch {
    report('a real comment card appears', false, 'no .cm-ai-comment within 25s');
    return;
  }

  // The anchor mark is what ties a card to the words it is about — the whole
  // point of anchoring, and easy to lose silently.
  const anchors = await page.locator(`${demo} .cm-ai-comment-anchor`).count();
  report('the commented fragment is marked in the text', anchors > 0, `count ${anchors}`);

  try {
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('.demo[data-demo="comment"] .cm-ai-comment-head')).some(
          (el) => (el.textContent ?? '').includes('answered')
        ),
      undefined,
      { timeout: 30000 }
    );
    report("the agent's answer lands in the thread", true);
  } catch {
    report("the agent's answer lands in the thread", false, 'no answered thread within 30s');
  }
}

async function checkShowcaseRibbon(page: Page): Promise<void> {
  console.log('\nCheck 2 & 5 — slide 6 (showcase) ribbon: real decorations, scroll, mermaid');
  await gotoSlide(page, 5);

  const editorSelector = '.demo[data-demo="showcase"] .cm-editor';
  try {
    await page.waitForSelector(editorSelector, { timeout: 5000 });
  } catch {
    report('.cm-editor mounted in showcase demo', false, 'not found within 5s');
    return;
  }
  report('.cm-editor mounted in showcase demo', true);

  const headingCount = await page
    .locator('.demo[data-demo="showcase"] .cm-md-h1, .demo[data-demo="showcase"] .cm-md-h2')
    .count();
  report('at least one real heading decoration present', headingCount > 0, `count ${headingCount}`);

  // The ribbon runs two editor lanes and crossfades between them, so there are
  // two scrollers; the first is the one on screen when a lane is active.
  const scroller = page.locator('.demo[data-demo="showcase"] .cm-scroller').first();
  const scrollTopBefore = await scroller.evaluate((el) => el.scrollTop);
  // Do not hover the card — pointer-over pauses the ribbon's auto-scroll.
  await page.waitForTimeout(3000);
  const scrollTopAfter = await scroller.evaluate((el) => el.scrollTop);
  report(
    'ribbon scrollTop advanced after 3s dwell',
    scrollTopAfter > scrollTopBefore,
    `${scrollTopBefore} -> ${scrollTopAfter}`
  );

  // Mermaid's dynamic import('mermaid') pulls in ~20 chunked files (dagre
  // layout, KaTeX, etc.), and by the time this check runs point/edit/ask are
  // already animating concurrently too, adding real contention for the main
  // thread. On top of that, mermaid measures node-label text using the
  // ribbon's real inherited font metrics to lay out the diagram — since the
  // editor-metrics fix gave the ribbon its correct 16px/1.6 line-height (up
  // from an accidental, undersized 14px), that layout pass got measurably
  // slower (~2x, observed 7s -> ~19-20s under the same four-demo contention
  // used here). The diagram still always renders; it just now does so later
  // in wall-clock time. Generous margin over that observed ceiling.
  const mermaidTimeoutMs = 30000;
  try {
    await page.waitForSelector('.demo[data-demo="showcase"] svg', { timeout: mermaidTimeoutMs });
    report(`mermaid <svg> rendered in the ribbon within ${mermaidTimeoutMs / 1000}s`, true);
  } catch {
    report(
      `mermaid <svg> rendered in the ribbon within ${mermaidTimeoutMs / 1000}s`,
      false,
      `not found within ${mermaidTimeoutMs / 1000}s`
    );
  }
}

async function checkThemeScreenshots(browser: Browser): Promise<void> {
  console.log('\nCheck 8 — both themes render (screenshots saved for visual review)');
  await mkdir(SCREENSHOT_DIR, { recursive: true });

  for (const theme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/`, { waitUntil: 'load' });
    await page.evaluate((t) => localStorage.setItem('mdmini-site:theme', t), theme);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(500);

    const dataTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    const expected = theme === 'dark' ? 'aurora-dark' : 'aurora-light';
    report(`data-theme is "${expected}" after setting "${theme}"`, dataTheme === expected, `got "${dataTheme}"`);

    const file = path.join(SCREENSHOT_DIR, `landing-${theme}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`  saved ${file}`);

    await context.close();
  }
}

async function main(): Promise<void> {
  await checkRawHtmlNoJs();

  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    await checkConsoleAndPageErrors(page);
    await checkEditDemo(page);
    await checkAskDemo(page);
    await checkCommentRoundTrip(page);
    await checkShowcaseRibbon(page);

    console.log('\nCheck 6 — no horizontal page scroll');
    await checkNoHorizontalScroll(page, '1280x900');
    await context.close();

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(`${BASE_URL}/`, { waitUntil: 'load' });
    await checkNoHorizontalScroll(mobilePage, '390x844');
    await mobileContext.close();

    await checkThemeScreenshots(browser);
  } finally {
    await browser.close();
  }

  console.log(
    failureCount === 0
      ? '\nAll checks passed.'
      : `\n${failureCount} check(s) FAILED — see above.`
  );
  process.exitCode = failureCount === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
