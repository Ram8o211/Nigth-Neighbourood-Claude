import type { Door, WindowState } from './types';
import { CELL, F_BLOCK, F_DOOR, F_WINDOW, type WorldGrid } from './grid';

export interface NavAgent {
  /** extra cost for passing a closed door, or -1 if impassable */
  doorCost(door: Door): number;
  /** extra cost for passing a window, or -1 if impassable */
  windowCost(win: WindowState): number;
  /** optional additional cost for entering a cell (e.g. light avoidance) */
  cellCost?(i: number): number;
}

export interface PathPoint {
  x: number;
  z: number;
  door: number;
  window: number;
}

export const RESIDENT_AGENT = (keys: (keyId: number) => boolean): NavAgent => ({
  doorCost: (d) => (d.locked && !keys(d.keyId) ? -1 : 2),
  windowCost: () => -1,
});

const SQRT2 = Math.SQRT2;

export class Pathfinder {
  private g: Float32Array;
  private fs: Float32Array;
  private parent: Int32Array;
  private stamp: Uint32Array;
  private closed: Uint32Array;
  private heap: Int32Array;
  private heapN = 0;
  private cur = 1;
  expansions = 0;

  constructor(private grid: WorldGrid) {
    const n = grid.w * grid.h;
    this.g = new Float32Array(n);
    this.fs = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.heap = new Int32Array(n * 2);
  }

  /** cost to enter cell i, or -1 if impassable */
  cellCost(i: number, agent: NavAgent): number {
    const f = this.grid.flags[i];
    if (f & F_DOOR) {
      const d = this.grid.world.doors[this.grid.ref[i]];
      if (d.broken || d.open >= 0.45) return 0;
      return agent.doorCost(d);
    }
    if (f & F_WINDOW) return agent.windowCost(this.grid.world.windows[this.grid.ref[i]]);
    if (f & F_BLOCK) return -1;
    return agent.cellCost ? agent.cellCost(i) : 0;
  }

  passable(i: number, agent: NavAgent) {
    return this.cellCost(i, agent) >= 0;
  }

  /** nearest passable cell around a world point (spiral search) */
  nearestFree(x: number, z: number, agent: NavAgent, maxR = 6): number {
    const grid = this.grid;
    const cx = grid.cx(x);
    const cz = grid.cz(z);
    const c0 = grid.idx(cx, cz);
    const plain = (i: number) => {
      const f = grid.flags[i];
      return !(f & (F_BLOCK | F_DOOR | F_WINDOW)) && this.cellCost(i, agent) >= 0;
    };
    if (plain(c0)) return c0;
    let best = -1;
    let bestD = Infinity;
    for (let r = 1; r <= maxR; r++) {
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= grid.w || nz >= grid.h) continue;
          const i = grid.idx(nx, nz);
          if (!plain(i)) continue;
          const d = (grid.centreX(i) - x) ** 2 + (grid.centreZ(i) - z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      if (best >= 0) return best;
    }
    return -1;
  }

