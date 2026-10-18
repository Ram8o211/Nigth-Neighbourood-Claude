import { approachAngle, yawTo } from '../core/math';
import type { Simulation } from './simulation';
import type { ActorState, NpcState } from './types';
import { CFG } from './config';

/** moves an actor by (dx, dz) with collision, sub-stepping long moves */
export function moveActor(sim: Simulation, a: ActorState, dx: number, dz: number, ignoreWindow = -1) {
  const len = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(len / 0.18));
  const p = { x: a.x, z: a.z };
  for (let s = 0; s < steps; s++) {
    p.x += dx / steps;
    p.z += dz / steps;
    sim.colliders.resolveCircle(p, a.radius, ignoreWindow);
  }
  a.x = Math.max(1, Math.min(sim.world.width - 1, p.x));
  a.z = Math.max(1, Math.min(sim.world.depth - 1, p.z));
}

export function updateLocation(sim: Simulation, a: ActorState, dt: number) {
  const target = sim.grid.heightAt(a.x, a.z);
  a.y += (target - a.y) * Math.min(1, dt * 12);
  a.room = sim.grid.roomAt(a.x, a.z);
  a.building = a.room >= 0 ? sim.world.rooms[a.room].buildingId : -1;
}

/** get up from a bed / chair / hiding place onto the furniture's free use point */
export function leaveFurniture(sim: Simulation, a: ActorState) {
  if (a.usingFurniture < 0) return;
  const f = sim.world.furniture[a.usingFurniture];
  if (f && (a.stance === 'sit' || a.stance === 'lie' || a.stance === 'hidden')) {
    a.x = f.ux;
    a.z = f.uz;
  }
  a.usingFurniture = -1;
  a.hiddenIn = -1;
}

/**
 * Safety net: an npc that cannot even reach the door of the room it stands in
 * has been pushed into a sealed pocket (between furniture and walls). Move it
 * to the room's door when nobody is looking.
 */
export function unstick(sim: Simulation, npc: NpcState) {
  const room = sim.grid.roomAt(npc.x, npc.z);
  let exit: { x: number; z: number } | null = null;
  if (room >= 0 && sim.world.rooms[room].doorIds.length) exit = sim.doorFrontOfRoom(room);
  else if (room < 0) exit = sim.randomStreetPoint();
  if (!exit) return;
  if (Math.hypot(exit.x - npc.x, exit.z - npc.z) < 0.6) return;
  if (sim.pf.find(npc.x, npc.z, exit.x, exit.z, sim.agentFor(npc), 6000)) return; // not trapped
  if (sim.actorsSee(npc.x, npc.z, 0) || sim.actorsSee(exit.x, exit.z, 0)) return;
  npc.x = exit.x;
  npc.z = exit.z;
  npc.pathFail = 0;
  sim.emit({ type: 'unstuck', a: npc.id });
}

export function doorPos(sim: Simulation, id: number) {
  const d = sim.world.doors[id];
  return d.axis === 'x' ? { x: d.t, z: d.c } : { x: d.c, z: d.t };
}

/** request a path for an npc; returns false if the request was deferred or failed */
export function requestPath(sim: Simulation, npc: NpcState, x: number, z: number): 'ok' | 'later' | 'fail' {
  if (sim.pathBudget <= 0) return 'later';
  sim.pathBudget--;
  npc.pathGoalBuilding = sim.grid.buildingAt(x, z);
  const path = sim.pf.find(npc.x, npc.z, x, z, sim.agentFor(npc), 50000);
  if (!path) {
    npc.ctl.failX = x;
    npc.ctl.failZ = z;
    npc.ctl.failT = sim.time;
    sim.onPathFail?.(npc, x, z);
  }
  if (!path) {
    npc.path = null;
    npc.pathFail++;
    if (npc.pathFail >= 3) unstick(sim, npc);
    return 'fail';
  }
  npc.path = path;
  npc.pathIdx = 0;
  npc.pathGoal = { x, z };
  npc.stuckT = 0;
  return 'ok';
}

export type FollowResult = 'moving' | 'arrived' | 'blocked' | 'waiting';

/**
 * Advances an npc along its path, opening (and unlocking) doors on the way
 * and closing exterior doors behind it.
 */
