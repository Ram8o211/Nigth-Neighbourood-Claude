// Bundles a TypeScript entry with esbuild and runs it in Node (dev utility).
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
const [entry, ...rest] = process.argv.slice(2);
const outDir = path.resolve('node_modules/.cache/nn-scripts');
mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, path.basename(entry).replace(/\.ts$/, '.mjs'));
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'warning', target: 'node20' });
process.argv = [process.argv[0], outfile, ...rest];
await import(pathToFileURL(outfile).href);
