import { approachAngle, yawTo } from '../core/math';
import type { Simulation } from './simulation';
import type { ActorState, NpcState, Task } from './types';
import { stepGoto, type TaskResult } from './tasks';
import { combatTask, startAttack } from './combat';
import { setActivity, inWindow } from './brain';
import { visibility } from './perception';
import { moveActor } from './movement';
import { DOOR_W } from '../world/gen/buildings';

/**
 * The Night Neighbour: an ordinary resident by day. On hunting nights it
 * dresses up, picks a victim, travels through dark routes, gets inside by
 * picking a lock or smashing a window, kills, sometimes drags the body to its
 * lair, and returns home to clean up. Everything happens through the normal
 * simulation (paths, doors, noise, witnesses, evidence).
 */

export interface HuntPlan {
  hunt: boolean;
  start: number; // hour
  maxKills: number;
  targetPlayer: boolean;
  watchPlayer: boolean;
  knock: boolean;
}

interface Entry {
  kind: 'door' | 'window';
  id: number;
  ox: number;
  oz: number;
  ix: number;
  iz: number;
  score: number;
}

export function entriesFor(sim: Simulation, bId: number): Entry[] {
  const b = sim.world.buildings[bId];
  const out: Entry[] = [];
  const pt = (axis: 'x' | 'z', c: number, t: number, outside: number, d: number) => (axis === 'x' ? { x: t, z: c + outside * d } : { x: c + outside * d, z: t });
  for (const did of b.doorIds) {
    const d = sim.world.doors[did];
    if (!d.exterior) continue;
    const outside = d.roomPos >= 0 ? -1 : 1;
    const o = pt(d.axis, d.c, d.t, outside, 1.0);
    const i = pt(d.axis, d.c, d.t, outside, -0.9);
    let score = d.locked ? 1 : 4;
    if (did !== b.frontDoorId) score += 1.5;
    score -= sim.lightAt(o.x, o.z) * 3;
    out.push({ kind: 'door', id: did, ox: o.x, oz: o.z, ix: i.x, iz: i.z, score });
  }
  for (const wid of b.windowIds) {
    const w = sim.world.windows[wid];
    if (w.width < 1.0 || w.sill > 1.2) continue;
    const o = pt(w.axis, w.c, w.t, w.outside, 1.0);
    const i = pt(w.axis, w.c, w.t, w.outside, -0.9);
    let score = w.damage === 2 && !w.boarded ? 3.5 : w.boarded ? -2 : 0.5;
    score -= sim.lightAt(o.x, o.z) * 3;
    // windows facing the street are risky
    const fd = sim.world.doors[b.frontDoorId];
    if (fd && fd.axis === w.axis && Math.abs(fd.c - w.c) < 0.01) score -= 1.2;
    out.push({ kind: 'window', id: wid, ox: o.x, oz: o.z, ix: i.x, iz: i.z, score });
  }
  return out.sort((a, b2) => b2.score - a.score);
}

function pickTarget(sim: Simulation, k: NpcState, plan: HuntPlan): { tgt: number; bld: number } | null {
  let best: { tgt: number; bld: number } | null = null;
  let bestScore = -Infinity;
  const p = sim.player;
  if (plan.targetPlayer && p.alive && !p.inCustody) {
    const atHome = p.building === sim.world.playerHouseId;
    const score = atHome ? 9 : p.building < 0 ? 6 : -10;
    if (score > bestScore) {
      bestScore = score;
      best = { tgt: 0, bld: atHome ? sim.world.playerHouseId : -1 };
    }
  }
  for (const n of sim.npcs) {
    if (n === k || !n.alive || n.inCustody || n.missing) continue;
    if (n.household === k.household) continue;
    if (n.role === 'police' && n.activity?.kind !== 'sleep') continue;
    const d = Math.hypot(n.x - k.x, n.z - k.z);
    let score: number;
    if (n.building === n.homeId) {
      const home = sim.households[n.household];
      const others = home ? home.members.filter((m) => m !== n.id && sim.actors[m].alive && sim.actors[m].building === n.homeId).length : 0;
      score = 3 - others * 1.6 + (n.sleeping ? 2 : 0) - d / 90;
    } else if (n.building < 0 && d < 140) {
      // somebody walking alone at night
      const company = sim.npcs.some((o) => o !== n && o.alive && Math.hypot(o.x - n.x, o.z - n.z) < 15);
      score = company ? -5 : 3.5 - d / 60;
    } else continue;
    score += sim.rand(0, 1.5);
    if (score > bestScore) {
      bestScore = score;
      best = { tgt: n.id, bld: n.building === n.homeId ? n.homeId : -1 };
    }
  }
  return best;
}