export function followPath(sim: Simulation, npc: NpcState, dt: number, speed: number, arrive = 0.35): FollowResult {
  const path = npc.path;
  if (!path || npc.pathIdx >= path.length) return 'arrived';
  const wp = path[npc.pathIdx];
  // door handling
  if (wp.door >= 0) {
    const door = sim.world.doors[wp.door];
    const dp = doorPos(sim, wp.door);
    const dd = Math.hypot(dp.x - npc.x, dp.z - npc.z);
    if (!door.broken && door.open < 0.75 && dd < 1.4) {
      npc.yaw = approachAngle(npc.yaw, yawTo(npc.x, npc.z, dp.x, dp.z), dt * 8);
      npc.speed = 0;
      npc.anim = 'idle';
      if (door.locked) {
        // keys, or the thumb-turn on the inside of a door
        if (sim.hasKey(npc, door.keyId) || npc.building === door.buildingId) {
          npc.doorWait += dt;
          if (npc.doorWait > 0.6) {
            door.locked = false;
            sim.sound('unlock', dp.x, dp.z, 5, npc.id);
            npc.doorWait = 0;
          }
          return 'waiting';
        }
        // police knock and are let in; everyone else is stuck
        if (npc.role === 'police') {
          npc.doorWait += dt;
          if (npc.doorWait > 2.5) {
            sim.sound('knock', dp.x, dp.z, 10, npc.id);
            door.locked = false;
            npc.doorWait = 0;
          }
          return 'waiting';
        }
        return 'blocked';
      }
      if (door.target < 1) {
        door.target = 1;
        sim.sound('door_open', dp.x, dp.z, 7, npc.id);
        sim.emit({ type: 'door', a: wp.door, s: 'open' });
      }
      npc.doorWait += dt;
      if (npc.doorWait > 3) {
        npc.doorWait = 0;
        return 'blocked';
      }
      return 'waiting';
    }
    npc.doorWait = 0;
    if (door.exterior && !npc.closeDoors.includes(wp.door)) npc.closeDoors.push(wp.door);
  }
  // window traversal (intruders only reach here with a broken window)
  const ignoreWindow = wp.window;
  const dx = wp.x - npc.x;
  const dz = wp.z - npc.z;
  const d = Math.hypot(dx, dz);
  const last = npc.pathIdx === path.length - 1;
  const portal = wp.door >= 0 || wp.window >= 0;
  if (d < (last ? arrive : portal ? 0.3 : 0.55)) {
    npc.pathIdx++;
    if (npc.pathIdx >= path.length) {
      npc.speed = 0;
      return 'arrived';
    }
    return 'moving';
  }
  // light local avoidance of other actors: steer around anyone just ahead
  const fx = dx / d;
  const fz = dz / d;
  let ax = fx;
  let az = fz;
  const ghost = Number(npc.ctl.ghost ?? 0) > sim.time;
  for (const o of sim.actors) {
    if (ghost) break;
    if (o === npc || !o.alive || o.stance === 'hidden' || o.inCustody) continue;
    const ox = o.x - npc.x;
    const oz = o.z - npc.z;
    const od = Math.hypot(ox, oz);
    if (od > 1.2 || od < 1e-3) continue;
    const ahead = (ox * fx + oz * fz) / od;
    if (ahead < 0.3) continue;
    const side = ox * -fz + oz * fx > 0 ? -1 : 1;
    const w = (1.2 - od) * 0.9;
    ax += -fz * side * w;
    az += fx * side * w;
  }
  const al = Math.hypot(ax, az) || 1;
  ax /= al;
  az /= al;
  const step = Math.min(d, speed * dt);
  const ox = npc.x;
  const oz = npc.z;
  moveActor(sim, npc, ax * step, az * step, ignoreWindow);
  const moved = Math.hypot(npc.x - ox, npc.z - oz);
  npc.vx = (npc.x - ox) / Math.max(dt, 1e-4);
  npc.vz = (npc.z - oz) / Math.max(dt, 1e-4);
  npc.speed = moved / Math.max(dt, 1e-4);
  npc.yaw = approachAngle(npc.yaw, yawTo(ox, oz, ox + ax, oz + az), dt * 7);
  // close exterior doors once we are past them
  if (npc.closeDoors.length) {
    for (let i = npc.closeDoors.length - 1; i >= 0; i--) {
      const id = npc.closeDoors[i];
      const dp = doorPos(sim, id);
      const dist = Math.hypot(dp.x - npc.x, dp.z - npc.z);
      if (dist > 1.5) {
        const door = sim.world.doors[id];
        npc.closeDoors.splice(i, 1);
        if (dist < 4 && !door.broken && !sim.actorNear(dp.x, dp.z, 1.0)) {
          door.target = 0;
          sim.sound('door_close', dp.x, dp.z, 8, npc.id);
          // lock our own empty home behind us
          if (npc.lockBehind === id && !door.locked && sim.hasKey(npc, door.keyId)) door.locked = true;
        }
      }
    }
  }
  // stuck detection
  if (moved < speed * dt * 0.15) {
    npc.stuckT += dt;
    if (npc.stuckT > 1.2) {
      npc.stuckT = 0;
      // let the npc slip past other people for a moment
      npc.ctl.ghost = sim.time + 4 * sim.timeScale();
      return 'blocked';
    }
  } else npc.stuckT = Math.max(0, npc.stuckT - dt);
  return 'moving';
}

export function animForSpeed(a: ActorState) {
  if (a.stance === 'crouch') return a.speed > 0.2 ? 'sneak' : 'crouch';
  if (a.speed > 3) return 'run';
  if (a.speed > 0.2) return 'walk';
  return 'idle';
}

export const SPEEDS = CFG;
