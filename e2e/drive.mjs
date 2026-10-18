// Interactive test driver: node e2e/drive.mjs <steps.mjs> [outDir]
// The steps module exports `default async (page, h) => {}` (see lib.mjs for helpers).
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from './lib.mjs';

const [stepsFile, outDir = 'e2e/out'] = process.argv.slice(2);
const base = process.env.NN_URL ?? 'http://localhost:5173/';
const { browser, page, h, errors } = await launch({ base, outDir, width: Number(process.env.NN_W ?? 1280), height: Number(process.env.NN_H ?? 720) });
let failed = false;
try {
  const mod = await import(pathToFileURL(resolve(stepsFile)).href);
  await mod.default(page, h);
} catch (e) {
  failed = true;
  console.log('STEP FAILURE:', e && e.stack ? e.stack : e);
  try {
    await h.shot('failure');
  } catch {}
}
if (errors.length) console.log('PAGE MESSAGES:\n' + errors.slice(0, 30).join('\n'));
await browser.close();
process.exit(failed ? 1 : 0);
