// Usage: node e2e/shot.mjs "<query>" out.png [waitFrames] [timeoutSec]
import { chromium } from 'playwright-core';
const [query, out, wait = '20', tmo = '240'] = process.argv.slice(2);
const base = process.env.NN_URL ?? 'http://localhost:5173/';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--no-proxy-server'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.stack || e)));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
await page.goto(base + '?' + query, { waitUntil: 'load' });
const t0 = Date.now();
try {
  await page.waitForFunction((n) => (window.__frames ?? 0) >= n, Number(wait), { timeout: Number(tmo) * 1000 });
} catch (e) {
  console.log('timeout; frames =', await page.evaluate(() => window.__frames));
}
console.log('render wait', ((Date.now() - t0) / 1000).toFixed(1), 's');
await page.screenshot({ path: out });
if (errors.length) console.log('MESSAGES:\n' + errors.slice(0, 20).join('\n'));
await browser.close();
console.log('saved', out);
