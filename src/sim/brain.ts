import type { Simulation } from './simulation';
import type { Activity, NpcState, Task } from './types';
import { clearTasks } from './tasks';
import { isDark, isNight, SHOP_COST } from './config';

/** is hour h inside the window [a, b) where a, b may exceed 24 */
export function inWindow(h: number, a: number, b: number): boolean {
  const A = ((a % 24) + 24) % 24;
  const B = ((b % 24) + 24) % 24;
  if (Math.abs(b - a) >= 24) return true;
  return A <= B ? h >= A && h < B : h >= A || h < B;
}

/** absolute game time of the next occurrence of hour h */
export function nextHour(sim: Simulation, h: number): number {
  const day0 = Math.floor(sim.time / 86400) * 86400;
  let t = day0 + (((h % 24) + 24) % 24) * 3600;
  if (t <= sim.time + 60) t += 86400;
  return t;
}

export function setActivity(sim: Simulation, npc: NpcState, kind: string, priority: number, tasks: Task[], data: Activity['data'] = {}, until = Infinity) {
  clearTasks(sim, npc);
  sim.onActivity?.(npc, kind);
  npc.activity = { kind, priority, started: sim.time, until, data };
  npc.tasks = tasks;
  npc.lockBehind = -1;
  // leaving an otherwise empty home: lock up behind (unless careless)
  if (npc.building === npc.homeId && kind !== 'sleep' && kind !== 'relax' && kind !== 'eat' && kind !== 'lockdown' && kind !== 'hide') {
    const others = sim.npcs.some((o) => o !== npc && o.alive && o.household === npc.household && o.building === npc.homeId);
    const home = sim.world.buildings[npc.homeId];
    if (!others && npc.traits.careless < 0.6) npc.lockBehind = home.frontDoorId;
  }
}

function travelHours(sim: Simulation, npc: NpcState, x: number, z: number) {
  return (Math.hypot(npc.x - x, npc.z - z) * 1.35) / 80 + 0.15;
}

function homeTasks(sim: Simulation, npc: NpcState): Task[] {
  if (npc.building === npc.homeId) return [];
  const b = sim.world.buildings[npc.homeId];
  return [{ kind: 'goto', x: b.insideFront.x, z: b.insideFront.z, arrive: 0.6 }];
}

function homeFurniture(sim: Simulation, npc: NpcState, use: string) {
  return sim.world.furniture.filter((f) => f.buildingId === npc.homeId && f.use === use && f.kind !== 'none');
}

function bedFor(sim: Simulation, npc: NpcState) {
  const beds = homeFurniture(sim, npc, 'bed');
  if (!beds.length) return null;
  const hh = sim.households[npc.household];
  const idx = hh ? hh.members.indexOf(npc.id) : 0;
  // couples share the first (double) bed
  return beds[idx >= 2 ? Math.min(beds.length - 1, 1) : 0];
}

function lockAllTasks(sim: Simulation, npc: NpcState): Task[] {
  const b = sim.world.buildings[npc.homeId];
  return b.doorIds.filter((d) => sim.world.doors[d].exterior).map((d) => ({ kind: 'door', target: d, data: { act: 'lock' } }));
}

export function workStation(sim: Simulation, npc: NpcState) {
  const wanted: Record<string, string[]> = {
    shopkeeper: ['register'],
    clerk: ['register'],
    cook: ['stove'],
    waiter: ['register', 'table'],
    bartender: ['bartap'],
    doctor: ['exam', 'desk'],
    mechanic: ['workbench'],
    chief: ['register', 'desk'],
    officer: ['desk', 'register'],
    pastor: ['altar', 'pew'],
  };
  const uses = wanted[npc.job] ?? ['desk'];
  for (const u of uses) {
    const fs = sim.world.furniture.filter((f) => f.buildingId === npc.workId && f.use === u && f.kind !== 'none');
    if (fs.length) {
      // chief takes the front desk; officers share desks
      return fs[npc.id % fs.length];
    }
  }
  return null;
}

