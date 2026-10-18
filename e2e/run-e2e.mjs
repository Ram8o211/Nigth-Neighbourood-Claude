// Browser smoke test runner: builds the game and serves it with `vite preview`
// (unless NN_URL points at a running server), drives the game in headless Chromium
// through e2e/smoke.mjs (desktop: keyboard and mouse) and e2e/mobile.mjs (an emulated
// phone: touch only), and writes screenshots to e2e/out (or NN_OUT).
// NN_SUITE=desktop or NN_SUITE=mobile runs one of the two. Exit code 1 if any check fails.
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launch } from './lib.mjs';
import smoke, { results as desktopResults } from './smoke.mjs';
import mobile, { results as mobileResults } from './mobile.mjs';

const suite = process.env.NN_SUITE ?? 'all';

const outDir = process.env.NN_OUT ?? 'e2e/out';
let base = process.env.NN_URL;
let server = null;

async function waitForServer(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

if (!base) {
  // test the production bundle: build, then serve it with `vite preview`
  if (!process.env.NN_SKIP_BUILD) {
    const b = spawnSync('npm', ['run', 'build'], { stdio: 'inherit' });
    if (b.status !== 0) {
      console.error('build failed');
      process.exit(2);
    }
  }
  const port = 5199;
  base = `http://localhost:${port}/`;
  server = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { stdio: 'ignore', detached: true });
  if (!(await waitForServer(base, 30000))) {
    console.error('dev server did not start');
    process.exit(2);
  }
}

const t0 = Date.now();
let crashed = null;
for (const [name, run, opts] of [
  ['desktop', smoke, { width: 1280, height: 720 }],
  ['mobile', mobile, { mobile: true }],
]) {
  if (suite !== 'all' && suite !== name) continue;
  console.log(`\n=== ${name}`);
  const { browser, page, h } = await launch({ base, outDir, ...opts });
  try {
    await run(page, h);
  } catch (e) {
    crashed = crashed ?? e;
    console.log(`${name.toUpperCase()} SMOKE TEST ABORTED:`, e && e.stack ? e.stack : e);
    try {
      await h.shot(`aborted_${name}`);
    } catch {}
  }
  await browser.close();
}
const results = [...desktopResults, ...mobileResults];
if (server) {
  try {
    process.kill(-server.pid);
  } catch {}
}
const failed = results.filter((r) => !r.ok);
const summary = {
  date: new Date().toISOString(),
  seconds: Math.round((Date.now() - t0) / 1000),
  checks: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  aborted: crashed ? String(crashed.message ?? crashed) : null,
  results,
};
writeFileSync(resolve(outDir, 'e2e-results.json'), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${summary.checks} checks passed in ${summary.seconds}s${crashed ? ' (ABORTED)' : ''}`);
process.exit(failed.length || crashed ? 1 : 0);
