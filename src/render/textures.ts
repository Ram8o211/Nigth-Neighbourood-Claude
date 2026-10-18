import * as THREE from 'three';
import { Rng } from '../core/rng';

// Procedurally painted canvas textures. Every texture is generated at load
// time from a fixed seed so the art is original and needs no asset files.

type Painter = (ctx: CanvasRenderingContext2D, size: number, rng: Rng) => void;

const cache = new Map<string, THREE.Texture>();
let anisotropy = 4;
export function setAnisotropy(a: number) {
  anisotropy = a;
}

function hex(c: number, a = 1) {
  const r = (c >> 16) & 255;
  const g = (c >> 8) & 255;
  const b = c & 255;
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
}

function shade(c: number, f: number) {
  const r = Math.min(255, Math.max(0, Math.round(((c >> 16) & 255) * f)));
  const g = Math.min(255, Math.max(0, Math.round(((c >> 8) & 255) * f)));
  const b = Math.min(255, Math.max(0, Math.round((c & 255) * f)));
  return (r << 16) | (g << 8) | b;
}

function noise(ctx: CanvasRenderingContext2D, size: number, rng: Rng, amount: number, scale = 1) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  // multi-octave value noise (cheap) + per-pixel grain
  const grid = 8;
  const vals: number[] = [];
  for (let i = 0; i < (grid + 1) * (grid + 1); i++) vals.push(rng.next());
  const wrap = (x: number) => ((x % grid) + grid) % grid;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * grid * scale;
      const fy = (y / size) * grid * scale;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const tx = fx - ix;
      const ty = fy - iy;
      const v00 = vals[wrap(iy) * (grid + 1) + wrap(ix)];
      const v10 = vals[wrap(iy) * (grid + 1) + wrap(ix + 1)];
      const v01 = vals[wrap(iy + 1) * (grid + 1) + wrap(ix)];
      const v11 = vals[wrap(iy + 1) * (grid + 1) + wrap(ix + 1)];
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const v = (v00 * (1 - sx) + v10 * sx) * (1 - sy) + (v01 * (1 - sx) + v11 * sx) * sy;
      const g = (v - 0.5) * amount + (rng.next() - 0.5) * amount * 0.5;
      const i = (y * size + x) * 4;
      d[i] = Math.max(0, Math.min(255, d[i] * (1 + g)));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] * (1 + g)));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] * (1 + g)));
    }
  ctx.putImageData(img, 0, 0);
}

function speckle(ctx: CanvasRenderingContext2D, size: number, rng: Rng, n: number, colors: number[], rmin = 0.5, rmax = 1.5, alpha = 1) {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = hex(rng.pick(colors), alpha);
    const r = rng.range(rmin, rmax);
    ctx.fillRect(rng.range(0, size), rng.range(0, size), r, r);
  }
}

