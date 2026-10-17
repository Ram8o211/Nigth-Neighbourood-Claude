import type { Surface, WorldData } from './types';
import { wallPieces, wallRect } from './collision';
import { GROUND_Y } from './ground';

export const CELL = 0.5;
export const NAV_R = 0.25;

export const F_BLOCK = 1;
export const F_DOOR = 2;
export const F_WINDOW = 4;
export const F_INDOOR = 8;
export const F_SIGHT = 16;
export const F_WALL = 32;
export const F_ROAD = 64;
export const F_DARKPREF = 128;

export const SURFACES: Surface[] = ['grass', 'asphalt', 'concrete', 'dirt', 'gravel', 'wood', 'tile', 'carpet'];

/**
 * Multi-layer occupancy grid used for navigation, sight, hearing,
 * footstep surfaces and floor heights. Static layers are built once from
 * WorldData; doors and windows are dynamic and resolved through `ref`.
 */
export class WorldGrid {
  readonly w: number;
  readonly h: number;
  flags: Uint8Array;
  /** door id (F_DOOR) or window id (F_WINDOW) */
  ref: Int16Array;
  /** room id + 1, or 0 outdoors */
  zone: Int16Array;
  surface: Uint8Array;
  floorH: Uint8Array;
  /** building id + 1 for cells inside a building footprint */
  bld: Int16Array;

  constructor(public world: WorldData) {
    this.w = Math.ceil(world.width / CELL);
    this.h = Math.ceil(world.depth / CELL);
    const n = this.w * this.h;
    this.flags = new Uint8Array(n);
    this.ref = new Int16Array(n).fill(-1);
    this.zone = new Int16Array(n);
    this.surface = new Uint8Array(n);
    this.floorH = new Uint8Array(n);
    this.bld = new Int16Array(n);
    this.build();
  }

  idx(cx: number, cz: number) {
    return cz * this.w + cx;
  }
  cx(x: number) {
    return Math.max(0, Math.min(this.w - 1, Math.floor(x / CELL)));
  }
  cz(z: number) {
    return Math.max(0, Math.min(this.h - 1, Math.floor(z / CELL)));
  }
  cellAt(x: number, z: number) {
    return this.idx(this.cx(x), this.cz(z));
  }
  centreX(i: number) {
    return ((i % this.w) + 0.5) * CELL;
  }
  centreZ(i: number) {
    return (Math.floor(i / this.w) + 0.5) * CELL;
  }

  /** marks cells whose centre lies inside rect (expanded by m) */
  private fillCentres(x0: number, z0: number, x1: number, z1: number, m: number, fn: (i: number) => void) {
    const a = Math.max(0, Math.ceil((x0 - m) / CELL - 0.5));
    const b = Math.min(this.w - 1, Math.floor((x1 + m) / CELL - 0.5));
    const c = Math.max(0, Math.ceil((z0 - m) / CELL - 0.5));
    const d = Math.min(this.h - 1, Math.floor((z1 + m) / CELL - 0.5));
    for (let z = c; z <= d; z++) for (let x = a; x <= b; x++) fn(z * this.w + x);
  }

  /** marks every cell overlapping the rect */
  private fillOverlap(x0: number, z0: number, x1: number, z1: number, fn: (i: number) => void) {
    const a = Math.max(0, Math.floor(x0 / CELL));
    const b = Math.min(this.w - 1, Math.floor((x1 - 1e-6) / CELL));
    const c = Math.max(0, Math.floor(z0 / CELL));
    const d = Math.min(this.h - 1, Math.floor((z1 - 1e-6) / CELL));
    for (let z = c; z <= d; z++) for (let x = a; x <= b; x++) fn(z * this.w + x);
  }

  build() {
    const world = this.world;
    this.flags.fill(0);
    this.ref.fill(-1);
    this.zone.fill(0);
    this.surface.fill(0);
    this.floorH.fill(0);
    this.bld.fill(0);
    for (const g of world.ground) {
      const s = SURFACES.indexOf(g.surface);
      const h = g.kind === 'sidewalk' ? 10 : g.kind === 'porch' || g.kind === 'porch_old' ? 12 : Math.max(0, Math.round((GROUND_Y[g.kind] ?? 0) * 100));
      const road = g.surface === 'asphalt' || g.kind === 'sidewalk';
      this.fillCentres(g.rect.x0, g.rect.z0, g.rect.x1, g.rect.z1, 0, (i) => {
        this.surface[i] = s;
        this.floorH[i] = h;
        if (road) this.flags[i] |= F_ROAD;
        else this.flags[i] &= ~F_ROAD;
      });
    }
    for (const r of world.rooms) {
      const s = SURFACES.indexOf(r.floor);
      const fh = Math.round(world.buildings[r.buildingId].floorY * 100);
      this.fillCentres(r.rect.x0, r.rect.z0, r.rect.x1, r.rect.z1, 0, (i) => {
        this.zone[i] = r.id + 1;
        this.surface[i] = s;
        this.flags[i] |= F_INDOOR;
        this.flags[i] &= ~F_ROAD;
        this.floorH[i] = fh;
      });
    }
    for (const b of world.buildings)
      this.fillOverlap(b.rect.x0, b.rect.z0, b.rect.x1, b.rect.z1, (i) => {
        this.bld[i] = b.id + 1;
      });
    // walls
    for (const w of world.walls) {
      for (const p of wallPieces(w)) {
        const r = wallRect(w.axis, w.c, p.a, p.b, w.thickness);
        if (p.bottom < 0.5) this.fillCentres(r.x0, r.z0, r.x1, r.z1, NAV_R, (i) => (this.flags[i] |= F_BLOCK));
        if (p.bottom < 0.01 && p.top > 2) this.fillOverlap(r.x0, r.z0, r.x1, r.z1, (i) => (this.flags[i] |= F_SIGHT | F_WALL));
        else this.fillOverlap(r.x0, r.z0, r.x1, r.z1, (i) => (this.flags[i] |= F_WALL));
      }
    }
    // furniture and props
    for (const f of world.furniture) {
      if (!f.solid) continue;
      this.fillCentres(f.x - f.w / 2, f.z - f.d / 2, f.x + f.w / 2, f.z + f.d / 2, NAV_R, (i) => (this.flags[i] |= F_BLOCK));
      if (f.tall) this.fillCentres(f.x - f.w / 2, f.z - f.d / 2, f.x + f.w / 2, f.z + f.d / 2, 0, (i) => (this.flags[i] |= F_SIGHT));
    }
    for (const p of world.props) {
      if (!p.solid) continue;
      const r = p.solid;
      this.fillCentres(r.x0, r.z0, r.x1, r.z1, NAV_R, (i) => (this.flags[i] |= F_BLOCK));
      if (p.blocksSight) this.fillOverlap(r.x0, r.z0, r.x1, r.z1, (i) => (this.flags[i] |= F_SIGHT));
    }
    // carve door & window passages: one cell column through the wall
    for (const d of world.doors) this.carve(d.axis, d.c, d.t, F_DOOR, d.id);
    for (const w of world.windows) this.carve(w.axis, w.c, w.t, F_WINDOW, w.id);
  }

