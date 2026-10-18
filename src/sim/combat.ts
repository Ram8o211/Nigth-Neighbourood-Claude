import { approachAngle, wrapAngle, yawTo } from '../core/math';
import type { Simulation } from './simulation';
import type { ActorState, NpcState, Task } from './types';
import { FISTS, ITEMS, type WeaponDef } from './items';
import { CK } from '../world/collision';
import { witnessAct, raiseAlarm } from './perception';
import { followPath, requestPath, leaveFurniture } from './movement';
import type { TaskResult } from './tasks';

export function weaponOf(a: ActorState): WeaponDef {
  if (a.weapon && ITEMS[a.weapon]?.weapon) return ITEMS[a.weapon].weapon!;
  return FISTS;
}

/** begin a swing; the hit is resolved at the windup frame */
export function startAttack(sim: Simulation, a: ActorState): boolean {
  if (!a.alive || a.stance === 'downed' || a.attackCd > 0 || a.staggerT > 0 || a.carrying >= 0) return false;
  const w = weaponOf(a);
  if (a.stamina < w.stamina * 0.5) return false;
  a.stamina = Math.max(0, a.stamina - w.stamina);
  a.attackCd = w.cooldown;
  a.hitPending = w.windup;
  a.swingT = w.windup + 0.28;
  a.swingItem = a.weapon;
  a.blocking = false;
  sim.emit({ type: 'swing', a: a.id, s: a.weapon ?? 'fists' });
  sim.sound('swing', a.x, a.z, 4, a.id);
  return true;
}

/** per-step combat timers for every actor */
export function updateCombat(sim: Simulation, a: ActorState, dt: number) {
  if (a.attackCd > 0) a.attackCd -= dt;
  if (a.swingT > 0) a.swingT -= dt;
  if (a.staggerT > 0) a.staggerT -= dt;
  if (a.hitFlash > 0) a.hitFlash -= dt;
  if (a.hitPending >= 0) {
    a.hitPending -= dt;
    if (a.hitPending < 0) {
      a.hitPending = -1;
      if (a.alive && a.stance !== 'downed') resolveHit(sim, a);
    }
  }
  if (!a.alive) return;
  // bleeding
  if (a.bleeding > 0) {
    a.health -= a.bleeding * dt;
    a.bleeding = Math.max(0, a.bleeding - dt * 0.012);
    const dropT = Number(a.ctl.dripT ?? 0) - dt;
    if (dropT <= 0) {
      sim.addDecal('blood', a.x + sim.rand(-0.2, 0.2), a.y + 0.012, a.z + sim.rand(-0.2, 0.2), 0, 1, 0, 0.18 + a.bleeding * 0.1, 0);
      setCtl(a, 'dripT', a.speed > 0.5 ? 0.9 : 2.5);
    } else setCtl(a, 'dripT', dropT);
    if (a.health <= 0) kill(sim, a, a.lastAttacker, 'bleeding');
  }
  if (a.stance === 'downed') {
    a.downedT -= dt;
    if (a.downedT <= 0 && a.health > 4) {
      a.stance = 'stand';
      a.health = Math.max(a.health, 18);
      sim.emit({ type: 'getup', a: a.id });
    }
  }
  // stamina regeneration
  if (a.kind === 'npc') a.stamina = Math.min(100, a.stamina + dt * 12);
}

function setCtl(a: ActorState, k: string, v: number) {
  a.ctl[k] = v;
}

/** finds who / what a swing connects with and applies damage */
export function resolveHit(sim: Simulation, a: ActorState) {
  const w = a.swingItem && ITEMS[a.swingItem]?.weapon ? ITEMS[a.swingItem].weapon! : FISTS;
  const fx = Math.sin(a.yaw);
  const fz = -Math.cos(a.yaw);
  let best: ActorState | null = null;
  let bestScore = Infinity;
  for (const t of sim.actors) {
    if (t === a || t.inCustody || t.stance === 'hidden') continue;
    if (!t.alive && t.stance === 'dead') continue;
    const dx = t.x - a.x;
    const dz = t.z - a.z;
    const d = Math.hypot(dx, dz);
    const extra = t.usingFurniture >= 0 && (t.stance === 'lie' || t.stance === 'sit') ? 0.9 : 0;
    if (d > w.range + t.radius + extra) continue;
    const ang = Math.abs(wrapAngle(Math.atan2(dx, -dz) - a.yaw));
    if (ang > w.arc + 0.25 && d > 0.6) continue;
    if (sim.colliders.segmentBlocked(a.x, a.z, t.x, t.z, 1.2)) continue;
    const score = d + ang * 0.8;
    if (score < bestScore) {
      bestScore = score;
      best = t;
    }
  }
  if (best) {
    damageActor(sim, best, a, w);
    return;
  }
  // hit the world: windows, doors, walls
  const hit = sim.colliders.firstHit(a.x, a.z, a.x + fx * w.range, a.z + fz * w.range, 1.2);
  if (!hit) return;
  const hx = a.x + fx * w.range * hit.t;
  const hz = a.z + fz * w.range * hit.t;
  const c = hit.c;
  if (c.kind === CK.Window) sim.damageWindow(c.ref, w.breaks, a.id);
  else if (c.kind === CK.Door) sim.damageDoor(c.ref, w.breaks, a.id);
  else {
    const mat = c.kind === CK.Wall ? 'wall' : c.kind === CK.Furniture ? 'wood' : 'wood';
    sim.emit({ type: 'impact', s: mat, x: hx, y: a.y + 1.2, z: hz });
    sim.sound('thud', hx, hz, 10, a.id);
  }
}

