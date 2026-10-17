import { approachAngle, yawTo } from '../core/math';
import type { Simulation } from './simulation';
import type { NpcState, Task } from './types';
import { followPath, requestPath, doorPos, animForSpeed } from './movement';
import { CFG, SHOP_COST } from './config';
import { shareGossip } from './memory';
import type { Furniture } from '../world/types';

export type TaskResult = 'running' | 'done' | 'failed';

export const DIR_YAW = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

/** how many people can use a piece of furniture at once */
export function capacity(f: Furniture) {
  const long = Math.max(f.w, f.d);
  const short = Math.min(f.w, f.d);
  switch (f.use) {
    case 'bed':
      return short >= 1.3 ? 2 : 1;
    case 'sofa':
    case 'pew':
      return long >= 2.6 ? 3 : long >= 1.8 ? 2 : 1;
    case 'chair':
      return long >= 1.4 ? 2 : 1; // benches
    case 'register':
    case 'bartap':
      return 99;
    default:
      return 1;
  }
}

/** where an actor sits or lies on a piece of furniture; slot spreads several users out */
export function seatPos(f: Furniture, slot = 0) {
  const cap = Math.min(3, capacity(f));
  const xLong = f.w >= f.d;
  // offset along the axis people sit side by side on (beds: across the width)
  const along = (axisX: boolean, spacing: number) => {
    const o = cap > 1 ? (slot - (cap - 1) / 2) * spacing : 0;
    return axisX ? { ox: o, oz: 0 } : { ox: 0, oz: o };
  };
  switch (f.use) {
    case 'bed':
    case 'cellbed':
    case 'exam': {
      const { ox, oz } = along(!xLong, 0.75);
      return { x: f.x + ox, z: f.z + oz, pose: 'lie' as const };
    }
    case 'sofa':
    case 'pew': {
      const v = [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ][f.face];
      const depth = f.face === 0 || f.face === 2 ? f.d : f.w;
      const { ox, oz } = along(xLong, 0.62);
      return { x: f.x + v[0] * depth * 0.12 + ox, z: f.z + v[1] * depth * 0.12 + oz, pose: 'sit' as const };
    }
    case 'chair':
    case 'barstool': {
      const { ox, oz } = along(xLong, 0.6);
      return { x: f.x + ox, z: f.z + oz, pose: 'sit' as const };
    }
    default:
      return { x: f.ux, z: f.uz, pose: 'stand' as const };
  }
}

function speedFor(npc: NpcState, t: Task) {
  if (t.run) return npc.role === 'police' ? CFG.runSpeed * 1.08 : CFG.runSpeed;
  if (t.sneak) return CFG.sneakSpeed;
  return npc.needs.fear > 50 || npc.role === 'killer' ? CFG.briskSpeed : CFG.walkSpeed * (0.92 + (npc.id % 5) * 0.03);
}

/** runs a goto towards (x, z); used by several task kinds */
export function stepGoto(sim: Simulation, npc: NpcState, t: Task, dt: number, x: number, z: number): TaskResult {
  const arrive = t.arrive ?? 0.4;
  if (Math.hypot(npc.x - x, npc.z - z) <= arrive + 0.05 && (!npc.path || npc.pathIdx >= (npc.path?.length ?? 0))) {
    npc.speed = 0;
    return 'done';
  }
  // moving targets only trigger a re-path once they have moved noticeably
  const tol = npc.pathGoal ? Math.max(0.3, Math.hypot(npc.x - x, npc.z - z) * 0.25) : 0;
  if (!npc.path || !npc.pathGoal || Math.hypot(npc.pathGoal.x - x, npc.pathGoal.z - z) > tol) {
    // do not hammer the pathfinder with a destination that just failed
    if (Math.hypot(Number(npc.ctl.failX ?? -99) - x, Number(npc.ctl.failZ ?? -99) - z) < 1.5 && sim.time - Number(npc.ctl.failT ?? -1e9) < 900) return 'failed';
    const r = requestPath(sim, npc, x, z);
    if (r === 'later') return 'running';
    if (r === 'fail') return 'failed';
  }
  npc.stance = t.sneak ? 'crouch' : 'stand';
  const res = followPath(sim, npc, dt, speedFor(npc, t), arrive);
  npc.anim = animForSpeed(npc);
  if (res === 'arrived') {
    npc.path = null;
    npc.pathGoal = null;
    npc.speed = 0;
    if (Math.hypot(npc.x - x, npc.z - z) > arrive + 1.2) {
      // path ended short (target cell blocked); good enough if close
      return Math.hypot(npc.x - x, npc.z - z) < 2.2 ? 'done' : 'failed';
    }
    return 'done';
  }
  if (res === 'blocked') {
    npc.path = null;
    npc.pathGoal = null;
    npc.pathFail++;
    if (npc.pathFail > 4) {
      npc.pathFail = 0;
      return 'failed';
    }
  }
  return 'running';
}

