import type { WorldData } from '../types';
import { WorldGrid, F_BLOCK, F_DOOR, F_WINDOW } from '../grid';
import { Pathfinder, type NavAgent } from '../pathfinding';

export const OPEN_AGENT: NavAgent = { doorCost: () => 0, windowCost: () => -1 };

/**
 * Validates generated content against the navigation grid and repairs
 * problems: furniture whose use point is unreachable is nudged or removed,
 * fences sealing off a building entrance are opened up.
 */
export function repairWorld(world: WorldData, maxPasses = 8): { removedFurniture: number; removedProps: number } {
  let removedFurniture = 0;
  let removedProps = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    const grid = new WorldGrid(world);
    const pf = new Pathfinder(grid);
    const home = world.buildings[world.playerHouseId];
    const reach = pf.flood(home.outsideFront.x, home.outsideFront.z, OPEN_AGENT);
    let changed = false;
    // entrances reachable from outside
    for (const b of world.buildings) {
      const i = pf.nearestFree(b.outsideFront.x, b.outsideFront.z, OPEN_AGENT, 3);
      if (i >= 0 && reach[i]) continue;
      // open up fences / hedges near the entrance
      const lot = world.lots[b.lotId];
      for (const p of world.props) {
        if (!p.solid) continue;
        if (!(p.kind.startsWith('fence') || p.kind === 'hedge' || p.kind === 'bush' || p.kind.startsWith('tree') || p.kind === 'trashcan' || p.kind === 'car')) continue;
        const near = Math.hypot(p.x - b.outsideFront.x, p.z - b.outsideFront.z) < 4.5;
        const inLot = lot && p.x >= lot.rect.x0 - 0.5 && p.x <= lot.rect.x1 + 0.5 && p.z >= lot.rect.z0 - 0.5 && p.z <= lot.rect.z1 + 0.5;
        if (near || (inLot && p.kind.startsWith('fence'))) {
          p.solid = null;
          p.kind = p.kind.startsWith('fence') ? p.kind + '_removed' : p.kind;
          if (p.kind.endsWith('_removed')) p.s = 0;
          removedProps++;
          changed = true;
        }
      }
    }
    // the outside of every exterior door must be reachable
    for (const d of world.doors) {
      if (!d.exterior) continue;
      const out = d.roomPos >= 0 ? -1 : 1;
      const x = d.axis === 'x' ? d.t : d.c + out * 0.8;
      const z = d.axis === 'x' ? d.c + out * 0.8 : d.t;
      const i = pf.nearestFree(x, z, OPEN_AGENT, 2);
      if (i >= 0 && reach[i]) continue;
      for (const p of world.props) {
        if (!p.solid || p.kind === 'collider') continue;
        if (Math.hypot(p.x - x, p.z - z) < 3.2 || (p.solid.x0 < x + 1 && p.solid.x1 > x - 1 && p.solid.z0 < z + 1 && p.solid.z1 > z - 1)) {
          p.solid = null;
          if (p.kind.startsWith('fence')) {
            p.kind += '_removed';
            p.s = 0;
          } else if (p.kind === 'car') p.kind = 'removed';
          removedProps++;
          changed = true;
        }
      }
    }
    // furniture use points
    for (const f of world.furniture) {
      if (!f.solid && f.use === 'decor') continue;
      if (f.kind === 'none') continue;
      const ci = grid.cellAt(f.ux, f.uz);
      const okCell = (i: number) => !(grid.flags[i] & (F_BLOCK | F_DOOR | F_WINDOW)) && reach[i];
      if (okCell(ci)) continue;
      // try nudging the use point around the furniture
      let fixed = false;
      const cands: [number, number][] = [];
      for (const d of [0.55, 0.8, 1.05])
        cands.push([f.x + (f.w / 2 + d), f.z], [f.x - (f.w / 2 + d), f.z], [f.x, f.z + (f.d / 2 + d)], [f.x, f.z - (f.d / 2 + d)]);
      for (const [x, z] of cands) {
        if (grid.roomAt(x, z) !== f.roomId) continue;
        const i = grid.cellAt(x, z);
        if (okCell(i)) {
          f.ux = x;
          f.uz = z;
          fixed = true;
          break;
        }
      }
      if (!fixed) {
        // nearest reachable cell inside the same room
        let best = -1;
        let bestD = 2.2 * 2.2;
        const r0 = 5;
        const fcx = grid.cx(f.x);
        const fcz = grid.cz(f.z);
        for (let dz = -r0; dz <= r0; dz++)
          for (let dx = -r0; dx <= r0; dx++) {
            const i = grid.idx(fcx + dx, fcz + dz);
            if (!okCell(i) || grid.zone[i] - 1 !== f.roomId) continue;
            const d = (grid.centreX(i) - f.x) ** 2 + (grid.centreZ(i) - f.z) ** 2;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        if (best >= 0) {
          f.ux = grid.centreX(best);
          f.uz = grid.centreZ(best);
          fixed = true;
        }
      }
      if (!fixed) {
        // essential furniture is kept (not solid) instead of removed
        const essential = f.use === 'bed' || f.use === 'fridge' || f.use === 'phone' || f.use === 'register' || f.use === 'bartap';
        if (essential) {
          f.solid = false;
          f.ux = f.x;
          f.uz = f.z;
        } else {
          f.kind = 'none';
          f.solid = false;
          f.container = null;
          f.hide = false;
        }
        removedFurniture++;
        changed = true;
      }
    }
    // rooms reachable: every room must contain reachable cells
    for (const r of world.rooms) {
      let any = false;
      const cx0 = grid.cx(r.rect.x0 + 0.3);
      const cx1 = grid.cx(r.rect.x1 - 0.3);
      const cz0 = grid.cz(r.rect.z0 + 0.3);
      const cz1 = grid.cz(r.rect.z1 - 0.3);
      for (let z = cz0; z <= cz1 && !any; z++) for (let x = cx0; x <= cx1 && !any; x++) if (reach[grid.idx(x, z)]) any = true;
      if (any) continue;
      // remove non-essential furniture in the room and in narrow neighbouring rooms
      const rooms = new Set<number>([r.id]);
      for (const did of r.doorIds) {
        const d = world.doors[did];
        for (const o of [d.roomNeg, d.roomPos]) {
          if (o < 0 || o === r.id) continue;
          const orr = world.rooms[o].rect;
          if (world.rooms[o].kind === 'hall' || Math.min(orr.x1 - orr.x0, orr.z1 - orr.z0) < 2.6) rooms.add(o);
        }
      }
      for (const f of world.furniture) {
        if (!rooms.has(f.roomId) || !f.solid) continue;
        if (f.use === 'bed' || f.use === 'fridge' || f.use === 'phone') f.solid = false;
        else {
          f.kind = 'none';
          f.solid = false;
          f.container = null;
        }
        removedFurniture++;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { removedFurniture, removedProps };
}