export function damageActor(sim: Simulation, t: ActorState, attacker: ActorState, w: WeaponDef) {
  let dmg = w.damage * sim.rand(0.85, 1.15);
  // blocking reduces damage when facing the attacker
  const facing = Math.abs(wrapAngle(yawTo(t.x, t.z, attacker.x, attacker.z) - t.yaw)) < 1.2;
  const blocked = t.blocking && facing && t.stamina > 5;
  if (blocked) {
    dmg *= 0.25;
    t.stamina = Math.max(0, t.stamina - w.damage * 0.9);
    sim.sound('block', t.x, t.z, 10, t.id);
    sim.emit({ type: 'block', a: t.id, x: t.x, y: t.y + 1.3, z: t.z });
  }
  // unaware / sleeping victims take much more damage
  const npcT = t.kind === 'npc' ? (t as NpcState) : null;
  const unaware = npcT ? npcT.sleeping || (npcT.aware[attacker.id] ?? 0) < 0.3 : false;
  if (unaware) dmg *= 2.2;
  // the Night Neighbour strikes with practised brutality
  if (attacker.kind === 'npc' && (attacker as NpcState).role === 'killer') dmg *= 1.35;
  if (t.stance === 'downed') dmg *= 1.6;
  t.health -= dmg;
  t.hitFlash = 0.2;
  t.lastAttacker = attacker.id;
  t.staggerT = Math.max(t.staggerT, blocked ? 0.12 : 0.35);
  if (npcT && npcT.sleeping) {
    npcT.sleeping = false;
    leaveFurniture(sim, npcT);
    npcT.stance = 'stand';
  }
  // knock back
  const kb = blocked ? 0.15 : 0.35;
  const dx = t.x - attacker.x;
  const dz = t.z - attacker.z;
  const dl = Math.hypot(dx, dz) || 1;
  if (t.alive && t.stance !== 'dead') {
    const p = { x: t.x + (dx / dl) * kb, z: t.z + (dz / dl) * kb };
    sim.colliders.resolveCircle(p, t.radius);
    t.x = p.x;
    t.z = p.z;
  }
  const hy = t.y + 1.25;
  if (!blocked) {
    if (sim.chance(w.bleed)) t.bleeding = Math.min(3, t.bleeding + sim.rand(0.4, 1.2));
    const amount = w.blood * (0.6 + dmg / 30);
    sim.emit({ type: 'blood', x: t.x, y: hy, z: t.z, v: amount, dir: Math.atan2(dx, -dz) });
    sim.splatterBlood(t.x, t.z, t.y, Math.atan2(dx, -dz), amount);
    attacker.bloody = Math.min(1, attacker.bloody + amount * 0.18);
    t.bloody = Math.min(1, t.bloody + amount * 0.25);
  }
  sim.sound('hit', t.x, t.z, 16 + w.noise * 0.6, attacker.id);
  sim.emit({ type: 'hit', a: t.id, b: attacker.id, v: dmg, s: blocked ? 'block' : attacker.swingItem ?? 'fists', x: t.x, y: hy, z: t.z });
  if (t.kind === 'npc' && !blocked && dmg > 6) sim.sound('hurt', t.x, t.z, 20, t.id);
  // fighting back against your own attacker is self defence, not a new crime
  const selfDefence = attacker.lastAttacker === t.id && sim.time - Number(attacker.ctl.hitAt ?? -1e9) < 900;
  if (selfDefence) witnessAct(sim, attacker.id, 'fight', t.x, t.z, t.id, sim.incidentForVictim(attacker.id), 0.5, true);
  else {
    const incident = sim.violence(attacker, t);
    witnessAct(sim, attacker.id, 'attack', t.x, t.z, t.id, incident, 0.95);
  }
  t.ctl.hitAt = sim.time;
  if (npcT) raiseAlarm(sim, npcT, 1, attacker.id, attacker.x, attacker.z);
  if (t.health <= 0) kill(sim, t, attacker.id, 'violence');
  else if (t.health < 15 && t.stance !== 'downed') {
    t.stance = 'downed';
    t.downedT = sim.rand(15, 30);
    t.speed = 0;
    sim.emit({ type: 'downed', a: t.id });
  } else if (!blocked && sim.chance(w.knockdown) && t.stance !== 'downed') {
    t.stance = 'downed';
    t.downedT = sim.rand(1.5, 3);
    sim.emit({ type: 'downed', a: t.id });
  }
}

