/**
 * The phone's mic button sits in the HEADER, outside `.toolbar`. Codeman's "tap a button while the
 * keyboard is up" fix only covered the toolbar, so the first tap on the mic took focus from the
 * terminal (the Android keyboard dropped away) and only a second tap reached the button.
 *
 * Browser-driven, so excluded from `npm run test:ci` (config/test-suites.ts). Run locally:
 *   npm run test:browser -- test/voice-mic-tap.browser.test.ts
 *
 * Port: 3295
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3295;

describe('mic button on a phone while the keyboard is up', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = new WebServer(PORT, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 390, height: 700 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    page = await context.newPage();
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
    await page.evaluate(() => {
      (window as any).__toggles = 0;
      // `VoiceInput` is a top-level const (a global binding, not a window property).
      // eslint-disable-next-line no-undef
      (0, eval)('VoiceInput').toggle = () => ((window as any).__toggles += 1);
    });
  }, 90000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  }, 60000);

  const tapMic = async () => {
    const box = (await page.locator('#voiceInputBtnMobile').boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(150);
  };
  const state = () =>
    page.evaluate(() => ({
      toggles: (window as any).__toggles as number,
      typing: document.activeElement?.classList.contains('xterm-helper-textarea') === true,
      active: document.activeElement?.id || document.activeElement?.tagName,
    }));

  it('the first tap starts it exactly once and the terminal keeps focus (so the keyboard stays up)', async () => {
    expect(await page.isVisible('#voiceInputBtnMobile')).toBe(true);
    await page.evaluate(() => (document.querySelector('.xterm-helper-textarea') as HTMLElement).focus());
    expect((await state()).typing).toBe(true);
    await tapMic();
    const after = await state();
    expect(after.toggles).toBe(1); // once: not swallowed, and not twice (the programmatic click plus a synthesized one)
    expect(after.typing, `focus moved to ${after.active}`).toBe(true);
  });

  it('with nothing focused a tap is an ordinary tap: it toggles once and does not grab focus', async () => {
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      (window as any).__toggles = 0;
    });
    await tapMic();
    const after = await state();
    expect(after.toggles).toBe(1);
    expect(after.typing).toBe(false);
  });
});
