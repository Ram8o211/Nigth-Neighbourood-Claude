import * as THREE from 'three';
import { GROUND_Y } from '../world/ground';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../core/rng';
import type { Building, Furniture, Prop, WorldData } from '../world/types';
import { DIR_VEC } from '../world/types';
import { wallPieces } from '../world/collision';
import { ChunkedBuilder, MeshBuilder, FACES } from './meshBuilder';
import { floorMat, groundMat, material } from './materials';
import { signTexture, tex } from './textures';


export interface WorldMeshes {
  group: THREE.Group;
  /** emissive sign meshes keyed by building id (toggled at night) */
  signs: THREE.Mesh[];
  water: THREE.Mesh[];
}

// ---------------------------------------------------------------------------
// helpers for oriented furniture / prop boxes

function localBoxer(mb: MeshBuilder, cx: number, cz: number, face: number, y0: number) {
  const fwd = DIR_VEC[face];
  const right = DIR_VEC[(face + 1) % 4];
  return (lx0: number, ly0: number, lz0: number, lx1: number, ly1: number, lz1: number, color: number) => {
    const xs = [cx + right.x * lx0 + fwd.x * lz0, cx + right.x * lx1 + fwd.x * lz1];
    const zs = [cz + right.z * lx0 + fwd.z * lz0, cz + right.z * lx1 + fwd.z * lz1];
    mb.box('vc', Math.min(xs[0], xs[1]), y0 + ly0, Math.min(zs[0], zs[1]), Math.max(xs[0], xs[1]), y0 + ly1, Math.max(zs[0], zs[1]), 63, color);
  };
}

function shadeHex(c: number, f: number) {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * f));
  const b = Math.min(255, Math.round((c & 255) * f));
  return (r << 16) | (g << 8) | b;
}

