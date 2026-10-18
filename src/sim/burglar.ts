import { approachAngle, yawTo } from '../core/math';
import type { Simulation } from './simulation';
import type { NpcState, Task } from './types';
import { stepGoto, type TaskResult } from './tasks';
import { setActivity, inWindow } from './brain';
import { entriesFor } from './killer';
import { visibility } from './perception';
import { ITEMS } from './items';

/**
 * A petty thief: on some nights breaks into a house whose owners are out or
 * asleep, takes valuables and slips away. Creates mundane crimes that can be
 * confused with the killer's work.
 */
export function burglarThink(sim: Simulation, b: NpcState): boolean {
  if (!b.alive || b.inCustody || b.arrested) return false;
  if (b.activity?.kind === 'burgle' && b.tasks.length) return true;
  const night = sim.nightIndex();
  const h = sim.hour();
  if (b.ctl.plannedNight !== night) {
    b.ctl.plannedNight = night;
    b.ctl.burgleTonight = sim.chance(night === 0 ? 0.35 : 0.55);
    b.ctl.burgleAt = 23.3 + sim.rand(0, 2.6);
  }
  if (!b.ctl.burgleTonight || b.ctl.didNight === night) return false;
  if (!inWindow(h, Number(b.ctl.burgleAt), 3.8)) return false;
  if (b.needs.fear > 70) return false;
  b.ctl.didNight = night;
  b.ctl.bs = 'pick';
  b.ctl.bsT = 0;
  setActivity(sim, b, 'burgle', 58, [{ kind: 'burgle' }]);
  return true;
}

function setBs(b: NpcState, s: string) {
  b.ctl.bs = s;
  b.ctl.bsT = 0;
  b.path = null;
  b.pathGoal = null;
}

function pickHouse(sim: Simulation, b: NpcState): number {
  let best = -1;
  let bestScore = -Infinity;
  for (const bl of sim.world.buildings) {
    if (bl.kind !== 'house' || bl.id === b.homeId) continue;
    const members = sim.npcs.filter((n) => n.homeId === bl.id && n.alive);
    const home = members.filter((n) => n.building === bl.id);
    const awake = home.filter((n) => !n.sleeping);
    let score = -Math.hypot(bl.outsideFront.x - b.x, bl.outsideFront.z - b.z) / 70 + sim.rand(0, 1.5);
    if (bl.id === sim.world.playerHouseId) score += sim.player.building === bl.id ? -10 : 1.5;
    else if (!members.length) continue;
    if (awake.length) score -= 6;
    else if (home.length) score -= 1.5;
    else score += 3;
    if (score > bestScore) {
      bestScore = score;
      best = bl.id;
    }
  }
  return best;
}