function endUse(sim: Simulation, npc: NpcState) {
  if (npc.usingFurniture >= 0) {
    const f = sim.world.furniture[npc.usingFurniture];
    if (f && (npc.stance === 'sit' || npc.stance === 'lie' || npc.stance === 'hidden')) {
      npc.x = f.ux;
      npc.z = f.uz;
    }
  }
  npc.usingFurniture = -1;
  npc.sleeping = false;
  if (npc.stance !== 'dead' && npc.stance !== 'downed') npc.stance = 'stand';
}

function applyEffect(sim: Simulation, npc: NpcState, effect: string | undefined, f: Furniture | null) {
  switch (effect) {
    case 'eat_fridge': {
      const food = sim.takeFood(npc.homeId);
      if (food) npc.needs.hunger = Math.max(0, npc.needs.hunger - 45);
      else npc.ctl.needGroceries = true;
      break;
    }
    case 'eat_diner':
      if (npc.money >= 7) {
        npc.money -= 7;
        npc.needs.hunger = Math.max(0, npc.needs.hunger - 55);
      }
      break;
    case 'drink':
      if (npc.money >= 4) npc.money -= 4;
      npc.needs.social = Math.min(100, npc.needs.social + 25);
      break;
    case 'work':
      npc.money += 45;
      break;
    case 'shop':
      if (npc.money >= SHOP_COST) {
        npc.money -= SHOP_COST;
        npc.carriesGroceries = 4;
      } else npc.ctl.fail_shop = sim.time;
      break;
    case 'stock':
      if (npc.carriesGroceries > 0 && f && f.container) {
        f.container.push({ item: 'sandwich', n: 2 }, { item: 'apple', n: 2 });
        npc.carriesGroceries = 0;
        npc.ctl.needGroceries = false;
      }
      break;
    case 'wash':
      npc.bloody = 0;
      break;
    case 'smoke':
      if (sim.chance(0.35)) sim.dropItem('cigarette_butt', npc.x + sim.rand(-0.4, 0.4), npc.z + sim.rand(-0.4, 0.4), 1, -1, 'Cigarette butt');
      break;
    case 'relax':
      npc.needs.social = Math.min(100, npc.needs.social + 5);
      break;
    case 'phone':
      sim.policeCall(npc);
      break;
  }
}