  private push(i: number) {
    let k = this.heapN++;
    const h = this.heap;
    const fs = this.fs;
    h[k] = i;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (fs[h[p]] <= fs[i]) break;
      h[k] = h[p];
      k = p;
    }
    h[k] = i;
  }

  private pop(): number {
    const h = this.heap;
    const fs = this.fs;
    const top = h[0];
    const last = h[--this.heapN];
    let k = 0;
    const n = this.heapN;
    while (true) {
      let c = 2 * k + 1;
      if (c >= n) break;
      if (c + 1 < n && fs[h[c + 1]] < fs[h[c]]) c++;
      if (fs[h[c]] >= fs[last]) break;
      h[k] = h[c];
      k = c;
    }
    h[k] = last;
    return top;
  }

  find(sx: number, sz: number, tx: number, tz: number, agent: NavAgent, maxNodes = 60000): PathPoint[] | null {
    const grid = this.grid;
    const start = this.nearestFree(sx, sz, agent, 4);
    const goal = this.nearestFree(tx, tz, agent, 6);
    if (start < 0 || goal < 0) return null;
    const W = grid.w;
    const gx = goal % W;
    const gz = Math.floor(goal / W);
    const stamp = ++this.cur;
    this.heapN = 0;
    this.g[start] = 0;
    this.stamp[start] = stamp;
    this.parent[start] = -1;
    const hfn = (i: number) => {
      const dx = Math.abs((i % W) - gx);
      const dz = Math.abs(Math.floor(i / W) - gz);
      return (Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz)) * 1.12;
    };
    this.fs[start] = hfn(start);
    this.push(start);
    let found = false;
    let n = 0;
    while (this.heapN > 0) {
      const c = this.pop();
      if (this.closed[c] === stamp) continue;
      this.closed[c] = stamp;
      if (c === goal) {
        found = true;
        break;
      }
      if (++n > maxNodes) break;
      const cx = c % W;
      const cz = (c - cx) / W;
      const cf = grid.flags[c];
      const cIsPortal = (cf & (F_DOOR | F_WINDOW)) !== 0;
      for (let k = 0; k < 8; k++) {
        const dx = k === 0 ? 1 : k === 1 ? -1 : k === 2 ? 0 : k === 3 ? 0 : k === 4 ? 1 : k === 5 ? 1 : k === 6 ? -1 : -1;
        const dz = k === 0 ? 0 : k === 1 ? 0 : k === 2 ? 1 : k === 3 ? -1 : k === 4 ? 1 : k === 5 ? -1 : k === 6 ? 1 : -1;
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= W || nz >= grid.h) continue;
        const ni = nz * W + nx;
        if (this.closed[ni] === stamp) continue;
        const cost = this.cellCost(ni, agent);
        if (cost < 0) continue;
        const diag = dx !== 0 && dz !== 0;
        if (diag) {
          if (cIsPortal || grid.flags[ni] & (F_DOOR | F_WINDOW)) continue;
          const a = cz * W + nx;
          const b = nz * W + cx;
          if (this.cellCost(a, agent) < 0 || this.cellCost(b, agent) < 0) continue;
          if (grid.flags[a] & (F_DOOR | F_WINDOW) || grid.flags[b] & (F_DOOR | F_WINDOW)) continue;
        }
        const ng = this.g[c] + (diag ? SQRT2 : 1) + cost;
        if (this.stamp[ni] !== stamp || ng < this.g[ni]) {
          this.stamp[ni] = stamp;
          this.g[ni] = ng;
          this.parent[ni] = c;
          this.fs[ni] = ng + hfn(ni);
          this.push(ni);
        }
      }
    }
    this.expansions = n;
    if (!found) return null;
    const cells: number[] = [];
    for (let c = goal; c !== -1; c = this.parent[c]) cells.push(c);
    cells.reverse();
    return this.smooth(cells, agent, tx, tz);
  }

  /** straight walkable line on plain cells (no portals) */
  lineClear(ax: number, az: number, bx: number, bz: number, agent: NavAgent): boolean {
    const d = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(d / (CELL * 0.4)));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const i = this.grid.cellAt(ax + (bx - ax) * t, az + (bz - az) * t);
      const f = this.grid.flags[i];
      if (f & (F_BLOCK | F_DOOR | F_WINDOW)) return false;
      if (agent.cellCost && agent.cellCost(i) > 2) return false;
    }
    return true;
  }

  private smooth(cells: number[], agent: NavAgent, tx: number, tz: number): PathPoint[] {
    const grid = this.grid;
    const pts: PathPoint[] = cells.map((c) => {
      const f = grid.flags[c];
      return {
        x: grid.centreX(c),
        z: grid.centreZ(c),
        door: f & F_DOOR ? grid.ref[c] : -1,
        window: f & F_WINDOW ? grid.ref[c] : -1,
      };
    });
    if (pts.length <= 2) return pts.slice(1);
    const out: PathPoint[] = [];
    let i = 0;
    while (i < pts.length - 1) {
      let j = i + 1;
      const portal = (p: PathPoint) => p.door >= 0 || p.window >= 0;
      if (!portal(pts[i]) && !portal(pts[j])) {
        let k = j + 1;
        while (k < pts.length && !portal(pts[k]) && this.lineClear(pts[i].x, pts[i].z, pts[k].x, pts[k].z, agent)) {
          j = k;
          k++;
        }
      }
      out.push(pts[j]);
      i = j;
    }
    // replace the final cell centre with the exact target when it is reachable in a straight line
    const last = out[out.length - 1];
    if (last && last.door < 0 && last.window < 0 && Math.hypot(last.x - tx, last.z - tz) < 0.8) {
      last.x = tx;
      last.z = tz;
    }
    return out;
  }

  /** flood fill reachable cells from a point; returns a stamp-marked set accessor */
  flood(sx: number, sz: number, agent: NavAgent, limit = 2_000_000): Uint8Array {
    const grid = this.grid;
    const seen = new Uint8Array(grid.w * grid.h);
    const start = this.nearestFree(sx, sz, agent, 4);
    if (start < 0) return seen;
    const q = new Int32Array(grid.w * grid.h);
    let head = 0;
    let tail = 0;
    q[tail++] = start;
    seen[start] = 1;
    const W = grid.w;
    while (head < tail && tail < limit) {
      const c = q[head++];
      const cx = c % W;
      const cz = (c - cx) / W;
      for (let k = 0; k < 4; k++) {
        const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const nz = cz + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nx < 0 || nz < 0 || nx >= W || nz >= grid.h) continue;
        const ni = nz * W + nx;
        if (seen[ni]) continue;
        if (this.cellCost(ni, agent) < 0) continue;
        seen[ni] = 1;
        q[tail++] = ni;
      }
    }
    return seen;
  }
}
