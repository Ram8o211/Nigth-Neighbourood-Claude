import { Rng } from '../core/rng';
import { FIRST_F, FIRST_M, SURNAMES } from '../core/names';
import type { Building, WorldData } from '../world/types';
import type { Appearance, Job, NpcState, Role, Schedule, Traits } from './types';

export const COATS: { name: string; color: number }[] = [
  { name: 'dark green', color: 0x2f4a32 },
  { name: 'navy blue', color: 0x23304e },
  { name: 'brown', color: 0x5a3e28 },
  { name: 'black', color: 0x1c1c1e },
  { name: 'dark red', color: 0x5e1e1c },
  { name: 'grey', color: 0x6a6a6a },
];

export const HAIR: { name: string; color: number }[] = [
  { name: 'black', color: 0x16120e },
  { name: 'brown', color: 0x4a3020 },
  { name: 'blond', color: 0xb8964e },
  { name: 'red', color: 0x8a3a1a },
  { name: 'grey', color: 0x9a9894 },
];

const SKINS = [0xf2d0b4, 0xe0b090, 0xc89070, 0x9a6a4a, 0x6a4430, 0xf6dcc8];

export function heightClass(h: number): 'short' | 'average' | 'tall' {
  return h < 1.66 ? 'short' : h > 1.82 ? 'tall' : 'average';
}

export function hairName(c: number): string {
  return HAIR.find((h) => h.color === c)?.name ?? 'dark';
}

interface JobSlot {
  job: Job;
  kind: Building['kind'];
  start: number;
  end: number;
  days: number;
}

const ALL_DAYS = 0x7f;
const JOB_SLOTS: JobSlot[] = [
  { job: 'chief', kind: 'police', start: 8, end: 18, days: ALL_DAYS },
  { job: 'officer', kind: 'police', start: 7, end: 19.5, days: ALL_DAYS },
  { job: 'officer', kind: 'police', start: 19, end: 31.5, days: ALL_DAYS },
  { job: 'shopkeeper', kind: 'store', start: 8, end: 19, days: ALL_DAYS },
  { job: 'clerk', kind: 'hardware', start: 8.5, end: 18, days: ALL_DAYS },
  { job: 'cook', kind: 'diner', start: 7, end: 16, days: ALL_DAYS },
  { job: 'waiter', kind: 'diner', start: 13, end: 22, days: ALL_DAYS },
  { job: 'bartender', kind: 'bar', start: 16, end: 25.5, days: ALL_DAYS },
  { job: 'doctor', kind: 'clinic', start: 8, end: 17, days: ALL_DAYS },
  { job: 'mechanic', kind: 'garage', start: 8, end: 17.5, days: ALL_DAYS },
  { job: 'pastor', kind: 'church', start: 9, end: 14, days: ALL_DAYS },
];

function traits(rng: Rng): Traits {
  const t = () => Math.max(0, Math.min(1, 0.5 + rng.normal() * 0.22));
  return { bravery: t(), curiosity: t(), sociability: t(), aggression: Math.max(0, Math.min(1, 0.3 + rng.normal() * 0.18)), vigilance: t(), gossip: t(), careless: Math.max(0, Math.min(1, 0.25 + rng.normal() * 0.2)) };
}

function appearance(rng: Rng, female: boolean, age: number): Appearance {
  const height = Math.max(1.5, Math.min(1.98, (female ? 1.64 : 1.77) + rng.normal() * 0.065));
  const hairPool = age > 60 ? [4, 4, 0, 1] : [0, 1, 1, 2, 3, 0];
  const hair = HAIR[rng.pick(hairPool)].color;
  const coat = rng.pick(COATS);
  return {
    female,
    height,
    build: Math.max(0.85, Math.min(1.25, 1 + rng.normal() * 0.1)),
    skin: rng.pick(SKINS),
    hair,
    hairStyle: female ? rng.pick(['long', 'bun', 'short', 'long'] as const) : rng.pick(['short', 'short', 'bald', 'cap'] as const),
    beard: !female && rng.chance(0.3),
    glasses: rng.chance(age > 50 ? 0.5 : 0.2),
    shirt: rng.pick([0xc8c0b0, 0x8a9ab0, 0xb08a7a, 0x7a8a6a, 0xe0d8c8, 0x9a7aa0, 0xb0a070, 0x5a6a7a]),
    pants: rng.pick([0x2e3440, 0x3a3226, 0x4a4a4e, 0x26303a, 0x5a4a3a]),
    coat: coat.color,
    coatName: coat.name,
    shoes: 'sneakers',
    face: rng.int(0, 5),
  };
}

