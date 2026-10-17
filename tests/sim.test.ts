import { describe, it, expect } from 'vitest';
import { makeSim, runHours, runUntilHour, freeSpot, hold } from './helpers';
import { Simulation } from '../src/sim/simulation';
import { generateWorld } from '../src/world/gen/generator';
import { visibility, hearSound, witnessAct } from '../src/sim/perception';
import { shareGossip, remember } from '../src/sim/memory';
import { startAttack, updateCombat } from '../src/sim/combat';
import type { NpcState } from '../src/sim/types';

function stateHash(sim: Simulation) {
  return JSON.stringify({
    t: Math.round(sim.time * 1000),
    a: sim.actors.map((a) => [a.x.toFixed(3), a.z.toFixed(3), a.health.toFixed(2), a.alive, (a as NpcState).activity?.kind ?? '']),
    i: sim.incidents.length,
    c: sim.cases.map((c) => c.status),
  });
}

/** two outdoor npcs standing 8 m apart in the street, observer facing the target */
function stage(sim: Simulation) {
  const [obs, tgt] = sim.npcs.filter((n) => n.role === 'resident').slice(0, 2);
  const road = sim.world.roads[0].rect;
  const spot = freeSpot(sim, (road.x0 + road.x1) / 2, (road.z0 + road.z1) / 2)!;
  hold(sim, obs);
  hold(sim, tgt);
  obs.x = spot.x;
  obs.z = spot.z;
  const spot2 = freeSpot(sim, spot.x + 8, spot.z, 3) ?? freeSpot(sim, spot.x, spot.z + 8, 3)!;
  tgt.x = spot2.x;
  tgt.z = spot2.z;
  obs.room = tgt.room = -1;
  obs.building = tgt.building = -1;
  obs.yaw = Math.atan2(tgt.x - obs.x, -(tgt.z - obs.z));
  return { obs, tgt };
}

describe('population', () => {
  it('is reproducible and well formed', () => {
    const a = makeSim('pop-test');
    const b = makeSim('pop-test');
    expect(a.npcs.map((n) => `${n.first} ${n.last} ${n.role} ${n.job}`)).toEqual(b.npcs.map((n) => `${n.first} ${n.last} ${n.role} ${n.job}`));
    expect(a.npcs.filter((n) => n.role === 'killer').length).toBe(1);
    expect(a.npcs.filter((n) => n.role === 'police').length).toBeGreaterThanOrEqual(2);
    expect(a.npcs.some((n) => n.job === 'chief')).toBe(true);
    for (const n of a.npcs) {
      expect(n.homeId).toBeGreaterThanOrEqual(0);
      expect(a.world.buildings[n.homeId]).toBeDefined();
      expect(n.app.height).toBeGreaterThan(1.4);
    }
    // the killer has a lair to bring victims to
    expect(a.lair.building).toBeGreaterThanOrEqual(0);
  });
});

describe('simulation core', () => {
  it('is deterministic for a seed', () => {
    const a = makeSim('det');
    const b = makeSim('det');
    for (let i = 0; i < 1500; i++) {
      a.step(1 / 20);
      b.step(1 / 20);
    }
    expect(stateHash(a)).toEqual(stateHash(b));
  });

  it('residents work by day and sleep at night', () => {
    const sim = makeSim('routine');
    runUntilHour(sim, 11);
    const workers = sim.npcs.filter((n) => n.alive && n.role === 'resident' && n.workId >= 0);
    const atWork = workers.filter((n) => n.building === n.workId || n.activity?.kind === 'work');
    expect(atWork.length / Math.max(1, workers.length)).toBeGreaterThan(0.4);
    runUntilHour(sim, 3);
    const residents = sim.npcs.filter((n) => n.alive && n.role === 'resident' && !n.inCustody);
    const asleep = residents.filter((n) => n.sleeping);
    expect(asleep.length / residents.length).toBeGreaterThan(0.8);
    // couples share a double bed: both partners get to sleep in it
    const shared = sim.world.furniture.filter((f) => f.use === 'bed' && asleep.filter((n) => n.usingFurniture === f.id).length === 2);
    expect(shared.length).toBeGreaterThan(0);
    for (const f of shared) {
      const [a, b] = asleep.filter((n) => n.usingFurniture === f.id);
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(0.5); // side by side, not on top of each other
    }
    // and most of the sleepers are at home
    const home = asleep.filter((n) => n.building === n.homeId);
    expect(home.length / Math.max(1, asleep.length)).toBeGreaterThan(0.8);
  });
});