  private carve(axis: 'x' | 'z', c: number, t: number, flag: number, id: number) {
    for (const off of [-0.25, 0.25]) {
      const x = axis === 'x' ? t : c + off;
      const z = axis === 'x' ? c + off : t;
      const i = this.cellAt(x, z);
      this.flags[i] = (this.flags[i] & ~(F_BLOCK | F_SIGHT)) | flag | F_WALL;
      this.ref[i] = id;
    }
  }

  /** room id at a world position or -1 outdoors */
  roomAt(x: number, z: number): number {
    return this.zone[this.cellAt(x, z)] - 1;
  }

  buildingAt(x: number, z: number): number {
    return this.bld[this.cellAt(x, z)] - 1;
  }

  surfaceAt(x: number, z: number): Surface {
    return SURFACES[this.surface[this.cellAt(x, z)]];
  }

  heightAt(x: number, z: number): number {
    return this.floorH[this.cellAt(x, z)] / 100;
  }

  isIndoor(x: number, z: number) {
    return (this.flags[this.cellAt(x, z)] & F_INDOOR) !== 0;
  }

  /** line of sight through the grid (2D). Closed solid doors and boarded windows block. */
  los(ax: number, az: number, bx: number, bz: number): boolean {
    let blocked = false;
    this.walk(ax, az, bx, bz, (i) => {
      const f = this.flags[i];
      if (f & F_SIGHT) {
        blocked = true;
        return false;
      }
      if (f & F_DOOR) {
        const d = this.world.doors[this.ref[i]];
        if (!d.bars && !d.broken && d.open < 0.3) {
          blocked = true;
          return false;
        }
      } else if (f & F_WINDOW) {
        const w = this.world.windows[this.ref[i]];
        if (w.boarded) {
          blocked = true;
          return false;
        }
      }
      return true;
    });
    return !blocked;
  }

  /**
   * Sound transmission factor between two points in [0,1].
   * Each solid wall crossing costs a lot, closed doors less, glass the least.
   */
  soundOcclusion(ax: number, az: number, bx: number, bz: number): number {
    let factor = 1;
    let inWall = false;
    this.walk(ax, az, bx, bz, (i) => {
      const f = this.flags[i];
      if (f & F_WALL) {
        if (!inWall) {
          inWall = true;
          if (f & F_DOOR) {
            const d = this.world.doors[this.ref[i]];
            factor *= d.open > 0.3 || d.broken ? 0.95 : 0.5;
          } else if (f & F_WINDOW) {
            const w = this.world.windows[this.ref[i]];
            factor *= w.damage === 2 ? 0.95 : w.boarded ? 0.4 : 0.6;
          } else factor *= 0.3;
        }
      } else inWall = false;
      return factor > 0.01;
    });
    return factor;
  }

  /** visits grid cells along a segment (Amanatides-Woo DDA). Callback returns false to stop. */
  walk(ax: number, az: number, bx: number, bz: number, cb: (i: number) => boolean) {
    let x = Math.floor(ax / CELL);
    let z = Math.floor(az / CELL);
    const ex = Math.floor(bx / CELL);
    const ez = Math.floor(bz / CELL);
    const dx = bx - ax;
    const dz = bz - az;
    const sx = dx > 0 ? 1 : -1;
    const sz = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(CELL / dx) : Infinity;
    const tdz = dz !== 0 ? Math.abs(CELL / dz) : Infinity;
    let tmx = dx !== 0 ? ((sx > 0 ? (x + 1) * CELL - ax : ax - x * CELL) / Math.abs(dx)) : Infinity;
    let tmz = dz !== 0 ? ((sz > 0 ? (z + 1) * CELL - az : az - z * CELL) / Math.abs(dz)) : Infinity;
    let guard = 0;
    while (guard++ < 4000) {
      if (x < 0 || z < 0 || x >= this.w || z >= this.h) return;
      // skip the starting cell (the viewer may stand in a door cell)
      if (guard > 1 && !cb(z * this.w + x)) return;
      if (x === ex && z === ez) return;
      if (tmx < tmz) {
        tmx += tdx;
        x += sx;
      } else {
        tmz += tdz;
        z += sz;
      }
    }
  }
}