/** generic task executor; returns the result for the current task */
export function runTask(sim: Simulation, npc: NpcState, t: Task, dt: number): TaskResult {
  const gdt = dt * sim.timeScale();
  switch (t.kind) {
    case 'goto':
      return stepGoto(sim, npc, t, dt, t.x!, t.z!);
    case 'wait': {
      npc.speed = 0;
      const anim = String(t.data?.anim ?? '');
      npc.anim = anim || (npc.stance === 'crouch' ? 'crouch' : t.pose === 'use' ? 'use' : 'idle');
      const prevT = t.t ?? 0;
      t.t = prevT + gdt;
      if (t.x !== undefined && t.z !== undefined) npc.yaw = approachAngle(npc.yaw, yawTo(npc.x, npc.z, t.x, t.z), dt * 5);
      if (anim === 'smoke' && Math.floor(prevT / 40) !== Math.floor(t.t / 40)) sim.emit({ type: 'smoke', x: npc.x + Math.sin(npc.yaw) * 0.3, y: npc.y + 1.55, z: npc.z - Math.cos(npc.yaw) * 0.3 });
      const done = t.until !== undefined ? sim.time >= t.until : t.t >= (t.dur ?? 60);
      if (done) applyEffect(sim, npc, t.effect, null);
      return done ? 'done' : 'running';
    }
    case 'look': {
      npc.speed = 0;
      npc.anim = 'look';
      t.t = (t.t ?? 0) + gdt;
      npc.yaw += Math.sin(sim.time * 0.05 + npc.id) * dt * 1.2;
      return t.t >= (t.dur ?? 60) ? 'done' : 'running';
    }
    case 'face': {
      npc.yaw = approachAngle(npc.yaw, yawTo(npc.x, npc.z, t.x!, t.z!), dt * 8);
      return 'done';
    }
    case 'say': {
      sim.say(npc, String(t.data?.text ?? '...'), Number(t.data?.dur ?? 4));
      return 'done';
    }
    case 'use': {
      const f = sim.world.furniture[t.target!];
      if (!f || f.kind === 'none') return 'failed';
      if (!t.started) {
        const users = sim.npcs.filter((o) => o !== npc && o.alive && o.usingFurniture === f.id);
        if (users.length >= capacity(f)) {
          // somebody is in the way: eat or rest standing instead of giving up the plan
          if (t.effect === 'eat_fridge' || t.effect === 'eat_diner' || t.effect === 'relax' || t.effect === 'drink') {
            t.kind = 'wait';
            return 'running';
          }
          return 'failed';
        }
        const r = stepGoto(sim, npc, t, dt, f.ux, f.uz);
        if (r !== 'done') return r;
        t.started = true;
        t.t = 0;
        npc.usingFurniture = f.id;
        const taken = new Set(users.map((o) => Number(o.ctl.seatSlot ?? 0)));
        let slot = 0;
        while (taken.has(slot)) slot++;
        npc.ctl.seatSlot = slot;
        const seat = seatPos(f, slot);
        const pose = t.pose === 'lie' || t.pose === 'sit' ? t.pose : seat.pose === 'stand' ? 'stand' : seat.pose;
        if (pose === 'sit' || pose === 'lie') {
          npc.x = seat.x;
          npc.z = seat.z;
          npc.stance = pose;
          npc.yaw = DIR_YAW[f.face];
        } else {
          npc.stance = 'stand';
          npc.yaw = yawTo(npc.x, npc.z, f.x, f.z);
        }
        if (t.effect === 'sleep') npc.sleeping = true;
        if (f.lightId >= 0 && t.effect !== 'sleep' && sim.isDarkNow()) sim.world.lights[f.lightId].on = true;
      }
      npc.speed = 0;
      npc.anim = npc.stance === 'sit' ? 'sit' : npc.stance === 'lie' ? 'lie' : t.effect === 'smoke' ? 'smoke' : 'use';
      t.t = (t.t ?? 0) + gdt;
      if (t.effect === 'sleep') {
        npc.needs.energy = Math.min(100, npc.needs.energy + (gdt / 3600) * 13);
        if (!npc.sleeping) {
          // woken up: abort
          endUse(sim, npc);
          return 'failed';
        }
      }
      if (t.effect === 'smoke' && Math.floor((t.t - gdt) / 40) !== Math.floor(t.t / 40)) sim.emit({ type: 'smoke', x: npc.x, y: npc.y + 1.6, z: npc.z });
      const done = t.until !== undefined ? sim.time >= t.until : t.t >= (t.dur ?? 60);
      if (done) {
        applyEffect(sim, npc, t.effect, f);
        if (f.lightId >= 0 && sim.chance(0.7)) sim.world.lights[f.lightId].on = false;
        endUse(sim, npc);
        return 'done';
      }
      return 'running';
    }
    case 'door': {
      const d = sim.world.doors[t.target!];
      const p = doorPos(sim, d.id);
      // stand on our side of the door
      const side = Math.hypot(npc.x - p.x, npc.z - p.z);
      if (side > 1.6) {
        const inside = sim.doorInsidePoint(d.id, npc.building >= 0 ? npc.building : -1);
        const r = stepGoto(sim, npc, { ...t, arrive: 0.6 }, dt, inside.x, inside.z);
        if (r === 'failed') return 'failed';
        if (r !== 'done') return 'running';
      }
      const act = String(t.data?.act ?? 'close');
      if (act === 'lock' || act === 'close') {
        if (!sim.actorNear(p.x, p.z, 0.75)) {
          if (d.target > 0) sim.sound('door_close', p.x, p.z, 7, npc.id);
          d.target = 0;
        }
        if (act === 'lock' && sim.hasKey(npc, d.keyId) && !d.broken) {
          if (!d.locked) sim.sound('lock', p.x, p.z, 4, npc.id);
          d.locked = true;
        }
      } else if (act === 'unlock' && sim.hasKey(npc, d.keyId)) {
        d.locked = false;
      } else if (act === 'open') {
        if (!d.locked) d.target = 1;
      }
      return 'done';
    }
    case 'lights': {
      // on: porch light only (rooms are lit by occupancy); off: everything in the building
      const on = !!t.data?.on;
      const b = sim.world.buildings[t.target!];
      if (!b) return 'done';
      if (!on) for (const rid of b.roomIds) for (const lid of sim.world.rooms[rid].lightIds) sim.world.lights[lid].on = false;
      if (b.porchLightId >= 0) sim.world.lights[b.porchLightId].on = on;
      return 'done';
    }
    case 'talk': {
      const other = sim.actors[t.target!];
      if (!other || !other.alive) return 'failed';
      const d = Math.hypot(other.x - npc.x, other.z - npc.z);
      const ob = other.building;
      const private_ = ob >= 0 && ob !== npc.homeId && ob !== npc.building && ['house', 'abandoned', 'shed'].includes(sim.world.buildings[ob].kind);
      if (private_) {
        // wait outside for them to come out
        npc.speed = 0;
        npc.anim = 'idle';
        t.t = (t.t ?? 0) + gdt * 0.5;
        return t.t > (t.dur ?? 300) ? 'done' : 'running';
      }
      if (d > 1.6) {
        const r = stepGoto(sim, npc, { ...t, arrive: 1.2 }, dt, other.x, other.z);
        if (r === 'failed') return 'failed';
        if (d > 1.7 && r !== 'done') return 'running';
      }
      npc.speed = 0;
      npc.anim = 'talk';
      npc.yaw = approachAngle(npc.yaw, yawTo(npc.x, npc.z, other.x, other.z), dt * 6);
      t.t = (t.t ?? 0) + gdt;
      if (t.t >= (t.dur ?? 300)) {
        if (other.kind === 'npc') {
          shareGossip(sim, npc, other as NpcState);
          shareGossip(sim, other as NpcState, npc);
        }
        npc.needs.social = Math.min(100, npc.needs.social + 30);
        return 'done';
      }
      return 'running';
    }
    case 'scream': {
      sim.sound('scream', npc.x, npc.z, 45, npc.id);
      sim.say(npc, String(t.data?.text ?? 'Help!'), 3);
      return 'done';
    }
    case 'hide': {
      const f = sim.world.furniture[t.target!];
      if (!f) return 'failed';
      if (!t.started) {
        const r = stepGoto(sim, npc, t, dt, f.ux, f.uz);
        if (r !== 'done') return r;
        t.started = true;
        t.t = 0;
        npc.stance = 'hidden';
        npc.usingFurniture = f.id;
        npc.x = f.x;
        npc.z = f.z;
      }
      t.t = (t.t ?? 0) + gdt;
      npc.speed = 0;
      if (t.t >= (t.dur ?? 1200)) {
        endUse(sim, npc);
        return 'done';
      }
      return 'running';
    }
    case 'equip': {
      const item = String(t.data?.item ?? '');
      if (item === 'flashlight') npc.flashlight = !!t.data?.on;
      else npc.weapon = item || null;
      return 'done';
    }
    case 'outfit': {
      npc.outfit = (t.data?.outfit as NpcState['outfit']) ?? 'day';
      return 'done';
    }
    case 'attack':
      return sim.combatTask(npc, t, dt);
    default:
      return sim.customTask(npc, t, dt);
  }
}

