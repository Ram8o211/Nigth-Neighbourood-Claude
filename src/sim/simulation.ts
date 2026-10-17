import { Rng } from '../core/rng';
import { clamp, wrapAngle, yawTo } from '../core/math';
import type { Building, WorldData, Door, ItemStack } from '../world/types';
import { WorldGrid, CELL } from '../world/grid';
import { Colliders, buildColliders } from '../world/collision';
import { Pathfinder, type NavAgent } from '../world/pathfinding';
import { generatePopulation, fullName, heightClass, hairName, COATS } from './population';
import type {
  ActorState,
  Appearance,
  Clue,
  Decal,
  Description,
  Incident,
  NpcState,
  PlayerState,
  PoliceCase,
  SimEvent,
  Task,
} from './types';
import { CFG, isDark, isNight } from './config';
import { hearSound, witnessAct, raiseAlarm } from './perception';
import { perceive } from './perception';
import { think, fleeFrom as brainFlee, setActivity } from './brain';
import { runTasks, clearTasks, type TaskResult } from './tasks';
import { updateCombat, combatTask as combatTaskFn, kill } from './combat';
import { updateLocation, moveActor } from './movement';
import { killerThink, huntTask, watchTask, knockTask, huntReturnTask, type HuntPlan } from './killer';
import { burglarThink, burgleTask } from './burglar';
import { policeThink, policeReact as policeReactFn, policeTask, policeCall as policeCallFn, rememberArrest } from './police';
import { placeName, descText, remember } from './memory';
import { flickerLevel } from './lightlevel';

export const SIM_VERSION = 4;

export interface SimSnapshot {
  version: number;
  time: number;
  rng: number;
  actors: ActorState[];
  cases: PoliceCase[];
  incidents: Incident[];
  clues: Clue[];
  items: SimItem[];
  decals: Decal[];
  doors: { open: number; target: number; locked: boolean; broken: boolean; hp: number }[];
  windows: { damage: 0 | 1 | 2; hp: number; boarded: boolean; boardHp: number }[];
  lights: { on: boolean; broken: boolean }[];
  furniture: { container: ItemStack[] | null; searched: boolean; solid: boolean; kind: string }[];
  props: { kind: string; solid: boolean }[];
  pop: { killer: number; burglar: number; lair: { building: number; furniture: number }; households: { id: number; building: number; members: number[] }[] };
  huntOverride: Partial<HuntPlan> | null;
  forcedDoors: number[];
  tape: { x: number; z: number; rot: number; len: number }[];
  misc: Record<string, number | string | boolean>;
}

export interface SimItem {
  id: number;
  item: string;
  n: number;
  x: number;
  y: number;
  z: number;
  tag: number;
  taken: boolean;
  label: string;
}

export interface HuntDirector {
  plan(sim: Simulation, night: number): HuntPlan;
}

export const DEFAULT_DIRECTOR: HuntDirector = {
  plan: (sim, night) => ({ hunt: night >= 0, start: 0.6 + (night % 3) * 0.5, maxKills: night >= 3 ? 2 : 1, targetPlayer: false, watchPlayer: night >= 1, knock: night >= 2 }),
};

export class Simulation {
  world: WorldData;
  grid: WorldGrid;
  colliders: Colliders;
  pf: Pathfinder;
  time = CFG.startHour * 3600;
  rng: Rng;
  actors: ActorState[] = [];
  npcs: NpcState[] = [];
  player!: PlayerState;
  households: { id: number; building: number; members: number[] }[] = [];
  killerId = -1;
  burglarId = -1;
  lair: { building: number; furniture: number } = { building: -1, furniture: -1 };
  cases: PoliceCase[] = [];
  incidents: Incident[] = [];
  clues: Clue[] = [];
  items: SimItem[] = [];
  decals: Decal[] = [];
  tape: { x: number; z: number; rot: number; len: number }[] = [];
  events: SimEvent[] = [];
  forcedDoors: number[] = [];
  pathBudget = 0;
  director: HuntDirector = DEFAULT_DIRECTOR;
  huntOverride: Partial<HuntPlan> | null = null;
  misc: Record<string, number | string | boolean> = {};
  /** per cell cost of lit areas (for the killer's dark routes) */
  private nightLight: Uint8Array;
  private lightBuckets = new Map<number, number[]>();
  private lightTimer = 0;
  speech: { actor: number; text: string; until: number }[] = [];
  /** callbacks for the game layer */
  onPlayerArrestAttempt: ((officer: NpcState) => void) | null = null;
  onPathFail: ((npc: NpcState, x: number, z: number) => void) | null = null;
  onActivity: ((npc: NpcState, kind: string) => void) | null = null;
  /** diagnostics: a task in an npc's plan failed */
  onTaskFail: ((npc: NpcState, task: Task) => void) | null = null;

  constructor(world: WorldData) {
    this.world = world;
    this.grid = new WorldGrid(world);
    this.colliders = buildColliders(world);
    this.pf = new Pathfinder(this.grid);
    this.rng = new Rng(world.seedNum ^ 0xa11ce);
    this.nightLight = new Uint8Array(this.grid.w * this.grid.h);
    this.buildLightBuckets();
    this.computeNightLight();
  }

  // ------------------------------------------------------------------ setup

  populate() {
    const pop = generatePopulation(this.world);
    this.npcs = pop.npcs;
    this.killerId = pop.killer;
    this.burglarId = pop.burglar;
    this.lair = pop.lair;
    this.households = pop.households;
    this.player = makePlayer();
    this.actors = [this.player, ...this.npcs];
    // place everybody according to the time of day
    const startH = this.hour();
    for (const n of this.npcs) {
      const home = this.world.buildings[n.homeId];
      let spot = this.randomPointInBuilding(home.id) ?? home.insideFront;
      if (n.workId >= 0 && this.inShift(n, startH)) spot = this.world.buildings[n.workId].insideFront;
      n.x = spot.x;
      n.z = spot.z;
      n.lastX = n.x;
      n.lastZ = n.z;
      n.yaw = this.rand(-3, 3);
      updateLocation(this, n, 1);
      n.y = this.grid.heightAt(n.x, n.z);
    }
    // houses are locked when the owners are out
    for (const b of this.world.buildings) {
      if (b.kind === 'house') {
        const anyHome = this.npcs.some((n) => n.homeId === b.id && n.building === b.id);
        for (const d of b.doorIds) if (this.world.doors[d].exterior) this.world.doors[d].locked = !anyHome || this.chance(0.3);
      } else if (b.kind === 'abandoned') {
        for (const d of b.doorIds) this.world.doors[d].locked = false;
        for (const w of b.windowIds) {
          const win = this.world.windows[w];
          if (this.chance(0.45)) {
            win.boarded = true;
            win.boardHp = 30;
          } else if (this.chance(0.4)) win.damage = 2;
        }
      } else if (b.kind === 'shed') {
        for (const d of b.doorIds) this.world.doors[d].locked = this.chance(0.5);
      } else if (b.kind !== 'police') {
        for (const d of b.doorIds) if (this.world.doors[d].exterior) this.world.doors[d].locked = true;
      }
    }
    // the killer's lair shed is always locked
    if (this.lair.building >= 0 && this.world.buildings[this.lair.building].kind === 'shed') for (const d of this.world.buildings[this.lair.building].doorIds) this.world.doors[d].locked = true;
    this.colliders = buildColliders(this.world);
  }

  inShift(n: NpcState, h: number) {
    const s = n.schedule;
    const a = s.workStart % 24;
    const b = s.workEnd % 24;
    return a <= b ? h >= a && h < b : h >= a || h < b;
  }

  // ------------------------------------------------------------------ clock

  hour() {
    return ((this.time % 86400) + 86400) % 86400 / 3600;
  }
  /** 0-based day index */
  day() {
    return Math.floor(this.time / 86400);
  }
  /** index of the current night: the night that starts on day N evening is N; early morning belongs to the previous night */
  nightIndex() {
    const h = this.hour();
    return h < 12 ? this.day() - 1 : this.day();
  }
  timeScale() {
    return isNight(this.hour()) ? CFG.timeScaleNight : CFG.timeScaleDay;
  }
  isDarkNow() {
    return isDark(this.hour());
  }

