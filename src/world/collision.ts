import type { Rect } from '../core/math';
import type { WorldData } from './types';
import { DOOR_W } from './gen/buildings';

export const enum CK {
  Wall = 0,
  Door = 1,
  Window = 2,
  Furniture = 3,
  Prop = 4,
}

/** a static or state-dependent axis aligned box collider */
export interface Collider {
  r: Rect;
  kind: CK;
  ref: number;
  /** blocks line of sight / melee */
  sight: boolean;
  /** height of the top of the collider */
  top: number;
  bottom: number;
}

const HASH = 2;

/** builds the wall pieces of a wall segment, splitting around its openings */
export function wallPieces(w: WorldData['walls'][number]) {
  const pieces: { a: number; b: number; bottom: number; top: number }[] = [];
  const a0 = w.a - w.extA;
  const b0 = w.b + w.extB;
  let t = a0;
  for (const o of w.openings) {
    if (o.t0 > t) pieces.push({ a: t, b: o.t0, bottom: 0, top: w.height });
    if (o.bottom > 0.01) pieces.push({ a: o.t0, b: o.t1, bottom: 0, top: o.bottom });
    if (o.top < w.height - 0.01) pieces.push({ a: o.t0, b: o.t1, bottom: o.top, top: w.height });
    t = Math.max(t, o.t1);
  }
  if (t < b0) pieces.push({ a: t, b: b0, bottom: 0, top: w.height });
  return pieces;
}

export function wallRect(axis: 'x' | 'z', c: number, a: number, b: number, th: number): Rect {
  return axis === 'x' ? { x0: a, z0: c - th / 2, x1: b, z1: c + th / 2 } : { x0: c - th / 2, z0: a, x1: c + th / 2, z1: b };
}

export function doorRect(d: WorldData['doors'][number]): Rect {
  return wallRect(d.axis, d.c, d.t - DOOR_W / 2, d.t + DOOR_W / 2, 0.12);
}

export function windowRect(w: WorldData['windows'][number]): Rect {
  return wallRect(w.axis, w.c, w.t - w.width / 2, w.t + w.width / 2, 0.14);
}

export class Colliders {
  list: Collider[] = [];
  private cells: number[][] = [];
  private cw: number;
  private ch: number;
  private stamp = 1;
  private marks: Uint32Array = new Uint32Array(0);

  constructor(
    private world: WorldData,
    width: number,
    depth: number,
  ) {
    this.cw = Math.ceil(width / HASH) + 1;
    this.ch = Math.ceil(depth / HASH) + 1;
    for (let i = 0; i < this.cw * this.ch; i++) this.cells.push([]);
  }

  add(c: Collider) {
    const id = this.list.length;
    this.list.push(c);
    const x0 = Math.max(0, Math.floor(c.r.x0 / HASH));
    const z0 = Math.max(0, Math.floor(c.r.z0 / HASH));
    const x1 = Math.min(this.cw - 1, Math.floor(c.r.x1 / HASH));
    const z1 = Math.min(this.ch - 1, Math.floor(c.r.z1 / HASH));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.cells[z * this.cw + x].push(id);
    if (this.marks.length < this.list.length) {
      const m = new Uint32Array(Math.max(1024, this.list.length * 2));
      m.set(this.marks);
      this.marks = m;
    }
  }

  /** is the collider currently blocking movement (doors/windows depend on state) */
  active(c: Collider): boolean {
    if (c.kind === CK.Door) {
      const d = this.world.doors[c.ref];
      return !d.broken && d.open < 0.45;
    }
    if (c.kind === CK.Furniture) return this.world.furniture[c.ref].solid;
    if (c.kind === CK.Prop) return this.world.props[c.ref].solid !== null;
    return true;
  }

  query(x0: number, z0: number, x1: number, z1: number, cb: (c: Collider, idx: number) => void) {
    const stamp = ++this.stamp;
    const cx0 = Math.max(0, Math.floor(x0 / HASH));
    const cz0 = Math.max(0, Math.floor(z0 / HASH));
    const cx1 = Math.min(this.cw - 1, Math.floor(x1 / HASH));
    const cz1 = Math.min(this.ch - 1, Math.floor(z1 / HASH));
    for (let z = cz0; z <= cz1; z++)
      for (let x = cx0; x <= cx1; x++) {
        const cell = this.cells[z * this.cw + x];
        for (let i = 0; i < cell.length; i++) {
          const id = cell[i];
          if (this.marks[id] === stamp) continue;
          this.marks[id] = stamp;
          const c = this.list[id];
          if (c.r.x1 < x0 || c.r.x0 > x1 || c.r.z1 < z0 || c.r.z0 > z1) continue;
          cb(c, id);
        }
      }
  }