export function buildFurniture(mb: MeshBuilder, f: Furniture, y0: number, rng: Rng) {
  if (f.kind === 'none') return;
  const along = f.face === 0 || f.face === 2;
  const W = along ? f.w : f.d;
  const Dp = along ? f.d : f.w;
  const hw = W / 2;
  const hd = Dp / 2;
  const B = localBoxer(mb, f.x, f.z, f.face, y0);
  const c = f.color;
  const dark = shadeHex(c, 0.6);
  const light = shadeHex(c, 1.25);
  const legs = (h: number, inset: number, col: number, t = 0.05) => {
    B(-hw + inset, 0, -hd + inset, -hw + inset + t, h, -hd + inset + t, col);
    B(hw - inset - t, 0, -hd + inset, hw - inset, h, -hd + inset + t, col);
    B(-hw + inset, 0, hd - inset - t, -hw + inset + t, h, hd - inset, col);
    B(hw - inset - t, 0, hd - inset - t, hw - inset, h, hd - inset, col);
  };
  switch (f.kind) {
    case 'bed': {
      B(-hw, 0, -hd, hw, 0.3, hd, 0x5a3d29);
      B(-hw + 0.03, 0.3, -hd + 0.05, hw - 0.03, 0.48, hd - 0.03, 0xe8e4dc);
      B(-hw + 0.02, 0.48, -hd + 0.55, hw - 0.02, 0.54, hd - 0.02, c);
      B(-hw + 0.02, 0.2, hd - 0.04, hw - 0.02, 0.5, hd, c);
      B(-hw * 0.8, 0.48, -hd + 0.1, hw * 0.8, 0.6, -hd + 0.45, 0xf4f0e8);
      B(-hw, 0, -hd, hw, 1.0, -hd + 0.08, 0x4a3324);
      break;
    }
    case 'sofa':
    case 'armchair': {
      B(-hw, 0, -hd, hw, 0.42, hd, c);
      B(-hw, 0.42, -hd, hw, 0.85, -hd + 0.22, dark);
      B(-hw, 0.42, -hd, -hw + 0.18, 0.66, hd, dark);
      B(hw - 0.18, 0.42, -hd, hw, 0.66, hd, dark);
      B(-hw + 0.18, 0.42, -hd + 0.22, hw - 0.18, 0.5, hd - 0.02, light);
      break;
    }
    case 'tv': {
      B(-hw, 0, -hd, hw, 0.5, hd, c);
      B(-hw * 0.65, 0.5, -0.1, hw * 0.65, 0.98, 0.06, 0x1a1a1c);
      B(-hw * 0.6, 0.54, 0.06, hw * 0.6, 0.94, 0.07, 0x223040);
      break;
    }
    case 'bookshelf': {
      B(-hw, 0, -hd, -hw + 0.04, f.h, hd, c);
      B(hw - 0.04, 0, -hd, hw, f.h, hd, c);
      B(-hw, 0, -hd, hw, f.h, -hd + 0.03, dark);
      for (let k = 0; k < 5; k++) {
        const y = 0.05 + k * (f.h / 5);
        B(-hw, y, -hd, hw, y + 0.03, hd, c);
        let x = -hw + 0.06;
        while (x < hw - 0.12) {
          const bw = rng.range(0.03, 0.08);
          const bh = rng.range(0.2, 0.3);
          if (rng.chance(0.85)) B(x, y + 0.03, -hd + 0.05, x + bw, y + 0.03 + bh, hd - 0.04, rng.pick([0x7a2a22, 0x2a3a5a, 0x3a5a3a, 0x8a7a4a, 0x4a2a4a, 0xc8b898]));
          x += bw + 0.005;
        }
      }
      B(-hw, f.h - 0.03, -hd, hw, f.h, hd, c);
      break;
    }
    case 'floorlamp': {
      mb.cyl(f.x, y0, f.z, 0.18, 0.04, 0x3a3a3a, 10);
      mb.cyl(f.x, y0 + 0.04, f.z, 0.025, 1.3, 0x3a3a3a, 6);
      mb.cyl(f.x, y0 + 1.3, f.z, 0.26, 0.32, 0xe8d8b0, 10, 0.16);
      break;
    }
    case 'phonetable': {
      B(-hw, 0.7, -hd, hw, 0.75, hd, c);
      legs(0.7, 0.04, dark);
      B(-0.12, 0.75, -0.08, 0.12, 0.83, 0.1, 0x1a1a1a);
      B(-0.1, 0.83, -0.06, 0.1, 0.87, 0.02, 0x8a1a1a);
      break;
    }
    case 'plant': {
      mb.cyl(f.x, y0, f.z, 0.2, 0.35, 0x8a4a2a, 8, 0.24);
      mb.cyl(f.x, y0 + 0.35, f.z, 0.28, 0.7, c, 7, 0.08);
      break;
    }
    case 'fridge': {
      B(-hw, 0, -hd, hw, f.h, hd, c);
      B(-hw + 0.02, f.h * 0.62, hd, hw - 0.02, f.h * 0.625, hd + 0.005, 0x8a8a8a);
      B(hw - 0.12, f.h * 0.3, hd, hw - 0.09, f.h * 0.55, hd + 0.04, 0x9a9a9a);
      B(hw - 0.12, f.h * 0.68, hd, hw - 0.09, f.h * 0.85, hd + 0.04, 0x9a9a9a);
      break;
    }
    case 'stove': {
      B(-hw, 0, -hd, hw, 0.88, hd, c);
      B(-hw, 0.88, -hd, hw, 0.92, hd, 0x1c1c1c);
      for (const [bx, bz] of [
        [-0.17, -0.14],
        [0.17, -0.14],
        [-0.17, 0.14],
        [0.17, 0.14],
      ])
        mb.cyl(f.x + DIR_VEC[(f.face + 1) % 4].x * bx + DIR_VEC[f.face].x * bz, y0 + 0.92, f.z + DIR_VEC[(f.face + 1) % 4].z * bx + DIR_VEC[f.face].z * bz, 0.09, 0.01, 0x3a3a3a, 8);
      B(-hw + 0.05, 0.2, hd, hw - 0.05, 0.7, hd + 0.01, 0x2a2a2a);
      B(-hw, 0.92, -hd, hw, 1.15, -hd + 0.06, c);
      break;
    }
    case 'kitchensink':
    case 'counter': {
      B(-hw, 0, -hd, hw, 0.86, hd - 0.02, f.kind === 'kitchensink' ? 0xd8d4c8 : c);
      B(-hw, 0.86, -hd, hw, 0.92, hd + 0.02, 0x9a968c);
      B(-hw + 0.04, 0.1, hd - 0.02, -0.02, 0.8, hd - 0.01, dark);
      B(0.02, 0.1, hd - 0.02, hw - 0.04, 0.8, hd - 0.01, dark);
      if (f.kind === 'kitchensink') {
        B(-0.32, 0.88, -0.2, 0.32, 0.925, 0.2, 0x5a5a5e);
        B(-0.03, 0.92, -hd + 0.06, 0.03, 1.15, -hd + 0.12, 0xa0a0a8);
      }
      break;
    }
    case 'nightstand': {
      B(-hw, 0, -hd, hw, 0.58, hd, c);
      B(-hw + 0.04, 0.32, hd, hw - 0.04, 0.34, hd + 0.005, dark);
      mb.cyl(f.x, y0 + 0.58, f.z, 0.06, 0.25, 0x6a6a6a, 6);
      mb.cyl(f.x, y0 + 0.78, f.z, 0.14, 0.18, 0xe8d8b0, 8, 0.09);
      break;
    }
    case 'wardrobe': {
      B(-hw, 0, -hd, hw, f.h, hd, c);
      B(-0.01, 0.05, hd, 0.01, f.h - 0.05, hd + 0.005, dark);
      B(-0.08, f.h * 0.45, hd, -0.05, f.h * 0.6, hd + 0.03, 0xb0a070);
      B(0.05, f.h * 0.45, hd, 0.08, f.h * 0.6, hd + 0.03, 0xb0a070);
      break;
    }
    case 'dresser':
    case 'filing': {
      B(-hw, 0, -hd, hw, f.h, hd, c);
      const n = f.kind === 'filing' ? 4 : 3;
      for (let k = 1; k < n; k++) B(-hw + 0.03, (f.h * k) / n, hd, hw - 0.03, (f.h * k) / n + 0.015, hd + 0.005, dark);
      for (let k = 0; k < n; k++) B(-0.08, (f.h * (k + 0.5)) / n, hd, 0.08, (f.h * (k + 0.5)) / n + 0.03, hd + 0.025, 0xa09060);
      break;
    }
    case 'desk': {
      B(-hw, 0.72, -hd, hw, 0.76, hd, c);
      B(hw - 0.42, 0, -hd + 0.02, hw - 0.02, 0.72, hd - 0.02, dark);
      B(-hw + 0.02, 0, -hd + 0.02, -hw + 0.07, 0.72, hd - 0.02, dark);
      B(-0.2, 0.76, -hd + 0.1, 0.12, 0.78, -hd + 0.32, 0xf0ece0);
      break;
    }
    case 'toilet': {
      B(-0.19, 0, -hd + 0.18, 0.19, 0.42, hd - 0.02, 0xf0f0ec);
      B(-0.21, 0.42, -hd + 0.15, 0.21, 0.46, hd, 0xe8e8e4);
      B(-0.22, 0.3, -hd, 0.22, 0.8, -hd + 0.18, 0xf0f0ec);
      break;
    }
    case 'bathsink': {
      B(-0.1, 0, -hd, 0.1, 0.78, -hd + 0.2, 0xf0f0ec);
      B(-hw, 0.78, -hd, hw, 0.9, hd, 0xf0f0ec);
      B(-hw + 0.08, 0.86, -hd + 0.08, hw - 0.08, 0.905, hd - 0.06, 0xc8ccd0);
      B(-hw * 0.7, 1.15, -hd, hw * 0.7, 1.75, -hd + 0.03, 0x9aaab8);
      break;
    }
    case 'tub': {
      B(-hw, 0, -hd, hw, 0.58, hd, 0xf0f0ec);
      B(-hw + 0.08, 0.5, -hd + 0.08, hw - 0.08, 0.585, hd - 0.08, 0xd0d8dc);
      break;
    }
    case 'shower': {
      B(-hw, 0, -hd, hw, 0.08, hd, 0xe8e8e4);
      B(-hw, 0, hd - 0.04, -hw + 0.04, 2.0, hd, 0xa0a8b0);
      B(hw - 0.04, 0, hd - 0.04, hw, 2.0, hd, 0xa0a8b0);
      B(-hw, 1.96, -hd, hw, 2.0, hd, 0xa0a8b0);
      B(-0.04, 1.6, -hd, 0.04, 1.9, -hd + 0.3, 0xa0a8b0);
      break;
    }
    case 'bathcabinet':
    case 'medcabinet': {
      B(-hw, f.kind === 'bathcabinet' ? 0.9 : 0, -hd, hw, f.h, hd, 0xf0f0ec);
      B(-hw + 0.04, (f.kind === 'bathcabinet' ? 0.9 : 0) + 0.05, hd, hw - 0.04, f.h - 0.05, hd + 0.005, f.kind === 'bathcabinet' ? 0x9aaab8 : 0xe0e0dc);
      if (f.kind === 'medcabinet') {
        B(-0.04, f.h * 0.7, hd, 0.04, f.h * 0.86, hd + 0.01, 0xb02020);
        B(-0.08, f.h * 0.76, hd, 0.08, f.h * 0.8, hd + 0.01, 0xb02020);
      }
      break;
    }
    case 'coatrack': {
      mb.cyl(f.x, y0, f.z, 0.18, 0.04, 0x3a2a1a, 8);
      mb.cyl(f.x, y0, f.z, 0.03, 1.75, 0x4a3324, 6);
      B(-0.2, 1.4, -0.12, 0.2, 1.6, 0.12, rng.pick([0x3a3a4a, 0x5a3a2a, 0x2a2a2a]));
      break;
    }
    case 'shelf': {
      B(-hw, 0, -hd, -hw + 0.04, f.h, hd, 0x6a6e72);
      B(hw - 0.04, 0, -hd, hw, f.h, hd, 0x6a6e72);
      for (let k = 0; k < 4; k++) {
        const y = 0.1 + k * (f.h / 4);
        B(-hw, y, -hd, hw, y + 0.03, hd, c);
        let x = -hw + 0.06;
        while (x < hw - 0.15) {
          const bw = rng.range(0.1, 0.25);
          const bh = rng.range(0.12, 0.3);
          if (rng.chance(0.75)) B(x, y + 0.03, -hd + 0.05, x + bw, y + 0.03 + bh, hd - 0.05, rng.pick([0xc8a060, 0x8a2a2a, 0x2a5a8a, 0xe0d8c0, 0x5a7a3a, 0xd89040]));
          x += bw + 0.03;
        }
      }
      break;
    }
    case 'crate': {
      B(-hw, 0, -hd, hw, f.h, hd, c);
      B(-hw - 0.005, f.h * 0.45, -hd - 0.005, hw + 0.005, f.h * 0.55, hd + 0.005, dark);
      break;
    }
    case 'workbench': {
      B(-hw, 0.88, -hd, hw, 0.95, hd, c);
      legs(0.88, 0.04, dark, 0.07);
      B(-hw + 0.05, 0.25, -hd + 0.05, hw - 0.05, 0.28, hd - 0.05, dark);
      B(hw - 0.35, 0.95, hd - 0.2, hw - 0.1, 1.05, hd, 0x3a4a5a);
      B(-hw + 0.1, 0.95, -hd + 0.05, -hw + 0.5, 1.0, -hd + 0.25, 0x8a2a1a);
      break;
    }
    case 'shopcounter':
    case 'frontdesk':
    case 'dinercounter':
    case 'barcounter': {
      const top = f.kind === 'barcounter' ? 0x2a1a10 : f.kind === 'dinercounter' ? 0xd8d0c0 : 0x5a4a3a;
      B(-hw, 0, -hd + 0.04, hw, f.h - 0.05, hd, c);
      B(-hw - 0.03, f.h - 0.05, -hd, hw + 0.03, f.h, hd + 0.05, top);
      if (f.kind === 'shopcounter') {
        B(-0.25, f.h, -0.15, 0.15, f.h + 0.22, 0.15, 0x3a3a3a);
        B(-0.22, f.h + 0.22, -0.1, 0.12, f.h + 0.3, 0.05, 0x2a4a2a);
      }
      if (f.kind === 'barcounter') {
        // bottles on a back shelf behind the counter
        for (let k = 0; k < 10; k++) {
          const x = -hw + 0.2 + k * ((W - 0.4) / 10);
          B(x, f.h, -hd + 0.06, x + 0.07, f.h + rng.range(0.22, 0.32), -hd + 0.13, rng.pick([0x2a5a2a, 0x6a3a1a, 0xc8b070, 0x3a2a1a]));
        }
      }
      if (f.kind === 'dinercounter' || f.kind === 'barcounter') {
        for (let x = -hw + 0.4; x < hw - 0.2; x += 0.7) {
          mb.cyl(
            f.x + DIR_VEC[(f.face + 1) % 4].x * x + DIR_VEC[f.face].x * (hd + 0.45),
            y0,
            f.z + DIR_VEC[(f.face + 1) % 4].z * x + DIR_VEC[f.face].z * (hd + 0.45),
            0.04,
            0.7,
            0x8a8a8a,
            6,
          );
          mb.cyl(
            f.x + DIR_VEC[(f.face + 1) % 4].x * x + DIR_VEC[f.face].x * (hd + 0.45),
            y0 + 0.7,
            f.z + DIR_VEC[(f.face + 1) % 4].z * x + DIR_VEC[f.face].z * (hd + 0.45),
            0.19,
            0.08,
            f.kind === 'dinercounter' ? 0xb03a2e : 0x3a2a1a,
            10,
          );
        }
      }
      break;
    }
    case 'cellbed': {
      B(-hw, 0.35, -hd, hw, 0.42, hd, 0x6a6e72);
      legs(0.35, 0.02, 0x5a5e62, 0.04);
      B(-hw + 0.04, 0.42, -hd + 0.04, hw - 0.04, 0.5, hd - 0.04, 0x7a7a6a);
      break;
    }
    case 'examtable': {
      B(-hw, 0.0, -hd + 0.1, hw, 0.6, hd - 0.1, 0xb8bcc0);
      B(-hw, 0.6, -hd, hw, 0.8, hd, 0x6a8a8a);
      B(-hw, 0.8, -hd, hw, 0.81, hd, 0xf0f0e8);
      break;
    }
    case 'altar': {
      B(-hw, 0, -hd, hw, f.h, hd, 0x6a4a32);
      B(-hw - 0.02, f.h - 0.4, -hd - 0.02, hw + 0.02, f.h + 0.01, hd + 0.02, 0xf0ece0);
      mb.cyl(f.x + DIR_VEC[(f.face + 1) % 4].x * 0.6, y0 + f.h, f.z + DIR_VEC[(f.face + 1) % 4].z * 0.6, 0.03, 0.3, 0xf0e8d0, 6);
      mb.cyl(f.x - DIR_VEC[(f.face + 1) % 4].x * 0.6, y0 + f.h, f.z - DIR_VEC[(f.face + 1) % 4].z * 0.6, 0.03, 0.3, 0xf0e8d0, 6);
      B(-0.03, f.h, -0.03, 0.03, f.h + 0.7, 0.03, 0xc8a040);
      B(-0.18, f.h + 0.45, -0.03, 0.18, f.h + 0.5, 0.03, 0xc8a040);
      break;
    }
    case 'jukebox': {
      B(-hw, 0, -hd, hw, 1.2, hd, c);
      B(-hw + 0.05, 0.5, hd, hw - 0.05, 1.1, hd + 0.01, 0xe8b040);
      B(-hw + 0.1, 0.2, hd, hw - 0.1, 0.4, hd + 0.01, 0x3a2a1a);
      mb.cyl(f.x, y0 + 1.2, f.z, Math.min(hw, hd), 0.3, c, 10);
      break;
    }
    case 'oildrum':
      mb.cyl(f.x, y0, f.z, Math.min(hw, hd), f.h, c, 10);
      break;
    case 'bench':
    case 'pew': {
      B(-hw, 0.42, -hd, hw, 0.48, hd, c);
      B(-hw, 0.48, -hd, hw, f.kind === 'pew' ? 0.95 : 0.85, -hd + 0.06, c);
      B(-hw, 0, -hd, -hw + 0.06, f.kind === 'pew' ? 0.95 : 0.42, hd, dark);
      B(hw - 0.06, 0, -hd, hw, f.kind === 'pew' ? 0.95 : 0.42, hd, dark);
      break;
    }
    case 'table': {
      B(-hw, 0.72, -hd, hw, 0.76, hd, c);
      legs(0.72, 0.05, dark, 0.06);
      break;
    }
    case 'chair': {
      B(-hw + 0.03, 0.44, -hd + 0.03, hw - 0.03, 0.48, hd - 0.03, c);
      B(-hw + 0.03, 0.48, -hd + 0.03, hw - 0.03, 0.95, -hd + 0.07, c);
      legs(0.44, 0.05, dark, 0.04);
      break;
    }
    case 'car':
      buildCar(mb, f.x, f.z, f.w > f.d, y0, c, false);
      break;
    case 'rug':
      mb.hquad('vc', f.x - f.w / 2, f.z - f.d / 2, f.x + f.w / 2, f.z + f.d / 2, y0 + 0.008, true, c);
      break;
    default:
      B(-hw, 0, -hd, hw, f.h, hd, c);
  }
}