function businessOpen(sim: Simulation, kind: string) {
  return sim.npcs.some((n) => n.alive && n.workId >= 0 && sim.world.buildings[n.workId].kind === kind && n.activity?.kind === 'work' && n.building === n.workId);
}

function findSeat(sim: Simulation, buildingId: number, uses: string[]) {
  const fs = sim.world.furniture.filter((f) => f.buildingId === buildingId && uses.includes(f.use) && f.kind !== 'none' && !sim.npcs.some((n) => n.usingFurniture === f.id));
  return fs.length ? fs[sim.randInt(0, fs.length - 1)] : null;
}

function porchPoint(sim: Simulation, npc: NpcState) {
  const b = sim.world.buildings[npc.homeId];
  return { x: b.outsideFront.x + sim.rand(-0.4, 0.4), z: b.outsideFront.z + sim.rand(-0.4, 0.4) };
}

// ---------------------------------------------------------------------------

/** chooses a routine activity from schedule and needs (utility based) */
export function chooseRoutine(sim: Simulation, npc: NpcState) {
  const h = sim.hour();
  const s = npc.schedule;
  const day = sim.day();
  const options: { kind: string; u: number }[] = [];
  const worksToday = npc.workId >= 0 && (s.workDays >> (day % 7)) & 1;
  const station = npc.workId >= 0 ? sim.world.buildings[npc.workId] : null;
  const lead = station ? travelHours(sim, npc, station.outsideFront.x, station.outsideFront.z) : 0;
  const atWork = npc.building === npc.workId;
  if (worksToday && inWindow(h, s.workStart - (atWork ? 0 : lead), s.workEnd - 0.05)) options.push({ kind: 'work', u: 90 });
  const bedLead = npc.building === npc.homeId ? 0 : travelHours(sim, npc, sim.world.buildings[npc.homeId].insideFront.x, sim.world.buildings[npc.homeId].insideFront.z);
  if (inWindow(h, s.bed - bedLead, s.wake) || npc.needs.energy < 12) options.push({ kind: 'sleep', u: 85 + (npc.needs.energy < 12 ? 20 : 0) });
  if (npc.needs.hunger > 55) options.push({ kind: 'eat', u: 55 + npc.needs.hunger * 0.4 });
  if ((npc.ctl.needGroceries || sim.foodCount(npc.homeId) < 2) && npc.money >= SHOP_COST && inWindow(h, 9, 18.3) && businessOpen(sim, 'store')) options.push({ kind: 'shop', u: 52 });
  if (npc.smoker && sim.time - Number(npc.ctl.lastSmoke ?? 0) > 3 * 3600 && !isNight(h)) options.push({ kind: 'smoke', u: 46 });
  const fearful = npc.avoidNightOut || npc.needs.fear > 55;
  if (inWindow(h, 17.5, s.bed - 0.7)) {
    if (s.evening === 'bar' && !fearful && businessOpen(sim, 'bar')) options.push({ kind: 'bar', u: 48 });
    if (s.evening === 'visit' && !(fearful && isDark(h))) options.push({ kind: 'visit', u: 38 });
    if (s.evening === 'walk' && !(fearful && isDark(h))) options.push({ kind: 'walk', u: 34 });
  }
  if (inWindow(h, 9.5, 17.5) && !worksToday && !fearful) options.push({ kind: 'walk', u: 22 + npc.traits.sociability * 10 });
  if (inWindow(h, 10, 17) && !worksToday && npc.traits.sociability > 0.5) options.push({ kind: 'visit', u: 20 });
  options.push({ kind: 'relax', u: 28 });
  for (const o of options) {
    o.u += sim.rand(0, 6);
    // recently failed plans are avoided for a while
    if (sim.time - Number(npc.ctl[`fail_${o.kind}`] ?? -1e9) < 3600) o.u -= 60;
  }
  options.sort((a, b) => b.u - a.u);
  const pick = options[0].kind;
  planRoutine(sim, npc, pick);
}