describe('perception', () => {
  it('sees less in darkness and nothing through walls or behind', () => {
    const sim = makeSim('percept');
    const { obs, tgt } = stage(sim);
    for (const l of sim.world.lights) l.on = false;
    sim.time = 12 * 3600;
    const day = visibility(sim, obs, tgt);
    sim.time = 24 * 3600 + 2 * 3600;
    const night = visibility(sim, obs, tgt);
    expect(day).toBeGreaterThan(0.3);
    expect(night).toBeLessThan(day * 0.5);
    // a flashlight gives you away
    tgt.flashlight = true;
    expect(visibility(sim, obs, tgt)).toBeGreaterThan(night);
    tgt.flashlight = false;
    // facing away
    sim.time = 12 * 3600;
    obs.yaw += Math.PI;
    expect(visibility(sim, obs, tgt)).toBe(0);
    obs.yaw -= Math.PI;
    // inside a house, an outdoor target is behind walls unless a window is in the way
    const house = sim.world.buildings.find((b) => b.kind === 'house')!;
    const room = sim.world.rooms[house.roomIds[0]];
    obs.x = (room.rect.x0 + room.rect.x1) / 2;
    obs.z = (room.rect.z0 + room.rect.z1) / 2;
    tgt.x = house.rect.x0 - 6;
    tgt.z = house.rect.z0 - 6;
    obs.yaw = Math.atan2(tgt.x - obs.x, -(tgt.z - obs.z));
    if (!sim.grid.los(obs.x, obs.z, tgt.x, tgt.z)) expect(visibility(sim, obs, tgt)).toBe(0);
  });

  it('records witnessed, heard and told memories separately', () => {
    const sim = makeSim('memory');
    const { obs, tgt } = stage(sim);
    sim.time = 13 * 3600;
    witnessAct(sim, tgt.id, 'attack', tgt.x, tgt.z, -1, -1, 0.8);
    const saw = obs.memories.find((m) => m.topic === 'attack');
    expect(saw?.source).toBe('saw');
    expect(saw?.actor).toBe(tgt.id); // close, daylight: identified
    // a scream heard from a distance
    hearSound(sim, 'scream', obs.x + 12, obs.z, 30, -1);
    const heard = obs.memories.find((m) => m.topic === 'scream');
    expect(heard?.source).toBe('heard');
    // gossip passes it on as hearsay
    const third = sim.npcs.find((n) => n.role === 'resident' && n !== obs && n !== tgt && !n.memories.some((m) => m.topic === 'attack'))!;
    shareGossip(sim, obs, third);
    const told = third.memories.find((m) => m.topic === 'attack');
    expect(told?.source).toBe('told');
    expect(told?.from).toBe(obs.id);
    expect(told!.confidence).toBeLessThan(saw!.confidence);
  });

  it('merges repeated observations instead of flooding memory', () => {
    const sim = makeSim('memory2');
    const { obs, tgt } = stage(sim);
    const base = { topic: 'prowler' as const, source: 'saw' as const, actor: tgt.id, subject: -1, desc: {}, x: tgt.x, z: tgt.z, confidence: 0.6, from: -1, incident: -1 };
    for (let i = 0; i < 20; i++) remember(sim, obs, { ...base, time: sim.time + i });
    expect(obs.memories.filter((m) => m.topic === 'prowler').length).toBeLessThanOrEqual(2);
  });
});