export function kill(sim: Simulation, t: ActorState, by: number, cause: string) {
  if (!t.alive) return;
  t.alive = false;
  t.health = 0;
  t.stance = 'dead';
  t.deathTime = sim.time;
  t.bleeding = 0;
  t.speed = 0;
  t.flashlight = false;
  t.carrying = -1;
  t.swingT = 0;
  t.hitPending = -1;
  if (t.kind === 'npc') {
    const n = t as NpcState;
    n.tasks.length = 0;
    n.activity = null;
    n.sleeping = false;
    if (n.usingFurniture >= 0) {
      const f = sim.world.furniture[n.usingFurniture];
      if (f && f.use !== 'bed') {
        n.x = f.ux;
        n.z = f.uz;
      }
      n.usingFurniture = -1;
    }
  }
  sim.addDecal('pool', t.x, t.y + 0.014, t.z, 0, 1, 0, 0.5, sim.rand(0, 6.28), 1);
  sim.sound('death', t.x, t.z, 28, t.id);
  sim.emit({ type: 'death', a: t.id, b: by, s: cause, x: t.x, y: t.y, z: t.z });
  sim.onDeath(t, by, cause);
}

// ---------------------------------------------------------------------------
// npc fighting behaviour

/** task 'attack': engage a target until it is down, dead, or we must flee */
export function combatTask(sim: Simulation, npc: NpcState, task: Task, dt: number): TaskResult {
  const t = sim.actors[task.target!];
  if (!t || !t.alive || t.inCustody) return 'done';
  if (npc.stance === 'downed') return 'running';
  const police = npc.role === 'police';
  const killer = npc.role === 'killer';
  // police stop once the suspect is down and arrest instead
  if (police && t.stance === 'downed') return 'done';
  // ordinary people stop once their attacker is down
  if (!killer && !police && t.stance === 'downed') return 'done';
  // break off and flee when badly hurt
  if (!killer && !police && npc.health < 30) {
    sim.fleeFrom(npc, t.x, t.z);
    return 'failed';
  }
  if (killer && npc.health < 25) return 'failed';
  const d = Math.hypot(t.x - npc.x, t.z - npc.z);
  if (d > 30 || (d > 8 && !sim.grid.los(npc.x, npc.z, t.x, t.z) && (task.t ?? 0) > 20)) return 'failed';
  task.t = (task.t ?? 0) + dt;
  const w = weaponOf(npc);
  npc.yaw = approachAngle(npc.yaw, yawTo(npc.x, npc.z, t.x, t.z), dt * 10);
  // block if the opponent is mid-swing and we are not attacking
  npc.blocking = t.swingT > 0 && t.hitPending > 0 && npc.swingT <= 0 && npc.stamina > 15 && sim.chance(dt * (npc.traits.bravery * 4 + 1));
  // someone lying in bed / sitting can be reached from beside the furniture
  let reach = d <= w.range + t.radius - 0.06;
  if (!reach && t.usingFurniture >= 0) {
    const f = sim.world.furniture[t.usingFurniture];
    if (f) {
      const cx = Math.max(f.x - f.w / 2, Math.min(npc.x, f.x + f.w / 2));
      const cz = Math.max(f.z - f.d / 2, Math.min(npc.z, f.z + f.d / 2));
      reach = Math.hypot(cx - npc.x, cz - npc.z) < 0.9 && d < w.range + 1.0;
    }
  }
  if (!reach) {
    // chase (towards where the target can actually be reached)
    const goal = sim.approachPoint(t);
    if (!npc.path || !npc.pathGoal || Math.hypot(npc.pathGoal.x - goal.x, npc.pathGoal.z - goal.z) > 1.5) {
      const r = requestPath(sim, npc, goal.x, goal.z);
      if (r === 'fail') {
        task.data = { ...(task.data ?? {}), fails: Number(task.data?.fails ?? 0) + 1 };
        if (d > 3 || Number(task.data.fails) > 6) return 'failed';
      }
    }
    if (npc.path) {
      const r = followPath(sim, npc, dt, police || killer ? 4.4 : 3.8, w.range * 0.7);
      if (r === 'blocked') {
        // locked door between us: kick it if furious
        npc.path = null;
      }
    }
    npc.anim = 'run';
    return 'running';
  }
  npc.path = null;
  npc.speed = 0;
  npc.anim = 'fight';
  if (npc.attackCd <= 0 && npc.swingT <= 0 && !npc.blocking && npc.staggerT <= 0) {
    if (sim.chance(dt * (1.8 + npc.traits.aggression * 2.5))) startAttack(sim, npc);
  }
  // circle a little
  if (sim.chance(dt * 0.8)) {
    const side = sim.chance(0.5) ? 1 : -1;
    const px = Math.cos(npc.yaw) * side * 0.4;
    const pz = Math.sin(npc.yaw) * side * 0.4;
    const p = { x: npc.x + px, z: npc.z + pz };
    sim.colliders.resolveCircle(p, npc.radius);
    npc.x = p.x;
    npc.z = p.z;
  }
  return 'running';
}