const P: Record<string, Painter> = {
  grass: (c, s, r) => {
    c.fillStyle = hex(0x3b5a2c);
    c.fillRect(0, 0, s, s);
    noise(c, s, r, 0.5, 1);
    for (let i = 0; i < 2600; i++) {
      c.strokeStyle = hex(r.pick([0x4a6e34, 0x2f4a24, 0x56763a, 0x3a5228, 0x617a3e]), 0.8);
      const x = r.range(0, s);
      const y = r.range(0, s);
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + r.range(-1.5, 1.5), y - r.range(2, 5));
      c.stroke();
    }
  },
  dirt: (c, s, r) => {
    c.fillStyle = hex(0x4a3c2a);
    c.fillRect(0, 0, s, s);
    noise(c, s, r, 0.6, 1.5);
    speckle(c, s, r, 900, [0x3a2e20, 0x5a4a34, 0x2e2418, 0x6a5a40], 0.8, 2.5);
    // pine needles and leaves
    for (let i = 0; i < 260; i++) {
      c.strokeStyle = hex(r.pick([0x5a4020, 0x3a3a1a, 0x6a4a28]), 0.7);
      const x = r.range(0, s);
      const y = r.range(0, s);
      const a = r.range(0, 6.28);
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + Math.cos(a) * 5, y + Math.sin(a) * 5);
      c.stroke();
    }
  },
  asphalt: (c, s, r) => {
    c.fillStyle = hex(0x3c3c40);
    c.fillRect(0, 0, s, s);
    noise(c, s, r, 0.35, 2);
    speckle(c, s, r, 3500, [0x45454a, 0x1e1e20, 0x55555a, 0x3a3a3e], 0.6, 1.6);
    c.strokeStyle = hex(0x18181a, 0.8);
    for (let i = 0; i < 6; i++) {
      let x = r.range(0, s);
      let y = r.range(0, s);
      c.beginPath();
      c.moveTo(x, y);
      for (let k = 0; k < 8; k++) {
        x += r.range(-14, 14);
        y += r.range(-14, 14);
        c.lineTo(x, y);
      }
      c.stroke();
    }
  },
  concrete: (c, s, r) => {
    c.fillStyle = hex(0x8c8a84);
    c.fillRect(0, 0, s, s);
    noise(c, s, r, 0.25, 2);
    speckle(c, s, r, 1500, [0x7a7872, 0x9a9890, 0x6a6862], 0.6, 1.4);
    c.strokeStyle = hex(0x55534e, 0.9);
    c.lineWidth = 2;
    c.strokeRect(1, 1, s - 2, s - 2);
  },
  gravel: (c, s, r) => {
    c.fillStyle = hex(0x6e675c);
    c.fillRect(0, 0, s, s);
    noise(c, s, r, 0.3, 3);
    speckle(c, s, r, 5000, [0x8a8274, 0x5a544a, 0x9a9282, 0x4a443c, 0x7a7466], 1, 3.2);
  },
  wood_floor: (c, s, r) => {
    const plank = s / 6;
    for (let i = 0; i < 6; i++) {
      c.fillStyle = hex(shade(0x7a5434, r.range(0.82, 1.15)));
      c.fillRect(0, i * plank, s, plank);
      c.fillStyle = hex(0x2e1e12, 0.7);
      c.fillRect(0, i * plank, s, 1.5);
      const off = r.range(0, s);
      c.fillRect(off, i * plank, 1.5, plank);
    }
    noise(c, s, r, 0.25, 4);
    for (let i = 0; i < 120; i++) {
      c.strokeStyle = hex(0x4a3020, 0.25);
      const y = r.range(0, s);
      c.beginPath();
      c.moveTo(0, y);
      c.bezierCurveTo(s / 3, y + r.range(-3, 3), (2 * s) / 3, y + r.range(-3, 3), s, y);
      c.stroke();
    }
  },
  tile: (c, s, r) => {
    const n = 4;
    const t = s / n;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        c.fillStyle = hex((x + y) % 2 === 0 ? 0xd8d4c8 : 0x9a968c);
        c.fillRect(x * t, y * t, t, t);
      }
    noise(c, s, r, 0.12, 2);
    c.strokeStyle = hex(0x5a5650, 0.8);
    c.lineWidth = 2;
    for (let i = 0; i <= n; i++) {
      c.beginPath();
      c.moveTo(i * t, 0);
      c.lineTo(i * t, s);
      c.moveTo(0, i * t);
      c.lineTo(s, i * t);
      c.stroke();
    }
  },
  carpet: (c, s, r) => {
    c.fillStyle = hex(0x8a8070);
    c.fillRect(0, 0, s, s);
    noise(c, s, r, 0.35, 6);
    speckle(c, s, r, 6000, [0x9a9080, 0x7a7060, 0xa09684], 0.6, 1.2, 0.6);
  },
  siding: (c, s, r) => {
    const n = 8;
    const h = s / n;
    for (let i = 0; i < n; i++) {
      c.fillStyle = hex(shade(0xd8d4cc, r.range(0.95, 1.03)));
      c.fillRect(0, i * h, s, h);
      const g = c.createLinearGradient(0, i * h, 0, (i + 1) * h);
      g.addColorStop(0, 'rgba(0,0,0,0.0)');
      g.addColorStop(0.85, 'rgba(0,0,0,0.12)');
      g.addColorStop(1, 'rgba(0,0,0,0.45)');
      c.fillStyle = g;
      c.fillRect(0, i * h, s, h);
    }
    noise(c, s, r, 0.12, 4);
  },
  siding_rotten: (c, s, r) => {
    P.siding(c, s, r);
    c.globalCompositeOperation = 'multiply';
    c.fillStyle = hex(0x8a8070);
    c.fillRect(0, 0, s, s);
    c.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 40; i++) {
      c.fillStyle = hex(r.pick([0x3a3020, 0x4a4030, 0x2a2418]), r.range(0.2, 0.6));
      c.beginPath();
      c.ellipse(r.range(0, s), r.range(0, s), r.range(4, 30), r.range(3, 14), 0, 0, 6.28);
      c.fill();
    }
    // streaks
    for (let i = 0; i < 30; i++) {
      c.fillStyle = hex(0x2a2418, 0.25);
      c.fillRect(r.range(0, s), r.range(0, s * 0.6), r.range(1, 3), r.range(20, 90));
    }
  },
  brick: (c, s, r) => {
    const rows = 16;
    const h = s / rows;
    const w = h * 2.1;
    c.fillStyle = hex(0x9a948a);
    c.fillRect(0, 0, s, s);
    for (let y = 0; y < rows; y++) {
      const off = y % 2 ? w / 2 : 0;
      for (let x = -w; x < s + w; x += w) {
        c.fillStyle = hex(shade(0xa0503a, r.range(0.75, 1.15)));
        c.fillRect(x + off + 1, y * h + 1, w - 2, h - 2);
      }
    }
    noise(c, s, r, 0.25, 4);
  },
  stucco: (c, s, r) => {
    c.fillStyle = hex(0xd8d0c0);
    c.fillRect(0, 0, s, s);
    noise(c, s, r, 0.2, 3);
    speckle(c, s, r, 4000, [0xc8c0b0, 0xe0d8c8, 0xb8b0a0], 0.5, 1.5, 0.7);
  },
  stone: (c, s, r) => {
    c.fillStyle = hex(0x5a5650);
    c.fillRect(0, 0, s, s);
    let y = 0;
    while (y < s) {
      const h = r.range(s / 10, s / 6);
      let x = -r.range(0, 40);
      while (x < s) {
        const w = r.range(s / 6, s / 3.5);
        c.fillStyle = hex(shade(0x8a867c, r.range(0.75, 1.15)));
        c.fillRect(x + 2, y + 2, w - 4, h - 4);
        x += w;
      }
      y += h;
    }
    noise(c, s, r, 0.3, 4);
  },
  metal: (c, s, r) => {
    const n = 12;
    const w = s / n;
    for (let i = 0; i < n; i++) {
      const g = c.createLinearGradient(i * w, 0, (i + 1) * w, 0);
      g.addColorStop(0, hex(0x7a8088));
      g.addColorStop(0.5, hex(0xa0a6ae));
      g.addColorStop(1, hex(0x6a7078));
      c.fillStyle = g;
      c.fillRect(i * w, 0, w, s);
    }
    noise(c, s, r, 0.15, 3);
    for (let i = 0; i < 25; i++) {
      c.fillStyle = hex(0x6a3a1a, r.range(0.1, 0.4));
      c.fillRect(r.range(0, s), r.range(0, s), r.range(1, 4), r.range(10, 60));
    }
  },
  planks: (c, s, r) => {
    const n = 6;
    const w = s / n;
    for (let i = 0; i < n; i++) {
      c.fillStyle = hex(shade(0x7a6248, r.range(0.75, 1.1)));
      c.fillRect(i * w, 0, w, s);
      c.fillStyle = hex(0x20160e, 0.8);
      c.fillRect(i * w, 0, 2, s);
    }
    noise(c, s, r, 0.3, 4);
  },
  plaster: (c, s, r) => {
    c.fillStyle = hex(0xe6e0d4);
    c.fillRect(0, 0, s, s);
    noise(c, s, r, 0.08, 2);
  },
  stripes: (c, s, r) => {
    c.fillStyle = hex(0xd8cbb0);
    c.fillRect(0, 0, s, s);
    for (let x = 0; x < s; x += s / 8) {
      c.fillStyle = hex(0xb8a888, 0.6);
      c.fillRect(x, 0, s / 32, s);
    }
    noise(c, s, r, 0.08, 2);
  },
  floral: (c, s, r) => {
    c.fillStyle = hex(0xd8ccb4);
    c.fillRect(0, 0, s, s);
    for (let i = 0; i < 40; i++) {
      const x = ((i % 6) + (Math.floor(i / 6) % 2) * 0.5) * (s / 6);
      const y = Math.floor(i / 6) * (s / 6.5);
      c.fillStyle = hex(0x9a6a6a, 0.5);
      for (let k = 0; k < 5; k++) {
        c.beginPath();
        c.ellipse(x + Math.cos(k * 1.256) * 5, y + Math.sin(k * 1.256) * 5, 4, 2.5, k * 1.256, 0, 6.28);
        c.fill();
      }
      c.fillStyle = hex(0x6a7a4a, 0.5);
      c.fillRect(x - 1, y + 6, 2, 10);
    }
    noise(c, s, r, 0.1, 2);
  },
  wall_tile: (c, s, r) => {
    const n = 8;
    const t = s / n;
    c.fillStyle = hex(0xe8e8e2);
    c.fillRect(0, 0, s, s);
    c.strokeStyle = hex(0xa0a09a);
    c.lineWidth = 1.5;
    for (let i = 0; i <= n; i++) {
      c.beginPath();
      c.moveTo(i * t, 0);
      c.lineTo(i * t, s);
      c.moveTo(0, i * t);
      c.lineTo(s, i * t);
      c.stroke();
    }
    noise(c, s, r, 0.06, 2);
  },
  stained: (c, s, r) => {
    P.stripes(c, s, r);
    for (let i = 0; i < 30; i++) {
      c.fillStyle = hex(r.pick([0x5a4a30, 0x4a3a28, 0x3a3020]), r.range(0.15, 0.4));
      c.beginPath();
      c.ellipse(r.range(0, s), r.range(0, s), r.range(5, 40), r.range(5, 60), 0, 0, 6.28);
      c.fill();
    }
  },
  roof: (c, s, r) => {
    const rows = 10;
    const h = s / rows;
    c.fillStyle = hex(0x5a5a5a);
    c.fillRect(0, 0, s, s);
    for (let y = 0; y < rows; y++) {
      const w = h * 1.4;
      const off = y % 2 ? w / 2 : 0;
      for (let x = -w; x < s + w; x += w) {
        c.fillStyle = hex(shade(0x8a8a8a, r.range(0.7, 1.1)));
        c.fillRect(x + off + 1, y * h, w - 2, h - 2);
        c.fillStyle = 'rgba(0,0,0,0.35)';
        c.fillRect(x + off + 1, y * h + h - 4, w - 2, 3);
      }
    }
    noise(c, s, r, 0.2, 4);
  },
  tar: (c, s, r) => {
    c.fillStyle = hex(0x3a3a3c);
    c.fillRect(0, 0, s, s);
    noise(c, s, r, 0.3, 3);
    speckle(c, s, r, 2000, [0x4a4a4c, 0x2a2a2c], 0.5, 1.5);
  },
  bark: (c, s, r) => {
    c.fillStyle = hex(0x6a6a6a);
    c.fillRect(0, 0, s, s);
    for (let i = 0; i < 60; i++) {
      c.fillStyle = hex(r.pick([0x4a4a4a, 0x8a8a8a, 0x3a3a3a]), 0.6);
      c.fillRect(r.range(0, s), 0, r.range(2, 6), s);
    }
    noise(c, s, r, 0.3, 4);
  },
  leaves: (c, s, r) => {
    c.fillStyle = hex(0x808080);
    c.fillRect(0, 0, s, s);
    for (let i = 0; i < 1400; i++) {
      c.fillStyle = hex(r.pick([0x6a6a6a, 0x9a9a9a, 0xb0b0b0, 0x505050]), 0.8);
      c.beginPath();
      c.ellipse(r.range(0, s), r.range(0, s), r.range(2, 5), r.range(1.5, 3), r.range(0, 6), 0, 6.28);
      c.fill();
    }
  },
  chain: (c, s) => {
    c.clearRect(0, 0, s, s);
    c.strokeStyle = 'rgba(150,150,150,1)';
    c.lineWidth = 2;
    const n = 8;
    const t = s / n;
    for (let i = -n; i <= 2 * n; i++) {
      c.beginPath();
      c.moveTo(i * t, 0);
      c.lineTo(i * t + s, s);
      c.moveTo(i * t, s);
      c.lineTo(i * t + s, 0);
      c.stroke();
    }
  },
  detail: (c, s, r) => {
    c.fillStyle = hex(0xe0e0e0);
    c.fillRect(0, 0, s, s);
    noise(c, s, r, 0.07, 3);
  },
};

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  return [cv, cv.getContext('2d', { willReadFrequently: true })!];
}

