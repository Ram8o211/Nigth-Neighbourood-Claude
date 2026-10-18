import { describe, it, expect } from 'vitest';
import { generateWorld } from '../src/world/gen/generator';
import { WorldGrid, F_BLOCK, F_DOOR, F_WINDOW, F_ROAD } from '../src/world/grid';
import { Pathfinder } from '../src/world/pathfinding';
import { OPEN_AGENT } from '../src/world/gen/repair';
import type { WorldData } from '../src/world/types';

const SEEDS = ['hollow', 'abc', 'night', '42', 'elm-street', 'crow', 'z9', 'lantern'];

function hashWorld(w: WorldData) {
  return JSON.stringify({ b: w.buildings, d: w.doors, wi: w.windows, f: w.furniture, p: w.props.length, l: w.lights.length, r: w.roads });
}

describe('procedural neighbourhood generation', () => {
  it('is reproducible from a seed', () => {
    const a = generateWorld({ seed: 'repro', size: 'medium', density: 0.85, nights: 5 });
    const b = generateWorld({ seed: 'repro', size: 'medium', density: 0.85, nights: 5 });
    expect(hashWorld(a)).toEqual(hashWorld(b));
    const c = generateWorld({ seed: 'repro-2', size: 'medium', density: 0.85, nights: 5 });
    expect(hashWorld(c)).not.toEqual(hashWorld(a));
  });

  for (const size of ['small', 'medium', 'large'] as const) {
    it(`produces required town structure (${size})`, () => {
      for (const seed of SEEDS.slice(0, 4)) {
        const w = generateWorld({ seed, size, density: 0.85, nights: 5 });
        const kinds = new Set(w.buildings.map((b) => b.kind));
        for (const k of ['police', 'store', 'diner', 'bar', 'hardware'] as const) expect(kinds.has(k), `${seed}/${size} missing ${k}`).toBe(true);
        expect(w.playerHouseId).toBeGreaterThanOrEqual(0);
        expect(w.buildings[w.playerHouseId].kind).toBe('house');
        expect(w.buildings.filter((b) => b.kind === 'house').length).toBeGreaterThanOrEqual(size === 'small' ? 10 : 18);
        expect(w.policeId).toBeGreaterThanOrEqual(0);
        expect(w.landmarks.length).toBeGreaterThan(5);
      }
    });
  }

  it('aligns doors and windows with wall openings and exterior sides', () => {
    for (const seed of SEEDS) {
      const w = generateWorld({ seed, size: 'medium', density: 0.85, nights: 5 });
      for (const b of w.buildings) {
        expect(b.frontDoorId, `${seed} building ${b.id} has front door`).toBeGreaterThanOrEqual(0);
        const fd = w.doors[b.frontDoorId];
        expect(fd.exterior).toBe(true);
        // front door lies on the footprint boundary
        const onBoundary = fd.axis === 'x' ? Math.abs(fd.c - b.rect.z0) < 1e-6 || Math.abs(fd.c - b.rect.z1) < 1e-6 : Math.abs(fd.c - b.rect.x0) < 1e-6 || Math.abs(fd.c - b.rect.x1) < 1e-6;
        expect(onBoundary).toBe(true);
      }
      for (const d of w.doors) {
        // exactly one wall carries an opening for this door
        const walls = w.walls.filter((wl) => wl.openings.some((o) => o.kind === 'door' && o.id === d.id));
        expect(walls.length, `door ${d.id}`).toBe(1);
        const wl = walls[0];
        expect(wl.axis).toBe(d.axis);
        expect(Math.abs(wl.c - d.c)).toBeLessThan(1e-6);
        expect(d.t - d.width / 2).toBeGreaterThanOrEqual(wl.a - 1e-6);
        expect(d.t + d.width / 2).toBeLessThanOrEqual(wl.b + 1e-6);
        // door centre on a nav cell centre so a passage exists
        expect(Math.abs(((d.t - 0.25) / 0.5) % 1)).toBeLessThan(1e-6);
        // connects rooms (or a room to outside)
        expect(d.roomNeg >= 0 || d.roomPos >= 0).toBe(true);
        if (d.exterior) expect(d.roomNeg < 0 || d.roomPos < 0).toBe(true);
      }
      for (const win of w.windows) {
        const walls = w.walls.filter((wl) => wl.openings.some((o) => o.kind === 'window' && o.id === win.id));
        expect(walls.length).toBe(1);
        expect(walls[0].exterior).toBe(true);
        expect(walls[0].outside).toBe(win.outside);
        // the outside of the window is outside of the building footprint
        const b = w.buildings[win.buildingId];
        const ox = win.axis === 'x' ? win.t : win.c + win.outside * 0.5;
        const oz = win.axis === 'x' ? win.c + win.outside * 0.5 : win.t;
        const inside = ox > b.rect.x0 && ox < b.rect.x1 && oz > b.rect.z0 && oz < b.rect.z1;
        expect(inside).toBe(false);
      }
      // openings never overlap on a wall
      for (const wl of w.walls) {
        const os = wl.openings.filter((o) => o.id >= 0);
        for (let i = 1; i < os.length; i++) expect(os[i].t0).toBeGreaterThanOrEqual(os[i - 1].t1 - 1e-6);
      }
    }
  });

  it('keeps every entrance, room, door and furniture use point reachable', () => {
    for (const seed of SEEDS) {
      const w = generateWorld({ seed, size: 'medium', density: 0.85, nights: 5 });
      const grid = new WorldGrid(w);
      const pf = new Pathfinder(grid);
      const home = w.buildings[w.playerHouseId];
      const reach = pf.flood(home.outsideFront.x, home.outsideFront.z, OPEN_AGENT);
      for (const b of w.buildings) {
        const i = pf.nearestFree(b.outsideFront.x, b.outsideFront.z, OPEN_AGENT, 3);
        expect(i >= 0 && reach[i] === 1, `${seed}: entrance of ${b.kind} ${b.name} reachable`).toBe(true);
      }
      for (const r of w.rooms) {
        let any = false;
        for (let z = grid.cz(r.rect.z0 + 0.3); z <= grid.cz(r.rect.z1 - 0.3) && !any; z++)
          for (let x = grid.cx(r.rect.x0 + 0.3); x <= grid.cx(r.rect.x1 - 0.3) && !any; x++) if (reach[grid.idx(x, z)]) any = true;
        expect(any, `${seed}: room ${r.id} ${r.kind} reachable`).toBe(true);
      }
      for (const d of w.doors) {
        for (const s of [-0.8, 0.8]) {
          const x = d.axis === 'x' ? d.t : d.c + s;
          const z = d.axis === 'x' ? d.c + s : d.t;
          const i = pf.nearestFree(x, z, OPEN_AGENT, 2);
          expect(i >= 0 && reach[i] === 1, `${seed}: door ${d.id} side ${s}`).toBe(true);
        }
      }
      let bad = 0;
      for (const f of w.furniture) {
        if (f.kind === 'none' || f.use === 'decor') continue;
        const i = grid.cellAt(f.ux, f.uz);
        if (!(reach[i] === 1 && !(grid.flags[i] & (F_BLOCK | F_DOOR | F_WINDOW)))) bad++;
      }
      expect(bad, `${seed}: unreachable furniture`).toBe(0);
    }
  });

  it('gives every home a telephone and the player a table for the letter', () => {
    for (const seed of SEEDS) {
      const w = generateWorld({ seed, size: 'medium', density: 0.85, nights: 5 });
      for (const b of w.buildings.filter((b) => b.kind === 'house')) {
        const phone = w.furniture.some((f) => f.buildingId === b.id && f.use === 'phone' && f.kind !== 'none');
        expect(phone, `${seed}: ${b.address} has a phone`).toBe(true);
      }
      const home = w.buildings[w.playerHouseId];
      expect(w.furniture.some((f) => f.buildingId === home.id && (f.use === 'table' || f.use === 'desk') && f.kind !== 'none'), `${seed}: player table`).toBe(true);
    }
  });

  it('builds a connected road and sidewalk network', () => {
    for (const seed of SEEDS) {
      const w = generateWorld({ seed, size: 'medium', density: 0.85, nights: 5 });
      const grid = new WorldGrid(w);
      const pf = new Pathfinder(grid);
      const home = w.buildings[w.playerHouseId];
      const reach = pf.flood(home.outsideFront.x, home.outsideFront.z, OPEN_AGENT);
      let road = 0;
      let reached = 0;
      for (let i = 0; i < grid.flags.length; i++) {
        if (!(grid.flags[i] & F_ROAD) || grid.flags[i] & F_BLOCK) continue;
        road++;
        if (reach[i]) reached++;
      }
      expect(road).toBeGreaterThan(1000);
      expect(reached / road, seed).toBeGreaterThan(0.97);
      // the police station can be reached by path from the player home
      const pol = w.buildings[w.policeId];
      const path = pf.find(home.outsideFront.x, home.outsideFront.z, pol.outsideFront.x, pol.outsideFront.z, OPEN_AGENT, 200000);
      expect(path).not.toBeNull();
    }
  });

  it('places streetlights, porch lights, and dark alleys', () => {
    const w = generateWorld({ seed: 'lights', size: 'medium', density: 0.85, nights: 5 });
    expect(w.lights.filter((l) => l.kind === 'street').length).toBeGreaterThan(20);
    expect(w.lights.filter((l) => l.kind === 'porch').length).toBeGreaterThan(10);
    expect(w.lights.filter((l) => l.kind === 'room').length).toBe(w.rooms.length);
    expect(w.roads.some((r) => r.kind === 'alley' && !r.lit)).toBe(true);
    expect(w.pois.filter((p) => p.kind === 'hide').length).toBeGreaterThan(5);
  });
});