function buildCar(mb: MeshBuilder, x: number, z: number, alongX: boolean, y0: number, color: number, wreck: boolean) {
  const L = 4.3;
  const Wd = 1.85;
  const box = (l0: number, yy0: number, w0: number, l1: number, yy1: number, w1: number, col: number) => {
    if (alongX) mb.box('vc', x + l0, y0 + yy0, z + w0, x + l1, y0 + yy1, z + w1, 63, col);
    else mb.box('vc', x + w0, y0 + yy0, z + l0, x + w1, y0 + yy1, z + l1, 63, col);
  };
  const body = wreck ? 0x5a3a26 : color;
  box(-L / 2, 0.32, -Wd / 2, L / 2, 0.85, Wd / 2, body);
  box(-L / 2 + 0.9, 0.85, -Wd / 2 + 0.08, L / 2 - 1.1, 1.38, Wd / 2 - 0.08, body);
  box(-L / 2 + 0.95, 0.88, -Wd / 2 + 0.06, L / 2 - 1.15, 1.33, Wd / 2 - 0.06, wreck ? 0x1a1a1a : 0x1a222a);
  box(-L / 2 - 0.02, 0.5, -Wd / 2 + 0.15, -L / 2, 0.62, -Wd / 2 + 0.4, 0xd8d0a0);
  box(-L / 2 - 0.02, 0.5, Wd / 2 - 0.4, -L / 2, 0.62, Wd / 2 - 0.15, 0xd8d0a0);
  box(L / 2, 0.55, -Wd / 2 + 0.15, L / 2 + 0.02, 0.65, -Wd / 2 + 0.4, 0x8a1010);
  box(L / 2, 0.55, Wd / 2 - 0.4, L / 2 + 0.02, 0.65, Wd / 2 - 0.15, 0x8a1010);
  for (const lx of [-L / 2 + 0.75, L / 2 - 0.75])
    for (const s of [-1, 1]) box(lx - 0.33, 0, s > 0 ? Wd / 2 - 0.25 : -Wd / 2 - 0.02, lx + 0.33, wreck && lx > 0 ? 0.25 : 0.62, s > 0 ? Wd / 2 + 0.02 : -Wd / 2 + 0.25, 0x151515);
}

// ---------------------------------------------------------------------------