function setHs(k: NpcState, s: string) {
  k.ctl.hs = s;
  k.ctl.hsT = 0;
  k.path = null;
  k.pathGoal = null;
}

/** is the killer currently being watched by somebody who could recognise it? */
function watchers(sim: Simulation, k: NpcState): ActorState[] {
  const out: ActorState[] = [];
  for (const a of sim.actors) {
    if (a === k || !a.alive || a.inCustody) continue;
    if (Math.abs(a.x - k.x) > 30 || Math.abs(a.z - k.z) > 30) continue;
    if (a.kind === 'npc' && (a as NpcState).sleeping) continue;
    if (visibility(sim, a, k) > 0.35) out.push(a);
  }
  return out;
}

export function killerThink(sim: Simulation, k: NpcState): boolean {
  if (!k.alive || k.inCustody || k.arrested) return false;
  const plan = sim.huntPlan();
  const h = sim.hour();
  const hunting = k.activity?.kind === 'hunt';
  // somebody is fighting us
  if (k.lastAttacker >= 0 && sim.time - Number(k.ctl.hitAt ?? -1e9) < 60 && k.activity?.kind !== 'kfight') {
    const att = sim.actors[k.lastAttacker];
    if (att && att.alive && k.health > 30) {
      setActivity(sim, k, 'kfight', 95, [{ kind: 'attack', target: att.id }, { kind: 'hunt_return' }]);
      return true;
    }
  }
  if ((hunting || k.activity?.kind === 'kfight' || k.activity?.kind === 'kwatch' || k.activity?.kind === 'kknock') && k.tasks.length) return true;
  // stalking / unsettling visits earlier in the night
  const night = sim.nightIndex();
  if (plan.watchPlayer && k.ctl.watchedNight !== night && inWindow(h, 21.5, 23.5) && sim.player.alive && k.building === k.homeId) {
    k.ctl.watchedNight = night;
    setActivity(sim, k, 'kwatch', 60, [{ kind: 'k_watch' }]);
    return true;
  }
  if (plan.knock && k.ctl.knockedNight !== night && inWindow(h, 23.5, 0.8) && sim.player.building === sim.world.playerHouseId && sim.player.alive) {
    k.ctl.knockedNight = night;
    setActivity(sim, k, 'kknock', 60, [{ kind: 'k_knock' }]);
    return true;
  }
  if (k.ctl.killNight !== night) {
    k.ctl.killNight = night;
    k.ctl.nightKills = 0;
  }
  if (plan.hunt && k.ctl.huntedNight !== night && inWindow(h, plan.start, 3.6) && Number(k.ctl.nightKills ?? 0) < plan.maxKills) {
    k.ctl.huntedNight = night;
    setHs(k, 'prep');
    setActivity(sim, k, 'hunt', 62, [{ kind: 'hunt' }]);
    return true;
  }
  return false;
}

function finishHunt(sim: Simulation, k: NpcState) {
  k.outfit = 'day';
  k.weapon = null;
  k.flashlight = false;
  k.stance = 'stand';
  k.carrying = -1;
}