export function planRoutine(sim: Simulation, npc: NpcState, kind: string) {
  const h = sim.hour();
  const home = sim.world.buildings[npc.homeId];
  switch (kind) {
    case 'sleep': {
      const bed = bedFor(sim, npc);
      const until = nextHour(sim, npc.schedule.wake + sim.rand(-0.2, 0.3));
      const tasks: Task[] = [...homeTasks(sim, npc), ...lockAllTasks(sim, npc), { kind: 'lights', target: npc.homeId, data: { on: false } }];
      if (bed) tasks.push({ kind: 'use', target: bed.id, until, effect: 'sleep', pose: 'lie' });
      else tasks.push({ kind: 'wait', until });
      setActivity(sim, npc, 'sleep', 30, tasks, {}, until);
      return;
    }
    case 'work': {
      const st = workStation(sim, npc);
      const b = sim.world.buildings[npc.workId];
      const until = nextHour(sim, npc.schedule.workEnd);
      const tasks: Task[] = [{ kind: 'goto', x: b.insideFront.x, z: b.insideFront.z, arrive: 0.7 }, { kind: 'open_business', target: b.id }];
      if (npc.job === 'officer' && inWindow(h, 19, 7)) {
        setActivity(sim, npc, 'patrol', 40, [{ kind: 'patrol' }], {}, until);
        return;
      }
      if (st) tasks.push({ kind: 'use', target: st.id, until, effect: 'work', pose: st.use === 'pew' || st.use === 'desk' ? 'sit' : 'stand' });
      else tasks.push({ kind: 'wait', until, effect: 'work' });
      tasks.push({ kind: 'close_business', target: b.id });
      setActivity(sim, npc, 'work', 35, tasks, {}, until);
      return;
    }
    case 'eat': {
      const fridge = homeFurniture(sim, npc, 'fridge')[0];
      if (fridge && sim.foodCount(npc.homeId) > 0) {
        const seat = homeFurniture(sim, npc, 'chair')[0] ?? homeFurniture(sim, npc, 'sofa')[0];
        const tasks: Task[] = [...homeTasks(sim, npc), { kind: 'use', target: fridge.id, dur: 90, pose: 'stand' }];
        if (seat) tasks.push({ kind: 'use', target: seat.id, dur: 900, pose: 'sit', effect: 'eat_fridge' });
        else tasks.push({ kind: 'wait', dur: 600, effect: 'eat_fridge' });
        setActivity(sim, npc, 'eat', 26, tasks);
        return;
      }
      const diner = sim.world.buildings.find((b) => b.kind === 'diner');
      if (diner && businessOpen(sim, 'diner') && npc.money >= 7) {
        const seat = findSeat(sim, diner.id, ['chair']);
        if (seat) {
          setActivity(sim, npc, 'eat', 26, [{ kind: 'use', target: seat.id, dur: 1200, pose: 'sit', effect: 'eat_diner' }]);
          return;
        }
      }
      npc.ctl.needGroceries = true;
      if (businessOpen(sim, 'store') && npc.money >= SHOP_COST) {
        planRoutine(sim, npc, 'shop');
        return;
      }
      planRoutine(sim, npc, 'relax');
      return;
    }
    case 'shop': {
      const store = sim.world.buildings.find((b) => b.kind === 'store');
      const reg = store ? sim.world.furniture.find((f) => f.buildingId === store.id && f.use === 'register') : null;
      const fridge = homeFurniture(sim, npc, 'fridge')[0];
      if (!store || !reg || !fridge) return planRoutine(sim, npc, 'relax');
      const shelf = findSeat(sim, store.id, ['shelf']);
      const tasks: Task[] = [{ kind: 'goto', x: store.insideFront.x, z: store.insideFront.z, arrive: 0.8 }];
      if (shelf) tasks.push({ kind: 'use', target: shelf.id, dur: 240, pose: 'stand' });
      tasks.push({ kind: 'use', target: reg.id, dur: 120, pose: 'stand', effect: 'shop' });
      tasks.push({ kind: 'use', target: fridge.id, dur: 60, pose: 'stand', effect: 'stock' });
      setActivity(sim, npc, 'shop', 24, tasks);
      return;
    }
    case 'smoke': {
      npc.ctl.lastSmoke = sim.time;
      const p = npc.building === npc.workId && npc.workId >= 0 ? { x: sim.world.buildings[npc.workId].outsideFront.x + sim.rand(-1.5, 1.5), z: sim.world.buildings[npc.workId].outsideFront.z + sim.rand(-1, 1) } : porchPoint(sim, npc);
      setActivity(sim, npc, 'smoke', 22, [
        { kind: 'goto', x: p.x, z: p.z, arrive: 0.5 },
        { kind: 'wait', dur: 420, data: { anim: 'smoke' }, effect: 'smoke' },
      ]);
      return;
    }
    case 'bar': {
      const bar = sim.world.buildings.find((b) => b.kind === 'bar');
      if (!bar) return planRoutine(sim, npc, 'relax');
      const seat = findSeat(sim, bar.id, ['chair']);
      const until = Math.min(nextHour(sim, Math.min(npc.schedule.bed - 0.4, 25.2)), sim.time + 4 * 3600);
      const tasks: Task[] = [{ kind: 'goto', x: bar.insideFront.x, z: bar.insideFront.z, arrive: 0.8 }];
      if (seat) tasks.push({ kind: 'use', target: seat.id, until, pose: 'sit', effect: 'drink' });
      else tasks.push({ kind: 'wait', until, effect: 'drink' });
      setActivity(sim, npc, 'bar', 24, tasks, {}, until);
      return;
    }
    case 'visit': {
      const friends = npc.rel.filter((r) => (r.kind === 'friend' || r.kind === 'neighbour') && r.affinity > 0.2);
      const f = friends.length ? sim.npc(friends[sim.randInt(0, friends.length - 1)].id) : null;
      if (!f || !f.alive || f.homeId === npc.homeId) return planRoutine(sim, npc, 'walk');
      const fb = sim.world.buildings[f.homeId];
      setActivity(sim, npc, 'visit', 22, [
        { kind: 'goto', x: fb.outsideFront.x, z: fb.outsideFront.z, arrive: 0.7 },
        { kind: 'knock', target: f.id },
        { kind: 'wait', dur: 120 },
        { kind: 'meet', target: f.id, dur: 1500 },
        ...homeTasks(sim, npc),
      ]);
      return;
    }
    case 'walk': {
      const pois = sim.world.pois.filter((p) => p.kind === 'bench' || p.kind === 'pond' || p.kind === 'park' || p.kind === 'playground' || p.kind === 'bus');
      const p = pois.length ? pois[sim.randInt(0, pois.length - 1)] : null;
      if (!p) return planRoutine(sim, npc, 'relax');
      setActivity(sim, npc, 'walk', 20, [
        { kind: 'goto', x: p.x + sim.rand(-1, 1), z: p.z + sim.rand(-1, 1), arrive: 0.8 },
        { kind: 'wait', dur: sim.rand(600, 1500), data: { anim: 'idle' } },
        ...homeTasksFrom(sim, npc),
      ]);
      return;
    }
    case 'relax':
    default: {
      const tasks: Task[] = [...homeTasks(sim, npc)];
      const roll = sim.next();
      const sofa = homeFurniture(sim, npc, 'sofa')[0];
      const tv = homeFurniture(sim, npc, 'tv')[0];
      const books = homeFurniture(sim, npc, 'bookshelf')[0];
      const dur = sim.rand(1200, 3000);
      if (roll < 0.45 && sofa) tasks.push({ kind: 'use', target: sofa.id, dur, pose: 'sit', effect: 'relax' });
      else if (roll < 0.6 && books) tasks.push({ kind: 'use', target: books.id, dur: dur * 0.3, pose: 'stand' }, { kind: 'use', target: (sofa ?? books).id, dur: dur * 0.7, pose: 'sit' });
      else if (roll < 0.75 && !isDark(h)) {
        // potter around the garden
        const lot = sim.world.lots[home.lotId];
        const gx = lot.rect.x0 + sim.rand(1.5, lot.rect.x1 - lot.rect.x0 - 1.5);
        const gz = lot.rect.z0 + sim.rand(1.5, lot.rect.z1 - lot.rect.z0 - 1.5);
        tasks.push({ kind: 'goto', x: gx, z: gz, arrive: 1.0 }, { kind: 'wait', dur: dur * 0.6, data: { anim: 'crouch' } }, ...homeTasksFromHome(sim, npc));
      } else if (roll < 0.85) {
        const k = homeFurniture(sim, npc, 'stove')[0] ?? homeFurniture(sim, npc, 'sink')[0];
        if (k) tasks.push({ kind: 'use', target: k.id, dur: dur * 0.5, pose: 'stand' });
        else tasks.push({ kind: 'wait', dur: dur * 0.5 });
      } else if (tv && sofa) tasks.push({ kind: 'use', target: sofa.id, dur, pose: 'sit', effect: 'relax' });
      else {
        const rooms = home.roomIds.map((r) => sim.world.rooms[r]);
        const room = rooms[sim.randInt(0, rooms.length - 1)];
        const p = sim.randomPointInRoom(room.id);
        if (p) tasks.push({ kind: 'goto', x: p.x, z: p.z, arrive: 0.6 });
        tasks.push({ kind: 'wait', dur: dur * 0.5, data: { anim: 'idle' } });
      }
      setActivity(sim, npc, 'relax', 15, tasks);
    }
  }
}