function buildWalls(cb: ChunkedBuilder, world: WorldData, b: Building) {
  const mb = cb.at((b.rect.x0 + b.rect.x1) / 2, (b.rect.z0 + b.rect.z1) / 2);
  const fy = b.floorY;
  const trim = `trim_${b.trimColor}`;
  for (const wid of b.wallIds) {
    const w = world.walls[wid];
    const th = w.thickness / 2;
    for (const p of wallPieces(w)) {
      if (p.b - p.a < 0.005) continue;
      const y0 = p.bottom < 0.01 ? (w.exterior ? 0 : fy) : fy + p.bottom;
      const y1 = fy + p.top;
      // faces: px nx py ny pz nz
      const isFull = p.bottom < 0.01 && p.top >= w.height - 0.01;
      if (w.axis === 'x') {
        const keys = [trim, trim, trim, trim, w.matPos, w.matNeg];
        let faces = FACES.PZ | FACES.NZ | FACES.PX | FACES.NX;
        if (!isFull && p.bottom < 0.01) faces |= FACES.PY;
        if (p.bottom > 0.01) faces |= FACES.NY;
        mb.box(keys, p.a, y0, w.c - th, p.b, y1, w.c + th, faces);
      } else {
        const keys = [w.matPos, w.matNeg, trim, trim, trim, trim];
        let faces = FACES.PX | FACES.NX | FACES.PZ | FACES.NZ;
        if (!isFull && p.bottom < 0.01) faces |= FACES.PY;
        if (p.bottom > 0.01) faces |= FACES.NY;
        mb.box(keys, w.c - th, y0, p.a, w.c + th, y1, p.b, faces);
      }
    }
    // window frames and sills
    for (const o of w.openings) {
      if (o.kind !== 'window' || o.id < 0) continue;
      const win = world.windows[o.id];
      const ft = 0.07;
      const y0 = fy + o.bottom;
      const y1 = fy + o.top;
      const fr = (a: number, b2: number, ya: number, yb: number, extra = 0) => {
        if (w.axis === 'x') mb.box(trim, a, ya, w.c - th - 0.02 - extra, b2, yb, w.c + th + 0.02 + extra);
        else mb.box(trim, w.c - th - 0.02 - extra, ya, a, w.c + th + 0.02 + extra, yb, b2);
      };
      fr(o.t0 - ft, o.t0, y0, y1);
      fr(o.t1, o.t1 + ft, y0, y1);
      fr(o.t0 - ft, o.t1 + ft, y1, y1 + ft);
      // outside sill
      const out = win.outside;
      if (w.axis === 'x') mb.box(trim, o.t0 - 0.12, y0 - 0.06, out > 0 ? w.c : w.c - th - 0.12, o.t1 + 0.12, y0, out > 0 ? w.c + th + 0.12 : w.c);
      else mb.box(trim, out > 0 ? w.c : w.c - th - 0.12, y0 - 0.06, o.t0 - 0.12, out > 0 ? w.c + th + 0.12 : w.c, y0, o.t1 + 0.12);
      // mullions
      if (!win.shop) fr((o.t0 + o.t1) / 2 - 0.025, (o.t0 + o.t1) / 2 + 0.025, y0, y1, -0.1);
    }
    // door frames
    for (const o of w.openings) {
      if (o.kind !== 'door') continue;
      const ft = 0.07;
      const y1 = fy + o.top;
      const fr = (a: number, b2: number, ya: number, yb: number) => {
        if (w.axis === 'x') mb.box(trim, a, ya, w.c - th - 0.025, b2, yb, w.c + th + 0.025);
        else mb.box(trim, w.c - th - 0.025, ya, a, w.c + th + 0.025, yb, b2);
      };
      if (o.id >= 0) {
        fr(o.t0 - ft, o.t0, fy, y1);
        fr(o.t1, o.t1 + ft, fy, y1);
        fr(o.t0 - ft, o.t1 + ft, y1, y1 + ft);
      }
      // threshold floor patch inside the wall thickness
      if (w.axis === 'x') mb.hquad('floor_wood', o.t0, w.c - th - 0.01, o.t1, w.c + th + 0.01, fy + 0.004);
      else mb.hquad('floor_wood', w.c - th - 0.01, o.t0, w.c + th + 0.01, o.t1, fy + 0.004);
    }
  }
}