  // ------------------------------------------------------------------ rng
  next() {
    return this.rng.next();
  }
  rand(a: number, b: number) {
    return this.rng.range(a, b);
  }
  randInt(a: number, b: number) {
    return this.rng.int(a, b);
  }
  chance(p: number) {
    return this.rng.chance(p);
  }

  // ------------------------------------------------------------------ helpers
  npc(id: number): NpcState | null {
    const a = this.actors[id];
    return a && a.kind === 'npc' ? (a as NpcState) : null;
  }
  actorName(id: number) {
    if (id === 0) return 'you';
    const n = this.npc(id);
    return n ? fullName(n) : 'someone';
  }
  placeName(x: number, z: number) {
    return placeName(this, x, z);
  }
  descText(d: Description) {
    return descText(d);
  }
  appearanceOf(a: ActorState): Appearance | null {
    if (a.kind === 'npc') return (a as NpcState).app;
    return PLAYER_APP;
  }
  coatNameOf(a: ActorState) {
    const app = this.appearanceOf(a);
    return app ? app.coatName : 'dark';
  }
  emit(e: SimEvent) {
    this.events.push(e);
    if (this.events.length > 2000) this.events.splice(0, 1000);
  }
  say(a: ActorState, text: string, dur: number) {
    this.speech = this.speech.filter((s) => s.actor !== a.id && s.until > this.time);
    this.speech.push({ actor: a.id, text, until: this.time + dur * this.timeScale() });
    this.emit({ type: 'say', a: a.id, text });
  }
  sound(kind: string, x: number, z: number, loud: number, source: number) {
    this.emit({ type: 'sound', s: kind, x, y: this.grid.heightAt(x, z) + 1, z, v: loud, a: source });
    hearSound(this, kind, x, z, loud, source);
  }
  hasKey(n: ActorState, keyId: number) {
    if (n.kind === 'player') return this.playerHasKey(keyId);
    const npc = n as NpcState;
    if (npc.keys.includes(keyId)) return true;
    // anyone can unlock an exterior door from the inside
    return false;
  }
  playerHasKey(keyId: number) {
    return keyId === this.world.playerHouseId || this.player.inventory.some((s) => s.item === 'key' && s.tag === keyId);
  }
  actorNear(x: number, z: number, r: number) {
    return this.actors.some((a) => a.alive && Math.abs(a.x - x) < r && Math.abs(a.z - z) < r);
  }
  isInvited(npc: NpcState, actorId: number) {
    if (actorId !== 0) {
      const o = this.npc(actorId);
      return !!o && (o.role === 'police' || npc.rel.some((r) => r.id === actorId && r.affinity > 0.3));
    }
    const lt = Number(npc.ctl.lastTalkPlayer ?? -1e9);
    return this.time - lt < 2 * 3600 && npc.suspicionOfPlayer < 0.6 && !isNight(this.hour());
  }
  /** is a point currently in view of the player (used to avoid pop-in of off-screen changes) */
  actorsSee(x: number, z: number, actor: number) {
    const a = this.actors[actor];
    if (!a || !a.alive) return false;
    return Math.hypot(a.x - x, a.z - z) < 25 && this.grid.los(a.x, a.z, x, z);
  }

  playerWeaponDrawn() {
    const p = this.player;
    return !!p.weapon && p.weapon !== 'flashlight';
  }

  /** navigation agent for an npc: residents use their keys, intruders avoid light */
  agentFor(n: NpcState): NavAgent {
    const hunting = (n.role === 'killer' && n.activity?.kind === 'hunt') || (n.role === 'burglar' && n.activity?.kind === 'burgle');
    const own = (d: Door) => n.keys.includes(d.keyId) || d.buildingId === n.homeId || d.buildingId === n.workId;
    const target = Number(n.ctl.tgtB ?? n.ctl.tb ?? -1);
    return {
      doorCost: (d: Door) => {
        // the inside of a building can always be unlocked by hand; police get let in
        if (d.locked && !own(d) && !(n.building === d.buildingId)) {
          const bk = this.world.buildings[d.buildingId].kind;
          if (!(n.role === 'police' && (bk === 'house' || bk === 'shed'))) return -1;
        }
        if (d.bars && !own(d)) return -1;
        if (own(d) || d.buildingId === target || n.building === d.buildingId) return 1;
        const b = this.world.buildings[d.buildingId];
        const goal = n.pathGoalBuilding;
        if (goal === d.buildingId) return 2;
        // police may enter homes to interview; residents never cut through other people's homes
        if (b.kind === 'house' || b.kind === 'abandoned' || b.kind === 'shed') return n.role === 'police' ? 30 : -1;
        return 4;
      },
      windowCost: (w) => (hunting && w.buildingId === target && w.damage === 2 && !w.boarded ? 6 : -1),
      cellCost: hunting ? (i: number) => this.nightLight[i] / 64 : undefined,
    };
  }

  /** where to stand to reach an actor (beside the bed / chair they are using) */
  approachPoint(t: ActorState) {
    if (t.usingFurniture >= 0 && (t.stance === 'lie' || t.stance === 'sit' || t.stance === 'hidden')) {
      const f = this.world.furniture[t.usingFurniture];
      if (f) return { x: f.ux, z: f.uz };
    }
    return { x: t.x, z: t.z };
  }

  doorInsidePoint(doorId: number, buildingHint: number) {
    const d = this.world.doors[doorId];
    // prefer the side belonging to the building (or our current side)
    let s = d.roomPos >= 0 ? 1 : -1;
    if (buildingHint < 0 && d.exterior) s = -s;
    return d.axis === 'x' ? { x: d.t, z: d.c + s * 0.9 } : { x: d.c + s * 0.9, z: d.t };
  }

  doorFrontOfRoom(roomId: number) {
    const r = this.world.rooms[roomId];
    const d = this.world.doors[r.doorIds[0]];
    const s = d.roomNeg === roomId ? 1 : -1;
    return d.axis === 'x' ? { x: d.t, z: d.c + s * 0.9 } : { x: d.c + s * 0.9, z: d.t };
  }

  randomPointInRoom(roomId: number): { x: number; z: number } | null {
    const r = this.world.rooms[roomId];
    for (let i = 0; i < 20; i++) {
      const x = this.rand(r.rect.x0 + 0.5, r.rect.x1 - 0.5);
      const z = this.rand(r.rect.z0 + 0.5, r.rect.z1 - 0.5);
      const c = this.grid.cellAt(x, z);
      if (!(this.grid.flags[c] & 1)) return { x, z };
    }
    return null;
  }

  randomPointInBuilding(bId: number) {
    const b = this.world.buildings[bId];
    const rooms = b.roomIds.filter((r) => this.world.rooms[r].kind !== 'bath');
    return this.randomPointInRoom(rooms[this.randInt(0, rooms.length - 1)] ?? b.roomIds[0]);
  }

  randomStreetPoint() {
    const roads = this.world.roads.filter((r) => r.kind === 'street' || r.kind === 'main' || r.kind === 'alley');
    const r = roads[this.randInt(0, roads.length - 1)];
    const x = this.rand(Math.max(r.rect.x0, 30), Math.min(r.rect.x1, this.world.width - 30));
    const z = this.rand(Math.max(r.rect.z0, 30), Math.min(r.rect.z1, this.world.depth - 30));
    return { x, z };
  }

  smallTalk(a: NpcState, b: NpcState) {
    const lines = [
      `Evening, ${b.first}.`,
      `Morning, ${b.first}. Cold one today.`,
      `${b.first}! Did you hear what happened?`,
      `How's the family, ${b.first}?`,
      `Have you seen the new neighbour yet?`,
      `Lock your doors tonight, ${b.first}.`,
    ];
    const known = a.memories.some((m) => m.topic === 'murder' || m.topic === 'body' || m.topic === 'missing');
    return known ? lines[2] : lines[this.randInt(0, lines.length - 1)];
  }