export function clearTasks(sim: Simulation, npc: NpcState) {
  if (npc.usingFurniture >= 0 || npc.stance === 'sit' || npc.stance === 'lie' || npc.stance === 'hidden') endUse(sim, npc);
  npc.tasks.length = 0;
  npc.path = null;
  npc.pathGoal = null;
  npc.doorWait = 0;
}

/** advances the npc's task queue */
export function runTasks(sim: Simulation, npc: NpcState, dt: number) {
  let guard = 0;
  while (npc.tasks.length && guard++ < 6) {
    const t = npc.tasks[0];
    const r = runTask(sim, npc, t, dt);
    if (r === 'running') return;
    npc.tasks.shift();
    npc.path = null;
    npc.pathGoal = null;
    if (r === 'failed') {
      sim.onTaskFail?.(npc, t);
      // abandon the rest of the plan; the brain will choose again
      if (npc.usingFurniture >= 0) endUse(sim, npc);
      npc.tasks.length = 0;
      if (npc.activity) {
        npc.activity.data.failed = true;
        npc.ctl[`fail_${npc.activity.kind}`] = sim.time;
      }
      npc.thinkT = Math.min(npc.thinkT, 0.2);
      return;
    }
    // done: continue with the next task in the same step only for instant tasks
    if (npc.tasks.length && !['say', 'face', 'door', 'lights', 'equip', 'outfit', 'scream'].includes(npc.tasks[0].kind)) return;
  }
  if (!npc.tasks.length) {
    npc.speed = 0;
    if (npc.stance === 'stand') npc.anim = 'idle';
  }
}
