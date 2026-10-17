// Offline sample synthesis: every sound effect in the game is generated here
// from oscillators, noise and filters. No audio files are required.

import { Rng } from '../core/rng';

export const SR = 44100;

type Buf = Float32Array;

function buf(sec: number): Buf {
  return new Float32Array(Math.max(1, Math.floor(sec * SR)));
}

class Biquad {
  b0 = 1;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  x1 = 0;
  x2 = 0;
  y1 = 0;
  y2 = 0;
  set(type: 'lp' | 'hp' | 'bp', f: number, q = 0.707) {
    const w = (2 * Math.PI * Math.min(f, SR * 0.45)) / SR;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    let b0: number, b1: number, b2: number;
    const a0 = 1 + alpha;
    if (type === 'lp') {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
    } else if (type === 'hp') {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
    } else {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
    return this;
  }
  run(x: number) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

function filter(b: Buf, type: 'lp' | 'hp' | 'bp', f: number | ((t: number) => number), q = 0.707): Buf {
  const bq = new Biquad();
  const dyn = typeof f === 'function';
  if (!dyn) bq.set(type, f as number, q);
  for (let i = 0; i < b.length; i++) {
    if (dyn && i % 32 === 0) bq.set(type, (f as (t: number) => number)(i / SR), q);
    b[i] = bq.run(b[i]);
  }
  return b;
}

function noise(b: Buf, rng: Rng, amp = 1, start = 0, end = b.length) {
  for (let i = start; i < end; i++) b[i] += (rng.next() * 2 - 1) * amp;
  return b;
}

function env(b: Buf, attack: number, decay: number, start = 0) {
  const s = Math.floor(start * SR);
  for (let i = 0; i < b.length; i++) {
    const t = (i - s) / SR;
    let g = 0;
    if (t >= 0) g = t < attack ? t / attack : Math.exp(-(t - attack) / decay);
    b[i] *= g;
  }
  return b;
}

function add(dst: Buf, src: Buf, at = 0, gain = 1) {
  const o = Math.floor(at * SR);
  for (let i = 0; i < src.length && i + o < dst.length; i++) dst[i + o] += src[i] * gain;
  return dst;
}

function tone(sec: number, f: number | ((t: number) => number), shape: 'sin' | 'saw' | 'sq' | 'tri' = 'sin', amp = 1): Buf {
  const b = buf(sec);
  let ph = 0;
  for (let i = 0; i < b.length; i++) {
    const t = i / SR;
    const fr = typeof f === 'function' ? f(t) : f;
    ph += fr / SR;
    const x = ph % 1;
    let v: number;
    switch (shape) {
      case 'saw':
        v = 2 * x - 1;
        break;
      case 'sq':
        v = x < 0.5 ? 1 : -1;
        break;
      case 'tri':
        v = 1 - 4 * Math.abs(x - 0.5);
        break;
      default:
        v = Math.sin(2 * Math.PI * ph);
    }
    b[i] = v * amp;
  }
  return b;
}

function normalize(b: Buf, peak = 0.9) {
  let m = 0;
  for (let i = 0; i < b.length; i++) m = Math.max(m, Math.abs(b[i]));
  if (m > 0) for (let i = 0; i < b.length; i++) b[i] *= peak / m;
  return b;
}

/** formant voice: a sawtooth source through vowel resonances */
function voice(sec: number, pitch: (t: number) => number, formants: number[], rng: Rng, breath = 0.15): Buf {
  const src = tone(sec, (t) => pitch(t) * (1 + 0.012 * Math.sin(t * 35)), 'saw', 0.6);
  noise(src, rng, breath);
  const out = buf(sec);
  formants.forEach((f, i) => {
    const c = Float32Array.from(src);
    filter(c, 'bp', f, 6 + i * 2);
    add(out, c, 0, 1 / (i + 1));
  });
  return out;
}

function reverbTail(b: Buf, time = 0.6, mix = 0.3): Buf {
  const out = buf(b.length / SR + time);
  out.set(b);
  const delays = [0.029, 0.037, 0.043, 0.051];
  for (const d of delays) {
    const ds = Math.floor(d * SR);
    const fb = Math.pow(0.001, d / time);
    for (let i = ds; i < out.length; i++) out[i] += out[i - ds] * fb * mix * 0.6;
  }
  return out;
}

// ---------------------------------------------------------------------------

type Gen = (rng: Rng) => Buf;

const step = (lp: number, hp: number, dur: number, thump: number, crunch: number): Gen => (rng) => {
  const b = buf(dur);
  noise(b, rng, 1);
  filter(b, 'lp', lp);
  filter(b, 'hp', hp);
  env(b, 0.004, dur / 4);
  if (crunch > 0) {
    for (let k = 0; k < 5; k++) {
      const g = buf(0.02);
      noise(g, rng, crunch);
      filter(g, 'hp', 2500);
      env(g, 0.001, 0.005);
      add(b, g, rng.range(0, dur * 0.6));
    }
  }
  if (thump > 0) add(b, env(tone(dur, (t) => 90 - t * 200, 'sin', thump), 0.002, 0.03));
  return normalize(b, 0.8);
};

export const GENERATORS: Record<string, Gen> = {
  step_grass: step(1800, 200, 0.12, 0.2, 0.25),
  step_dirt: step(1500, 150, 0.12, 0.3, 0.4),
  step_gravel: step(5000, 400, 0.14, 0.1, 0.9),
  step_asphalt: step(6000, 300, 0.07, 0.4, 0.2),
  step_concrete: step(7000, 400, 0.06, 0.4, 0.15),
  step_wood: (rng) => {
    const b = step(900, 60, 0.13, 1.0, 0)(rng);
    if (rng.chance(0.35)) add(b, env(filter(tone(0.25, (t) => 600 + Math.sin(t * 30) * 80, 'saw', 0.06), 'bp', 900, 8), 0.02, 0.08), 0.02);
    return normalize(b, 0.8);
  },
  step_tile: (rng) => {
    const b = step(9000, 1500, 0.06, 0.2, 0)(rng);
    add(b, env(tone(0.08, 3200, 'sin', 0.15), 0.001, 0.02));
    return normalize(b, 0.8);
  },
  step_carpet: step(500, 60, 0.12, 0.3, 0),
  door_open: (rng) => {
    const b = buf(0.9);
    const creak = tone(0.8, (t) => 380 + 260 * t + Math.sin(t * 23) * 40, 'saw', 0.5);
    filter(creak, 'bp', (t) => 700 + t * 500, 6);
    env(creak, 0.08, 0.35);
    add(b, creak, 0.05);
    const latch = buf(0.05);
    noise(latch, rng, 1);
    filter(latch, 'bp', 2400, 4);
    env(latch, 0.001, 0.01);
    add(b, latch);
    return normalize(b, 0.7);
  },
  door_close: (rng) => {
    const b = buf(0.5);
    const th = tone(0.4, (t) => 75 - t * 40, 'sin', 1);
    env(th, 0.003, 0.09);
    add(b, th);
    const n = buf(0.3);
    noise(n, rng, 0.6);
    filter(n, 'lp', 900);
    env(n, 0.002, 0.05);
    add(b, n);
    const latch = buf(0.04);
    noise(latch, rng, 0.8);
    filter(latch, 'bp', 3000, 5);
    env(latch, 0.001, 0.008);
    add(b, latch, 0.06);
    return normalize(b, 0.9);
  },
  lock: (rng) => {
    const b = buf(0.25);
    for (const at of [0, 0.09]) {
      const c = buf(0.06);
      noise(c, rng, 1);
      filter(c, 'bp', 3500, 9);
      env(c, 0.0005, 0.01);
      add(b, c, at);
    }
    return normalize(b, 0.6);
  },
  unlock: (rng) => GENERATORS.lock(rng),
  knock: (rng) => {
    const b = buf(0.75);
    for (const at of [0, 0.2, 0.42]) {
      const k = tone(0.12, (t) => 170 - t * 300, 'sin', 1);
      env(k, 0.001, 0.025);
      const n = buf(0.1);
      noise(n, rng, 0.5);
      filter(n, 'bp', 700, 2);
      env(n, 0.001, 0.02);
      add(b, k, at);
      add(b, n, at);
    }
    return normalize(reverbTail(b, 0.5, 0.25), 0.95);
  },
  handle: (rng) => {
    const b = buf(0.6);
    for (let k = 0; k < 5; k++) {
      const c = buf(0.05);
      noise(c, rng, 1);
      filter(c, 'bp', 2000 + rng.range(-300, 300), 6);
      env(c, 0.001, 0.012);
      add(b, c, k * 0.1 + rng.range(0, 0.03));
    }
    return normalize(b, 0.6);
  },
  glass: (rng) => {
    const b = buf(1.6);
    const burst = buf(0.25);
    noise(burst, rng, 1);
    filter(burst, 'hp', 1800);
    env(burst, 0.001, 0.06);
    add(b, burst);
    for (let k = 0; k < 70; k++) {
      const f = rng.range(2500, 9000);
      const p = env(tone(0.35, f, 'sin', rng.range(0.05, 0.25)), 0.0005, rng.range(0.02, 0.1));
      add(b, p, rng.range(0, 0.9) ** 2);
    }
    const low = env(tone(0.2, 120, 'sin', 0.6), 0.001, 0.05);
    add(b, low);
    return normalize(reverbTail(b, 0.6, 0.2), 0.95);
  },
  glass_crack: (rng) => {
    const b = buf(0.4);
    const c = buf(0.05);
    noise(c, rng, 1);
    filter(c, 'hp', 3000);
    env(c, 0.0005, 0.008);
    add(b, c);
    for (let k = 0; k < 6; k++) add(b, env(tone(0.2, rng.range(3000, 6000), 'sin', 0.15), 0.0005, 0.04), rng.range(0, 0.05));
    return normalize(b, 0.8);
  },
  hit: (rng) => {
    const b = buf(0.3);
    add(b, env(tone(0.25, (t) => 95 - t * 120, 'sin', 1), 0.001, 0.05));
    const n = buf(0.2);
    noise(n, rng, 0.7);
    filter(n, 'lp', 700);
    env(n, 0.001, 0.04);
    add(b, n);
    const sl = buf(0.12);
    noise(sl, rng, 0.25);
    filter(sl, 'bp', 1600, 1.5);
    env(sl, 0.002, 0.03);
    add(b, sl, 0.01);
    return normalize(b, 0.95);
  },
  thud: (rng) => {
    const b = buf(0.35);
    add(b, env(tone(0.3, (t) => 130 - t * 160, 'sin', 1), 0.001, 0.06));
    const n = buf(0.2);
    noise(n, rng, 0.6);
    filter(n, 'bp', 500, 1.5);
    env(n, 0.001, 0.04);
    add(b, n);
    return normalize(b, 0.9);
  },
  block: (rng) => {
    const b = buf(0.25);
    const n = buf(0.1);
    noise(n, rng, 1);
    filter(n, 'bp', 1200, 3);
    env(n, 0.0005, 0.02);
    add(b, n);
    add(b, env(tone(0.2, 420, 'tri', 0.4), 0.001, 0.04));
    return normalize(b, 0.8);
  },
  swing: (rng) => {
    const b = buf(0.32);
    noise(b, rng, 1);
    filter(b, 'bp', (t) => 300 + Math.sin((t / 0.32) * Math.PI) * 1400, 2.5);
    for (let i = 0; i < b.length; i++) b[i] *= Math.sin((i / b.length) * Math.PI) ** 2;
    return normalize(b, 0.5);
  },
  hurt: (rng) => normalize(env(voice(0.4, (t) => 180 - t * 140, [650, 1100, 2400], rng, 0.3), 0.01, 0.12), 0.8),
  hurt_f: (rng) => normalize(env(voice(0.4, (t) => 300 - t * 200, [800, 1200, 2800], rng, 0.3), 0.01, 0.12), 0.8),
  scream: (rng) => {
    const b = voice(1.5, (t) => 420 + 160 * Math.sin(t * 3) * (1 - t / 1.5) + Math.sin(t * 40) * 12, [850, 1250, 2900], rng, 0.4);
    env(b, 0.06, 0.6);
    return normalize(reverbTail(b, 0.8, 0.3), 0.9);
  },
  death: (rng) => {
    const b = voice(1.2, (t) => 160 - t * 70, [600, 1000, 2400], rng, 0.5);
    env(b, 0.05, 0.4);
    return normalize(b, 0.8);
  },
  kick: (rng) => {
    const b = buf(0.6);
    add(b, env(tone(0.4, (t) => 70 - t * 60, 'sin', 1), 0.001, 0.12));
    const n = buf(0.35);
    noise(n, rng, 0.9);
    filter(n, 'lp', 1100);
    env(n, 0.001, 0.07);
    add(b, n);
    return normalize(reverbTail(b, 0.4, 0.25), 1);
  },
  door_force: (rng) => {
    const b = GENERATORS.kick(rng);
    const crack = buf(0.4);
    for (let k = 0; k < 12; k++) {
      const c = buf(0.03);
      noise(c, rng, 1);
      filter(c, 'bp', rng.range(800, 2500), 3);
      env(c, 0.0005, 0.01);
      add(crack, c, rng.range(0, 0.3));
    }
    add(b, crack, 0.02);
    return normalize(b, 1);
  },
  board_hit: (rng) => GENERATORS.thud(rng),
  boards_break: (rng) => GENERATORS.door_force(rng),
  hammer: (rng) => {
    const b = buf(1.1);
    for (const at of [0, 0.35, 0.7]) {
      add(b, env(tone(0.2, 900, 'tri', 0.5), 0.0005, 0.03), at);
      const n = buf(0.06);
      noise(n, rng, 0.6);
      filter(n, 'hp', 2000);
      env(n, 0.0005, 0.01);
      add(b, n, at);
    }
    return normalize(b, 0.8);
  },
  pry: (rng) => {
    const b = tone(0.8, (t) => 220 + t * 300 + Math.sin(t * 50) * 30, 'saw', 0.5);
    filter(b, 'bp', 1500, 5);
    env(b, 0.1, 0.3);
    add(b, GENERATORS.glass_crack(rng), 0.6, 0.6);
    return normalize(b, 0.7);
  },
  lockpick: (rng) => {
    const b = buf(0.3);
    for (let k = 0; k < 3; k++) {
      const c = buf(0.02);
      noise(c, rng, 1);
      filter(c, 'bp', 5000, 8);
      env(c, 0.0005, 0.004);
      add(b, c, rng.range(0, 0.25));
    }
    return normalize(b, 0.35);
  },
  rummage: (rng) => {
    const b = buf(0.8);
    noise(b, rng, 1);
    filter(b, 'bp', 1800, 0.8);
    for (let i = 0; i < b.length; i++) b[i] *= 0.5 + 0.5 * Math.sin(i / 900) ** 2;
    env(b, 0.05, 0.3);
    return normalize(b, 0.4);
  },
  wardrobe: (rng) => {
    const b = GENERATORS.door_open(rng);
    return normalize(b, 0.5);
  },
  climb: (rng) => normalize(env(filter(noise(buf(0.6), rng, 1), 'bp', 1200, 1), 0.05, 0.2), 0.5),
  swallow: (rng) => normalize(env(filter(noise(buf(0.3), rng, 1), 'lp', 600), 0.02, 0.08), 0.5),
  eat: (rng) => {
    const b = buf(0.6);
    for (let k = 0; k < 4; k++) {
      const c = buf(0.06);
      noise(c, rng, 1);
      filter(c, 'bp', 2500, 2);
      env(c, 0.001, 0.02);
      add(b, c, k * 0.14);
    }
    return normalize(b, 0.5);
  },
  bandage: (rng) => normalize(env(filter(noise(buf(0.5), rng, 1), 'bp', 3500, 1.5), 0.02, 0.15), 0.4),
  equip: (rng) => {
    const b = buf(0.2);
    add(b, env(tone(0.15, 600, 'tri', 0.4), 0.001, 0.04));
    const n = buf(0.08);
    noise(n, rng, 0.5);
    filter(n, 'hp', 3000);
    env(n, 0.001, 0.015);
    add(b, n);
    return normalize(b, 0.4);
  },
  click: () => normalize(env(tone(0.05, 1800, 'sq', 0.3), 0.0005, 0.006), 0.25),
  switch: (rng) => normalize(env(filter(noise(buf(0.05), rng, 1), 'bp', 2500, 6), 0.0005, 0.006), 0.4),
  pickup: (rng) => normalize(env(filter(noise(buf(0.25), rng, 1), 'bp', 3000, 1.2), 0.01, 0.06), 0.4),
  coins: () => {
    const b = buf(0.5);
    for (let k = 0; k < 5; k++) add(b, env(tone(0.25, 2400 + k * 330, 'sin', 0.3), 0.001, 0.05), k * 0.05);
    return normalize(b, 0.4);
  },
  page: (rng) => normalize(env(filter(noise(buf(0.35), rng, 1), 'hp', 1500), 0.03, 0.1), 0.35),
  heartbeat: () => {
    const b = buf(0.6);
    add(b, env(tone(0.15, 55, 'sin', 1), 0.005, 0.04));
    add(b, env(tone(0.15, 48, 'sin', 0.7), 0.005, 0.05), 0.2);
    return normalize(b, 0.9);
  },
  breath: (rng) => {
    const b = buf(1.4);
    noise(b, rng, 1);
    filter(b, 'bp', 900, 1.2);
    for (let i = 0; i < b.length; i++) {
      const t = i / SR;
      b[i] *= t < 0.55 ? Math.sin((t / 0.55) * Math.PI) * 0.6 : t > 0.65 ? Math.sin(((t - 0.65) / 0.7) * Math.PI) * 0.4 : 0;
    }
    return normalize(b, 0.5);
  },
  phone: () => {
    const b = buf(2.2);
    const ring = tone(1.6, 440, 'sin', 0.5);
    add(ring, tone(1.6, 480, 'sin', 0.5));
    for (let i = 0; i < ring.length; i++) ring[i] *= Math.sin(i / 400) > 0 ? 1 : 0.2;
    env(ring, 0.01, 2);
    add(b, ring);
    return normalize(b, 0.4);
  },
  smoke: (rng) => normalize(env(filter(noise(buf(0.5), rng, 1), 'lp', 900), 0.1, 0.2), 0.2),
  // ambience beds (looped)
  amb_wind: (rng) => {
    const b = buf(8);
    noise(b, rng, 1);
    filter(b, 'lp', 500);
    filter(b, 'hp', 60);
    for (let i = 0; i < b.length; i++) {
      const t = i / SR;
      b[i] *= 0.55 + 0.3 * Math.sin((t / 8) * Math.PI * 2) + 0.15 * Math.sin((t / 8) * Math.PI * 6 + 1);
    }
    return loopable(normalize(b, 0.6));
  },
  amb_crickets: (rng) => {
    const b = buf(6);
    for (let k = 0; k < 3; k++) {
      const f = rng.range(4200, 5200);
      const rate = rng.range(14, 22);
      const off = rng.range(0, 1);
      for (let i = 0; i < b.length; i++) {
        const t = i / SR;
        const chirp = (Math.sin((t + off) * Math.PI * 2 * 0.5) > 0.2 ? 1 : 0) * (Math.sin(t * rate * Math.PI * 2) > 0 ? 1 : 0);
        b[i] += Math.sin(t * f * Math.PI * 2) * chirp * 0.2;
      }
    }
    filter(b, 'hp', 2500);
    return loopable(normalize(b, 0.35));
  },
  amb_birds: (rng) => {
    const b = buf(10);
    for (let k = 0; k < 14; k++) {
      const at = rng.range(0, 9);
      const base = rng.range(2000, 3800);
      const notes = rng.int(2, 6);
      for (let n = 0; n < notes; n++) {
        const s = tone(0.12, (t) => base + Math.sin(t * 60) * 300 + n * 100, 'sin', 0.3);
        env(s, 0.01, 0.03);
        add(b, s, at + n * 0.13);
      }
    }
    return loopable(normalize(b, 0.4));
  },
  amb_traffic: (rng) => {
    const b = buf(12);
    noise(b, rng, 1);
    filter(b, 'lp', 300);
    for (let i = 0; i < b.length; i++) {
      const t = i / SR;
      b[i] *= 0.3 + 0.7 * Math.max(0, Math.sin((t / 12) * Math.PI * 2)) ** 3;
    }
    return loopable(normalize(b, 0.4));
  },
  amb_hum: (rng) => {
    const b = buf(4);
    add(b, tone(4, 60, 'sin', 0.5));
    add(b, tone(4, 120, 'sin', 0.25));
    add(b, tone(4, 180, 'saw', 0.04));
    noise(b, rng, 0.03);
    filter(b, 'lp', 800);
    return loopable(normalize(b, 0.3));
  },
  dog: (rng) => {
    const b = buf(1.2);
    for (let k = 0; k < rng.int(2, 3); k++) add(b, env(voice(0.18, (t) => 380 - t * 600, [600, 1500], rng, 0.5), 0.005, 0.05), k * 0.3);
    return normalize(reverbTail(b, 1, 0.4), 0.7);
  },
  owl: () => {
    const b = buf(1.5);
    for (const at of [0, 0.5, 0.75]) add(b, env(tone(0.35, (t) => 380 + Math.sin(t * 25) * 6, 'sin', 0.6), 0.04, 0.12), at);
    return normalize(reverbTail(b, 1.2, 0.4), 0.6);
  },
  distant_scream: (rng) => normalize(filter(GENERATORS.scream(rng), 'lp', 1500), 0.5),
  creak: () => {
    const b = tone(1.2, (t) => 140 + Math.sin(t * 9) * 25 + t * 30, 'saw', 0.5);
    filter(b, 'bp', 600, 9);
    env(b, 0.2, 0.4);
    return normalize(b, 0.5);
  },
  stinger: (rng) => {
    const b = buf(4);
    add(b, env(tone(3, (t) => 40 - t * 5, 'sin', 1), 0.005, 1.0));
    for (const f of [440, 466, 622, 659, 880]) add(b, env(tone(3, f * (1 + rng.range(-0.004, 0.004)), 'saw', 0.12), 0.01, 0.9));
    const n = buf(1);
    noise(n, rng, 0.4);
    filter(n, 'hp', 2000);
    env(n, 0.002, 0.2);
    add(b, n);
    filter(b, 'lp', 3500);
    return normalize(reverbTail(b, 2.2, 0.45), 0.9);
  },
};

/** crossfade the end into the start so a buffer loops seamlessly */
function loopable(b: Buf) {
  const fade = Math.floor(0.5 * SR);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    b[i] = b[i] * t + b[b.length - fade + i] * (1 - t);
  }
  return b.subarray(0, b.length - fade).slice();
}

export const VARIANTS: Record<string, number> = {
  step_grass: 3,
  step_dirt: 3,
  step_gravel: 3,
  step_asphalt: 3,
  step_concrete: 3,
  step_wood: 3,
  step_tile: 3,
  step_carpet: 3,
  hit: 3,
  hurt: 2,
  hurt_f: 2,
  swing: 2,
  glass: 2,
  dog: 2,
};

export function synthesizeAll(): Map<string, Float32Array[]> {
  const out = new Map<string, Float32Array[]>();
  for (const [k, g] of Object.entries(GENERATORS)) {
    const n = VARIANTS[k] ?? 1;
    const list: Float32Array[] = [];
    for (let v = 0; v < n; v++) list.push(g(new Rng(`${k}#${v}`)));
    out.set(k, list);
  }
  return out;
}