function buildRoof(mb: MeshBuilder, b: Building) {
  const r = b.rect;
  const top = b.floorY + b.wallHeight;
  const ext = b.wallMat;
  const roofKey = `roof_${b.roofColor}`;
  const trim = `trim_${b.trimColor}`;
  // ceiling slab top hides the wall tops
  if (b.roof === 'flat') {
    mb.box('tar', r.x0 - 0.15, top, r.z0 - 0.15, r.x1 + 0.15, top + 0.12, r.z1 + 0.15);
    const pw = 0.25;
    mb.box(ext, r.x0 - 0.15, top, r.z0 - 0.15, r.x1 + 0.15, top + 0.6, r.z0 - 0.15 + pw);
    mb.box(ext, r.x0 - 0.15, top, r.z1 + 0.15 - pw, r.x1 + 0.15, top + 0.6, r.z1 + 0.15);
    mb.box(ext, r.x0 - 0.15, top, r.z0 - 0.15, r.x0 - 0.15 + pw, top + 0.6, r.z1 + 0.15);
    mb.box(ext, r.x1 + 0.15 - pw, top, r.z0 - 0.15, r.x1 + 0.15, top + 0.6, r.z1 + 0.15);
    mb.box(trim, r.x0 - 0.18, top + 0.6, r.z0 - 0.18, r.x1 + 0.18, top + 0.66, r.z1 + 0.18, FACES.ALL & ~FACES.NY);
    return;
  }
  const w = r.x1 - r.x0;
  const d = r.z1 - r.z0;
  const o = b.roof === 'shed' ? 0.25 : 0.45;
  const ridgeX = w >= d; // ridge runs along x
  const span = ridgeX ? d : w;
  const pitch = b.roof === 'shed' ? 0.25 : b.roof === 'steeple' ? 0.8 : 0.62;
  const rise = (span / 2) * pitch;
  const x0 = r.x0 - o;
  const x1 = r.x1 + o;
  const z0 = r.z0 - o;
  const z1 = r.z1 + o;
  const n = (a: number[], b2: number[], c: number[]) => {
    const ux = b2[0] - a[0];
    const uy = b2[1] - a[1];
    const uz = b2[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  };
  const quad = (key: string, p: number[][], uvScale = 2.5) => {
    const nn = n(p[0], p[1], p[2]);
    const len01 = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]);
    const len03 = Math.hypot(p[3][0] - p[0][0], p[3][1] - p[0][1], p[3][2] - p[0][2]);
    mb.quad(key, p, nn, [
      [0, 0],
      [len01 / uvScale, 0],
      [len01 / uvScale, len03 / uvScale],
      [0, len03 / uvScale],
    ]);
    // underside
    const q = [p[3], p[2], p[1], p[0]];
    mb.quad(trim, q, [-nn[0], -nn[1], -nn[2]], [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
  };
  const eave = top - o * pitch;
  if (b.roof === 'shed') {
    // single slope from front to back
    if (ridgeX) {
      quad(roofKey, [
        [x0, eave, z1],
        [x1, eave, z1],
        [x1, top + rise * 2, z0],
        [x0, top + rise * 2, z0],
      ]);
    } else
      quad(roofKey, [
        [x1, eave, z1],
        [x1, eave, z0],
        [x0, top + rise * 2, z0],
        [x0, top + rise * 2, z1],
      ]);
    return;
  }
  const ry = top + rise;
  if (ridgeX) {
    const zm = (r.z0 + r.z1) / 2;
    quad(roofKey, [
      [x0, eave, z0],
      [x0, ry, zm],
      [x1, ry, zm],
      [x1, eave, z0],
    ]);
    quad(roofKey, [
      [x1, eave, z1],
      [x1, ry, zm],
      [x0, ry, zm],
      [x0, eave, z1],
    ]);
    // gables
    for (const [x, s] of [
      [r.x0, -1],
      [r.x1, 1],
    ] as [number, number][]) {
      const p = [
        [x, top, r.z0],
        [x, ry - 0.02, zm],
        [x, top, r.z1],
      ];
      mb.tri(ext, s > 0 ? p : [p[2], p[1], p[0]], [s, 0, 0], [
        [r.z0 / 2.2, top / 2.2],
        [zm / 2.2, ry / 2.2],
        [r.z1 / 2.2, top / 2.2],
      ]);
    }
  } else {
    const xm = (r.x0 + r.x1) / 2;
    quad(roofKey, [
      [x0, eave, z1],
      [xm, ry, z1],
      [xm, ry, z0],
      [x0, eave, z0],
    ]);
    quad(roofKey, [
      [x1, eave, z0],
      [xm, ry, z0],
      [xm, ry, z1],
      [x1, eave, z1],
    ]);
    for (const [z, s] of [
      [r.z0, -1],
      [r.z1, 1],
    ] as [number, number][]) {
      const p = [
        [r.x1, top, z],
        [xm, ry - 0.02, z],
        [r.x0, top, z],
      ];
      mb.tri(ext, s > 0 ? p : [p[2], p[1], p[0]], [0, 0, s], [
        [r.x1 / 2.2, top / 2.2],
        [xm / 2.2, ry / 2.2],
        [r.x0 / 2.2, top / 2.2],
      ]);
    }
  }
  // chimney on houses
  if (b.kind === 'house' || b.kind === 'abandoned') {
    const cx = ridgeX ? r.x0 + w * 0.25 : (r.x0 + r.x1) / 2 + (w / 2) * 0.35;
    const cz = ridgeX ? (r.z0 + r.z1) / 2 + (d / 2) * 0.35 : r.z0 + d * 0.25;
    mb.box('brick_dark', cx - 0.35, top, cz - 0.35, cx + 0.35, ry + 0.9, cz + 0.35);
  }
  if (b.roof === 'steeple') {
    // bell tower on the front of the ridge with a spire
    const front = DIR_VEC[b.front];
    const cx = (r.x0 + r.x1) / 2 + front.x * ((ridgeX ? w : d) / 2 - 1.6);
    const cz = (r.z0 + r.z1) / 2 + front.z * ((ridgeX ? w : d) / 2 - 1.6);
    mb.box('stone', cx - 1.4, top, cz - 1.4, cx + 1.4, ry + 4.5, cz + 1.4);
    mb.box('vc', cx - 1.0, ry + 2.6, cz - 1.45, cx + 1.0, ry + 4.0, cz + 1.45, 63, 0x141414);
    mb.box('vc', cx - 1.45, ry + 2.6, cz - 1.0, cx + 1.45, ry + 4.0, cz + 1.0, 63, 0x141414);
    const sy = ry + 4.5;
    const h = 7;
    const pts = [
      [cx - 1.5, sy, cz - 1.5],
      [cx + 1.5, sy, cz - 1.5],
      [cx + 1.5, sy, cz + 1.5],
      [cx - 1.5, sy, cz + 1.5],
    ];
    const apex = [cx, sy + h, cz];
    for (let i = 0; i < 4; i++) {
      const a = pts[i];
      const c = pts[(i + 1) % 4];
      const nn = n(a, apex, c);
      mb.tri(roofKey, [a, apex, c], nn, [
        [0, 0],
        [0.5, 2],
        [1, 0],
      ]);
    }
    mb.box('vc', cx - 0.05, sy + h, cz - 0.05, cx + 0.05, sy + h + 1.4, cz + 0.05, 63, 0x2a2a2a);
    mb.box('vc', cx - 0.4, sy + h + 0.8, cz - 0.05, cx + 0.4, sy + h + 0.95, cz + 0.05, 63, 0x2a2a2a);
  }
}

function buildBuildingGeometry(cb: ChunkedBuilder, world: WorldData, b: Building, rng: Rng) {
  const cx = (b.rect.x0 + b.rect.x1) / 2;
  const cz = (b.rect.z0 + b.rect.z1) / 2;
  const mb = cb.at(cx, cz);
  const r = b.rect;
  // foundation plinth
  mb.box('foundation', r.x0 - 0.2, -0.05, r.z0 - 0.2, r.x1 + 0.2, b.floorY + 0.02, r.z1 + 0.2, FACES.ALL & ~FACES.NY & ~FACES.PY);
  // floors & ceilings
  for (const rid of b.roomIds) {
    const room = world.rooms[rid];
    const rr = room.rect;
    mb.hquad(floorMat(room.floor, rid), rr.x0 - 0.1, rr.z0 - 0.1, rr.x1 + 0.1, rr.z1 + 0.1, b.floorY);
    mb.hquad('ceiling', rr.x0 - 0.1, rr.z0 - 0.1, rr.x1 + 0.1, rr.z1 + 0.1, b.floorY + b.wallHeight - 0.005, false);
    // skirting boards
    if (b.kind !== 'shed' && b.kind !== 'garage') {
      const sk = 0x4a3a2a;
      const t = 0.02;
      mb.box('vc', rr.x0 + 0.08, b.floorY, rr.z0 + 0.08, rr.x1 - 0.08, b.floorY + 0.1, rr.z0 + 0.08 + t, FACES.PZ | FACES.PY, sk);
      mb.box('vc', rr.x0 + 0.08, b.floorY, rr.z1 - 0.08 - t, rr.x1 - 0.08, b.floorY + 0.1, rr.z1 - 0.08, FACES.NZ | FACES.PY, sk);
    }
  }
  buildWalls(cb, world, b);
  buildRoof(mb, b);
  // porch step outside front door
  const fd = world.doors[b.frontDoorId];
  if (fd && b.kind !== 'shed') {
    const out = fd.roomPos >= 0 ? -1 : 1;
    if (fd.axis === 'x') mb.box('foundation', fd.t - 0.9, 0, out > 0 ? fd.c + 0.15 : fd.c - 0.75, fd.t + 0.9, b.floorY - 0.02, out > 0 ? fd.c + 0.75 : fd.c - 0.15);
    else mb.box('foundation', out > 0 ? fd.c + 0.15 : fd.c - 0.75, 0, fd.t - 0.9, out > 0 ? fd.c + 0.75 : fd.c - 0.15, b.floorY - 0.02, fd.t + 0.9);
  }
  // furniture
  for (const f of world.furniture) {
    if (f.buildingId !== b.id) continue;
    buildFurniture(mb, f, b.floorY, rng);
  }
}

// ---------------------------------------------------------------------------
// props

function buildProp(cb: ChunkedBuilder, p: Prop, rng: Rng, signs: THREE.Mesh[], world: WorldData, group: THREE.Group) {
  const mb = cb.at(p.x, p.z);
  const face = ((Math.round(-p.rot / (Math.PI / 2)) % 4) + 4) % 4;
  const B = localBoxer(mb, p.x, p.z, face, 0);
  switch (p.kind) {
    case 'mailbox':
      B(-0.04, 0, -0.04, 0.04, 1.0, 0.04, 0x5a4a3a);
      B(-0.13, 1.0, -0.25, 0.13, 1.25, 0.25, p.color);
      B(0.13, 1.1, 0.05, 0.15, 1.35, 0.1, 0xb02020);
      break;
    case 'trashcan':
      mb.cyl(p.x, 0, p.z, 0.3, 0.95, 0x4a5a4a, 10, 0.32);
      mb.cyl(p.x, 0.95, p.z, 0.34, 0.06, 0x3a4a3a, 10);
      break;
    case 'car':
    case 'car_wreck':
      buildCar(mb, p.x, p.z, Math.abs(Math.sin(p.rot)) > 0.5, 0, p.color, p.kind === 'car_wreck');
      break;
    case 'streetlamp': {
      mb.cyl(p.x, 0, p.z, 0.12, 0.4, 0x2a2a2c, 8, 0.09);
      mb.cyl(p.x, 0.4, p.z, 0.07, 5.2, 0x3a3a3e, 8, 0.05);
      // arm points toward road: rot encodes it
      const ax = -Math.sin(p.rot);
      const az = Math.cos(p.rot);
      const ex = p.x - ax * 1.15;
      const ez = p.z - az * 1.15;
      mb.box('vc', Math.min(p.x, ex) - 0.03, 5.45, Math.min(p.z, ez) - 0.03, Math.max(p.x, ex) + 0.03, 5.52, Math.max(p.z, ez) + 0.03, 63, 0x3a3a3e);
      mb.box('vc', ex - 0.22, 5.3, ez - 0.22, ex + 0.22, 5.48, ez + 0.22, 63, 0x2a2a2c);
      break;
    }
    case 'lamppost':
      mb.cyl(p.x, 0, p.z, 0.08, p.h - 0.4, 0x1e1e20, 8, 0.05);
      mb.box('vc', p.x - 0.18, p.h - 0.45, p.z - 0.18, p.x + 0.18, p.h - 0.05, p.z + 0.18, 63, 0x1a1a1a);
      mb.box('vc', p.x - 0.22, p.h - 0.05, p.z - 0.22, p.x + 0.22, p.h + 0.02, p.z + 0.22, 63, 0x1a1a1a);
      break;
    case 'powerpole': {
      mb.cyl(p.x, 0, p.z, 0.13, p.h, 0x4a3a2a, 7, 0.1);
      const along = Math.abs(Math.sin(p.rot)) > 0.5;
      if (along) mb.box('vc', p.x - 0.08, p.h - 0.6, p.z - 0.9, p.x + 0.08, p.h - 0.45, p.z + 0.9, 63, 0x4a3a2a);
      else mb.box('vc', p.x - 0.9, p.h - 0.6, p.z - 0.08, p.x + 0.9, p.h - 0.45, p.z + 0.08, 63, 0x4a3a2a);
      break;
    }
    case 'headstone':
      B(-0.32 * p.s, 0, -0.08, 0.32 * p.s, 0.75 * p.s, 0.08, p.color);
      B(-0.25 * p.s, 0.75 * p.s, -0.08, 0.25 * p.s, 0.85 * p.s, 0.08, p.color);
      B(-0.4 * p.s, 0, -0.12, 0.4 * p.s, 0.08, 0.5, 0x5a5a50);
      break;
    case 'cross':
      B(-0.06, 0, -0.06, 0.06, 1.3 * p.s, 0.06, p.color);
      B(-0.35, 0.85 * p.s, -0.06, 0.35, 0.97 * p.s, 0.06, p.color);
      break;
    case 'dumpster':
      B(-0.95, 0.15, -0.55, 0.95, 1.2, 0.55, p.color);
      B(-0.98, 1.2, -0.58, 0.98, 1.28, 0.4, shadeHex(p.color, 0.8));
      B(-0.9, 0, -0.5, -0.8, 0.15, -0.4, 0x222222);
      B(0.8, 0, 0.4, 0.9, 0.15, 0.5, 0x222222);
      break;
    case 'phonebooth':
      B(-0.5, 0, -0.5, 0.5, 0.15, 0.5, 0x6a6a6a);
      B(-0.5, 0, -0.5, -0.44, 2.2, 0.5, 0x8a1a1a);
      B(0.44, 0, -0.5, 0.5, 2.2, 0.5, 0x8a1a1a);
      B(-0.5, 0, -0.5, 0.5, 2.2, -0.44, 0x8a1a1a);
      B(-0.52, 2.2, -0.52, 0.52, 2.35, 0.52, 0x8a1a1a);
      B(-0.15, 1.1, -0.44, 0.15, 1.5, -0.38, 0x1a1a1a);
      break;
    case 'busstop':
      B(-1.6, 0, 0.3, -1.52, 2.4, 0.38, 0x5a5a5e);
      B(1.52, 0, 0.3, 1.6, 2.4, 0.38, 0x5a5a5e);
      B(-1.7, 2.4, -0.4, 1.7, 2.5, 0.5, 0x3a4a5a);
      B(-1.55, 0.6, 0.32, 1.55, 2.2, 0.36, 0x6a7a8a);
      B(-1.2, 0.42, -0.1, 1.2, 0.48, 0.3, 0x6a4a32);
      B(-1.6, 0, -0.3, -1.54, 2.6, -0.24, 0x3a3a3e);
      B(-1.7, 2.6, -0.3, -1.35, 2.9, -0.24, 0x2a6a3a);
      break;
    case 'barrier':
      B(-0.05, 0, -0.8, 0.05, 0.9, -0.7, 0x8a8a8a);
      B(-0.05, 0, 0.7, 0.05, 0.9, 0.8, 0x8a8a8a);
      for (let k = 0; k < 6; k++) B(-0.04, 0.75, -0.9 + k * 0.3, 0.04, 1.0, -0.6 + k * 0.3, k % 2 ? 0xe8e8e0 : 0xd84a1a);
      break;
    case 'sign': {
      const b = world.buildings.find((bb) => Math.hypot(bb.outsideFront.x - p.x, bb.outsideFront.z - p.z) < 2.5 && bb.kind !== 'house');
      const name = b ? b.name.toUpperCase() : 'OPEN';
      const len = Math.min(5.5, Math.max(2.5, name.length * 0.22));
      const tx = signTexture(name, 0x1a1414, p.color);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.6), new THREE.MeshBasicMaterial({ map: tx, color: 0x777777, toneMapped: false }));
      m.position.set(p.x, p.h, p.z);
      m.rotation.y = p.rot + Math.PI;
      m.userData.baseColor = 0x777777;
      group.add(m);
      signs.push(m);
      B(-len / 2 - 0.05, p.h - 0.35, -0.08, len / 2 + 0.05, p.h + 0.35, -0.02, 0x2a2a2a);
      break;
    }
    case 'sign_deadend':
    case 'sign_roadclosed': {
      mb.cyl(p.x, 0, p.z, 0.04, 2.0, 0x8a8a8a, 6);
      const col = p.kind === 'sign_deadend' ? 0xd8b830 : 0xe86a1a;
      mb.box('vc', p.x - 0.35, 1.6, p.z - 0.03, p.x + 0.35, 2.2, p.z + 0.03, 63, col);
      mb.box('vc', p.x - 0.03, 1.6, p.z - 0.35, p.x + 0.03, 2.2, p.z + 0.35, 63, col);
      break;
    }
    case 'watertower': {
      for (const [ox, oz] of [
        [-2.5, -2.5],
        [2.5, -2.5],
        [-2.5, 2.5],
        [2.5, 2.5],
      ])
        mb.box('vc', p.x + ox - 0.15, 0, p.z + oz - 0.15, p.x + ox + 0.15, 15, p.z + oz + 0.15, 63, 0x5a5a5a);
      mb.box('vc', p.x - 2.6, 7, p.z - 0.05, p.x + 2.6, 7.2, p.z + 0.05, 63, 0x5a5a5a);
      mb.box('vc', p.x - 0.05, 7, p.z - 2.6, p.x + 0.05, 7.2, p.z + 2.6, 63, 0x5a5a5a);
      mb.cyl(p.x, 15, p.z, 4, 5, 0x8a8a84, 14);
      mb.cyl(p.x, 20, p.z, 4.2, 2.2, 0x6a6a64, 14, 0.2);
      break;
    }
    case 'radiomast':
      mb.box('vc', p.x - 0.4, 0, p.z - 0.4, p.x + 0.4, p.h, p.z + 0.4, 63, 0x2a2a2a);
      break;
    case 'swingset':
      B(-1.4, 0, -0.05, -1.3, 2.4, 0.05, 0x7a2a2a);
      B(1.3, 0, -0.05, 1.4, 2.4, 0.05, 0x7a2a2a);
      B(-1.4, 2.3, -0.06, 1.4, 2.4, 0.06, 0x7a2a2a);
      for (const x of [-0.65, 0.65]) {
        B(x - 0.25, 0.45, -0.12, x + 0.25, 0.5, 0.12, 0x2a2a2a);
        B(x - 0.22, 0.5, -0.01, x - 0.2, 2.3, 0.01, 0x9a9a9a);
        B(x + 0.2, 0.5, -0.01, x + 0.22, 2.3, 0.01, 0x9a9a9a);
      }
      break;
    case 'slide':
      B(-0.4, 0, -1.5, 0.4, 2.0, -1.0, 0x3a5a8a);
      for (let k = 0; k < 8; k++) B(-0.35, 0.25 * k, -1 + k * 0.28, 0.35, 0.25 * k + 0.08, -0.7 + k * 0.28, 0xc8a030);
      break;
    case 'sandbox':
      mb.box('vc', p.x - 1.5, 0, p.z - 1.5, p.x + 1.5, 0.25, p.z - 1.4, 63, 0x6a4a2a);
      mb.box('vc', p.x - 1.5, 0, p.z + 1.4, p.x + 1.5, 0.25, p.z + 1.5, 63, 0x6a4a2a);
      mb.box('vc', p.x - 1.5, 0, p.z - 1.5, p.x - 1.4, 0.25, p.z + 1.5, 63, 0x6a4a2a);
      mb.box('vc', p.x + 1.4, 0, p.z - 1.5, p.x + 1.5, 0.25, p.z + 1.5, 63, 0x6a4a2a);
      mb.hquad('vc', p.x - 1.4, p.z - 1.4, p.x + 1.4, p.z + 1.4, 0.15, true, 0xc8b08a);
      break;
    case 'gazebo': {
      mb.cyl(p.x, 0, p.z, 3.4, 0.3, 0xd8d0c0, 8);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
        mb.cyl(p.x + Math.cos(a) * 3.1, 0.3, p.z + Math.sin(a) * 3.1, 0.09, 2.6, 0xe8e4dc, 6);
      }
      mb.cyl(p.x, 2.9, p.z, 3.8, 0.2, 0xe8e4dc, 8);
      mb.cyl(p.x, 3.1, p.z, 3.8, 1.6, 0x4a3a3a, 8, 0.15);
      break;
    }
    case 'pond':
      break;
    case 'tire':
      mb.cyl(p.x, 0, p.z, 0.4, 0.25, 0x1a1a1a, 10);
      break;
    case 'junk':
      mb.cbox(p.x, 0, p.z, 0.8, 0.5, 0.6, 0x6a5a4a);
      mb.cbox(p.x + 0.2, 0.5, p.z - 0.1, 0.4, 0.3, 0.4, 0x5a4a3a);
      break;
    case 'woodpile':
      for (let k = 0; k < 3; k++) B(-0.8, k * 0.22, -0.3 + k * 0.05, 0.8, k * 0.22 + 0.22, 0.3 - k * 0.05, 0x6a4a2a);
      break;
    case 'laundry':
      B(-1.6, 0, -0.04, -1.52, 1.9, 0.04, 0x6a6a6a);
      B(1.52, 0, -0.04, 1.6, 1.9, 0.04, 0x6a6a6a);
      B(-1.6, 1.82, -0.01, 1.6, 1.84, 0.01, 0xd0d0d0);
      for (let k = 0; k < 4; k++) B(-1.2 + k * 0.7, 1.1 + rng.range(0, 0.2), -0.01, -0.8 + k * 0.7, 1.82, 0.01, rng.pick([0xe8e4dc, 0x8a3a3a, 0x3a5a8a, 0xc8c0a0]));
      break;
    case 'gnome':
      mb.cyl(p.x, 0, p.z, 0.12, 0.25, 0x3a5a8a, 6);
      mb.cyl(p.x, 0.25, p.z, 0.1, 0.12, 0xe8c8a8, 6);
      mb.cyl(p.x, 0.37, p.z, 0.11, 0.22, 0xb02020, 6, 0);
      break;
    case 'picnic':
      B(-0.9, 0.72, -0.4, 0.9, 0.77, 0.4, 0x7a5a3a);
      B(-0.9, 0.42, -0.75, 0.9, 0.46, -0.5, 0x7a5a3a);
      B(-0.9, 0.42, 0.5, 0.9, 0.46, 0.75, 0x7a5a3a);
      B(-0.7, 0, -0.05, -0.6, 0.72, 0.05, 0x5a3a2a);
      B(0.6, 0, -0.05, 0.7, 0.72, 0.05, 0x5a3a2a);
      break;
    case 'grill':
      mb.cyl(p.x, 0, p.z, 0.04, 0.7, 0x2a2a2a, 5);
      mb.cyl(p.x, 0.7, p.z, 0.3, 0.3, 0x1a1a1a, 10, 0.25);
      break;
    case 'bench':
      B(-0.8, 0.42, -0.25, 0.8, 0.48, 0.2, 0x6a4a32);
      B(-0.8, 0.5, 0.2, 0.8, 0.9, 0.25, 0x6a4a32);
      B(-0.75, 0, -0.2, -0.68, 0.48, 0.2, 0x2a2a2a);
      B(0.68, 0, -0.2, 0.75, 0.48, 0.2, 0x2a2a2a);
      break;
    case 'tent': {
      const s = 1.0;
      const hgt = 1.3;
      const along = Math.abs(Math.sin(p.rot)) > 0.5;
      const q = (pts: number[][]) =>
        mb.quad('vc', pts, [0, 1, 0], [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ], 0x4a5a3a);
      if (along) {
        q([
          [p.x - s, 0, p.z - s],
          [p.x - s, hgt, p.z],
          [p.x + s, hgt, p.z],
          [p.x + s, 0, p.z - s],
        ]);
        q([
          [p.x + s, 0, p.z + s],
          [p.x + s, hgt, p.z],
          [p.x - s, hgt, p.z],
          [p.x - s, 0, p.z + s],
        ]);
      } else {
        q([
          [p.x - s, 0, p.z + s],
          [p.x, hgt, p.z + s],
          [p.x, hgt, p.z - s],
          [p.x - s, 0, p.z - s],
        ]);
        q([
          [p.x + s, 0, p.z - s],
          [p.x, hgt, p.z - s],
          [p.x, hgt, p.z + s],
          [p.x + s, 0, p.z + s],
        ]);
      }
      break;
    }
    case 'campfire':
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2;
        mb.cbox(p.x + Math.cos(a) * 0.45, 0, p.z + Math.sin(a) * 0.45, 0.2, 0.15, 0.2, 0x5a5a56);
      }
      mb.cbox(p.x, 0, p.z, 0.5, 0.06, 0.5, 0x1a1a1a);
      break;
    case 'collider':
    case 'removed':
      break;
    default:
      if (p.kind.endsWith('_removed')) break;
      if (p.kind.startsWith('fence') || p.kind === 'hedge') buildFence(cb, p);
  }
}