function homeTasksFrom(sim: Simulation, npc: NpcState): Task[] {
  const b = sim.world.buildings[npc.homeId];
  return [{ kind: 'goto', x: b.insideFront.x, z: b.insideFront.z, arrive: 0.6 }];
}

function homeTasksFromHome(sim: Simulation, npc: NpcState): Task[] {
  return homeTasksFrom(sim, npc);
}

// ---------------------------------------------------------------------------
// reactions to danger

function nearestPhone(sim: Simulation, npc: NpcState) {
  let best: { x: number; z: number; f: number } | null = null;
  let bd = Infinity;
  for (const f of sim.world.furniture) {
    if (f.use !== 'phone' || f.kind === 'none') continue;
    const b = sim.world.buildings[f.buildingId];
    // only phones the npc can actually reach: own home, police, businesses that are open
    const ok = f.buildingId === npc.homeId || (npc.workId === f.buildingId && npc.building === npc.workId) || (b.kind !== 'house' && b.kind !== 'abandoned' && !sim.world.doors[b.frontDoorId].locked);
    if (!ok) continue;
    const d = Math.hypot(f.ux - npc.x, f.uz - npc.z);
    if (d < bd) {
      bd = d;
      best = { x: f.ux, z: f.uz, f: f.id };
    }
  }
  for (const p of sim.world.pois)
    if (p.kind === 'phonebooth') {
      const d = Math.hypot(p.x - npc.x, p.z - npc.z);
      if (d < bd) {
        bd = d;
        best = { x: p.x, z: p.z, f: -1 };
      }
    }
  return best;
}