/** returns a repeating texture tinted by `tint` (multiplied) */
export function tex(kind: string, tint = 0xffffff, size = 256): THREE.Texture {
  const key = `${kind}:${tint}:${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const [cv, ctx] = makeCanvas(size);
  const painter = P[kind] ?? P.plaster;
  painter(ctx, size, new Rng(`tex-${kind}`));
  if (tint !== 0xffffff) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = hex(tint);
    ctx.fillRect(0, 0, size, size);
    ctx.globalCompositeOperation = 'source-over';
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  cache.set(key, t);
  return t;
}

/** radial soft blob, used for glows and light pools */
export function glowTexture(): THREE.Texture {
  const key = 'glow';
  const hit = cache.get(key);
  if (hit) return hit;
  const [cv, c] = makeCanvas(128);
  const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}

/** blood splatter atlas: 4x4 variations; row 3 contains footprints / drips */
export function bloodTexture(): THREE.Texture {
  const key = 'blood';
  const hit = cache.get(key);
  if (hit) return hit;
  const S = 512;
  const [cv, c] = makeCanvas(S);
  c.clearRect(0, 0, S, S);
  const rng = new Rng('blood');
  const cell = S / 4;
  for (let i = 0; i < 16; i++) {
    const cx = (i % 4) * cell + cell / 2;
    const cy = Math.floor(i / 4) * cell + cell / 2;
    const kind = Math.floor(i / 4);
    if (kind === 3 && i % 4 >= 2) {
      // shoe prints
      c.fillStyle = 'rgba(90,6,8,0.85)';
      c.beginPath();
      c.ellipse(cx, cy - 18, 9, 16, 0, 0, 6.28);
      c.fill();
      c.beginPath();
      c.ellipse(cx, cy + 18, 8, 10, 0, 0, 6.28);
      c.fill();
      continue;
    }
    const n = kind === 0 ? 1 : kind === 1 ? 3 : 6;
    for (let k = 0; k < n; k++) {
      const r = kind === 0 ? rng.range(30, 50) : rng.range(10, 28);
      const ox = kind === 0 ? 0 : rng.range(-30, 30);
      const oy = kind === 0 ? 0 : rng.range(-30, 30);
      c.fillStyle = `rgba(${rng.int(70, 120)},${rng.int(0, 10)},${rng.int(4, 12)},0.92)`;
      c.beginPath();
      for (let a = 0; a < 6.28; a += 0.35) {
        const rr = r * rng.range(0.7, 1.15);
        const x = cx + ox + Math.cos(a) * rr;
        const y = cy + oy + Math.sin(a) * rr;
        if (a === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.closePath();
      c.fill();
    }
    // droplets
    for (let k = 0; k < 18; k++) {
      c.fillStyle = 'rgba(100,4,8,0.9)';
      c.beginPath();
      const a = rng.range(0, 6.28);
      const d = rng.range(20, cell / 2 - 6);
      c.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rng.range(1, 4), 0, 6.28);
      c.fill();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}

/** crack overlay for damaged glass */
export function crackTexture(): THREE.Texture {
  const key = 'crack';
  const hit = cache.get(key);
  if (hit) return hit;
  const [cv, c] = makeCanvas(256);
  c.clearRect(0, 0, 256, 256);
  const rng = new Rng('crack');
  c.strokeStyle = 'rgba(255,255,255,0.85)';
  c.lineWidth = 1.2;
  const ox = 128 + rng.range(-30, 30);
  const oy = 128 + rng.range(-30, 30);
  for (let i = 0; i < 14; i++) {
    let x = ox;
    let y = oy;
    const a = (i / 14) * 6.28 + rng.range(-0.2, 0.2);
    c.beginPath();
    c.moveTo(x, y);
    for (let k = 0; k < 6; k++) {
      x += Math.cos(a + rng.range(-0.4, 0.4)) * rng.range(10, 30);
      y += Math.sin(a + rng.range(-0.4, 0.4)) * rng.range(10, 30);
      c.lineTo(x, y);
    }
    c.stroke();
  }
  for (let r = 12; r < 90; r += rng.range(14, 26)) {
    c.beginPath();
    for (let a = 0; a <= 6.3; a += 0.4) {
      const rr = r * rng.range(0.85, 1.15);
      const x = ox + Math.cos(a) * rr;
      const y = oy + Math.sin(a) * rr;
      if (a === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  cache.set(key, t);
  return t;
}

/** simple face texture (eyes / brows / mouth) for character heads */
export function faceTexture(skin: number, variant: number): THREE.Texture {
  const key = `face:${skin}:${variant}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const [cv, c] = makeCanvas(64);
  c.fillStyle = hex(skin);
  c.fillRect(0, 0, 64, 64);
  const dark = variant === 99;
  c.fillStyle = dark ? '#0a0a0a' : '#1a1410';
  // eyes
  c.fillRect(16, 26, 8, 5);
  c.fillRect(40, 26, 8, 5);
  c.fillStyle = dark ? '#d8d0c0' : '#f0ece4';
  c.fillRect(17, 27, 3, 3);
  c.fillRect(41, 27, 3, 3);
  // brows
  c.fillStyle = hex(shade(skin, 0.45));
  c.fillRect(14, 21 + (variant % 3), 12, 2);
  c.fillRect(38, 21 + ((variant + 1) % 3), 12, 2);
  // nose shadow and mouth
  c.fillStyle = hex(shade(skin, 0.8));
  c.fillRect(30, 32, 4, 10);
  c.fillStyle = hex(shade(skin, 0.5));
  c.fillRect(24, 47, 16, 2 + (variant % 2));
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  cache.set(key, t);
  return t;
}

/** a sheet of text, used for signs and notes */
export function signTexture(text: string, bg: number, fg: number, w = 512, h = 128): THREE.Texture {
  const key = `sign:${text}:${bg}:${fg}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const c = cv.getContext('2d')!;
  c.fillStyle = hex(bg);
  c.fillRect(0, 0, w, h);
  c.fillStyle = hex(fg);
  let size = h * 0.5;
  c.font = `bold ${size}px Georgia, serif`;
  while (c.measureText(text).width > w * 0.9 && size > 10) {
    size -= 2;
    c.font = `bold ${size}px Georgia, serif`;
  }
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, w / 2, h / 2);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}
