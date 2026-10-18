// Renders a top-down debug image of a generated neighbourhood (and its nav grid).
// usage: node scripts/run.mjs scripts/mapdump.ts <seed> <size> <out.png>
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { generateWorld } from '../src/world/gen/generator';
import { WorldGrid, F_BLOCK, F_DOOR, F_WINDOW, F_SIGHT } from '../src/world/grid';

function crc32(buf: Uint8Array) {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodePng(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const seed = process.argv[2] ?? 'hollow';
const size = (process.argv[3] ?? 'medium') as 'small' | 'medium' | 'large';
const out = process.argv[4] ?? 'map.png';
const t0 = performance.now();
const world = generateWorld({ seed, size, density: 0.85, nights: 5 });
const t1 = performance.now();
const grid = new WorldGrid(world);
const t2 = performance.now();
console.log(`gen ${(t1 - t0).toFixed(0)}ms grid ${(t2 - t1).toFixed(0)}ms size ${world.width}x${world.depth} buildings ${world.buildings.length} rooms ${world.rooms.length} doors ${world.doors.length} windows ${world.windows.length} furniture ${world.furniture.length} props ${world.props.length} lights ${world.lights.length}`);
const S = 4; // px per m
const W = Math.ceil(world.width * S);
const H = Math.ceil(world.depth * S);
const img = new Uint8Array(W * H * 3);
const put = (x: number, y: number, c: number) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  img[i] = (c >> 16) & 255;
  img[i + 1] = (c >> 8) & 255;
  img[i + 2] = c & 255;
};
const surfCol: Record<string, number> = { grass: 0x4a6a3a, asphalt: 0x3a3a3e, concrete: 0x9a9a92, dirt: 0x5a4a32, gravel: 0x8a8070, wood: 0x8a6a4a, tile: 0xc8c8c0, carpet: 0x8a4a4a };
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const wx = (x + 0.5) / S;
    const wz = (y + 0.5) / S;
    const i = grid.cellAt(wx, wz);
    const f = grid.flags[i];
    let c = surfCol[grid.surfaceAt(wx, wz)];
    if (f & F_SIGHT) c = 0x101010;
    else if (f & F_DOOR) c = 0xff3030;
    else if (f & F_WINDOW) c = 0x30a0ff;
    else if (f & F_BLOCK) c = ((c >> 1) & 0x7f7f7f) + 0x202020;
    put(x, y, c);
  }
for (const p of world.props) {
  if (p.kind.startsWith('tree')) for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) put(Math.round(p.x * S) + a, Math.round(p.z * S) + b, 0x1a3a1a);
}
for (const l of world.lights) {
  const c = l.broken ? 0x553311 : l.kind === 'street' ? 0xffdd55 : l.kind === 'porch' ? 0xffaa33 : l.kind === 'room' ? 0xffffaa : 0xff66ff;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) put(Math.round(l.x * S) + a, Math.round(l.z * S) + b, c);
}
const home = world.buildings[world.playerHouseId];
for (let a = -4; a <= 4; a++) for (let b = -4; b <= 4; b++) if (Math.abs(a) + Math.abs(b) < 5) put(Math.round(home.outsideFront.x * S) + a, Math.round(home.outsideFront.z * S) + b, 0xff00ff);
writeFileSync(out, encodePng(W, H, img));
console.log('wrote', out, W, H);
for (const b of world.buildings) if (b.kind !== 'house' && b.kind !== 'shed') console.log(b.kind.padEnd(10), b.name.padEnd(32), b.address);