export function reportTasks(sim: Simulation, npc: NpcState): Task[] {
  const ph = nearestPhone(sim, npc);
  const pol = sim.world.buildings[sim.world.policeId];
  const dPol = pol ? Math.hypot(pol.outsideFront.x - npc.x, pol.outsideFront.z - npc.z) : Infinity;
  if (ph && (Math.hypot(ph.x - npc.x, ph.z - npc.z) < dPol || !pol)) {
    if (ph.f >= 0) return [{ kind: 'use', target: ph.f, dur: 120, pose: 'stand', effect: 'phone', run: true }];
    return [{ kind: 'goto', x: ph.x, z: ph.z, arrive: 0.6, run: true }, { kind: 'wait', dur: 120, data: { anim: 'phone' }, effect: 'phone' }];
  }
  if (pol) return [{ kind: 'goto', x: pol.insideFront.x, z: pol.insideFront.z, run: true, arrive: 0.8 }, { kind: 'wait', dur: 180, effect: 'phone' }];
  return [];
}

export function unreportedSerious(npc: NpcState) {
  if (npc.role === 'killer' || npc.role === 'burglar') return false;
  return npc.memories.some((m) => !m.reported && (m.topic === 'murder' || m.topic === 'body' || m.topic === 'attack' || m.topic === 'breakin' || m.topic === 'missing' || m.topic === 'theft' || (m.topic === 'trespass' && m.actor >= 0)) && m.source !== 'told');
}

