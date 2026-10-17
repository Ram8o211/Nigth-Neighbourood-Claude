import { wrapAngle, yawTo } from '../core/math';
import type { Simulation } from './simulation';
import type { ActorState, MemTopic, NpcState } from './types';
import { describeActor, identifies, remember } from './memory';
import { CFG, isDark, isNight } from './config';

/**
 * How visible `target` is to `observer` (0..1). Accounts for field of view,
 * line of sight, light at the target, distance, stance and motion.
 */
export function visibility(sim: Simulation, observer: ActorState, target: ActorState): number {
  if (!observer.alive || observer.stance === 'downed' || observer.stance === 'hidden') return 0;
  if ((observer as NpcState).sleeping) return 0;
  if (target.stance === 'hidden' || target.inCustody) return 0;
  const dx = target.x - observer.x;
  const dz = target.z - observer.z;
  const d = Math.hypot(dx, dz);
  if (d > 45) return 0;
  const ang = Math.abs(wrapAngle(yawTo(observer.x, observer.z, target.x, target.z) - observer.yaw));
  let fov = ang < 1.05 ? 1 : ang < 1.75 ? 0.3 : 0;
  if (d < 1.2) fov = Math.max(fov, 0.6); // you notice someone right beside you
  if (fov <= 0) return 0;
  if (!sim.grid.los(observer.x, observer.z, target.x, target.z)) return 0;
  let L = sim.lightAt(target.x, target.z);
  if (target.flashlight) L = Math.max(L, 0.95);
  const range = 5 + 37 * Math.min(1, L);
  const distF = Math.max(0, 1 - d / range);
  if (distF <= 0) return 0;
  let stance = target.stance === 'crouch' ? 0.55 : target.stance === 'lie' || target.stance === 'dead' || target.stance === 'downed' ? 0.8 : 1;
  if (target.speed > 3) stance *= 1.25;
  else if (target.speed < 0.2) stance *= 0.8;
  return Math.min(1, distF * fov * stance * 1.15);
}

export function lightLabel(L: number) {
  return L > 0.6 ? 'lit' : L > 0.25 ? 'dim' : 'dark';
}

/** periodic sight processing for one npc */
export function perceive(sim: Simulation, npc: NpcState, interval: number) {
  if (!npc.alive || npc.sleeping || npc.stance === 'downed' || npc.inCustody) return;
  const hour = sim.hour();
  const night = isNight(hour);
  for (const t of sim.actors) {
    if (t === npc) continue;
    if (Math.abs(t.x - npc.x) > 45 || Math.abs(t.z - npc.z) > 45) continue;
    const vis = visibility(sim, npc, t);
    const prev = npc.aware[t.id] ?? 0;
    const aw = vis > 0 ? Math.min(1, prev + vis * interval * 4) : Math.max(0, prev - interval * 0.5);
    if (aw <= 0.01) delete npc.aware[t.id];
    else npc.aware[t.id] = aw;
    if (aw < 0.6 || vis <= 0) continue;
    const d = Math.hypot(t.x - npc.x, t.z - npc.z);
    const ident = identifies(sim, npc, t, vis, d);
    if (t.kind === 'player' && d < 4 && vis > 0.6 && sim.player.knownTo.includes(npc.id)) npc.metPlayer = true;
    const desc = describeActor(sim, t, vis, d);
    const base = { source: 'saw' as const, actor: ident ? t.id : -1, desc, x: t.x, z: t.z, time: sim.time, confidence: vis, from: -1 };
    // a dead body (the culprit does not 'discover' its own work)
    if (!t.alive && !t.bodyRemoved && npc.role === 'killer') continue;
    if (!t.alive && !t.bodyRemoved) {
      const m = remember(sim, npc, { ...base, topic: 'body', actor: -1, subject: t.id, incident: sim.incidentForVictim(t.id) });
      if (!m.reported) sim.discoverBody(t.id, npc.id);
      raiseAlarm(sim, npc, 0.95, -1, t.x, t.z);
      continue;
    }
    if (!t.alive) continue;
    if (t.kind === 'npc' && (t as NpcState).role === 'police' && !t.flashlight && t.outfit === 'day') {
      // uniformed police are not suspicious
      continue;
    }
    if (t.carrying >= 0) {
      remember(sim, npc, { ...base, topic: 'murder', subject: t.carrying, incident: sim.incidentForVictim(t.carrying) });
      raiseAlarm(sim, npc, 1, t.id, t.x, t.z);
      continue;
    }
    if (t.bloody > 0.35 && vis > 0.45) {
      remember(sim, npc, { ...base, topic: 'blood', subject: -1, incident: -1 });
      // a bloodied person is only a threat if they are armed too (victims are bloody as well)
      raiseAlarm(sim, npc, 0.5, t.weapon ? t.id : -1, t.x, t.z);
      if (t.kind === 'player') npc.suspicionOfPlayer = Math.min(1, npc.suspicionOfPlayer + 0.2);
    }
    const weaponOut = t.weapon && t.weapon !== 'flashlight' && (t.kind === 'npc' || sim.playerWeaponDrawn());
    if (weaponOut && (night || d < 6) && vis > 0.4) {
      remember(sim, npc, { ...base, topic: 'weapon', subject: -1, incident: -1 });
      raiseAlarm(sim, npc, night ? 0.45 : 0.25, t.id, t.x, t.z);
      if (t.kind === 'player') npc.suspicionOfPlayer = Math.min(1, npc.suspicionOfPlayer + 0.08);
    }
    // somebody in my home who does not live here
    const tNpc = t.kind === 'npc' ? (t as NpcState) : null;
    const resident = tNpc && tNpc.household === npc.household;
    if (t.building >= 0 && t.building === npc.homeId && !resident && !(tNpc && tNpc.role === 'police')) {
      const invited = sim.isInvited(npc, t.id);
      if (!invited) {
        remember(sim, npc, { ...base, topic: 'trespass', subject: npc.id, incident: -1 });
        raiseAlarm(sim, npc, night ? 0.85 : 0.6, t.id, t.x, t.z);
        if (t.kind === 'player') npc.suspicionOfPlayer = Math.min(1, npc.suspicionOfPlayer + 0.3);
      }
    }
    if (night && t.building < 0) {
      // night time observations become alibi information
      if (t.outfit === 'night' || (t.stance === 'crouch' && isDark(hour))) {
        remember(sim, npc, { ...base, topic: 'prowler', subject: -1, incident: -1 });
        raiseAlarm(sim, npc, 0.45, ident ? t.id : -1, t.x, t.z);
      } else if (vis > 0.45) remember(sim, npc, { ...base, topic: 'leftHome', subject: -1, incident: -1 });
    }
  }
}

