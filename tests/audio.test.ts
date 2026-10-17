import { describe, it, expect } from 'vitest';
import audioSource from '../src/audio/audio.ts?raw';
import { synthesizeAll, SR } from '../src/audio/synth';

describe('synthesized audio', () => {
  const t0 = performance.now();
  const bank = synthesizeAll();
  const ms = performance.now() - t0;

  it('provides every sample the game plays', () => {
    // every quoted sample name the audio engine refers to must exist in the bank
    const src: string = audioSource;
    const names = new Set<string>();
    for (const m of src.matchAll(/(?:play|startLoop)\('([a-z_]+)'/g)) names.add(m[1]);
    for (const m of src.matchAll(/:\s*'((?:step|amb)_[a-z]+)'/g)) names.add(m[1]);
    const kindBlock = src.slice(src.indexOf('const KIND_SAMPLE'), src.indexOf('};', src.indexOf('const KIND_SAMPLE')));
    for (const m of kindBlock.matchAll(/:\s*'([a-z_]+)'/g)) names.add(m[1]);
    for (const m of src.matchAll(/'(amb_[a-z]+)'/g)) names.add(m[1]);
    for (const m of src.matchAll(/\? '([a-z]+)' : '([a-z]+)'/g)) {
      names.add(m[1]);
      names.add(m[2]);
    }
    expect(names.size).toBeGreaterThan(40);
    const missing = [...names].filter((n) => !bank.has(n));
    expect(missing).toEqual([]);
  });

  it('produces finite, audible, unclipped buffers in reasonable time', () => {
    let total = 0;
    for (const [name, variants] of bank) {
      expect(variants.length, name).toBeGreaterThan(0);
      for (const v of variants) {
        expect(v.length, name).toBeGreaterThan(SR * 0.02);
        let peak = 0;
        for (let i = 0; i < v.length; i++) {
          const x = v[i];
          if (!Number.isFinite(x)) throw new Error(`${name}: non-finite sample at ${i}`);
          const a = Math.abs(x);
          if (a > peak) peak = a;
        }
        expect(peak, `${name} is silent`).toBeGreaterThan(0.01);
        expect(peak, `${name} clips`).toBeLessThanOrEqual(1.0001);
        total += v.length;
      }
    }
    // startup cost of synthesising the whole bank (also paid once in the browser)
    expect(ms).toBeLessThan(20000);
    console.log(`synthesised ${bank.size} sounds, ${(total / SR).toFixed(1)} s of audio in ${ms.toFixed(0)} ms`);
  });
});