function buildFence(cb: ChunkedBuilder, p: Prop) {
  const mb = cb.at(p.x, p.z);
  const alongX = Math.abs(Math.sin(p.rot)) < 0.5;
  const L = p.s;
  const h = p.h;
  const a = -L / 2;
  const seg = (t0: number, t1: number, y0: number, y1: number, th: number, key: string, color?: number) => {
    if (alongX) mb.box(key, p.x + t0, y0, p.z - th, p.x + t1, y1, p.z + th, 63, color);
    else mb.box(key, p.x - th, y0, p.z + t0, p.x + th, y1, p.z + t1, 63, color);
  };
  switch (p.kind) {
    case 'hedge':
      seg(a, -a, 0, h, 0.42, 'hedge');
      break;
    case 'fence_picket':
    case 'fence_picket_broken': {
      const broken = p.kind.endsWith('broken');
      for (let t = a; t <= -a + 1e-3; t += 2) seg(t - 0.05, t + 0.05, 0, h + 0.05, 0.05, 'vc', p.color);
      seg(a, -a, h * 0.3, h * 0.38, 0.03, 'vc', p.color);
      seg(a, -a, h * 0.7, h * 0.78, 0.03, 'vc', p.color);
      let k = 0;
      for (let t = a + 0.1; t < -a - 0.05; t += 0.22) {
        k++;
        if (broken && (k * 7) % 5 === 0) continue;
        seg(t - 0.045, t + 0.045, 0.05, h - ((k * 13) % 3 === 0 && broken ? 0.4 : 0), 0.02, 'vc', p.color);
      }
      break;
    }
    case 'fence_wood':
    case 'fence_wood_broken': {
      for (let t = a; t <= -a + 1e-3; t += 2.4) seg(t - 0.06, t + 0.06, 0, h, 0.06, 'vc', 0x4a3a2a);
      if (p.kind === 'fence_wood_broken') {
        for (let t = a; t < -a - 0.3; t += 1.2) if (Math.floor(t * 3) % 4 !== 0) seg(t, Math.min(-a, t + 1.15), 0.05, h - 0.1 - (Math.floor(t) % 3) * 0.3, 0.025, 'planks_shed');
      } else seg(a, -a, 0.05, h - 0.05, 0.025, 'planks_shed');
      break;
    }
    case 'fence_chain':
      for (let t = a; t <= -a + 1e-3; t += 2.5) seg(t - 0.03, t + 0.03, 0, h, 0.03, 'vc', 0x8a8a8a);
      seg(a, -a, h - 0.05, h, 0.025, 'vc', 0x8a8a8a);
      seg(a, -a, 0.02, h - 0.05, 0.004, 'chain');
      break;
    case 'fence_iron':
      for (let t = a; t <= -a + 1e-3; t += 0.14) seg(t - 0.012, t + 0.012, 0, h + ((Math.round(t / 0.14) % 2) ? 0.08 : 0), 0.012, 'vc', p.color);
      seg(a, -a, 0.15, 0.2, 0.02, 'vc', p.color);
      seg(a, -a, h - 0.15, h - 0.1, 0.02, 'vc', p.color);
      break;
  }
}