export function raiseAlarm(sim: Simulation, npc: NpcState, level: number, threat: number, x: number, z: number) {
  if (level > npc.alarm || threat >= 0) {
    npc.threatX = x;
    npc.threatZ = z;
    if (threat >= 0) npc.threat = threat;
  }
  npc.alarm = Math.min(1, Math.max(npc.alarm, level));
  npc.needs.fear = Math.min(100, npc.needs.fear + level * 30);
  // force a re-think soon
  npc.thinkT = Math.min(npc.thinkT, 0.05);
}

const SOUND_TOPIC: Record<string, MemTopic | null> = {
  glass: 'glass',
  glass_crack: null,
  scream: 'scream',
  hit: 'fight',
  fight: 'fight',
  death: 'scream',
  kick: 'breakin',
  door_force: 'breakin',
  knock: 'knock',
  footstep: 'footsteps',
  lockpick: 'footsteps',
};

/** a sound propagates to listeners. `loud` is the audible radius for an awake listener in metres. */
export function hearSound(sim: Simulation, kind: string, x: number, z: number, loud: number, source: number) {
  const topic = SOUND_TOPIC[kind];
  if (topic === undefined || topic === null) return;
  const night = isNight(sim.hour());
  for (const npc of sim.npcs) {
    if (!npc.alive || npc.id === source || npc.inCustody || npc.stance === 'downed') continue;
    const d = Math.hypot(npc.x - x, npc.z - z);
    if (d > loud * 1.1) continue;
    let eff = loud * sim.grid.soundOcclusion(npc.x, npc.z, x, z);
    if (npc.sleeping) eff *= CFG.sleepHearing + npc.traits.vigilance * 0.45;
    if (d > eff) continue;
    // footsteps only matter when they are inside your own home and not a housemate
    if (topic === 'footsteps') {
      const src = sim.actors[source];
      if (!src || src.building !== npc.homeId) continue;
      if (src.kind === 'npc' && (src as NpcState).household === npc.household) continue;
      if (src.kind === 'npc' && (src as NpcState).role === 'police') continue;
      if (src.kind === 'player' && sim.isInvited(npc, 0)) continue;
    }
    if (topic === 'knock' && sim.actors[source]?.kind === 'npc') continue;
    const clarity = Math.max(0.15, 1 - d / Math.max(1, eff));
    const err = d * 0.18 * (1 - clarity);
    const hx = x + sim.rand(-err, err);
    const hz = z + sim.rand(-err, err);
    if (npc.sleeping) {
      npc.sleeping = false;
      npc.stance = 'stand';
      npc.usingFurniture = -1;
      sim.emit({ type: 'wake', a: npc.id });
    }
    remember(sim, npc, { topic, source: 'heard', actor: -1, subject: -1, desc: {}, x: hx, z: hz, time: sim.time, confidence: clarity, from: -1, incident: sim.incidentNear(x, z, 120) });
    const level = topic === 'scream' ? 0.8 : topic === 'glass' ? (night ? 0.7 : 0.35) : topic === 'fight' ? 0.7 : topic === 'breakin' ? 0.75 : topic === 'footsteps' ? 0.75 : night ? 0.35 : 0.15;
    raiseAlarm(sim, npc, level * (0.6 + clarity * 0.4), -1, hx, hz);
  }
}

/** an instantaneous act is seen by whoever is looking */
export function witnessAct(sim: Simulation, actorId: number, topic: MemTopic, x: number, z: number, subject: number, incident: number, alarm: number, defensive = false) {
  const actor = sim.actors[actorId];
  if (!actor) return;
  for (const npc of sim.npcs) {
    if (npc.id === actorId || npc.id === subject) continue;
    if (!npc.alive || npc.sleeping) continue;
    const vis = visibility(sim, npc, actor);
    if (vis < 0.12) continue;
    const d = Math.hypot(actor.x - npc.x, actor.z - npc.z);
    const ident = identifies(sim, npc, actor, vis, d);
    remember(sim, npc, { topic, source: 'saw', actor: ident ? actorId : -1, subject, desc: describeActor(sim, actor, vis, d), x, z, time: sim.time, confidence: vis, from: -1, incident });
    // a defender is not the threat: point the alarm at whoever started it
    raiseAlarm(sim, npc, alarm, defensive ? subject : actorId, x, z);
    if (defensive) continue;
    if (actorId === 0) {
      npc.suspicionOfPlayer = Math.min(1, npc.suspicionOfPlayer + alarm * 0.6);
      if (ident) sim.player.wantedLevel = Math.max(sim.player.wantedLevel, alarm >= 0.9 ? 2 : 1);
    }
    sim.emit({ type: 'witness', a: npc.id, b: actorId, s: topic });
  }
}