  // ------------------------------------------------------------------ lighting

  private buildLightBuckets() {
    this.lightBuckets.clear();
    for (const l of this.world.lights) {
      const k = Math.floor(l.x / 16) * 1000 + Math.floor(l.z / 16);
      if (!this.lightBuckets.has(k)) this.lightBuckets.set(k, []);
      this.lightBuckets.get(k)!.push(l.id);
    }
  }

  computeNightLight() {
    const g = this.grid;
    this.nightLight.fill(0);
    for (const l of this.world.lights) {
      if (l.broken || l.buildingId >= 0) continue;
      if (!(l.kind === 'street' || l.kind === 'porch' || l.kind === 'park' || l.kind === 'sign')) continue;
      const r = l.range * 0.9;
      const x0 = g.cx(l.x - r);
      const x1 = g.cx(l.x + r);
      const z0 = g.cz(l.z - r);
      const z1 = g.cz(l.z + r);
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot((x + 0.5) * CELL - l.x, (z + 0.5) * CELL - l.z);
          if (d > r) continue;
          const v = Math.round((1 - d / r) * 255 * Math.min(1, l.intensity / 2));
          const i = g.idx(x, z);
          if (v > this.nightLight[i]) this.nightLight[i] = v;
        }
    }
  }

  nightLightCost(i: number) {
    return this.nightLight[i] / 64;
  }

  /** ambient daylight factor 0..1 */
  daylight() {
    const h = this.hour();
    if (h < 5.8 || h > 20.4) return 0.0;
    if (h < 7.2) return (h - 5.8) / 1.4;
    if (h > 18.8) return (20.4 - h) / 1.6;
    return 1;
  }

  /** light level at a point (0 dark .. 1+ bright); used by stealth and perception */
  lightAt(x: number, z: number): number {
    const room = this.grid.roomAt(x, z);
    const day = this.daylight();
    let L = room >= 0 ? day * 0.5 + 0.02 : day * 1.0 + 0.06;
    const bx = Math.floor(x / 16);
    const bz = Math.floor(z / 16);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        const ids = this.lightBuckets.get((bx + dx) * 1000 + (bz + dz));
        if (!ids) continue;
        for (const id of ids) {
          const l = this.world.lights[id];
          if (!l.on || l.broken) continue;
          if (room >= 0) {
            if (l.roomId !== room) continue;
          } else if (l.buildingId >= 0) continue;
          const d = Math.hypot(l.x - x, l.z - z);
          if (d > l.range) continue;
          const f = 1 - d / l.range;
          L += f * f * Math.min(1.2, l.intensity * 0.7) * flickerLevel(l);
        }
      }
    // flashlight beams
    for (const a of this.actors) {
      if (!a.flashlight || !a.alive) continue;
      const d = Math.hypot(a.x - x, a.z - z);
      if (d > 20 || d < 0.01) continue;
      const ang = Math.abs(wrapAngle(yawTo(a.x, a.z, x, z) - a.yaw));
      if (ang > 0.5) continue;
      L += (1 - d / 20) * 1.1;
    }
    return L;
  }

  /** occupancy driven house lights, auto street lights, business lights */
  private updateLights() {
    const h = this.hour();
    const dark = isDark(h);
    const autoOn = h >= CFG.dusk || h < CFG.dawn;
    for (const l of this.world.lights) {
      if (l.auto) l.on = autoOn;
    }
    const occupied = new Set<number>();
    for (const n of this.npcs) if (n.alive && !n.sleeping && n.room >= 0 && n.outfit !== 'night' && !n.inCustody) occupied.add(n.room);
    if (this.player.room >= 0) occupied.add(this.player.room);
    for (const room of this.world.rooms) {
      const b = this.world.buildings[room.buildingId];
      if (b.kind === 'abandoned' || b.id === this.world.playerHouseId) continue;
      const business = b.kind !== 'house' && b.kind !== 'shed';
      for (const lid of room.lightIds) {
        const l = this.world.lights[lid];
        if (l.kind !== 'room') continue;
        if (business) l.on = occupied.has(room.id) || (b.kind === 'police' && true) || (dark && this.npcs.some((n) => n.workId === b.id && n.building === b.id && n.alive));
        else if (dark && occupied.has(room.id)) l.on = true;
        else if (!occupied.has(room.id) && l.on && this.chance(0.5)) l.on = false;
        else if (!dark && l.on && this.chance(0.3)) l.on = false;
      }
    }
    // porch lights: households awake at night keep them on
    for (const hh of this.households) {
      const b = this.world.buildings[hh.building];
      if (b.porchLightId < 0) continue;
      const l = this.world.lights[b.porchLightId];
      const awake = hh.members.some((m) => this.actors[m].alive && this.actors[m].building === b.id && !(this.actors[m] as NpcState).sleeping);
      const keep = (hh.id * 7) % 3 === 0;
      l.on = dark && (awake || keep);
    }
  }

  // ------------------------------------------------------------------ items & decals

  takeFood(homeId: number): boolean {
    for (const f of this.world.furniture) {
      if (f.buildingId !== homeId || !f.container) continue;
      if (f.use !== 'fridge' && f.use !== 'cabinet' && f.use !== 'sink') continue;
      const s = f.container.find((x) => x.item === 'sandwich' || x.item === 'apple' || x.item === 'canned_beans');
      if (s) {
        s.n--;
        if (s.n <= 0) f.container.splice(f.container.indexOf(s), 1);
        return true;
      }
    }
    return false;
  }

  foodCount(homeId: number) {
    let n = 0;
    for (const f of this.world.furniture) {
      if (f.buildingId !== homeId || !f.container) continue;
      for (const s of f.container) if (s.item === 'sandwich' || s.item === 'apple' || s.item === 'canned_beans') n += s.n;
    }
    return n;
  }

  dropItem(item: string, x: number, z: number, n = 1, tag = -1, label = '') {
    const it: SimItem = { id: this.items.length, item, n, x, y: this.grid.heightAt(x, z) + 0.03, z, tag, taken: false, label };
    this.items.push(it);
    this.emit({ type: 'item', a: it.id });
    return it;
  }

  addDecal(kind: Decal['kind'], x: number, y: number, z: number, nx: number, ny: number, nz: number, size: number, rot: number, grow = 0) {
    if (this.decals.length > 1400) this.decals.splice(0, 200);
    const d: Decal = { id: this.decals.length ? this.decals[this.decals.length - 1].id + 1 : 0, kind, x, y, z, nx, ny, nz, size, rot, variant: this.randInt(0, 3), time: this.time, grow };
    this.decals.push(d);
    this.emit({ type: 'decal', a: d.id });
    return d;
  }

  /** blood on the floor around the victim and on a wall if one is close behind */
  splatterBlood(x: number, z: number, y: number, dir: number, amount: number) {
    const n = Math.min(4, 1 + Math.round(amount * 2));
    for (let i = 0; i < n; i++) {
      const d = this.rand(0.2, 1.0 + amount);
      const a = dir + this.rand(-0.6, 0.6);
      const px = x + Math.sin(a) * d;
      const pz = z - Math.cos(a) * d;
      this.addDecal('blood', px, this.grid.heightAt(px, pz) + 0.011 + i * 0.0006, pz, 0, 1, 0, this.rand(0.25, 0.5) * (0.6 + amount * 0.5), this.rand(0, 6.28));
    }
    // wall behind the victim
    const fx = Math.sin(dir);
    const fz = -Math.cos(dir);
    const hit = this.colliders.firstHit(x, z, x + fx * 1.6, z + fz * 1.6, 1.2);
    if (hit && hit.c.kind === 0) {
      const hx = x + fx * 1.6 * hit.t;
      const hz = z + fz * 1.6 * hit.t;
      const r = hit.c.r;
      // choose the face normal facing back toward the victim
      const nxw = Math.abs(hx - r.x0) < 0.02 ? -1 : Math.abs(hx - r.x1) < 0.02 ? 1 : 0;
      const nzw = nxw === 0 ? (Math.abs(hz - r.z0) < 0.02 ? -1 : 1) : 0;
      this.addDecal('blood', hx + nxw * 0.012, y + this.rand(0.7, 1.5), hz + nzw * 0.012, nxw, 0, nzw, this.rand(0.35, 0.7) * (0.7 + amount * 0.4), this.rand(0, 6.28));
    }
  }

  // ------------------------------------------------------------------ windows & doors

  damageWindow(id: number, dmg: number, by: number, pry = false) {
    const w = this.world.windows[id];
    const p = w.axis === 'x' ? { x: w.t, z: w.c } : { x: w.c, z: w.t };
    const b = this.world.buildings[w.buildingId];
    const y = b.floorY + (w.sill + w.top) / 2;
    if (w.boarded) {
      w.boardHp -= dmg;
      this.emit({ type: 'impact', s: 'wood', x: p.x, y, z: p.z });
      this.sound('board_hit', p.x, p.z, 22, by);
      if (w.boardHp <= 0) {
        w.boarded = false;
        w.boardHp = 0;
        this.emit({ type: 'boards_break', a: id, x: p.x, y, z: p.z });
        this.sound('boards_break', p.x, p.z, 26, by);
      }
      return;
    }
    if (w.damage === 2) return;
    w.hp -= dmg;
    if (pry) {
      w.damage = 2;
      w.hp = 0;
      this.sound('pry', p.x, p.z, 9, by);
      this.emit({ type: 'glass', a: id, x: p.x, y, z: p.z, v: 0.4 });
    } else if (w.hp <= 0) {
      w.damage = 2;
      this.sound('glass', p.x, p.z, 34, by);
      this.emit({ type: 'glass', a: id, x: p.x, y, z: p.z, v: 1 });
      // shards on both sides of the window
      for (let i = 0; i < 6; i++) {
        const s = this.chance(0.7) ? -w.outside : w.outside;
        const ox = w.axis === 'x' ? this.rand(-w.width / 2, w.width / 2) : s * this.rand(0.2, 1.2);
        const oz = w.axis === 'x' ? s * this.rand(0.2, 1.2) : this.rand(-w.width / 2, w.width / 2);
        this.addDecal('glass', p.x + ox, this.grid.heightAt(p.x + ox, p.z + oz) + 0.012, p.z + oz, 0, 1, 0, this.rand(0.15, 0.35), this.rand(0, 6.28));
      }
      witnessAct(this, by, 'breakin', p.x, p.z, -1, this.openIncident('breakin', by, -1, p.x, p.z, w.buildingId), 0.7);
    } else {
      w.damage = 1;
      this.sound('glass_crack', p.x, p.z, 12, by);
      this.emit({ type: 'glass_crack', a: id, x: p.x, y, z: p.z });
    }
  }

  damageDoor(id: number, dmg: number, by: number) {
    const d = this.world.doors[id];
    const p = d.axis === 'x' ? { x: d.t, z: d.c } : { x: d.c, z: d.t };
    if (d.broken) return;
    d.hp -= dmg;
    this.emit({ type: 'impact', s: 'door', x: p.x, y: this.world.buildings[d.buildingId].floorY + 1.1, z: p.z });
    this.sound('kick', p.x, p.z, 26, by);
    if (d.hp <= 0) {
      d.broken = true;
      d.locked = false;
      d.open = 1;
      d.target = 1;
      this.emit({ type: 'door_break', a: id, x: p.x, y: 1, z: p.z });
      this.sound('door_force', p.x, p.z, 30, by);
      this.markForced(id);
    }
  }

  markForced(doorId: number) {
    if (!this.forcedDoors.includes(doorId)) this.forcedDoors.push(doorId);
  }

  // ------------------------------------------------------------------ incidents & evidence

  openIncident(kind: Incident['kind'], perp: number, victim: number, x: number, z: number, building: number) {
    const recent = this.incidents.find(
      (i) => (i.perp === perp || perp < 0) && i.building === building && this.time - i.time < 3 * 3600 && (i.kind === kind || (kind === 'breakin' && (i.kind === 'murder' || i.kind === 'attack' || i.kind === 'burglary'))),
    );
    if (recent) {
      if (victim >= 0 && recent.victim < 0) recent.victim = victim;
      return recent.id;
    }
    const inc: Incident = { id: this.incidents.length, kind, perp, victim, x, z, building, time: this.time, discovered: false, reported: false, caseId: -1, night: this.nightIndex(), clues: [], bodyHidden: false };
    this.incidents.push(inc);
    this.emit({ type: 'incident', a: inc.id, s: kind });
    return inc.id;
  }

  /** called whenever one actor damages another; returns the incident id */
  violence(attacker: ActorState, target: ActorState) {
    const existing = this.incidents.find((i) => i.perp === attacker.id && i.victim === target.id && this.time - i.time < 3600);
    if (existing) return existing.id;
    return this.openIncident('attack', attacker.id, target.id, target.x, target.z, target.building);
  }

  incidentForVictim(id: number) {
    for (let i = this.incidents.length - 1; i >= 0; i--) if (this.incidents[i].victim === id) return i;
    return -1;
  }

  incidentNear(x: number, z: number, maxMinutes: number) {
    for (let i = this.incidents.length - 1; i >= 0; i--) {
      const inc = this.incidents[i];
      if (this.time - inc.time > maxMinutes * 60) break;
      if (Math.hypot(inc.x - x, inc.z - z) < 40) return i;
    }
    return -1;
  }

  onDeath(t: ActorState, by: number, cause: string) {
    let inc = this.incidents.find((i) => i.victim === t.id && (i.kind === 'attack' || i.kind === 'murder'));
    if (!inc) inc = this.incidents[this.openIncident('murder', by, t.id, t.x, t.z, t.building)];
    inc.kind = 'murder';
    inc.perp = by >= 0 ? by : inc.perp;
    inc.x = t.x;
    inc.z = t.z;
    witnessAct(this, by, 'murder', t.x, t.z, t.id, inc.id, 1);
    if (by === 0 && t.kind === 'npc') this.player.wantedLevel = Math.max(this.player.wantedLevel, this.npcs.some((n) => n.memories.some((m) => m.topic === 'murder' && m.actor === 0)) ? 2 : this.player.wantedLevel);
    void cause;
  }

  discoverBody(victim: number, finder: number) {
    const idx = this.incidentForVictim(victim);
    if (idx >= 0) {
      const inc = this.incidents[idx];
      if (!inc.discovered) {
        inc.discovered = true;
        this.emit({ type: 'body_found', a: victim, b: finder, x: inc.x, z: inc.z, text: `${this.actorName(victim)} has been found dead ${this.placeName(inc.x, inc.z)}.` });
      }
    }
  }

  newClue(c: Omit<Clue, 'id' | 'found' | 'foundTime' | 'item'>, physical: boolean, x: number, z: number, label: string): Clue {
    const clue: Clue = { ...c, id: this.clues.length, found: false, foundTime: -1, item: -1 };
    this.clues.push(clue);
    if (physical) {
      const it = this.dropItem('evidence', x, z, 1, clue.id, label);
      clue.item = it.id;
    }
    if (c.incident >= 0) this.incidents[c.incident]?.clues.push(clue.id);
    return clue;
  }

  /** the killer leaves traces: chosen to reveal attributes not yet revealed */
  leaveKillerClues(k: NpcState, victim: ActorState) {
    const incId = this.incidentForVictim(victim.id);
    const revealed = new Set(this.clues.filter((c) => c.points === k.id).map((c) => c.attr));
    const options: { attr: Clue['attr']; kind: Clue['kind'] }[] = [];
    options.push({ attr: 'coat', kind: 'fabric' }, { attr: 'shoes', kind: 'footprint' }, { attr: 'height', kind: 'footprint' });
    if (k.smoker) options.push({ attr: 'smoker', kind: 'cigarette' });
    if (k.app.hairStyle !== 'bald') options.push({ attr: 'hair', kind: 'hair' });
    const fresh = options.filter((o) => !revealed.has(o.attr));
    const pool = fresh.length ? fresh : options;
    this.rng.shuffle(pool);
    const count = this.clues.filter((c) => c.points === k.id).length < 2 ? 2 : this.chance(0.5) ? 2 : 1;
    const ex = Number(k.ctl.ex ?? victim.x);
    const ez = Number(k.ctl.ez ?? victim.z);
    for (let i = 0; i < Math.min(count, pool.length); i++) {
      const o = pool[i];
      const nearBody = i === 0;
      const x = nearBody ? victim.x + this.rand(-1, 1) : ex + this.rand(-0.8, 0.8);
      const z = nearBody ? victim.z + this.rand(-1, 1) : ez + this.rand(-0.8, 0.8);
      const p = this.pf.nearestFree(x, z, { doorCost: () => 0, windowCost: () => -1 }, 3);
      const px = p >= 0 ? this.grid.centreX(p) : x;
      const pz = p >= 0 ? this.grid.centreZ(p) : z;
      let text = '';
      let value = '';
      let label = '';
      switch (o.attr) {
        case 'coat':
          value = k.app.coatName;
          text = `A torn scrap of ${value} coat fabric.`;
          label = 'Torn fabric';
          break;
        case 'shoes':
          value = k.app.shoes;
          text = `A clear muddy print from ${value === 'dress' ? 'dress shoes' : value}.`;
          label = 'Shoe print';
          break;
        case 'height': {
          value = heightClass(k.app.height);
          text = `Long, deep strides in the mud. Whoever made them is ${value === 'average' ? 'of average height' : value}.`;
          label = 'Footprints';
          break;
        }
        case 'smoker':
          value = 'smoker';
          text = 'A fresh cigarette butt, still warm. The Night Neighbour smokes.';
          label = 'Cigarette butt';
          break;
        case 'hair':
          value = k.app.hairStyle === 'cap' ? hairName(k.app.hair) : hairName(k.app.hair);
          text = `A few ${value} hairs caught on a splinter.`;
          label = 'Hair strands';
          break;
      }
      this.newClue({ kind: o.kind, incident: incId, attr: o.attr, value, points: k.id, reliability: 0.85, text, x: px, z: pz }, true, px, pz, label);
      if (o.kind === 'footprint') for (let s = 0; s < 4; s++) this.addDecal('footprint', px + this.rand(-1.2, 1.2), this.grid.heightAt(px, pz) + 0.013, pz + this.rand(-1.2, 1.2), 0, 1, 0, 0.32, this.rand(0, 6.28));
    }
    // bloody footprints leading away
    if (k.bloody > 0.2) for (let s = 0; s < 5; s++) this.addDecal('footprint', k.x + this.rand(-2, 2), k.y + 0.013, k.z + this.rand(-2, 2), 0, 1, 0, 0.3, k.yaw);
  }

  stashKillerEvidence(k: NpcState) {
    const f = this.world.furniture[this.lair.furniture];
    if (!f) return;
    if (!f.container) f.container = [];
    if (f.container.some((s) => s.item === 'evidence')) return;
    const own = this.lair.building === k.homeId || this.world.buildings[this.lair.building].lotId === this.world.buildings[k.homeId].lotId;
    const knife = this.newClue({ kind: 'weapon', incident: -1, attr: own ? 'identity' : 'none', value: own ? String(k.id) : '', points: k.id, reliability: own ? 1 : 0.4, text: own ? `A bloody kitchen knife hidden in ${fullName(k)}'s shed.` : 'A bloody kitchen knife wrapped in a rag.', x: f.x, z: f.z }, false, 0, 0, '');
    f.container.push({ item: 'evidence', n: 1, tag: knife.id });
    if (!own) {
      const key = this.newClue({ kind: 'lair', incident: -1, attr: 'identity', value: String(k.id), points: k.id, reliability: 0.95, text: `A house key on a ring tagged "${this.world.buildings[k.homeId].address}", left with the bloody knife.`, x: f.x, z: f.z }, false, 0, 0, '');
      f.container.push({ item: 'evidence', n: 1, tag: key.id });
    }
    const coat = this.newClue({ kind: 'fabric', incident: -1, attr: 'coat', value: k.app.coatName, points: k.id, reliability: 1, text: `A ${k.app.coatName} coat, stiff with dried blood.`, x: f.x, z: f.z }, false, 0, 0, '');
    f.container.push({ item: 'evidence', n: 1, tag: coat.id });
  }

  lairPoint() {
    const b = this.world.buildings[this.lair.building];
    const f = this.world.furniture[this.lair.furniture];
    if (f) return { x: f.ux, z: f.uz };
    return b.insideFront;
  }

  hideBody(k: NpcState, body: ActorState) {
    k.carrying = -1;
    const p = this.lairPoint();
    body.x = p.x + this.rand(-0.3, 0.3);
    body.z = p.z + this.rand(-0.3, 0.3);
    updateLocation(this, body, 1);
    const inc = this.incidents[this.incidentForVictim(body.id)];
    if (inc) inc.bodyHidden = true;
    const n = this.npc(body.id);
    if (n) n.missing = true;
    this.addDecal('pool', body.x, body.y + 0.014, body.z, 0, 1, 0, 0.45, this.rand(0, 6.28), 0.5);
  }

  dragOutOfHiding(t: ActorState) {
    const f = this.world.furniture[t.usingFurniture];
    t.usingFurniture = -1;
    t.hiddenIn = -1;
    t.stance = 'stand';
    if (f) {
      t.x = f.ux;
      t.z = f.uz;
    }
    if (t.kind === 'npc') {
      const n = t as NpcState;
      clearTasks(this, n);
      n.activity = null;
      raiseAlarm(this, n, 1, -1, t.x, t.z);
    }
    this.emit({ type: 'found_hiding', a: t.id });
  }

  dropBody(k: ActorState) {
    k.carrying = -1;
  }

  recordTheft(b: NpcState, building: number, item: string, n: number) {
    const id = this.openIncident('burglary', b.id, -1, this.world.buildings[building].insideFront.x, this.world.buildings[building].insideFront.z, building);
    const inc = this.incidents[id];
    inc.kind = 'burglary';
    this.misc[`stolen_${id}`] = `${n} ${item}`;
  }

  stashLoot(b: NpcState) {
    const f = this.world.furniture.find((x) => x.buildingId === b.homeId && (x.use === 'dresser' || x.use === 'wardrobe') && x.kind !== 'none');
    if (!f) return;
    if (!f.container) f.container = [];
    const n = Number(b.ctl.loot);
    b.ctl.loot = 0;
    const inc = this.incidents.filter((i) => i.perp === b.id && i.kind === 'burglary').pop();
    const clue = this.newClue({ kind: 'stolen', incident: inc ? inc.id : -1, attr: 'identity', value: String(b.id), points: b.id, reliability: 0.9, text: `Stolen jewellery and watches stuffed in ${fullName(b)}'s ${f.kind}.`, x: f.x, z: f.z }, false, 0, 0, '');
    f.container.push({ item: 'evidence', n: 1, tag: clue.id }, { item: 'watch', n: Math.max(1, Math.min(3, n)) });
  }

  /** morning discoveries: break-ins noticed, missing people missed */
  private dailyChecks() {
    const day = this.day();
    if (this.misc.lastDaily === day) return;
    this.misc.lastDaily = day;
    // pensions, benefits, royalties: people without a workplace still get by
    for (const n of this.npcs) if (n.alive && n.workId < 0 && !n.inCustody) n.money += 20;
    for (const inc of this.incidents) {
      if (inc.discovered) continue;
      if (inc.kind === 'burglary' || inc.kind === 'breakin') {
        const owners = this.npcs.filter((n) => n.homeId === inc.building && n.alive);
        for (const o of owners) {
          remember(this, o, { topic: inc.kind === 'burglary' ? 'theft' : 'breakin', source: 'saw', actor: -1, subject: o.id, desc: {}, x: inc.x, z: inc.z, time: this.time, confidence: 1, from: -1, incident: inc.id });
          raiseAlarm(this, o, 0.55, -1, inc.x, inc.z);
        }
        if (owners.length) inc.discovered = true;
      }
      if (inc.kind === 'murder' && !inc.discovered && this.time - inc.time > 3 * 3600) {
        // somebody misses them: housemates, coworkers or friends raise the alarm
        const v = this.npc(inc.victim);
        if (!v) continue;
        let knowers = this.npcs.filter((n) => n.alive && n.id !== v.id && n.role !== 'killer' && (n.household === v.household || (v.workId >= 0 && n.workId === v.workId) || n.rel.some((r) => r.id === v.id && r.kind === 'friend')));
        if (!knowers.length) knowers = this.npcs.filter((n) => n.alive && n.id !== v.id && n.role !== 'killer' && n.rel.some((r) => r.id === v.id && r.kind === 'neighbour')).slice(0, 2);
        if (!knowers.length) {
          // the nearest neighbours notice the curtains have not moved
          const vh0 = this.world.buildings[v.homeId];
          knowers = this.npcs
            .filter((n) => n.alive && n.id !== v.id && n.role !== 'killer')
            .sort((a, b) => Math.hypot(this.world.buildings[a.homeId].insideFront.x - vh0.insideFront.x, this.world.buildings[a.homeId].insideFront.z - vh0.insideFront.z) - Math.hypot(this.world.buildings[b.homeId].insideFront.x - vh0.insideFront.x, this.world.buildings[b.homeId].insideFront.z - vh0.insideFront.z))
            .slice(0, 2);
        }
        const vh = this.world.buildings[v.homeId];
        for (const kn of knowers) {
          remember(this, kn, { topic: 'missing', source: 'saw', actor: -1, subject: v.id, desc: {}, x: vh.outsideFront.x, z: vh.outsideFront.z, time: this.time, confidence: 1, from: -1, incident: inc.id });
          raiseAlarm(this, kn, 0.6, -1, vh.outsideFront.x, vh.outsideFront.z);
        }
        if (knowers.length && !this.misc[`missing_${inc.id}`]) {
          this.misc[`missing_${inc.id}`] = true;
          v.missing = true;
          this.emit({ type: 'missing', a: v.id, text: `${fullName(v)} hasn't been seen since last night.` });
        }
      }
    }
    // people get warier as bodies pile up
    const murders = this.incidents.filter((i) => i.kind === 'murder' && i.discovered).length;
    if (murders > 0) for (const n of this.npcs) if (n.traits.bravery < 0.5 + murders * 0.1) n.avoidNightOut = true;
  }

  // ------------------------------------------------------------------ police glue

  policeCall(npc: NpcState) {
    policeCallFn(this, npc);
  }

  policeReact(npc: NpcState) {
    return policeReactFn(this, npc);
  }

  policeExamineScene(o: NpcState, c: PoliceCase) {
    c.sceneChecked = true;
    // bodies at the scene (same building, or close by) are found, examined and later taken away
    for (const a of this.actors) {
      if (a.alive || a.bodyRemoved) continue;
      const sameBuilding = c.building >= 0 && a.building === c.building;
      if (!sameBuilding && Math.hypot(a.x - c.x, a.z - c.z) > 15) continue;
      this.discoverBody(a.id, o.id);
      remember(this, o, { topic: 'body', source: 'saw', actor: -1, subject: a.id, desc: {}, x: a.x, z: a.z, time: this.time, confidence: 1, from: -1, incident: this.incidentForVictim(a.id) });
      if (c.kind === 'missing person') c.kind = 'homicide';
      a.ctl.examined = this.time;
      if (!this.tape.some((t) => Math.hypot(t.x - a.x, t.z - a.z) < 4)) {
        this.tape.push({ x: a.x, z: a.z, rot: this.rand(0, 3), len: 4.5 });
        this.emit({ type: 'tape', x: a.x, z: a.z });
      }
      const inc = this.incidents[this.incidentForVictim(a.id)];
      if (inc) inc.discovered = true;
    }
    // physical traces at the scene are noted (players can still find them)
    for (const cl of this.clues) if (cl.incident === c.incident && cl.incident >= 0) c.reports.push({ from: o.id, topic: 'murder', actor: -1, desc: cl.attr === 'coat' ? { coat: cl.value } : cl.attr === 'height' ? { height: cl.value as 'tall' } : cl.attr === 'shoes' ? { shoes: cl.value as 'boots' } : {}, confidence: 0.5, time: this.time });
  }

  arrest(o: NpcState, sus: ActorState) {
    if (sus.kind === 'player') {
      this.onPlayerArrestAttempt?.(o);
      return;
    }
    if (sus.arrested) return;
    sus.arrested = true;
    sus.stance = 'stand';
    const n = sus as NpcState;
    clearTasks(this, n);
    n.activity = { kind: 'arrested', priority: 200, started: this.time, until: Infinity, data: { by: o.id } };
    n.weapon = null;
    this.say(o, 'You have the right to remain silent.', 3);
    this.emit({ type: 'arrest', a: sus.id, b: o.id, text: `${fullName(n)} has been arrested by ${fullName(o)}.` });
    rememberArrest(this, sus.id);
  }

  jail(a: ActorState, cellRoom: number) {
    a.arrested = true;
    a.inCustody = true;
    a.ctl.jailedAt = this.time;
    if (cellRoom >= 0) {
      const r = this.world.rooms[cellRoom].rect;
      a.x = (r.x0 + r.x1) / 2;
      a.z = (r.z0 + r.z1) / 2 + 0.3;
      updateLocation(this, a, 1);
      for (const d of this.world.rooms[cellRoom].doorIds) {
        const door = this.world.doors[d];
        door.target = 0;
        door.locked = true;
      }
    }
    for (const c of this.cases) if (c.suspect === a.id) c.status = 'closed';
    this.emit({ type: 'jailed', a: a.id, text: `${this.actorName(a.id)} is now in custody.` });
  }

  release(a: ActorState) {
    a.inCustody = false;
    a.arrested = false;
    const pol = this.world.buildings[this.world.policeId];
    a.x = pol.outsideFront.x;
    a.z = pol.outsideFront.z;
    updateLocation(this, a, 1);
    if (a.kind === 'npc') {
      (a as NpcState).activity = null;
      (a as NpcState).tasks = [];
    }
    this.emit({ type: 'released', a: a.id, text: `${this.actorName(a.id)} was released from custody.` });
  }

  suspectResponds(sus: NpcState, officer: NpcState) {
    if (sus.role === 'killer') {
      if (sus.health > 45 && this.chance(0.6)) {
        sus.weapon = 'kitchen_knife';
        setActivity(this, sus, 'kfight', 96, [{ kind: 'attack', target: officer.id }]);
      } else brainFlee(this, sus, officer.x, officer.z);
    } else if (sus.role === 'burglar' && this.chance(0.6)) brainFlee(this, sus, officer.x, officer.z);
    else {
      clearTasks(this, sus);
      sus.activity = { kind: 'comply', priority: 150, started: this.time, until: this.time + 600, data: {} };
      this.say(sus, 'This is a mistake! I did nothing!', 3);
    }
  }

  fleeFrom(npc: NpcState, x: number, z: number) {
    brainFlee(this, npc, x, z);
  }

  // ------------------------------------------------------------------ killer glue

  huntPlan(): HuntPlan {
    const base = this.director.plan(this, this.nightIndex());
    return this.huntOverride ? { ...base, ...this.huntOverride } : base;
  }

  huntPlanOverride(p: Partial<HuntPlan>) {
    this.huntOverride = { ...(this.huntOverride ?? {}), ...p };
    this.misc.overrideNight = this.nightIndex();
  }

  roleThink(npc: NpcState): boolean {
    if (npc.activity?.kind === 'arrested') return true;
    if (npc.activity?.kind === 'comply') {
      if (this.time > npc.activity.until) npc.activity = null;
      else return true;
    }
    // a finished special activity hands control back to the routine
    const special = ['hunt', 'kfight', 'kwatch', 'kknock', 'burgle', 'respond', 'arrest', 'patrol'];
    if (npc.activity && special.includes(npc.activity.kind) && npc.tasks.length === 0) npc.activity = null;
    if (npc.role === 'killer') return killerThink(this, npc);
    if (npc.role === 'burglar') return burglarThink(this, npc);
    if (npc.role === 'police') return policeThink(this, npc);
    return false;
  }

  combatTask(npc: NpcState, t: Task, dt: number): TaskResult {
    return combatTaskFn(this, npc, t, dt);
  }

  customTask(npc: NpcState, t: Task, dt: number): TaskResult {
    switch (t.kind) {
      case 'hunt':
        return huntTask(this, npc, t, dt);
      case 'k_watch':
        return watchTask(this, npc, t, dt);
      case 'k_knock':
        return knockTask(this, npc, t, dt);
      case 'hunt_return':
        return huntReturnTask(this, npc, t, dt);
      case 'burgle':
        return burgleTask(this, npc, t, dt);
      case 'patrol':
      case 'p_scene':
      case 'p_interview':
      case 'p_arrest':
        return policeTask(this, npc, t, dt);
      case 'open_business': {
        const b = this.world.buildings[t.target!];
        for (const d of b.doorIds) if (this.world.doors[d].exterior && d === b.frontDoorId) this.world.doors[d].locked = false;
        return 'done';
      }
      case 'close_business': {
        const b = this.world.buildings[t.target!];
        const others = this.npcs.some((o) => o !== npc && o.alive && o.workId === b.id && o.activity?.kind === 'work' && o.building === b.id);
        if (!others && b.kind !== 'police') {
          for (const d of b.doorIds) if (this.world.doors[d].exterior) {
            this.world.doors[d].target = 0;
            this.world.doors[d].locked = true;
          }
          for (const rid of b.roomIds) for (const lid of this.world.rooms[rid].lightIds) this.world.lights[lid].on = false;
        }
        return 'done';
      }
      case 'knock': {
        const host = this.npc(t.target!);
        const b = host ? this.world.buildings[host.homeId] : null;
        if (b) this.sound('knock', b.outsideFront.x, b.outsideFront.z, 12, npc.id);
        return 'done';
      }
      case 'meet': {
        // the host comes out to the porch if home and free
        const host = this.npc(t.target!);
        if (!host || !host.alive || host.building !== host.homeId || host.sleeping || (host.activity && host.activity.priority > 26)) return 'done';
        const dur = t.dur ?? 900;
        setActivity(this, host, 'chat', 24, [{ kind: 'talk', target: npc.id, dur: dur + 120 }]);
        t.kind = 'talk';
        return 'running';
      }
      case 'confront': {
        const th = this.actors[t.target!];
        if (!th || !th.alive) return 'done';
        const d = Math.hypot(th.x - npc.x, th.z - npc.z);
        t.t = (t.t ?? 0) + dt * this.timeScale();
        if (th.building !== npc.homeId && d > 6) return 'done';
        if (d > 2) {
          moveActor(this, npc, ((th.x - npc.x) / d) * dt * 1.6, ((th.z - npc.z) / d) * dt * 1.6);
          npc.anim = 'walk';
        } else {
          npc.anim = 'talk';
          if (npc.traits.aggression > 0.6 && t.t > 60) {
            setActivity(this, npc, 'fight', 90, [{ kind: 'attack', target: th.id }]);
            return 'running';
          }
        }
        npc.yaw = yawTo(npc.x, npc.z, th.x, th.z);
        if (t.t > (t.dur ?? 400)) return 'done';
        return 'running';
      }
    }
    return 'done';
  }

  // ------------------------------------------------------------------ main step

  /** advances the simulation by dt real seconds */
  step(dt: number) {
    dt = Math.min(dt, CFG.maxStep);
    const gdt = dt * this.timeScale();
    const prevHour = this.hour();
    this.time += gdt;
    this.pathBudget = CFG.pathBudgetPerStep;
    // door animation
    for (const d of this.world.doors) {
      if (d.broken) continue;
      if (d.open !== d.target) {
        const sp = dt * 2.8;
        d.open = d.target > d.open ? Math.min(d.target, d.open + sp) : Math.max(d.target, d.open - sp);
      }
    }
    // lights every game minute
    this.lightTimer -= gdt;
    if (this.lightTimer <= 0) {
      this.lightTimer = 60;
      this.updateLights();
    }
    if (prevHour < 8 && this.hour() >= 8) this.dailyChecks();
    // the coroner collects examined bodies after a while
    for (const a of this.actors) {
      if (a.alive || a.bodyRemoved || a.ctl.examined === undefined) continue;
      if (this.time - Number(a.ctl.examined) > 2 * 3600 && !this.actorsSee(a.x, a.z, 0)) {
        a.bodyRemoved = true;
        this.addDecal('chalk', a.x, a.y + 0.016, a.z, 0, 1, 0, 1.9, a.yaw);
        this.emit({ type: 'body_removed', a: a.id });
      }
    }
    if (this.misc.overrideNight !== undefined && this.misc.overrideNight !== this.nightIndex()) {
      this.huntOverride = null;
      delete this.misc.overrideNight;
    }
    // actors
    for (const a of this.actors) updateCombat(this, a, dt);
    for (const n of this.npcs) this.stepNpc(n, dt, gdt);
    // dragged bodies follow their carrier
    for (const a of this.actors) {
      if (a.carrying < 0) continue;
      const body = this.actors[a.carrying];
      if (!body || body.alive) {
        a.carrying = -1;
        continue;
      }
      const bx = a.x - Math.sin(a.yaw) * 1.1;
      const bz = a.z + Math.cos(a.yaw) * 1.1;
      const prev = { x: body.x, z: body.z };
      body.x += (bx - body.x) * Math.min(1, dt * 8);
      body.z += (bz - body.z) * Math.min(1, dt * 8);
      body.yaw = a.yaw;
      updateLocation(this, body, dt);
      if (Math.hypot(body.x - prev.x, body.z - prev.z) > 0.02 && this.chance(dt * 3)) this.addDecal('drag', body.x, body.y + 0.012, body.z, 0, 1, 0, 0.35, a.yaw);
    }
    // arrested npcs follow the arresting officer
    for (const n of this.npcs) {
      if (!n.arrested || n.inCustody || !n.alive) continue;
      const by = this.npc(Number(n.activity?.data.by ?? -1));
      if (!by || !by.alive) {
        n.arrested = false;
        n.activity = null;
        continue;
      }
      const tx = by.x - Math.sin(by.yaw) * 1.1;
      const tz = by.z + Math.cos(by.yaw) * 1.1;
      const d = Math.hypot(tx - n.x, tz - n.z);
      if (d > 0.3) {
        moveActor(this, n, ((tx - n.x) / d) * Math.min(d, dt * 3.5), ((tz - n.z) / d) * Math.min(d, dt * 3.5));
        n.speed = Math.min(3.5, d / dt);
        n.anim = 'walk';
      } else n.anim = 'idle';
      n.yaw = by.yaw;
      if (d > 12) {
        n.x = tx;
        n.z = tz;
      }
      updateLocation(this, n, dt);
    }
    // keep actors apart
    this.separate();
    // speech bubbles expire
    if (this.speech.length) this.speech = this.speech.filter((s) => s.until > this.time);
  }

  private stepNpc(n: NpcState, dt: number, gdt: number) {
    if (!n.alive) {
      updateLocation(this, n, dt);
      return;
    }
    if (n.inCustody) {
      n.anim = 'sit';
      n.speed = 0;
      // innocents are let go after a day without new evidence
      if (n.role !== 'killer' && this.time - Number(n.ctl.jailedAt ?? this.time) > 86400) this.release(n);
      return;
    }
    // needs
    const hrs = gdt / 3600;
    n.needs.hunger = clamp(n.needs.hunger + hrs * 4.2, 0, 100);
    if (!n.sleeping) n.needs.energy = clamp(n.needs.energy - hrs * 5.5, 0, 100);
    n.needs.social = clamp(n.needs.social - hrs * 3, 0, 100);
    n.needs.fear = clamp(n.needs.fear - hrs * 6, 0, 100);
    n.alarm = Math.max(0, n.alarm - hrs * 0.9);
    if (n.alarm < 0.2) n.threat = -1;
    if (n.sayT > 0) n.sayT -= dt;
    if (n.stance === 'downed') {
      n.speed = 0;
      n.anim = 'downed';
      updateLocation(this, n, dt);
      return;
    }
    if (n.arrested) return;
    // perception
    n.perceiveT -= dt;
    if (n.perceiveT <= 0) {
      n.perceiveT = CFG.perceiveInterval * (n.sleeping ? 3 : 1);
      perceive(this, n, CFG.perceiveInterval);
    }
    // decisions
    n.thinkT -= dt;
    if (n.thinkT <= 0) {
      n.thinkT = CFG.thinkInterval * (0.8 + (n.id % 7) * 0.05);
      think(this, n);
    }
    if (n.staggerT > 0) {
      n.speed = 0;
      n.anim = 'hit';
    } else runTasks(this, n, dt);
    updateLocation(this, n, dt);
    // footsteps are audible (indoor intruders get noticed)
    if (n.speed > 0.3) {
      n.ctl.stepAcc = Number(n.ctl.stepAcc ?? 0) + n.speed * dt;
      if (Number(n.ctl.stepAcc) > 0.75) {
        n.ctl.stepAcc = 0;
        const loud = n.stance === 'crouch' ? 2.5 : n.speed > 3 ? 11 : 5.5;
        this.emit({ type: 'step', a: n.id, x: n.x, y: n.y, z: n.z, v: loud, s: this.grid.surfaceAt(n.x, n.z) });
        if (n.building >= 0) hearSound(this, 'footstep', n.x, n.z, loud, n.id);
      }
    }
  }

  private separate() {
    const as = this.actors;
    for (let i = 0; i < as.length; i++) {
      const a = as[i];
      if (!a.alive || a.inCustody || a.stance === 'hidden' || a.stance === 'sit' || a.stance === 'lie') continue;
      for (let j = i + 1; j < as.length; j++) {
        const b = as[j];
        if (!b.alive || b.inCustody || b.stance === 'hidden' || b.stance === 'sit' || b.stance === 'lie') continue;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        if (Math.abs(dx) > 0.7 || Math.abs(dz) > 0.7) continue;
        if (Number(a.ctl.ghost ?? 0) > this.time || Number(b.ctl.ghost ?? 0) > this.time) continue;
        const d = Math.hypot(dx, dz);
        const min = a.radius + b.radius;
        if (d >= min || d < 1e-4) continue;
        const push = (min - d) / 2;
        const ux = dx / d;
        const uz = dz / d;
        const pa = { x: a.x - ux * push, z: a.z - uz * push };
        const pb = { x: b.x + ux * push, z: b.z + uz * push };
        this.colliders.resolveCircle(pa, a.radius);
        this.colliders.resolveCircle(pb, b.radius);
        if (!(a.kind === 'npc' && (a as NpcState).arrested)) {
          a.x = pa.x;
          a.z = pa.z;
        }
        b.x = pb.x;
        b.z = pb.z;
      }
    }
  }

  // ------------------------------------------------------------------ persistence

  snapshot(): SimSnapshot {
    const w = this.world;
    return JSON.parse(
      JSON.stringify({
        version: SIM_VERSION,
        time: this.time,
        rng: this.rng.state,
        actors: this.actors,
        cases: this.cases,
        incidents: this.incidents,
        clues: this.clues,
        items: this.items,
        decals: this.decals,
        doors: w.doors.map((d) => ({ open: d.open, target: d.target, locked: d.locked, broken: d.broken, hp: d.hp })),
        windows: w.windows.map((x) => ({ damage: x.damage, hp: x.hp, boarded: x.boarded, boardHp: x.boardHp })),
        lights: w.lights.map((l) => ({ on: l.on, broken: l.broken })),
        furniture: w.furniture.map((f) => ({ container: f.container, searched: f.searched, solid: f.solid, kind: f.kind })),
        props: w.props.map((p) => ({ kind: p.kind, solid: !!p.solid })),
        pop: { killer: this.killerId, burglar: this.burglarId, lair: this.lair, households: this.households },
        huntOverride: this.huntOverride,
        forcedDoors: this.forcedDoors,
        tape: this.tape,
        misc: this.misc,
      }),
    );
  }

  restore(s: SimSnapshot) {
    if (s.version !== SIM_VERSION) throw new Error(`Incompatible save version ${s.version} (expected ${SIM_VERSION})`);
    const w = this.world;
    if (s.doors.length !== w.doors.length || s.windows.length !== w.windows.length || s.furniture.length !== w.furniture.length) throw new Error('Save does not match the generated neighbourhood');
    this.time = s.time;
    this.rng.state = s.rng;
    this.actors = s.actors;
    this.player = this.actors[0] as PlayerState;
    this.npcs = this.actors.slice(1) as NpcState[];
    this.cases = s.cases;
    this.incidents = s.incidents;
    this.clues = s.clues;
    this.items = s.items;
    this.decals = s.decals;
    s.doors.forEach((d, i) => Object.assign(w.doors[i], d));
    s.windows.forEach((d, i) => Object.assign(w.windows[i], d));
    s.lights.forEach((d, i) => Object.assign(w.lights[i], d));
    s.furniture.forEach((d, i) => Object.assign(w.furniture[i], d));
    s.props.forEach((d, i) => {
      const p = w.props[i];
      if (!p) return;
      p.kind = d.kind;
      if (!d.solid) p.solid = null;
    });
    this.killerId = s.pop.killer;
    this.burglarId = s.pop.burglar;
    this.lair = s.pop.lair;
    this.households = s.pop.households;
    for (const hh of this.households) w.buildings[hh.building].householdId = hh.id;
    this.huntOverride = s.huntOverride;
    this.forcedDoors = s.forcedDoors;
    this.tape = s.tape;
    this.misc = s.misc;
    this.colliders = buildColliders(w);
    this.computeNightLight();
  }
}