  /**
   * Pushes a circle out of all active colliders. Returns true if a collision occurred.
   * `ignore` lets vaulting actors pass through a particular window.
   */
  resolveCircle(p: { x: number; z: number }, r: number, ignoreWindow = -1, lowObstacles = true): boolean {
    let hit = false;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      this.query(p.x - r, p.z - r, p.x + r, p.z + r, (c) => {
        if (!this.active(c)) return;
        if (c.kind === CK.Window && c.ref === ignoreWindow) return;
        if (!lowObstacles && c.top < 0.5) return;
        if (c.bottom > 1.9) return; // lintels overhead
        const cx = Math.max(c.r.x0, Math.min(p.x, c.r.x1));
        const cz = Math.max(c.r.z0, Math.min(p.z, c.r.z1));
        const dx = p.x - cx;
        const dz = p.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) return;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          const push = r - d;
          p.x += (dx / d) * push;
          p.z += (dz / d) * push;
        } else {
          // centre inside the box: push out along the smallest axis
          const l = p.x - c.r.x0;
          const rr = c.r.x1 - p.x;
          const t = p.z - c.r.z0;
          const b = c.r.z1 - p.z;
          const m = Math.min(l, rr, t, b);
          if (m === l) p.x = c.r.x0 - r;
          else if (m === rr) p.x = c.r.x1 + r;
          else if (m === t) p.z = c.r.z0 - r;
          else p.z = c.r.z1 + r;
        }
        moved = true;
        hit = true;
      });
      if (!moved) break;
    }
    return hit;
  }

  /** checks a 2D segment against sight-blocking colliders between heights; used for melee and throws */
  segmentBlocked(ax: number, az: number, bx: number, bz: number, height = 1.2): boolean {
    let blocked = false;
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    const z0 = Math.min(az, bz);
    const z1 = Math.max(az, bz);
    this.query(x0, z0, x1, z1, (c) => {
      if (blocked || !this.active(c)) return;
      if (height < c.bottom || height > c.top) return;
      if (c.kind === CK.Furniture || c.kind === CK.Prop) {
        if (c.top < height) return;
      }
      if (segRect(ax, az, bx, bz, c.r)) blocked = true;
    });
    return blocked;
  }

  /** first collider hit along a segment (for melee impacts on walls / windows) */
  firstHit(ax: number, az: number, bx: number, bz: number, height: number): { c: Collider; t: number } | null {
    let best: { c: Collider; t: number } | null = null;
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    const z0 = Math.min(az, bz);
    const z1 = Math.max(az, bz);
    this.query(x0, z0, x1, z1, (c) => {
      if (!this.active(c)) return;
      if (height < c.bottom || height > c.top) return;
      const t = segRectT(ax, az, bx, bz, c.r);
      if (t !== null && (!best || t < best.t)) best = { c, t };
    });
    return best;
  }
}

export function segRect(ax: number, az: number, bx: number, bz: number, r: Rect): boolean {
  return segRectT(ax, az, bx, bz, r) !== null;
}

/** slab test; returns entry parameter in [0,1] or null */
export function segRectT(ax: number, az: number, bx: number, bz: number, r: Rect): number | null {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dz = bz - az;
  const clip = (p: number, q: number) => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  if (!clip(-dx, ax - r.x0)) return null;
  if (!clip(dx, r.x1 - ax)) return null;
  if (!clip(-dz, az - r.z0)) return null;
  if (!clip(dz, r.z1 - az)) return null;
  return t0 <= t1 ? t0 : null;
}

export function buildColliders(world: WorldData): Colliders {
  const col = new Colliders(world, world.width, world.depth);
  for (const w of world.walls) {
    for (const p of wallPieces(w)) {
      if (p.b - p.a < 0.01) continue;
      col.add({ r: wallRect(w.axis, w.c, p.a, p.b, w.thickness), kind: CK.Wall, ref: w.id, sight: p.bottom < 0.01 && p.top > 2, top: p.top, bottom: p.bottom });
    }
  }
  for (const d of world.doors) col.add({ r: doorRect(d), kind: CK.Door, ref: d.id, sight: !d.bars, top: d.height, bottom: 0 });
  for (const w of world.windows) col.add({ r: windowRect(w), kind: CK.Window, ref: w.id, sight: false, top: w.top, bottom: w.sill });
  for (const f of world.furniture) {
    if (!f.solid) continue;
    col.add({ r: { x0: f.x - f.w / 2, z0: f.z - f.d / 2, x1: f.x + f.w / 2, z1: f.z + f.d / 2 }, kind: CK.Furniture, ref: f.id, sight: f.tall, top: f.h, bottom: 0 });
  }
  for (const p of world.props) {
    if (!p.solid) continue;
    col.add({ r: p.solid, kind: CK.Prop, ref: p.id, sight: p.blocksSight, top: Math.max(0.3, p.h), bottom: 0 });
  }
  return col;
}