describe('combat', () => {
  it('hits in range, never through walls, and kills', () => {
    const sim = makeSim('combat');
    const { obs: att, tgt } = stage(sim);
    // attacker right next to the target
    att.x = tgt.x - 1.2;
    att.z = tgt.z;
    att.yaw = Math.atan2(tgt.x - att.x, -(tgt.z - att.z));
    att.weapon = 'baseball_bat';
    const hp0 = tgt.health;
    expect(startAttack(sim, att)).toBe(true);
    for (let i = 0; i < 20; i++) updateCombat(sim, att, 0.05);
    expect(tgt.health).toBeLessThan(hp0);
    // a cooldown prevents spamming
    att.attackCd = 0.5;
    expect(startAttack(sim, att)).toBe(false);
    // through a wall: put the target inside a house and the attacker outside
    const house = sim.world.buildings.find((b) => b.kind === 'house' && b.id !== sim.world.playerHouseId)!;
    const room = sim.world.rooms[house.roomIds[0]];
    const r = room.rect;
    // stand just outside the west wall of the room, target just inside
    tgt.x = r.x0 + 0.5;
    tgt.z = (r.z0 + r.z1) / 2;
    att.x = r.x0 - 0.7;
    att.z = tgt.z;
    att.yaw = Math.atan2(tgt.x - att.x, -(tgt.z - att.z));
    if (sim.colliders.segmentBlocked(att.x, att.z, tgt.x, tgt.z, 1.2)) {
      const hp1 = tgt.health;
      att.attackCd = 0;
      att.stamina = 100;
      startAttack(sim, att);
      for (let i = 0; i < 20; i++) updateCombat(sim, att, 0.05);
      expect(tgt.health).toBe(hp1);
    }
    // keep attacking in the open until the target dies
    tgt.x = att.x + 1.1;
    tgt.z = att.z;
    const road = freeSpot(sim, sim.world.roads[0].rect.x0 + 5, (sim.world.roads[0].rect.z0 + sim.world.roads[0].rect.z1) / 2)!;
    att.x = road.x;
    att.z = road.z;
    tgt.x = road.x + 1.1;
    tgt.z = road.z;
    tgt.room = -1;
    tgt.building = -1;
    att.yaw = Math.atan2(tgt.x - att.x, -(tgt.z - att.z));
    for (let k = 0; k < 40 && tgt.alive; k++) {
      att.attackCd = 0;
      att.stamina = 100;
      tgt.blocking = false;
      tgt.x = att.x + 1.1;
      tgt.z = att.z;
      startAttack(sim, att);
      for (let i = 0; i < 12; i++) {
        updateCombat(sim, att, 0.05);
        updateCombat(sim, tgt, 0.05);
      }
    }
    expect(tgt.alive).toBe(false);
    expect(tgt.stance).toBe('dead');
    expect(sim.incidents.some((i) => i.victim === tgt.id && i.perp === att.id)).toBe(true);
    // blood was spilled
    expect(sim.decals.some((d) => d.kind === 'blood' || d.kind === 'pool')).toBe(true);
  });

  it('witnessed violence by the player leads to a police case', () => {
    const sim = makeSim('witness');
    runUntilHour(sim, 13);
    const { obs: witness, tgt: victim } = stage(sim);
    const p = sim.player;
    p.x = victim.x - 1.1;
    p.z = victim.z;
    p.room = -1;
    p.building = -1;
    p.yaw = Math.atan2(victim.x - p.x, -(victim.z - p.z));
    p.weapon = 'kitchen_knife';
    witness.yaw = Math.atan2(p.x - witness.x, -(p.z - witness.z));
    // the witness has met the player before, so they can put a name to the face
    witness.metPlayer = true;
    p.knownTo.push(witness.id);
    for (let k = 0; k < 60 && victim.alive; k++) {
      p.attackCd = 0;
      p.stamina = 100;
      victim.x = p.x + 1.1;
      victim.z = p.z;
      victim.blocking = false;
      p.yaw = Math.atan2(victim.x - p.x, -(victim.z - p.z));
      startAttack(sim, p);
      for (let i = 0; i < 8; i++) sim.step(0.05);
    }
    expect(victim.alive).toBe(false);
    const sawIt = sim.npcs.filter((n) => n.memories.some((m) => m.source === 'saw' && (m.topic === 'murder' || m.topic === 'attack') && m.actor === 0));
    expect(sawIt.length).toBeGreaterThan(0);
    expect(p.wantedLevel).toBeGreaterThan(0);
    runHours(sim, 3);
    const c = sim.cases.find((c) => c.reports.length > 0 && (c.kind === 'homicide' || c.kind === 'assault'));
    expect(c, 'a police case was opened from the witness report').toBeDefined();
    // officers were sent out
    expect(sim.npcs.some((n) => n.role === 'police' && n.memories.length > 0)).toBe(true);
  });
});

describe('save / load', () => {
  it('restores the full state and continues identically', () => {
    const a = makeSim('saveload');
    runHours(a, 15); // into the evening of day 1
    const snap = JSON.parse(JSON.stringify(a.snapshot()));
    // restore into a fresh simulation built from a freshly generated world (as the game does)
    const b = new Simulation(generateWorld(a.world.params));
    b.populate();
    b.restore(snap);
    expect(stateHash(b)).toEqual(stateHash(a));
    for (let i = 0; i < 1200; i++) {
      a.step(1 / 20);
      b.step(1 / 20);
    }
    expect(stateHash(b)).toEqual(stateHash(a));
  });
});