/** returns true if a reaction activity was started */
export function react(sim: Simulation, npc: NpcState): boolean {
  if (npc.alarm < 0.3) return false;
  const last = Number(npc.ctl.reactAlarm ?? 0);
  const lastT = Number(npc.ctl.reactT ?? -1e9);
  const cur = npc.activity;
  const reacting = cur && npc.tasks.length > 0 && ['flee', 'fight', 'report', 'investigate', 'lockdown', 'hide', 'confront', 'arrest', 'respond'].includes(cur.kind);
  // only a clearly stronger stimulus, or one after a cool-down, triggers a new reaction
  const stronger = npc.alarm >= last + 0.12;
  const cooled = sim.time - lastT > 25 * 60;
  if (reacting && !stronger) return false;
  if (!reacting && !stronger && !(cooled && npc.alarm >= 0.45)) return false;
  npc.ctl.reactAlarm = npc.alarm;
  npc.ctl.reactT = sim.time;
  const threat = npc.threat >= 0 ? sim.actors[npc.threat] : null;
  const threatNear = threat && threat.alive && Math.hypot(threat.x - npc.x, threat.z - npc.z) < 12;
  const brave = npc.traits.bravery;
  const agg = npc.traits.aggression;
  const night = isNight(sim.hour());
  const atHome = npc.building === npc.homeId;
  if (npc.role === 'police') return sim.policeReact(npc);
  // armed / violent threat close by
  const hitMe = npc.lastAttacker === threat?.id && sim.time - Number(npc.ctl.hitAt ?? -1e9) < 120;
  const violent = threat && (threat.swingT > 0 || threat.carrying >= 0 || hitMe);
  if (threatNear && threat && (threat.weapon || violent) && npc.alarm > 0.6) {
    // only stand and fight against someone actually being violent
    if (violent && brave * 0.6 + agg * 0.6 > 0.85 && npc.health > 50 && !(threat.weapon && !npc.weapon && brave < 0.8)) {
      setActivity(sim, npc, 'fight', 90, [{ kind: 'scream', data: { text: rngLine(sim, ['Hey! Get away from them!', 'Stop right there!', 'Back off!']) } }, { kind: 'attack', target: threat.id }]);
      return true;
    }
    if (sim.time - Number(npc.ctl.fail_flee ?? -1e9) < 600) {
      // cornered: hide if possible, otherwise fight for your life
      const hide = sim.world.furniture.find((f) => f.buildingId === npc.building && f.hide && f.kind !== 'none' && Math.hypot(f.ux - npc.x, f.uz - npc.z) < 8);
      if (hide && !sim.npcs.some((o) => o.usingFurniture === hide.id)) setActivity(sim, npc, 'hide', 88, [{ kind: 'hide', target: hide.id, dur: 1500 }]);
      else setActivity(sim, npc, 'fight', 90, [{ kind: 'scream', data: { text: 'Get away from me!' } }, { kind: 'attack', target: threat.id }]);
      return true;
    }
    fleeFrom(sim, npc, threat.x, threat.z);
    return true;
  }
  // intruder in my own home
  if (threat && threat.alive && threat.building === npc.homeId && atHome && npc.alarm > 0.5) {
    if (brave > 0.65 && agg > 0.45) {
      setActivity(sim, npc, 'confront', 80, [
        { kind: 'say', data: { text: 'Who the hell are you? Get out of my house!' } },
        { kind: 'confront', target: threat.id, dur: 400 },
      ]);
      return true;
    }
    const hide = sim.world.furniture.find((f) => f.buildingId === npc.homeId && f.hide && f.kind !== 'none');
    if (hide && brave < 0.4) {
      setActivity(sim, npc, 'hide', 75, [{ kind: 'hide', target: hide.id, dur: 1800 }, ...reportTasks(sim, npc)]);
      return true;
    }
    fleeFrom(sim, npc, threat.x, threat.z);
    return true;
  }
  // serious first hand knowledge: report it
  if (unreportedSerious(npc)) {
    const tasks: Task[] = [];
    if (npc.alarm > 0.85 && !npc.ctl.screamed) {
      tasks.push({ kind: 'scream', data: { text: rngLine(sim, ['Oh my god! Somebody help!', 'No, no, no...', 'Help! Police!']) } });
      npc.ctl.screamed = true;
    }
    tasks.push(...reportTasks(sim, npc));
    if (night || npc.needs.fear > 60) tasks.push(...homeTasks(sim, npc), ...lockAllTasks(sim, npc));
    setActivity(sim, npc, 'report', 70, tasks);
    return true;
  }
  // suspicious noises / glimpses
  if (npc.alarm >= 0.45) {
    const curious = npc.traits.curiosity * 0.5 + brave * 0.5;
    if (curious > 0.62 && npc.health > 60 && !(night && npc.needs.fear > 70)) {
      const tasks: Task[] = [];
      if (night) tasks.push({ kind: 'equip', data: { item: 'flashlight', on: true } });
      // never barge into somebody else's home: look from outside its front door
      let ix = npc.threatX;
      let iz = npc.threatZ;
      const tb = sim.grid.buildingAt(ix, iz);
      if (tb >= 0 && tb !== npc.homeId && sim.world.buildings[tb].kind !== 'police') {
        ix = sim.world.buildings[tb].outsideFront.x;
        iz = sim.world.buildings[tb].outsideFront.z;
      }
      tasks.push({ kind: 'goto', x: ix, z: iz, arrive: 2.5 }, { kind: 'look', dur: 240 }, { kind: 'equip', data: { item: 'flashlight', on: false } }, ...homeTasks(sim, npc));
      setActivity(sim, npc, 'investigate', 50, tasks);
      return true;
    }
    if (atHome || night) {
      const tasks: Task[] = [...homeTasks(sim, npc), ...lockAllTasks(sim, npc)];
      if (npc.alarm > 0.65) tasks.push(...reportTasks(sim, npc));
      tasks.push({ kind: 'wait', dur: 900, data: { anim: 'idle' } });
      setActivity(sim, npc, 'lockdown', 55, tasks);
      return true;
    }
  }
  return false;
}