/** state machine for the hunting night, run as a single long task */
export function huntTask(sim: Simulation, k: NpcState, task: Task, dt: number): TaskResult {
  const hs = String(k.ctl.hs ?? 'prep');
  k.ctl.hsT = Number(k.ctl.hsT ?? 0) + dt;
  const h = sim.hour();
  const home = sim.world.buildings[k.homeId];
  const lateAbort = h > 5.1 && h < 12;
  const tgt = k.ctl.tgt !== undefined ? sim.actors[Number(k.ctl.tgt)] : null;
  // generic interruptions while out
  if (lateAbort && ['prep', 'travel', 'entry', 'inside', 'stalk', 'attack'].includes(hs)) {
    // dawn is coming: abandon whatever we were doing
    setHs(k, 'return');
    return 'running';
  }
  if (['travel', 'entry', 'inside', 'stalk', 'drag'].includes(hs) && k.building !== k.homeId) {
    const w = watchers(sim, k).filter((a) => !(a.kind === 'npc' && (a as NpcState).household === k.household));
    const police = w.find((a) => a.kind === 'npc' && (a as NpcState).role === 'police');
    if (police) {
      k.ctl.panic = 1;
      if (k.carrying >= 0) sim.dropBody(k);
      setHs(k, 'flee');
    } else if (w.length && hs !== 'inside') {
      const lone = w.length === 1 && Math.hypot(w[0].x - k.x, w[0].z - k.z) < 9 && k.health > 50 && w[0].id !== Number(k.ctl.tgt);
      if (lone && w[0].kind === 'npc') {
        // silence the witness
        k.ctl.tgt = w[0].id;
        setHs(k, 'stalk');
      } else if (k.carrying < 0 && sim.chance(dt * 0.8)) setHs(k, 'flee');
    }
  }
  switch (hs) {
    case 'prep': {
      if (k.building !== k.homeId) {
        const r = stepGoto(sim, k, task, dt, home.insideFront.x, home.insideFront.z);
        if (r === 'failed') setHs(k, 'abort');
        return 'running';
      }
      k.outfit = 'night';
      k.weapon = 'kitchen_knife';
      k.flashlight = false;
      k.speed = 0;
      k.anim = 'idle';
      for (const rid of home.roomIds) for (const lid of sim.world.rooms[rid].lightIds) sim.world.lights[lid].on = false;
      if (home.porchLightId >= 0) sim.world.lights[home.porchLightId].on = false;
      if (Number(k.ctl.hsT) > 1.5) {
        const pick = pickTarget(sim, k, sim.huntPlan());
        if (!pick) {
          setHs(k, 'cleanup');
          return 'running';
        }
        k.ctl.tgt = pick.tgt;
        k.ctl.tgtB = pick.bld;
        if (pick.bld < 0) setHs(k, 'stalk');
        else {
          const e = entriesFor(sim, pick.bld).find((x) => sim.pf.nearestFree(x.ox, x.oz, sim.agentFor(k), 2) >= 0);
          if (!e) {
            setHs(k, 'cleanup');
            return 'running';
          }
          k.ctl.ek = e.kind;
          k.ctl.eid = e.id;
          k.ctl.ex = e.ox;
          k.ctl.ez = e.oz;
          k.ctl.ix = e.ix;
          k.ctl.iz = e.iz;
          setHs(k, 'travel');
        }
        sim.emit({ type: 'killer', s: 'hunt', a: k.id, b: Number(k.ctl.tgt) });
      }
      return 'running';
    }
    case 'travel': {
      if (!tgt || !tgt.alive || Number(k.ctl.hsT) > 160) {
        setHs(k, 'return');
        return 'running';
      }
      const tb = Number(k.ctl.tgtB);
      // the victim went out: follow them instead
      if (tgt.building !== tb && tgt.building < 0) {
        setHs(k, 'stalk');
        return 'running';
      }
      const ex = Number(k.ctl.ex);
      const ez = Number(k.ctl.ez);
      const near = Math.hypot(k.x - ex, k.z - ez) < 18;
      const r = stepGoto(sim, k, { ...task, sneak: near, arrive: 0.6 }, dt, ex, ez);
      if (r === 'done') setHs(k, 'entry');
      else if (r === 'failed') setHs(k, 'return');
      return 'running';
    }
    case 'entry': {
      k.stance = 'crouch';
      k.speed = 0;
      k.anim = 'crouch';
      const ek = String(k.ctl.ek);
      const id = Number(k.ctl.eid);
      if (ek === 'door') {
        const d = sim.world.doors[id];
        const dp = { x: d.axis === 'x' ? d.t : d.c, z: d.axis === 'x' ? d.c : d.t };
        k.yaw = approachAngle(k.yaw, yawTo(k.x, k.z, dp.x, dp.z), dt * 6);
        if (d.locked && !d.broken) {
          k.anim = 'pick';
          if (Math.floor(Number(k.ctl.hsT) * 2) !== Math.floor((Number(k.ctl.hsT) - dt) * 2)) sim.sound('lockpick', dp.x, dp.z, 3.5, k.id);
          if (Number(k.ctl.hsT) > 7) {
            if (sim.chance(0.72)) {
              d.locked = false;
              sim.markForced(d.id);
            } else {
              // give up on this lock, try a window
              const e = entriesFor(sim, Number(k.ctl.tgtB)).find((x) => x.kind === 'window');
              if (!e) {
                setHs(k, 'return');
                return 'running';
              }
              Object.assign(k.ctl, { ek: 'window', eid: e.id, ex: e.ox, ez: e.oz, ix: e.ix, iz: e.iz });
              setHs(k, 'travel');
            }
          }
          return 'running';
        }
        if (d.target < 1) {
          d.target = 1;
          sim.sound('door_open', dp.x, dp.z, 4, k.id);
        }
        if (d.open > 0.7 || d.broken) {
          k.stance = 'crouch';
          setHs(k, 'inside');
        }
        return 'running';
      }
      const w = sim.world.windows[id];
      const wp = { x: w.axis === 'x' ? w.t : w.c, z: w.axis === 'x' ? w.c : w.t };
      k.yaw = approachAngle(k.yaw, yawTo(k.x, k.z, wp.x, wp.z), dt * 6);
      if (w.damage < 2 || w.boarded) {
        k.anim = 'fight';
        if (Number(k.ctl.hsT) > 1.2 && k.attackCd <= 0) {
          k.attackCd = 0.9;
          k.swingT = 0.3;
          sim.damageWindow(id, w.boarded ? 22 : 40, k.id);
        }
        return 'running';
      }
      // climb through the broken window
      const t = Math.min(1, Number(k.ctl.climb ?? 0) + dt / 1.4);
      k.ctl.climb = t;
      k.anim = 'climb';
      const ox = Number(k.ctl.ex);
      const oz = Number(k.ctl.ez);
      const ix = Number(k.ctl.ix);
      const iz = Number(k.ctl.iz);
      k.x = ox + (ix - ox) * t;
      k.z = oz + (iz - oz) * t;
      if (t >= 1) {
        k.ctl.climb = 0;
        setHs(k, 'inside');
      }
      return 'running';
    }
    case 'inside': {
      if (!tgt || !tgt.alive) {
        setHs(k, 'after');
        return 'running';
      }
      if (Number(k.ctl.hsT) > 50) {
        setHs(k, 'return');
        return 'running';
      }
      const d = Math.hypot(tgt.x - k.x, tgt.z - k.z);
      if (d < (tgt.stance === 'lie' || tgt.stance === 'sit' ? 1.7 : 1.4)) {
        setHs(k, 'attack');
        return 'running';
      }
      if (tgt.building !== Number(k.ctl.tgtB) && d > 12) {
        setHs(k, 'stalk');
        return 'running';
      }
      const goal = sim.approachPoint(tgt);
      const r = stepGoto(sim, k, { ...task, sneak: true, arrive: 0.5 }, dt, goal.x, goal.z);
      if (r === 'failed') setHs(k, 'return');
      return 'running';
    }
    case 'stalk': {
      if (!tgt || !tgt.alive) {
        setHs(k, tgt && !tgt.alive ? 'after' : 'return');
        return 'running';
      }
      const d = Math.hypot(tgt.x - k.x, tgt.z - k.z);
      if (d < 1.6) {
        setHs(k, 'attack');
        return 'running';
      }
      if (d > 70 || Number(k.ctl.hsT) > 90) {
        setHs(k, 'return');
        return 'running';
      }
      const r = stepGoto(sim, k, { ...task, sneak: d < 10, run: d > 10 && d < 25 && Number(k.ctl.panic ?? 0) === 0, arrive: 1.0 }, dt, tgt.x, tgt.z);
      if (r === 'failed') setHs(k, 'return');
      return 'running';
    }
    case 'attack': {
      k.stance = 'stand';
      if (!tgt) {
        setHs(k, 'return');
        return 'running';
      }
      if (!tgt.alive) {
        setHs(k, 'after');
        return 'running';
      }
      if (Number(k.ctl.hsT) > 45) {
        setHs(k, 'return');
        return 'running';
      }
      // the victim is hiding in a wardrobe: search for them
      if (tgt.stance === 'hidden' && tgt.usingFurniture >= 0) {
        const f = sim.world.furniture[tgt.usingFurniture];
        const r = stepGoto(sim, k, { ...task, arrive: 0.6 }, dt, f.ux, f.uz);
        if (r === 'failed') setHs(k, 'return');
        if (r !== 'done') return 'running';
        k.anim = 'search';
        k.ctl.searchT = Number(k.ctl.searchT ?? 0) + dt;
        if (Number(k.ctl.searchT) > 2.5) {
          k.ctl.searchT = 0;
          if (sim.chance(0.55)) {
            sim.dragOutOfHiding(tgt);
            sim.sound('wardrobe', f.x, f.z, 10, k.id);
          } else if (Number(k.ctl.hsT) > 20) setHs(k, 'return');
        }
        return 'running';
      }
      // finish off downed victims
      if (tgt.stance === 'downed' && Math.hypot(tgt.x - k.x, tgt.z - k.z) < 1.6) {
        k.yaw = yawTo(k.x, k.z, tgt.x, tgt.z);
        if (k.attackCd <= 0) startAttack(sim, k);
        return 'running';
      }
      const sub: Task = { kind: 'attack', target: tgt.id };
      const r = combatTask(sim, k, sub, dt);
      if (r === 'failed') {
        setHs(k, k.health < 30 ? 'flee' : 'return');
      }
      return 'running';
    }
    case 'after': {
      if (tgt && !tgt.alive && !k.ctl.cluesLeft) {
        k.ctl.cluesLeft = true;
        k.ctl.nightKills = Number(k.ctl.nightKills ?? 0) + 1;
        k.ctl.kills = Number(k.ctl.kills ?? 0) + 1;
        sim.leaveKillerClues(k, tgt);
      }
      const lair = sim.lair;
      const lb = sim.world.buildings[lair.building];
      const timeLeft = h > 18 ? 24 - h + 5 : 5 - h;
      const dLair = Math.hypot(lb.insideFront.x - k.x, lb.insideFront.z - k.z);
      if (tgt && !tgt.alive && tgt.id !== 0 && !k.ctl.decidedDrag) {
        k.ctl.decidedDrag = true;
        if (dLair < 140 && timeLeft > 1.6 && sim.chance(0.4)) {
          k.carrying = tgt.id;
          setHs(k, 'drag');
          return 'running';
        }
      }
      k.ctl.cluesLeft = false;
      k.ctl.decidedDrag = false;
      // another victim tonight?
      if (Number(k.ctl.nightKills) < sim.huntPlan().maxKills && h > 18 && h < 23.5) {
        setHs(k, 'prep');
        return 'running';
      }
      setHs(k, 'return');
      return 'running';
    }
    case 'drag': {
      const body = k.carrying >= 0 ? sim.actors[k.carrying] : null;
      if (!body) {
        setHs(k, 'return');
        return 'running';
      }
      const lb = sim.world.buildings[sim.lair.building];
      const dest = sim.lairPoint();
      const r = stepGoto(sim, k, { ...task, arrive: 0.8 }, dt, dest.x, dest.z);
      k.speed = Math.min(k.speed, 1.1);
      if (r === 'done' || (k.building === lb.id && Math.hypot(k.x - dest.x, k.z - dest.z) < 2.5)) {
        sim.hideBody(k, body);
        setHs(k, 'return');
      } else if (r === 'failed') {
        sim.dropBody(k);
        setHs(k, 'return');
      }
      return 'running';
    }
    case 'flee':
    case 'return': {
      if (k.carrying >= 0) sim.dropBody(k);
      k.stance = 'stand';
      const r = stepGoto(sim, k, { ...task, run: hs === 'flee', arrive: 0.7 }, dt, home.insideFront.x, home.insideFront.z);
      if (r === 'done' || k.building === k.homeId) setHs(k, 'cleanup');
      else if (r === 'failed' && Number(k.ctl.hsT) > 5) {
        // stuck somewhere: drift toward home and retry
        setHs(k, hs);
      }
      return 'running';
    }
    case 'cleanup': {
      const sink = sim.world.furniture.find((f) => f.buildingId === k.homeId && f.use === 'sink' && f.kind !== 'none');
      if (sink && k.bloody > 0.05) {
        const r = stepGoto(sim, k, task, dt, sink.ux, sink.uz);
        if (r === 'running') return 'running';
        k.bloody = 0;
        sim.emit({ type: 'wash', a: k.id });
      }
      if (Number(k.ctl.kills ?? 0) > 0 && !k.ctl.stashed) {
        k.ctl.stashed = true;
        sim.stashKillerEvidence(k);
      }
      for (const did of home.doorIds) if (sim.world.doors[did].exterior) {
        sim.world.doors[did].target = 0;
        sim.world.doors[did].locked = true;
      }
      finishHunt(sim, k);
      setHs(k, 'done');
      return 'done';
    }
    case 'abort':
    default:
      finishHunt(sim, k);
      return 'done';
  }
}

