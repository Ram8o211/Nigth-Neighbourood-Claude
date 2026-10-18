import * as THREE from 'three';
import { material, texScale } from './materials';

interface Bucket {
  pos: number[];
  nor: number[];
  uv: number[];
  col: number[] | null;
  idx: number[];
}

const FACE_PX = 1;
const FACE_NX = 2;
const FACE_PY = 4;
const FACE_NY = 8;
const FACE_PZ = 16;
const FACE_NZ = 32;
export const FACES = { PX: FACE_PX, NX: FACE_NX, PY: FACE_PY, NY: FACE_NY, PZ: FACE_PZ, NZ: FACE_NZ, ALL: 63 };

/**
 * Accumulates quads and boxes into per-material buckets with world-space UVs,
 * then emits merged BufferGeometries (one draw call per material).
 */
export class MeshBuilder {
  buckets = new Map<string, Bucket>();
  private color = new THREE.Color();

  private bucket(key: string): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = { pos: [], nor: [], uv: [], col: key === 'vc' ? [] : null, idx: [] };
      this.buckets.set(key, b);
    }
    return b;
  }

  /** quad from 4 corners in CCW order (as seen from the normal side) */
  quad(key: string, p: number[][], n: number[], uv: number[][], color?: number) {
    const b = this.bucket(key);
    const base = b.pos.length / 3;
    for (let i = 0; i < 4; i++) {
      b.pos.push(p[i][0], p[i][1], p[i][2]);
      b.nor.push(n[0], n[1], n[2]);
      b.uv.push(uv[i][0], uv[i][1]);
    }
    if (b.col) {
      this.color.setHex(color ?? 0xffffff, THREE.SRGBColorSpace);
      for (let i = 0; i < 4; i++) b.col.push(this.color.r, this.color.g, this.color.b);
    }
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  tri(key: string, p: number[][], n: number[], uv: number[][], color?: number) {
    const b = this.bucket(key);
    const base = b.pos.length / 3;
    for (let i = 0; i < 3; i++) {
      b.pos.push(p[i][0], p[i][1], p[i][2]);
      b.nor.push(n[0], n[1], n[2]);
      b.uv.push(uv[i][0], uv[i][1]);
    }
    if (b.col) {
      this.color.setHex(color ?? 0xffffff, THREE.SRGBColorSpace);
      for (let i = 0; i < 3; i++) b.col.push(this.color.r, this.color.g, this.color.b);
    }
    b.idx.push(base, base + 1, base + 2);
  }

  /** horizontal rectangle at height y facing up (or down) */
  hquad(key: string, x0: number, z0: number, x1: number, z1: number, y: number, up = true, color?: number) {
    const s = key === 'vc' ? 1 : texScale(key);
    const uv = [
      [x0 / s, z0 / s],
      [x0 / s, z1 / s],
      [x1 / s, z1 / s],
      [x1 / s, z0 / s],
    ];
    if (up)
      this.quad(
        key,
        [
          [x0, y, z0],
          [x0, y, z1],
          [x1, y, z1],
          [x1, y, z0],
        ],
        [0, 1, 0],
        uv,
        color,
      );
    else
      this.quad(
        key,
        [
          [x0, y, z0],
          [x1, y, z0],
          [x1, y, z1],
          [x0, y, z1],
        ],
        [0, -1, 0],
        [uv[0], uv[3], uv[2], uv[1]],
        color,
      );
  }

  /**
   * Axis aligned box. `keys` may be a single material or per-face keys
   * [px, nx, py, ny, pz, nz]. `faces` is a bitmask of faces to emit.
   */
  box(keys: string | string[], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, faces = 63, color?: number) {
    const k = (i: number) => (typeof keys === 'string' ? keys : keys[i]);
    const sc = (i: number) => (k(i) === 'vc' ? 1 : texScale(k(i)));
    if (faces & FACE_PX) {
      const s = sc(0);
      this.quad(
        k(0),
        [
          [x1, y0, z1],
          [x1, y0, z0],
          [x1, y1, z0],
          [x1, y1, z1],
        ],
        [1, 0, 0],
        [
          [-z1 / s, y0 / s],
          [-z0 / s, y0 / s],
          [-z0 / s, y1 / s],
          [-z1 / s, y1 / s],
        ],
        color,
      );
    }
    if (faces & FACE_NX) {
      const s = sc(1);
      this.quad(
        k(1),
        [
          [x0, y0, z0],
          [x0, y0, z1],
          [x0, y1, z1],
          [x0, y1, z0],
        ],
        [-1, 0, 0],
        [
          [z0 / s, y0 / s],
          [z1 / s, y0 / s],
          [z1 / s, y1 / s],
          [z0 / s, y1 / s],
        ],
        color,
      );
    }
    if (faces & FACE_PY) {
      const s = sc(2);
      this.quad(
        k(2),
        [
          [x0, y1, z0],
          [x0, y1, z1],
          [x1, y1, z1],
          [x1, y1, z0],
        ],
        [0, 1, 0],
        [
          [x0 / s, z0 / s],
          [x0 / s, z1 / s],
          [x1 / s, z1 / s],
          [x1 / s, z0 / s],
        ],
        color,
      );
    }
    if (faces & FACE_NY) {
      const s = sc(3);
      this.quad(
        k(3),
        [
          [x0, y0, z0],
          [x1, y0, z0],
          [x1, y0, z1],
          [x0, y0, z1],
        ],
        [0, -1, 0],
        [
          [x0 / s, z0 / s],
          [x1 / s, z0 / s],
          [x1 / s, z1 / s],
          [x0 / s, z1 / s],
        ],
        color,
      );
    }
    if (faces & FACE_PZ) {
      const s = sc(4);
      this.quad(
        k(4),
        [
          [x0, y0, z1],
          [x1, y0, z1],
          [x1, y1, z1],
          [x0, y1, z1],
        ],
        [0, 0, 1],
        [
          [x0 / s, y0 / s],
          [x1 / s, y0 / s],
          [x1 / s, y1 / s],
          [x0 / s, y1 / s],
        ],
        color,
      );
    }
    if (faces & FACE_NZ) {
      const s = sc(5);
      this.quad(
        k(5),
        [
          [x1, y0, z0],
          [x0, y0, z0],
          [x0, y1, z0],
          [x1, y1, z0],
        ],
        [0, 0, -1],
        [
          [-x1 / s, y0 / s],
          [-x0 / s, y0 / s],
          [-x0 / s, y1 / s],
          [-x1 / s, y1 / s],
        ],
        color,
      );
    }
  }

  /** vertex coloured box centred at (cx, cz) */
  cbox(cx: number, y0: number, cz: number, w: number, h: number, d: number, color: number) {
    this.box('vc', cx - w / 2, y0, cz - d / 2, cx + w / 2, y0 + h, cz + d / 2, 63, color);
  }

  /** vertical cylinder approximation (n sides), vertex coloured */
  cyl(cx: number, y0: number, cz: number, r: number, h: number, color: number, n = 8, rTop?: number) {
    const rt = rTop ?? r;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const am = (a0 + a1) / 2;
      this.quad(
        'vc',
        [
          [cx + Math.cos(a0) * r, y0, cz + Math.sin(a0) * r],
          [cx + Math.cos(a1) * r, y0, cz + Math.sin(a1) * r],
          [cx + Math.cos(a1) * rt, y0 + h, cz + Math.sin(a1) * rt],
          [cx + Math.cos(a0) * rt, y0 + h, cz + Math.sin(a0) * rt],
        ].reverse(),
        [Math.cos(am), 0, Math.sin(am)],
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        color,
      );
    }
    if (rt > 0.001)
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2;
        const a1 = ((i + 1) / n) * Math.PI * 2;
        this.tri(
          'vc',
          [
            [cx, y0 + h, cz],
            [cx + Math.cos(a1) * rt, y0 + h, cz + Math.sin(a1) * rt],
            [cx + Math.cos(a0) * rt, y0 + h, cz + Math.sin(a0) * rt],
          ],
          [0, 1, 0],
          [
            [0, 0],
            [1, 0],
            [0, 1],
          ],
          color,
        );
      }
  }

  build(): { key: string; geom: THREE.BufferGeometry }[] {
    const out: { key: string; geom: THREE.BufferGeometry }[] = [];
    for (const [key, b] of this.buckets) {
      if (!b.idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      if (b.col) g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
      const n = b.pos.length / 3;
      g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(b.idx, 1) : new THREE.Uint16BufferAttribute(b.idx, 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      out.push({ key, geom: g });
    }
    return out;
  }

  toMeshes(castShadow = true, receiveShadow = true): THREE.Mesh[] {
    return this.build().map(({ key, geom }) => {
      const m = new THREE.Mesh(geom, material(key));
      m.castShadow = castShadow;
      m.receiveShadow = receiveShadow;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      return m;
    });
  }
}

/** routes geometry into a grid of builders so meshes can be frustum culled */
export class ChunkedBuilder {
  chunks = new Map<string, MeshBuilder>();
  constructor(public size = 48) {}
  at(x: number, z: number): MeshBuilder {
    const key = `${Math.floor(x / this.size)},${Math.floor(z / this.size)}`;
    let b = this.chunks.get(key);
    if (!b) {
      b = new MeshBuilder();
      this.chunks.set(key, b);
    }
    return b;
  }
  toMeshes(castShadow = true, receiveShadow = true): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const b of this.chunks.values()) out.push(...b.toMeshes(castShadow, receiveShadow));
    return out;
  }
}