export function fleeFrom(sim: Simulation, npc: NpcState, tx: number, tz: number) {
  const home = sim.world.buildings[npc.homeId];
  const pol = sim.world.buildings[sim.world.policeId];
  const dHomeThreat = Math.hypot(home.insideFront.x - tx, home.insideFront.z - tz);
  let dest = home.insideFront;
  if (dHomeThreat < 12 || npc.building === npc.homeId) dest = pol ? pol.insideFront : { x: npc.x + (npc.x - tx) * 3, z: npc.z + (npc.z - tz) * 3 };
  const tasks: Task[] = [{ kind: 'scream', data: { text: rngLine(sim, ['Help! Somebody help me!', 'Get away from me!', 'Police!']) } }, { kind: 'goto', x: dest.x, z: dest.z, run: true, arrive: 1 }];
  if (dest === home.insideFront) tasks.push(...lockAllTasks(sim, npc));
  tasks.push(...reportTasks(sim, npc));
  setActivity(sim, npc, 'flee', 85, tasks);
}

function rngLine(sim: Simulation, lines: string[]) {
  return lines[sim.randInt(0, lines.length - 1)];
}

/** spontaneous chats between npcs who meet */
export function maybeChat(sim: Simulation, npc: NpcState) {
  if (npc.needs.social > 70 || !npc.activity || npc.activity.priority > 22) return;
  if (sim.time - Number(npc.ctl.lastChat ?? 0) < 3600) return;
  for (const o of sim.npcs) {
    if (o === npc || !o.alive || o.sleeping || o.inCustody) continue;
    if (Math.abs(o.x - npc.x) > 4 || Math.abs(o.z - npc.z) > 4) continue;
    if (!o.activity || o.activity.priority > 22 || o.activity.kind === 'chat') continue;
    if (sim.time - Number(o.ctl.lastChat ?? 0) < 3600) continue;
    if (!sim.grid.los(npc.x, npc.z, o.x, o.z)) continue;
    const dur = sim.rand(240, 600);
    npc.ctl.lastChat = sim.time;
    o.ctl.lastChat = sim.time;
    setActivity(sim, npc, 'chat', 23, [{ kind: 'talk', target: o.id, dur }]);
    setActivity(sim, o, 'chat', 23, [{ kind: 'talk', target: npc.id, dur }]);
    sim.say(npc, sim.smallTalk(npc, o), 4);
    return;
  }
}