export const PLAYER_APP: Appearance = {
  female: false,
  height: 1.78,
  build: 1,
  skin: 0xe0b090,
  hair: 0x4a3020,
  hairStyle: 'short',
  beard: false,
  glasses: false,
  shirt: 0x6a7a8a,
  pants: 0x2e3440,
  coat: 0x3a3a34,
  coatName: 'olive',
  shoes: 'sneakers',
  face: 0,
};

export function makePlayer(): PlayerState {
  return {
    id: 0,
    kind: 'player',
    x: 0,
    z: 0,
    y: 0,
    yaw: 0,
    vx: 0,
    vz: 0,
    speed: 0,
    radius: 0.3,
    health: 100,
    maxHealth: 100,
    alive: true,
    stance: 'stand',
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
    outfit: 'day',
    usingFurniture: -1,
    deathTime: -1,
    bodyRemoved: false,
    arrested: false,
    inCustody: false,
    ctl: {},
    hunger: 20,
    energy: 85,
    fear: 0,
    money: 60,
    inventory: [],
    equipped: -1,
    battery: 100,
    crouching: false,
    sprinting: false,
    pitch: 0,
    wantedLevel: 0,
    knownTo: [],
    sleepUntil: -1,
    healPool: 0,
    boardTarget: -1,
  };
}

export { COATS, kill };