// ---------------------------------------------------------------------------
// vegetation (instanced)

function colorize(g: THREE.BufferGeometry, color: number, jitter = 0, rng?: Rng) {
  const n = g.attributes.position.count;
  const cols = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    c.setHex(color, THREE.SRGBColorSpace);
    if (jitter && rng) c.offsetHSL(0, 0, rng.range(-jitter, jitter));
    cols[i * 3] = c.r;
    cols[i * 3 + 1] = c.g;
    cols[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return g;
}

function prepare(g: THREE.BufferGeometry) {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('uv');
  if (!ng.attributes.normal) ng.computeVertexNormals();
  return ng;
}

function treeGeometry(kind: string): THREE.BufferGeometry {
  const rng = new Rng(kind);
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, color: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, jitter = 0.04) => {
    g.scale(sx, sy, sz);
    g.translate(x, y, z);
    parts.push(colorize(prepare(g), color, jitter, rng));
  };
  const seed = rng.range(0, 100);
  const blob = (r: number, detail = 1) => {
    const g = new THREE.IcosahedronGeometry(r, detail);
    const pos = g.attributes.position;
    // displacement is a function of the vertex direction so duplicated vertices stay welded
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const f = 1 + 0.13 * Math.sin(x * 3.1 + seed) * Math.cos(z * 2.7 - seed) + 0.06 * Math.sin(y * 4.3 + seed * 2);
      pos.setXYZ(i, x * f, y * f, z * f);
    }
    return g;
  };
  switch (kind) {
    case 'tree_pine': {
      add(new THREE.CylinderGeometry(0.12, 0.2, 2.2, 6), 0x3a2a1e, 0, 1.1, 0);
      for (let k = 0; k < 4; k++) add(new THREE.ConeGeometry(2.0 - k * 0.42, 2.6, 8), k % 2 ? 0x1c3324 : 0x223b2a, 0, 2.2 + k * 1.35, 0);
      break;
    }
    case 'tree_dead': {
      add(new THREE.CylinderGeometry(0.1, 0.26, 5.5, 6), 0x3a342e, 0, 2.75, 0);
      for (let k = 0; k < 5; k++) {
        const g = new THREE.CylinderGeometry(0.03, 0.08, 2.2, 4);
        g.rotateZ(rng.range(0.6, 1.1) * (k % 2 ? 1 : -1));
        g.rotateY(rng.range(0, 6.28));
        add(g, 0x3a342e, 0, 2.6 + k * 0.6, 0);
      }
      break;
    }
    case 'tree_birch': {
      add(new THREE.CylinderGeometry(0.1, 0.16, 4.5, 6), 0xd8d4c8, 0, 2.25, 0);
      add(blob(1.3), 0xc8a030, 0.2, 4.6, 0, 1, 1.3, 1);
      add(blob(0.9), 0xb88a28, -0.5, 4.0, 0.3);
      break;
    }
    case 'tree_maple': {
      add(new THREE.CylinderGeometry(0.16, 0.26, 3.2, 6), 0x3e2e22, 0, 1.6, 0);
      add(blob(1.9), 0x9a3218, 0, 4.4, 0, 1.1, 0.95, 1.1);
      add(blob(1.3), 0xb04a1c, 0.9, 3.6, 0.5);
      add(blob(1.2), 0x8a2a14, -0.8, 3.8, -0.4);
      break;
    }
    default: {
      add(new THREE.CylinderGeometry(0.18, 0.3, 3.2, 6), 0x3e2e22, 0, 1.6, 0);
      add(blob(2.1), 0x7a5a24, 0, 4.6, 0, 1.15, 0.9, 1.15);
      add(blob(1.4), 0x6a4a1c, 1.1, 3.8, 0.4);
      add(blob(1.3), 0x8a6a2a, -0.9, 4.1, -0.5);
    }
  }
  return mergeGeometries(parts)!;
}