/** top level decision step for a resident */
export function think(sim: Simulation, npc: NpcState) {
  if (!npc.alive || npc.stance === 'downed' || npc.inCustody) return;
  if (npc.staggerT > 0) return;
  // role controllers (killer, burglar, police) may take over
  if (sim.roleThink(npc)) return;
  if (react(sim, npc)) return;
  const act = npc.activity;
  const done = !act || npc.tasks.length === 0 || sim.time > act.until || act.data.failed;
  if (done) {
    // after a scare, stay in for the rest of the night
    if (npc.needs.fear > 60 && isNight(sim.hour()) && npc.building !== npc.homeId) {
      setActivity(sim, npc, 'gohome', 40, [...homeTasks(sim, npc), ...lockAllTasks(sim, npc)]);
      return;
    }
    chooseRoutine(sim, npc);
    return;
  }
  // interrupt low priority routine when something more pressing is due
  if (act.priority <= 26 && act.kind !== 'chat') {
    const h = sim.hour();
    const s = npc.schedule;
    const worksToday = npc.workId >= 0 && (s.workDays >> (sim.day() % 7)) & 1;
    const station = npc.workId >= 0 ? sim.world.buildings[npc.workId] : null;
    const lead = station ? travelHours(sim, npc, station.outsideFront.x, station.outsideFront.z) : 0;
    const bedLead = npc.building === npc.homeId ? 0 : travelHours(sim, npc, sim.world.buildings[npc.homeId].insideFront.x, sim.world.buildings[npc.homeId].insideFront.z);
    if ((worksToday && act.kind !== 'work' && inWindow(h, s.workStart - lead, s.workEnd - 0.1)) || (act.kind !== 'sleep' && inWindow(h, s.bed - bedLead, s.wake))) {
      chooseRoutine(sim, npc);
      return;
    }
  }
  maybeChat(sim, npc);
}
