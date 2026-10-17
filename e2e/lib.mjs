// Shared browser helpers for the E2E driver and smoke test.
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const CANDIDATES = [process.env.NN_CHROME, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'];

export function chromePath() {
  for (const c of CANDIDATES) if (c && existsSync(c)) return c;
  return undefined; // let playwright find its own
}

export async function launch({ base, outDir, width = 1280, height = 720 }) {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({
    executablePath: chromePath(),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--no-proxy-server'],
  });
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.stack || e)));
  page.on('console', (m) => {
    const t = m.text();
    if ((m.type() === 'error' || m.type() === 'warning') && !t.includes('404') && !t.includes('GPU stall') && !t.includes('GL Driver')) errors.push(m.type() + ': ' + t);
    if (m.type() === 'log' && t.startsWith('[nn]')) console.log(t);
  });
  const h = {
    base,
    errors,
    async open(query = '') {
      await page.goto(base + (query ? '?' + query : ''), { waitUntil: 'load' });
    },
    async frames(n, timeout = 180000) {
      const start = await page.evaluate(() => window.__frames ?? 0);
      await page.waitForFunction((t) => (window.__frames ?? 0) >= t, start + n, { timeout });
    },
    async waitFor(fn, arg, timeout = 180000) {
      await page.waitForFunction(fn, arg, { timeout });
    },
    async shot(name) {
      const p = resolve(outDir, name + '.png');
      await page.screenshot({ path: p });
      console.log('  screenshot', p);
      return p;
    },
    async clickText(text, sel = 'button') {
      await page.locator(sel, { hasText: text }).first().click({ timeout: 15000 });
    },
    async hasText(text, sel = 'button') {
      return (await page.locator(sel, { hasText: text }).count()) > 0;
    },
    async hold(key, ms) {
      await page.keyboard.down(key);
      await page.waitForTimeout(ms);
      await page.keyboard.up(key);
    },
    /** hold a key until the game has rendered n frames */
    async holdFrames(key, n) {
      await page.keyboard.down(key);
      await h.frames(n);
      await page.keyboard.up(key);
    },
    /** press a key and keep it down for a couple of frames so the game samples it */
    async tap(key) {
      await page.keyboard.down(key);
      await h.frames(1);
      await page.keyboard.up(key);
      await h.frames(1);
    },
    async eval(fn, arg) {
      return page.evaluate(fn, arg);
    },
    log(...a) {
      console.log(...a);
    },
  };
  return { browser, page, h, errors };
}