export function burgleTask(sim: Simulation, b: NpcState, task: Task, dt: number): TaskResult {
  const bs = String(b.ctl.bs ?? 'pick');
  b.ctl.bsT = Number(b.ctl.bsT ?? 0) + dt;
  const home = sim.world.buildings[b.homeId];
  const h = sim.hour();
  // spotted? run. On the way a hooded walker only worries about people close by;
  // at the window or inside the house anyone who sees them clearly is too many.
  if (['travel', 'entry', 'inside'].includes(bs)) {
    const range = bs === 'travel' ? 9 : 25;
    for (const a of sim.actors) {
      if (a === b || !a.alive) continue;
      if (Math.abs(a.x - b.x) > range || Math.abs(a.z - b.z) > range) continue;
      if (a.kind === 'npc' && (a as NpcState).sleeping) continue;
      if (a.id === sim.killerId) continue; // two of a kind keep out of each other's way
      if (visibility(sim, a, b) > 0.45) {
        setBs(b, 'flee');
        break;
      }
    }
    if (h > 5.2 && h < 12) setBs(b, 'flee');
  }
  switch (String(b.ctl.bs)) {
    case 'pick': {
      const t = pickHouse(sim, b);
      if (t < 0) return 'done';
      const e = entriesFor(sim, t).find((x) => sim.pf.nearestFree(x.ox, x.oz, sim.agentFor(b), 2) >= 0);
      if (!e) return 'done';
      Object.assign(b.ctl, { tb: t, ek: e.kind, eid: e.id, ex: e.ox, ez: e.oz, ix: e.ix, iz: e.iz, loot: 0, visited: '' });
      b.outfit = 'night';
      setBs(b, 'travel');
      return 'running';
    }
    case 'travel': {
      const ex = Number(b.ctl.ex);
      const ez = Number(b.ctl.ez);
      const r = stepGoto(sim, b, { ...task, sneak: Math.hypot(b.x - ex, b.z - ez) < 15, arrive: 0.6 }, dt, ex, ez);
      if (r === 'done') setBs(b, 'entry');
      else if (r === 'failed') setBs(b, 'flee');
      return 'running';
    }
    case 'entry': {
      b.stance = 'crouch';
      b.speed = 0;
      const id = Number(b.ctl.eid);
      if (b.ctl.ek === 'door') {
        const d = sim.world.doors[id];
        if (d.locked && !d.broken) {
          b.anim = 'pick';
          if (Math.floor(Number(b.ctl.bsT)) !== Math.floor(Number(b.ctl.bsT) - dt)) sim.sound('lockpick', b.x, b.z, 4, b.id);
          if (Number(b.ctl.bsT) > 9) {
            if (sim.chance(0.5)) {
              d.locked = false;
              sim.markForced(d.id);
            } else {
              setBs(b, 'flee');
              return 'running';
            }
          }
          return 'running';
        }
        d.target = 1;
        if (d.open > 0.7) setBs(b, 'inside');
        return 'running';
      }
      const w = sim.world.windows[id];
      const wp = { x: w.axis === 'x' ? w.t : w.c, z: w.axis === 'x' ? w.c : w.t };
      b.yaw = approachAngle(b.yaw, yawTo(b.x, b.z, wp.x, wp.z), dt * 5);
      if (w.boarded) {
        setBs(b, 'flee');
        return 'running';
      }
      if (w.damage < 2) {
        // prying the frame is quieter than smashing, but slow
        b.anim = 'pick';
        if (Number(b.ctl.bsT) > 6) {
          sim.damageWindow(id, 999, b.id, true);
        }
        return 'running';
      }
      const t = Math.min(1, Number(b.ctl.climb ?? 0) + dt / 1.6);
      b.ctl.climb = t;
      b.anim = 'climb';
      b.x = Number(b.ctl.ex) + (Number(b.ctl.ix) - Number(b.ctl.ex)) * t;
      b.z = Number(b.ctl.ez) + (Number(b.ctl.iz) - Number(b.ctl.ez)) * t;
      if (t >= 1) {
        b.ctl.climb = 0;
        setBs(b, 'inside');
      }
      return 'running';
    }
    case 'inside': {
      b.stance = 'crouch';
      const tb = Number(b.ctl.tb);
      const visited = String(b.ctl.visited ?? '').split(',').filter(Boolean).map(Number);
      const cont = sim.world.furniture.find((f) => f.buildingId === tb && f.container && !visited.includes(f.id) && (f.use === 'dresser' || f.use === 'desk' || f.use === 'wardrobe' || f.use === 'cabinet'));
      if (!cont || Number(b.ctl.loot) >= 3 || visited.length >= 4) {
        setBs(b, 'leave');
        return 'running';
      }
      const r = stepGoto(sim, b, { ...task, sneak: true, arrive: 0.5 }, dt, cont.ux, cont.uz);
      if (r === 'failed') {
        b.ctl.visited = [...visited, cont.id].join(',');
        return 'running';
      }
      if (r !== 'done') return 'running';
      b.anim = 'search';
      b.ctl.searchT = Number(b.ctl.searchT ?? 0) + dt;
      if (Number(b.ctl.searchT) > 2.5) {
        b.ctl.searchT = 0;
        b.ctl.visited = [...visited, cont.id].join(',');
        const stolen = cont.container!.filter((s) => ITEMS[s.item]?.cat === 'valuable');
        for (const s of stolen) {
          if (s.item === 'cash') b.money += s.n;
          else b.ctl.loot = Number(b.ctl.loot) + s.n;
          sim.recordTheft(b, tb, s.item, s.n);
        }
        cont.container = cont.container!.filter((s) => ITEMS[s.item]?.cat !== 'valuable');
        if (stolen.length) sim.sound('rummage', b.x, b.z, 5, b.id);
      }
      return 'running';
    }
    case 'leave':
    case 'flee': {
      b.stance = 'stand';
      const r = stepGoto(sim, b, { ...task, run: bs === 'flee', arrive: 0.7 }, dt, home.insideFront.x, home.insideFront.z);
      if (r === 'done' || b.building === b.homeId) {
        b.outfit = 'day';
        if (Number(b.ctl.loot) > 0) sim.stashLoot(b);
        for (const did of home.doorIds) if (sim.world.doors[did].exterior) {
          sim.world.doors[did].target = 0;
          sim.world.doors[did].locked = true;
        }
        return 'done';
      }
      if (r === 'failed' && Number(b.ctl.bsT) > 20) {
        b.outfit = 'day';
        return 'done';
      }
      return 'running';
    }
  }
  return 'done';
}