function bushGeometry(): THREE.BufferGeometry {
  const rng = new Rng('bush');
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) {
    const g = new THREE.IcosahedronGeometry(0.6 - k * 0.1, 1);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const f = 1 + 0.12 * Math.sin(x * 7 + k) * Math.cos(z * 6 - k);
      pos.setXYZ(i, x * f, pos.getY(i) * f, z * f);
    }
    g.translate(rng.range(-0.3, 0.3), 0.5 + rng.range(-0.1, 0.1), rng.range(-0.3, 0.3));
    parts.push(colorize(prepare(g), 0x9a9a9a, 0.06, rng));
  }
  return mergeGeometries(parts)!;
}

function buildVegetation(world: WorldData, group: THREE.Group) {
  const byKind = new Map<string, Prop[]>();
  for (const p of world.props) {
    if (!(p.kind.startsWith('tree') || p.kind === 'bush')) continue;
    if (!byKind.has(p.kind)) byKind.set(p.kind, []);
    byKind.get(p.kind)!.push(p);
  }
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  const rng = new Rng('veg');
  // split instanced meshes into spatial chunks for culling
  const CH = 64;
  for (const [kind, props] of byKind) {
    const geom = kind === 'bush' ? bushGeometry() : treeGeometry(kind);
    const chunks = new Map<string, Prop[]>();
    for (const p of props) {
      const key = `${Math.floor(p.x / CH)},${Math.floor(p.z / CH)}`;
      if (!chunks.has(key)) chunks.set(key, []);
      chunks.get(key)!.push(p);
    }
    for (const list of chunks.values()) {
      const im = new THREE.InstancedMesh(geom, mat, list.length);
      list.forEach((p, i) => {
        q.setFromAxisAngle(up, p.rot);
        m4.compose(new THREE.Vector3(p.x, kind === 'bush' ? -0.1 : 0, p.z), q, new THREE.Vector3(p.s, p.s * (kind === 'bush' ? 1 : rng.range(0.9, 1.1)), p.s));
        im.setMatrixAt(i, m4);
        if (kind === 'bush') col.setHex(p.color);
        else col.setRGB(1, 1, 1).offsetHSL(rng.range(-0.02, 0.02), 0, rng.range(-0.08, 0.06));
        im.setColorAt(i, col);
      });
      im.castShadow = true;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      im.frustumCulled = true;
      group.add(im);
    }
  }
}

// ---------------------------------------------------------------------------

export function buildWorldMeshes(world: WorldData): WorldMeshes {
  const group = new THREE.Group();
  group.name = 'world';
  const signs: THREE.Mesh[] = [];
  const water: THREE.Mesh[] = [];
  const rng = new Rng('render');
  // ground
  const ground = new ChunkedBuilder(64);
  for (const g of world.ground) {
    const r = g.rect;
    if (g.kind === 'sidewalk') {
      const mbs = ground.at((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2);
      mbs.box(['curb', 'curb', 'g_concrete', 'curb', 'curb', 'curb'], r.x0, -0.05, r.z0, r.x1, 0.1, r.z1, FACES.ALL & ~FACES.NY);
      continue;
    }
    if (g.kind === 'porch' || g.kind === 'porch_old') {
      ground.at(r.x0, r.z0).box(['g_wood', 'g_wood', 'g_wood', 'g_wood', 'g_wood', 'g_wood'], r.x0, -0.05, r.z0, r.x1, 0.12, r.z1, FACES.ALL & ~FACES.NY);
      continue;
    }
    const y = GROUND_Y[g.kind] ?? 0.01;
    const key = groundMat(g.kind, g.surface);
    // split large patches so that chunks cull
    const step = 64;
    for (let x = r.x0; x < r.x1; x += step)
      for (let z = r.z0; z < r.z1; z += step) {
        const x1 = Math.min(r.x1, x + step);
        const z1 = Math.min(r.z1, z + step);
        ground.at((x + x1) / 2, (z + z1) / 2).hquad(key, x, z, x1, z1, y);
      }
  }
  // dead-end turning circles
  for (const m of ground.toMeshes(false, true)) group.add(m);

  const cb = new ChunkedBuilder(48);
  for (const b of world.buildings) buildBuildingGeometry(cb, world, b, rng);
  for (const p of world.props) {
    if (p.kind.startsWith('tree') || p.kind === 'bush') continue;
    buildProp(cb, p, rng, signs, world, group);
  }
  for (const m of cb.toMeshes(true, true)) group.add(m);
  buildVegetation(world, group);
  // ponds
  for (const p of world.props) {
    if (p.kind !== 'pond') continue;
    const wm = new THREE.Mesh(
      new THREE.CircleGeometry(p.s, 32),
      new THREE.MeshStandardMaterial({ color: 0x0c1418, roughness: 0.08, metalness: 0.3 }),
    );
    wm.rotation.x = -Math.PI / 2;
    wm.position.set(p.x, 0.03, p.z);
    wm.receiveShadow = true;
    group.add(wm);
    water.push(wm);
    const rim = new THREE.Mesh(new THREE.RingGeometry(p.s, p.s + 0.6, 32), new THREE.MeshLambertMaterial({ map: tex('gravel'), color: 0x8a8478 }));
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(p.x, 0.035, p.z);
    group.add(rim);
  }
  return { group, signs, water };
}