/** stand in a dark spot and watch the player's house, flee if approached */
export function watchTask(sim: Simulation, k: NpcState, task: Task, dt: number): TaskResult {
  const p = sim.player;
  if (!task.started) {
    task.started = true;
    task.t = 0;
    k.outfit = 'night';
    // a dark spot with a view of the player's home
    const home = sim.world.buildings[sim.world.playerHouseId];
    let best = { x: home.outsideFront.x, z: home.outsideFront.z, s: -Infinity };
    for (let i = 0; i < 40; i++) {
      const a = sim.rand(0, Math.PI * 2);
      const r = sim.rand(14, 24);
      const x = home.outsideFront.x + Math.cos(a) * r;
      const z = home.outsideFront.z + Math.sin(a) * r;
      if (sim.pf.nearestFree(x, z, sim.agentFor(k), 1) < 0 || sim.grid.isIndoor(x, z)) continue;
      if (!sim.grid.los(x, z, home.outsideFront.x, home.outsideFront.z)) continue;
      const s = -sim.lightAt(x, z) * 4 + sim.rand(0, 0.5);
      if (s > best.s) best = { x, z, s };
    }
    task.x = best.x;
    task.z = best.z;
  }
  const d = Math.hypot(p.x - k.x, p.z - k.z);
  if (task.data?.fleeing || (d < 9 && visibility(sim, k, p) > 0.2) || (d < 14 && p.flashlight && visibility(sim, p, k) > 0.3)) {
    task.data = { fleeing: true };
    const home = sim.world.buildings[k.homeId];
    const r = stepGoto(sim, k, { ...task, run: true, arrive: 0.7 }, dt, home.insideFront.x, home.insideFront.z);
    if (r !== 'running') {
      k.outfit = 'day';
      return 'done';
    }
    return 'running';
  }
  const r = stepGoto(sim, k, { ...task, arrive: 0.6 }, dt, task.x!, task.z!);
  if (r === 'running') return 'running';
  const home = sim.world.buildings[sim.world.playerHouseId];
  k.speed = 0;
  k.anim = 'idle';
  k.stance = 'stand';
  k.yaw = approachAngle(k.yaw, yawTo(k.x, k.z, home.outsideFront.x, home.outsideFront.z), dt * 3);
  task.t = (task.t ?? 0) + dt * sim.timeScale();
  if (task.t > 1500) {
    task.data = { fleeing: true };
  }
  return 'running';
}

