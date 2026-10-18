// Renders the home-screen icons (public/icon-*.png) from the SVG below with headless Chromium.
// Run: node scripts/make-icons.mjs
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="sky" cx="50%" cy="30%" r="80%"><stop offset="0" stop-color="#26213a"/><stop offset="1" stop-color="#07070b"/></radialGradient>
    <radialGradient id="win" cx="50%" cy="50%" r="60%"><stop offset="0" stop-color="#ffd98a"/><stop offset="1" stop-color="#c8862f"/></radialGradient>
    <radialGradient id="halo" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ffcf7a" stop-opacity=".45"/><stop offset="1" stop-color="#ffcf7a" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#sky)"/>
  <circle cx="370" cy="128" r="54" fill="#e9e0c8"/>
  <circle cx="394" cy="112" r="50" fill="#1c1829"/>
  <g fill="#e9e0c8" opacity=".8"><circle cx="96" cy="92" r="3"/><circle cx="160" cy="150" r="2"/><circle cx="250" cy="80" r="2.5"/><circle cx="452" cy="230" r="2"/><circle cx="70" cy="210" r="2"/></g>
  <path d="M96 470 V282 L256 160 L416 282 V470 Z" fill="#050507"/>
  <rect x="330" y="186" width="30" height="66" fill="#050507"/>
  <circle cx="256" cy="330" r="92" fill="url(#halo)"/>
  <rect x="222" y="296" width="68" height="78" rx="3" fill="url(#win)"/>
  <path d="M256 296 V374 M222 335 H290" stroke="#050507" stroke-width="7"/>
  <rect x="0" y="466" width="512" height="46" fill="#030304"/>
</svg>`;

const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-proxy-server'] });
for (const size of [512, 192, 180]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0;background:#000">${SVG.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: `public/icon-${size}.png`, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  console.log(`public/icon-${size}.png`);
}
await browser.close();