function baseActor(id: number) {
  return {
    id,
    kind: 'npc' as const,
    x: 0,
    z: 0,
    y: 0,
    yaw: 0,
    vx: 0,
    vz: 0,
    speed: 0,
    radius: 0.28,
    health: 100,
    maxHealth: 100,
    alive: true,
    stance: 'stand' as const,
    downedT: 0,
    bleeding: 0,
    stamina: 100,
    building: -1,
    room: -1,
    weapon: null,
    attackCd: 0,
    swingT: 0,
    hitPending: -1,
    swingItem: null,
    blocking: false,
    staggerT: 0,
    hitFlash: 0,
    lastAttacker: -1,
    bloody: 0,
    flashlight: false,
    carrying: -1,
    hiddenIn: -1,
    noise: 0,
    anim: 'idle',
    animT: 0,
    outfit: 'day' as const,
    usingFurniture: -1,
    deathTime: -1,
    bodyRemoved: false,
    arrested: false,
    inCustody: false,
    ctl: {} as Record<string, number | string | boolean>,
  };
}

export interface Population {
  npcs: NpcState[];
  killer: number;
  burglar: number;
  lair: { building: number; furniture: number };
  households: { id: number; building: number; members: number[] }[];
}

/** Generates the persistent residents for a world, deterministically from its seed. */
export function generatePopulation(world: WorldData): Population {
  const rng = new Rng(world.seedNum ^ 0x5eed);
  const npcs: NpcState[] = [];
  const households: Population['households'] = [];
  const houses = world.buildings.filter((b) => b.kind === 'house' && b.id !== world.playerHouseId);
  rng.shuffle(houses);
  const usedSurnames = new Set<string>();
  const freshSurname = () => {
    for (let k = 0; k < 40; k++) {
      const s = rng.pick(SURNAMES);
      if (!usedSurnames.has(s)) {
        usedSurnames.add(s);
        return s;
      }
    }
    return rng.pick(SURNAMES);
  };
  const usedFirst = new Set<string>();
  const freshFirst = (female: boolean) => {
    for (let k = 0; k < 40; k++) {
      const f = rng.pick(female ? FIRST_F : FIRST_M);
      if (!usedFirst.has(f)) {
        usedFirst.add(f);
        return f;
      }
    }
    return rng.pick(female ? FIRST_F : FIRST_M);
  };
  const cap = world.params.size === 'small' ? 18 : world.params.size === 'large' ? 38 : 28;
  const occupied = houses.filter(() => rng.chance(world.params.density)).slice(0, Math.round(cap / 1.55));
  // make sure we have enough people for the jobs
  const minHouses = Math.min(houses.length, 12);
  for (const h of houses) if (occupied.length < minHouses && !occupied.includes(h)) occupied.push(h);
  let nextId = 1;
  for (const house of occupied) {
    const hh = { id: households.length, building: house.id, members: [] as number[] };
    households.push(hh);
    house.householdId = hh.id;
    const sizeRoll = rng.next();
    const size = sizeRoll < 0.5 ? 1 : sizeRoll < 0.95 ? 2 : 3;
    const surname = freshSurname();
    const firstFemale = rng.chance(0.5);
    for (let k = 0; k < size; k++) {
      const female = k === 0 ? firstFemale : k === 1 ? !firstFemale : rng.chance(0.5);
      const age = k < 2 ? rng.int(26, 78) : rng.int(18, 30);
      const npc: NpcState = {
        ...baseActor(nextId++),
        first: freshFirst(female),
        last: surname,
        age,
        job: age >= 66 ? 'retired' : 'unemployed',
        role: 'resident',
        homeId: house.id,
        workId: -1,
        household: hh.id,
        app: appearance(rng, female, age),
        traits: traits(rng),
        smoker: rng.chance(0.3),
        drinker: rng.chance(0.45),
        schedule: { wake: 7, bed: 23, workStart: 0, workEnd: 0, workDays: 0, evening: 'home' },
        money: rng.int(40, 220),
        needs: { hunger: rng.range(10, 40), energy: rng.range(70, 95), social: rng.range(20, 60), fear: 0 },
        rel: [],
        memories: [],
        nextMemId: 1,
        activity: null,
        tasks: [],
        path: null,
        pathIdx: 0,
        pathGoal: null,
        pathFail: 0,
        thinkT: rng.range(0, 1),
        perceiveT: rng.range(0, 0.4),
        aware: {},
        alarm: 0,
        threat: -1,
        threatX: 0,
        threatZ: 0,
        sleeping: false,
        metPlayer: false,
        suspicionOfPlayer: 0,
        carriesGroceries: 0,
        keys: [house.id],
        talkT: 0,
        sayText: '',
        sayT: 0,
        doorWait: 0,
        stuckT: 0,
        lastX: 0,
        lastZ: 0,
        missing: false,
        wanted: 0,
        avoidNightOut: false,
        closeDoors: [],
        lockBehind: -1,
        pathGoalBuilding: -1,
      };
      // sheds on the same lot are opened with the house key
      for (const b of world.buildings) if (b.kind === 'shed' && b.lotId === house.lotId) npc.keys.push(b.id);
      npcs.push(npc);
      hh.members.push(npc.id);
    }
  }
  // --- jobs ------------------------------------------------------------------
  const workers = npcs.filter((n) => n.age < 66);
  rng.shuffle(workers);
  const byKind = (k: Building['kind']) => world.buildings.find((b) => b.kind === k);
  let wi = 0;
  for (const slot of JOB_SLOTS) {
    const b = byKind(slot.kind);
    if (!b) continue;
    // prefer workers not yet employed
    while (wi < workers.length && workers[wi].workId >= 0) wi++;
    if (wi >= workers.length) {
      // pull a retiree back to work if needed for essential jobs
      const r = npcs.find((n) => n.workId < 0 && n.job === 'retired');
      if (!r || !['chief', 'officer', 'shopkeeper', 'bartender', 'cook'].includes(slot.job)) continue;
      workers.push(r);
    }
    const n = workers[wi++];
    n.job = slot.job;
    n.workId = b.id;
    n.keys.push(b.id);
    n.schedule.workStart = slot.start + rng.range(-0.25, 0.25);
    n.schedule.workEnd = slot.end + rng.range(-0.25, 0.25);
    n.schedule.workDays = slot.days;
    if (slot.job === 'officer' || slot.job === 'chief') {
      n.role = 'police';
      n.traits.bravery = Math.max(n.traits.bravery, 0.75);
      n.traits.aggression = Math.max(n.traits.aggression, 0.45);
    }
  }
  for (const n of npcs) {
    if (n.workId >= 0) continue;
    if (n.age >= 66) n.job = 'retired';
    else n.job = rng.pick(['homemaker', 'writer', 'unemployed', 'homemaker'] as Job[]);
  }
  // shoes follow work
  for (const n of npcs) {
    const a = n.app;
    if (['mechanic', 'clerk', 'cook', 'officer', 'chief'].includes(n.job)) a.shoes = n.job === 'chief' ? 'dress' : 'boots';
    else if (n.job === 'doctor' || n.job === 'pastor' || n.job === 'bartender') a.shoes = 'dress';
    else a.shoes = rng.pick(['sneakers', 'boots', 'dress', 'sneakers']);
  }
  // --- schedules -------------------------------------------------------------
  for (const n of npcs) {
    const s = n.schedule;
    const nightShift = s.workEnd > 24;
    s.wake = nightShift ? 13 + rng.range(0, 1.5) : n.workId >= 0 ? Math.max(5.5, s.workStart - rng.range(1.0, 1.6)) : rng.range(7, 9.5);
    s.bed = nightShift ? s.workEnd + rng.range(0.3, 1.0) : rng.range(21.8, 24.3);
    if (n.job === 'bartender') {
      s.wake = 10 + rng.range(0, 1);
      s.bed = s.workEnd + 0.6;
    }
    s.evening = n.drinker && rng.chance(0.7) ? 'bar' : rng.pick(['home', 'home', 'visit', 'walk']);
  }
  // --- relationships ---------------------------------------------------------
  for (const n of npcs) {
    for (const m of npcs) {
      if (m.id === n.id) continue;
      if (m.household === n.household) n.rel.push({ id: m.id, affinity: 0.8, familiarity: 1, kind: 'spouse' });
      else {
        const hb = world.buildings[n.homeId].rect;
        const mb = world.buildings[m.homeId].rect;
        const d = Math.hypot((hb.x0 + hb.x1) / 2 - (mb.x0 + mb.x1) / 2, (hb.z0 + hb.z1) / 2 - (mb.z0 + mb.z1) / 2);
        const co = n.workId >= 0 && n.workId === m.workId;
        const kind = co ? 'coworker' : d < 30 ? 'neighbour' : 'acquaintance';
        const friend = rng.chance(kind === 'acquaintance' ? 0.08 : 0.25);
        n.rel.push({ id: m.id, affinity: friend ? rng.range(0.4, 0.8) : rng.range(-0.3, 0.3), familiarity: kind === 'acquaintance' ? rng.range(0.4, 0.8) : rng.range(0.7, 1), kind: friend ? 'friend' : kind });
      }
    }
  }
  // --- the killer and the burglar --------------------------------------------
  const candidates = npcs.filter((n) => n.role === 'resident' && n.age >= 22 && n.age <= 64 && !['shopkeeper', 'bartender'].includes(n.job));
  candidates.sort((a, b) => {
    const alone = (n: NpcState) => (households[n.household].members.length === 1 ? 1 : 0);
    return alone(b) - alone(a) || b.traits.aggression - a.traits.aggression;
  });
  const pool = candidates.slice(0, Math.max(3, Math.ceil(candidates.length * 0.5)));
  const killer = pool.length ? rng.pick(pool) : npcs[0];
  killer.role = 'killer';
  killer.health = killer.maxHealth = 150;
  killer.traits.bravery = 0.9;
  killer.traits.aggression = 0.95;
  killer.traits.vigilance = 0.9;
  killer.schedule.evening = 'home';
  killer.drinker = false;
  killer.keys.push(...world.buildings.filter((b) => b.kind === 'abandoned').map((b) => b.id));
  // make the killer's attribute combination unique enough to be deducible
  const sig = (n: NpcState) => `${heightClass(n.app.height)}|${n.app.coatName}|${n.app.shoes}|${n.smoker}`;
  for (let k = 0; k < 12 && npcs.some((n) => n !== killer && sig(n) === sig(killer)); k++) {
    const c = rng.pick(COATS);
    killer.app.coat = c.color;
    killer.app.coatName = c.name;
    if (k > 5) killer.smoker = !killer.smoker;
  }
  const burglarPool = npcs.filter((n) => n.role === 'resident' && n !== killer && n.age < 60 && (n.job === 'unemployed' || n.job === 'writer' || n.job === 'homemaker'));
  const burglar = burglarPool.length ? rng.pick(burglarPool) : null;
  if (burglar) {
    burglar.role = 'burglar';
    burglar.money = rng.int(5, 25);
    burglar.traits.bravery = Math.min(burglar.traits.bravery, 0.45);
    burglar.traits.careless = 0.2;
  }
  // lair: the killer's shed, otherwise an abandoned house, otherwise their storage room
  const shed = world.buildings.find((b) => b.kind === 'shed' && b.lotId === world.buildings[killer.homeId].lotId);
  const aband = world.buildings.filter((b) => b.kind === 'abandoned');
  const lairB = shed ?? (aband.length ? aband.reduce((best, b) => (dist2b(b, world.buildings[killer.homeId]) < dist2b(best, world.buildings[killer.homeId]) ? b : best)) : world.buildings[killer.homeId]);
  const lairF = world.furniture.find((f) => f.buildingId === lairB.id && f.container && f.kind !== 'none') ?? world.furniture.find((f) => f.buildingId === lairB.id && f.kind !== 'none');
  return { npcs, killer: killer.id, burglar: burglar ? burglar.id : -1, lair: { building: lairB.id, furniture: lairF ? lairF.id : -1 }, households };
}

function dist2b(a: Building, b: Building) {
  return ((a.rect.x0 + a.rect.x1) / 2 - (b.rect.x0 + b.rect.x1) / 2) ** 2 + ((a.rect.z0 + a.rect.z1) / 2 - (b.rect.z0 + b.rect.z1) / 2) ** 2;
}

export function fullName(n: NpcState) {
  return `${n.first} ${n.last}`;
}

export const JOB_TITLE: Record<Job, string> = {
  shopkeeper: 'runs the general store',
  clerk: 'works at the hardware store',
  cook: 'cooks at the diner',
  waiter: 'waits tables at the diner',
  bartender: 'tends the bar',
  doctor: 'is the town doctor',
  mechanic: 'fixes cars at the garage',
  officer: 'is a police officer',
  chief: 'is the chief of police',
  pastor: 'is the pastor',
  retired: 'is retired',
  homemaker: 'keeps house',
  writer: 'writes at home',
  unemployed: 'is out of work',
};

export function roleIs(n: NpcState, r: Role) {
  return n.role === r;
}