/** knock on the player's door in the middle of the night, then slip away */
export function knockTask(sim: Simulation, k: NpcState, task: Task, dt: number): TaskResult {
  const home = sim.world.buildings[sim.world.playerHouseId];
  const fd = sim.world.doors[home.frontDoorId];
  if (!task.started) {
    k.outfit = 'night';
    const r = stepGoto(sim, k, { ...task, arrive: 0.5 }, dt, home.outsideFront.x, home.outsideFront.z);
    if (r === 'failed') return 'failed';
    if (r === 'running') return 'running';
    task.started = true;
    task.t = 0;
  }
  task.t = (task.t ?? 0) + dt;
  const dp = { x: fd.axis === 'x' ? fd.t : fd.c, z: fd.axis === 'x' ? fd.c : fd.t };
  if (task.t < 4) {
    k.yaw = yawTo(k.x, k.z, dp.x, dp.z);
    k.anim = 'knock';
    if (Math.floor(task.t * 1.4) !== Math.floor((task.t - dt) * 1.4) && task.t < 3) sim.sound('knock', dp.x, dp.z, 18, k.id);
    // try the handle
    if (task.t > 3.2 && !task.data?.tried) {
      task.data = { tried: true };
      sim.sound('handle', dp.x, dp.z, 8, k.id);
      if (!fd.locked && sim.player.alive) {
        // door is unlocked... the hunt is on tonight
        sim.huntPlanOverride({ targetPlayer: true, hunt: true });
      }
    }
    return 'running';
  }
  const kh = sim.world.buildings[k.homeId];
  const r = stepGoto(sim, k, { ...task, run: task.t < 8, arrive: 0.7 }, dt, kh.insideFront.x, kh.insideFront.z);
  if (r !== 'running') {
    k.outfit = 'day';
    return 'done';
  }
  return 'running';
}

export function huntReturnTask(sim: Simulation, k: NpcState, task: Task, dt: number): TaskResult {
  const home = sim.world.buildings[k.homeId];
  if (k.carrying >= 0) sim.dropBody(k);
  const r = stepGoto(sim, k, { ...task, run: true, arrive: 0.7 }, dt, home.insideFront.x, home.insideFront.z);
  if (r === 'running') return 'running';
  k.outfit = 'day';
  k.weapon = null;
  return 'done';
}

export { moveActor, DOOR_W };
