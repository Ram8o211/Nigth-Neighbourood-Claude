import type { Rng } from '../../core/rng';
import { rect, type Rect } from '../../core/math';
import type { Building, BuildingKind, Dir, Door, Room, RoomKind, Surface, WallSeg, WindowState, WorldData } from '../types';
import { DIR_VEC } from '../types';
import type { Frame } from './frame';
import type { Plan } from './plans';

export const EXT_WALL_T = 0.3;
export const INT_WALL_T = 0.16;
export const DOOR_W = 1.2;
export const DOOR_H = 2.15;

const EXTERIOR_MATS: Record<string, string[]> = {
  house: ['siding_white', 'siding_blue', 'siding_green', 'siding_yellow', 'siding_grey', 'brick_red', 'brick_brown', 'siding_white'],
  abandoned: ['siding_rotten', 'brick_dark'],
  store: ['brick_red', 'brick_brown', 'stucco'],
  hardware: ['brick_brown', 'siding_grey'],
  diner: ['stucco_teal', 'stucco'],
  bar: ['brick_dark', 'planks_dark'],
  police: ['brick_police'],
  clinic: ['stucco'],
  garage: ['metal_siding'],
  church: ['stone'],
  shed: ['planks_shed'],
};

const ROOF_COLORS = [0x3a3a40, 0x5a3328, 0x2f3b33, 0x463a2e, 0x2c2f3a, 0x5b5148];

function roomFloor(kind: RoomKind, bkind: BuildingKind, rng: Rng): Surface {
  switch (kind) {
    case 'kitchen':
    case 'bath':
    case 'exam':
      return 'tile';
    case 'bedroom':
      return rng.chance(0.6) ? 'carpet' : 'wood';
    case 'living':
      return rng.chance(0.5) ? 'carpet' : 'wood';
    case 'shopfloor':
    case 'dining':
    case 'lobby':
      return bkind === 'police' ? 'tile' : 'tile';
    case 'workshop':
    case 'cell':
    case 'storage':
    case 'backroom':
      return bkind === 'house' ? 'wood' : 'concrete';
    case 'nave':
    case 'barroom':
    case 'office':
    case 'hall':
    default:
      return 'wood';
  }
}

function roomWallMat(kind: RoomKind, bkind: BuildingKind, rng: Rng): string {
  if (bkind === 'abandoned') return rng.pick(['wall_stained', 'wall_peeling']);
  if (bkind === 'shed') return 'planks_shed';
  if (bkind === 'church') return 'wall_stone_in';
  if (bkind === 'police') return kind === 'cell' ? 'wall_concrete' : 'wall_institution';
  if (bkind === 'clinic') return 'wall_clinic';
  if (bkind === 'garage') return 'wall_concrete';
  if (bkind === 'bar') return 'wall_dark_wood';
  if (bkind === 'diner') return kind === 'kitchen' ? 'wall_tile_white' : 'wall_diner';
  if (bkind !== 'house') return kind === 'backroom' || kind === 'storage' ? 'wall_concrete' : 'wall_shop';
  switch (kind) {
    case 'kitchen':
      return rng.pick(['wall_tile_white', 'wall_kitchen_yellow']);
    case 'bath':
      return rng.pick(['wall_tile_blue', 'wall_tile_white']);
    case 'bedroom':
      return rng.pick(['wall_blue', 'wall_rose', 'wall_floral', 'wall_beige']);
    case 'living':
      return rng.pick(['wall_green', 'wall_beige', 'wall_floral', 'wall_stripes']);
    default:
      return rng.pick(['wall_beige', 'wall_stripes']);
  }
}

/** candidate door / window centres sit on nav-cell centres (k * 0.5 + 0.25) */
function cellCentres(a: number, b: number): number[] {
  const out: number[] = [];
  const start = Math.ceil((a - 0.25) / 0.5) * 0.5 + 0.25;
  for (let t = start; t <= b + 1e-6; t += 0.5) out.push(Math.round(t * 100) / 100);
  return out;
}

interface LocalEdge {
  axis: 'x' | 'z';
  c: number;
  a: number;
  b: number;
  /** local outward dir for exterior edges */
  out: Dir;
}

function roomExteriorEdges(r: Rect, W: number, D: number): LocalEdge[] {
  const e: LocalEdge[] = [];
  if (Math.abs(r.z0) < 1e-6) e.push({ axis: 'x', c: 0, a: r.x0, b: r.x1, out: 0 });
  if (Math.abs(r.x1 - W) < 1e-6) e.push({ axis: 'z', c: W, a: r.z0, b: r.z1, out: 1 });
  if (Math.abs(r.z1 - D) < 1e-6) e.push({ axis: 'x', c: D, a: r.x0, b: r.x1, out: 2 });
  if (Math.abs(r.x0) < 1e-6) e.push({ axis: 'z', c: 0, a: r.z0, b: r.z1, out: 3 });
  return e;
}

function sharedEdge(a: Rect, b: Rect): { axis: 'x' | 'z'; c: number; a: number; b: number } | null {
  const eps = 1e-6;
  if (Math.abs(a.x1 - b.x0) < eps || Math.abs(a.x0 - b.x1) < eps) {
    const c = Math.abs(a.x1 - b.x0) < eps ? a.x1 : a.x0;
    const lo = Math.max(a.z0, b.z0);
    const hi = Math.min(a.z1, b.z1);
    if (hi - lo > 0.05) return { axis: 'z', c, a: lo, b: hi };
  }
  if (Math.abs(a.z1 - b.z0) < eps || Math.abs(a.z0 - b.z1) < eps) {
    const c = Math.abs(a.z1 - b.z0) < eps ? a.z1 : a.z0;
    const lo = Math.max(a.x0, b.x0);
    const hi = Math.min(a.x1, b.x1);
    if (hi - lo > 0.05) return { axis: 'x', c, a: lo, b: hi };
  }
  return null;
}

export interface BuildOptions {
  kind: BuildingKind;
  name: string;
  address: string;
  lotId: number;
  frame: Frame; // building frame (footprint, front)
  plan: Plan;
  householdId: number;
}

/** converts a local wall line segment to world coordinates */
function segToWorld(frame: Frame, axis: 'x' | 'z', c: number, a: number, b: number) {
  const p = axis === 'x' ? frame.toWorld(a, c) : frame.toWorld(c, a);
  const q = axis === 'x' ? frame.toWorld(b, c) : frame.toWorld(c, b);
  const wAxis = frame.axis(axis);
  if (wAxis === 'x') return { axis: wAxis, c: p.z, a: Math.min(p.x, q.x), b: Math.max(p.x, q.x) };
  return { axis: wAxis, c: p.x, a: Math.min(p.z, q.z), b: Math.max(p.z, q.z) };
}

function pointToWorld(frame: Frame, axis: 'x' | 'z', c: number, t: number) {
  const p = axis === 'x' ? frame.toWorld(t, c) : frame.toWorld(c, t);
  const wAxis = frame.axis(axis);
  return { axis: wAxis, c: wAxis === 'x' ? p.z : p.x, t: wAxis === 'x' ? p.x : p.z, x: p.x, z: p.z };
}

export function roomAt(world: WorldData, b: Building, x: number, z: number): number {
  for (const rid of b.roomIds) {
    const r = world.rooms[rid].rect;
    if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) return rid;
  }
  return -1;
}

export function buildBuilding(rng: Rng, world: WorldData, opt: BuildOptions): Building {
  const { frame, plan, kind } = opt;
  const fr = frame.rect(0, 0, plan.W, plan.D);
  const extMat = rng.pick(EXTERIOR_MATS[kind] ?? EXTERIOR_MATS.house);
  const b: Building = {
    id: world.buildings.length,
    kind,
    name: opt.name,
    rect: fr,
    lotId: opt.lotId,
    front: frame.front,
    roomIds: [],
    doorIds: [],
    windowIds: [],
    wallIds: [],
    frontDoorId: -1,
    backDoorId: -1,
    wallHeight: plan.wallHeight,
    roof: kind === 'church' ? 'steeple' : kind === 'house' || kind === 'abandoned' ? 'gable' : kind === 'shed' ? 'shed' : 'flat',
    roofColor: kind === 'abandoned' ? 0x2b2622 : rng.pick(ROOF_COLORS),
    wallMat: extMat,
    trimColor: kind === 'abandoned' ? 0x6b6358 : rng.pick([0xf2efe6, 0xe9e2d0, 0x3b3b3b, 0xd8d2c4, 0x6e4b33]),
    address: opt.address,
    householdId: opt.householdId,
    outsideFront: { x: 0, z: 0 },
    insideFront: { x: 0, z: 0 },
    porchLightId: -1,
    floorY: kind === 'shed' ? 0.05 : 0.15,
  };
  world.buildings.push(b);

  // rooms
  const localRooms = plan.rooms;
  const roomIds: number[] = [];
  for (const pr of localRooms) {
    const room: Room = {
      id: world.rooms.length,
      buildingId: b.id,
      kind: pr.kind,
      rect: frame.rect(pr.r.x0, pr.r.z0, pr.r.x1, pr.r.z1),
      floor: roomFloor(pr.kind, kind, rng),
      doorIds: [],
      windowIds: [],
      lightIds: [],
      name: pr.name,
      clear: [],
    };
    world.rooms.push(room);
    roomIds.push(room.id);
    b.roomIds.push(room.id);
  }
  const wallMats = localRooms.map((pr) => roomWallMat(pr.kind, kind, rng));

  const addWall = (w: Omit<WallSeg, 'id' | 'buildingId' | 'openings' | 'height'>): WallSeg => {
    const wall: WallSeg = { ...w, id: world.walls.length, buildingId: b.id, openings: [], height: plan.wallHeight };
    world.walls.push(wall);
    b.wallIds.push(wall.id);
    return wall;
  };

  // which side of a world wall a room lies on
  const sideOfRoom = (axis: 'x' | 'z', c: number, rid: number): 1 | -1 => {
    const r = world.rooms[rid].rect;
    const mid = axis === 'x' ? (r.z0 + r.z1) / 2 : (r.x0 + r.x1) / 2;
    return mid > c ? 1 : -1;
  };

  // exterior wall pieces per room edge
  const extEdges: { room: number; edge: LocalEdge; wall: WallSeg }[] = [];
  localRooms.forEach((pr, idx) => {
    for (const e of roomExteriorEdges(pr.r, plan.W, plan.D)) {
      const ws = segToWorld(frame, e.axis, e.c, e.a, e.b);
      const outDir = frame.dir(e.out);
      const v = DIR_VEC[outDir];
      const outside = (ws.axis === 'x' ? v.z : v.x) as 1 | -1;
      // extend at building corners
      const atLow = e.a < 1e-6;
      const atHigh = Math.abs(e.b - (e.axis === 'x' ? plan.W : plan.D)) < 1e-6;
      // after transform the low/high ends may swap
      const pA = e.axis === 'x' ? frame.toWorld(e.a, e.c) : frame.toWorld(e.c, e.a);
      const lowMapsToA = ws.axis === 'x' ? Math.abs(pA.x - ws.a) < 1e-6 : Math.abs(pA.z - ws.a) < 1e-6;
      const extA = (lowMapsToA ? atLow : atHigh) ? EXT_WALL_T / 2 : 0;
      const extB = (lowMapsToA ? atHigh : atLow) ? EXT_WALL_T / 2 : 0;
      const inMat = wallMats[idx];
      const wall = addWall({
        axis: ws.axis,
        c: ws.c,
        a: ws.a,
        b: ws.b,
        thickness: EXT_WALL_T,
        exterior: true,
        outside,
        matNeg: outside === -1 ? extMat : inMat,
        matPos: outside === 1 ? extMat : inMat,
        extA,
        extB,
      });
      extEdges.push({ room: idx, edge: e, wall });
    }
  });

  // interior walls between room pairs (skipped for open links)
  const openPairs = new Set(plan.links.filter((l) => l.type === 'open').map((l) => `${Math.min(l.a, l.b)}-${Math.max(l.a, l.b)}`));
  const pairWall = new Map<string, { wall: WallSeg; local: { axis: 'x' | 'z'; c: number; a: number; b: number } }>();
  for (let i = 0; i < localRooms.length; i++)
    for (let j = i + 1; j < localRooms.length; j++) {
      const se = sharedEdge(localRooms[i].r, localRooms[j].r);
      if (!se) continue;
      const key = `${i}-${j}`;
      if (openPairs.has(key)) {
        const ws = segToWorld(frame, se.axis, se.c, se.a, se.b);
        const zone = ws.axis === 'x' ? rect(ws.a, ws.c - 1.1, ws.b, ws.c + 1.1) : rect(ws.c - 1.1, ws.a, ws.c + 1.1, ws.b);
        world.rooms[roomIds[i]].clear.push(zone);
        world.rooms[roomIds[j]].clear.push(zone);
        continue;
      }
      const ws = segToWorld(frame, se.axis, se.c, se.a, se.b);
      const si = sideOfRoom(ws.axis, ws.c, roomIds[i]);
      const wall = addWall({
        axis: ws.axis,
        c: ws.c,
        a: ws.a,
        b: ws.b,
        thickness: INT_WALL_T,
        exterior: false,
        outside: 0,
        matNeg: si === -1 ? wallMats[i] : wallMats[j],
        matPos: si === 1 ? wallMats[i] : wallMats[j],
        extA: 0,
        extB: 0,
      });
      pairWall.set(key, { wall, local: se });
    }

  const makeDoor = (wall: WallSeg, wp: { axis: 'x' | 'z'; c: number; t: number }, exterior: boolean, bars: boolean): Door => {
    const probe = (s: number) => {
      const px = wp.axis === 'x' ? wp.t : wp.c + s * 0.5;
      const pz = wp.axis === 'x' ? wp.c + s * 0.5 : wp.t;
      return roomAt(world, b, px, pz);
    };
    const roomNeg = probe(-1);
    const roomPos = probe(1);
    let openSide: 1 | -1;
    if (exterior) openSide = roomPos >= 0 ? 1 : -1;
    else if (bars) openSide = world.rooms[roomNeg]?.kind === 'cell' ? -1 : 1;
    else {
      const negHall = world.rooms[roomNeg]?.kind === 'hall';
      const posHall = world.rooms[roomPos]?.kind === 'hall';
      openSide = negHall && !posHall ? 1 : posHall && !negHall ? -1 : rng.chance(0.5) ? 1 : -1;
    }
    const door: Door = {
      id: world.doors.length,
      buildingId: b.id,
      axis: wp.axis,
      c: wp.c,
      t: wp.t,
      width: DOOR_W,
      height: DOOR_H,
      exterior,
      roomNeg,
      roomPos,
      bars,
      hingeLow: rng.chance(0.5),
      open: 0,
      target: 0,
      openSide,
      locked: bars,
      broken: false,
      hp: exterior ? 100 : 60,
      keyId: b.id,
    };
    world.doors.push(door);
    b.doorIds.push(door.id);
    wall.openings.push({ kind: 'door', id: door.id, t0: wp.t - DOOR_W / 2, t1: wp.t + DOOR_W / 2, bottom: 0, top: DOOR_H });
    const zone =
      wp.axis === 'x'
        ? rect(wp.t - 0.95, wp.c - 1.45, wp.t + 0.95, wp.c + 1.45)
        : rect(wp.c - 1.45, wp.t - 0.95, wp.c + 1.45, wp.t + 0.95);
    if (roomNeg >= 0) {
      world.rooms[roomNeg].doorIds.push(door.id);
      world.rooms[roomNeg].clear.push(zone);
    }
    if (roomPos >= 0) {
      world.rooms[roomPos].doorIds.push(door.id);
      world.rooms[roomPos].clear.push(zone);
    }
    return door;
  };

  // interior doors
  for (const link of plan.links) {
    if (link.type === 'open') continue;
    const i = Math.min(link.a, link.b);
    const j = Math.max(link.a, link.b);
    const pw = pairWall.get(`${i}-${j}`);
    if (!pw) continue;
    const { local } = pw;
    const cands = cellCentres(local.a + 0.85, local.b - 0.85);
    if (!cands.length) {
      // too short for a door: turn it into an opening (remove the wall)
      world.walls[pw.wall.id].openings.push({ kind: 'door', id: -1, t0: pw.wall.a, t1: pw.wall.b, bottom: 0, top: plan.wallHeight });
      continue;
    }
    const mid = (local.a + local.b) / 2;
    const isHallLink = localRooms[i].kind === 'hall' || localRooms[j].kind === 'hall';
    let t: number;
    if (isHallLink) {
      // put door near the hall-side centre of the other room
      cands.sort((p, q) => Math.abs(p - mid) - Math.abs(q - mid));
      t = cands[Math.min(cands.length - 1, rng.int(0, 1))];
    } else t = rng.pick(cands);
    const wp = pointToWorld(frame, local.axis, local.c, t);
    makeDoor(pw.wall, wp, false, link.type === 'bars');
  }

  // exterior doors
  const extDoorSpans: { axis: 'x' | 'z'; c: number; t: number }[] = [];
  const extList = [...plan.ext];
  // fallback: guarantee a main entrance on some exterior edge long enough for a door
  const fallback = (): { room: number; side: 0 | 1 | 2 | 3; main: boolean } | null => {
    for (const side of [0, 1, 3, 2] as const)
      for (let ri = 0; ri < localRooms.length; ri++) {
        const e = roomExteriorEdges(localRooms[ri].r, plan.W, plan.D).find((x) => x.out === side);
        if (e && cellCentres(e.a + 0.75, e.b - 0.75).length) return { room: ri, side, main: true };
      }
    return null;
  };
  for (let ei = 0; ei < extList.length; ei++) {
    const ed = extList[ei];
    const pr = localRooms[ed.room];
    const edge = roomExteriorEdges(pr.r, plan.W, plan.D).find((e) => e.out === ed.side);
    const cands = edge ? cellCentres(edge.a + 0.75, edge.b - 0.75) : [];
    if (!edge || !cands.length) {
      if (ed.main) {
        const fb = fallback();
        if (fb) extList.push(fb);
      }
      continue;
    }
    const mid = (edge.a + edge.b) / 2;
    cands.sort((p, q) => Math.abs(p - mid) - Math.abs(q - mid));
    const t = ed.main ? cands[0] : cands[rng.int(0, Math.min(2, cands.length - 1))];
    const wp = pointToWorld(frame, edge.axis, edge.c, t);
    const ee = extEdges.find((x) => x.room === ed.room && x.edge.out === ed.side)!;
    const door = makeDoor(ee.wall, wp, true, false);
    extDoorSpans.push({ axis: edge.axis, c: edge.c, t });
    if (ed.main) {
      b.frontDoorId = door.id;
      const outV = DIR_VEC[frame.dir(ed.side)];
      b.outsideFront = { x: wp.x + outV.x * 1.3, z: wp.z + outV.z * 1.3 };
      b.insideFront = { x: wp.x - outV.x * 1.1, z: wp.z - outV.z * 1.1 };
    } else b.backDoorId = door.id;
  }

  // windows
  for (const ee of extEdges) {
    const { edge, wall, room } = ee;
    const pr = localRooms[room];
    const isFront = edge.out === 0;
    let ww = 1.2;
    let sill = 0.9;
    let top = 2.1;
    let shop = false;
    if (pr.kind === 'bath') {
      ww = 0.8;
      sill = 1.45;
      top = 2.0;
    }
    if (kind === 'shed') {
      ww = 0.6;
      sill = 1.2;
      top = 1.7;
    }
    if (plan.shopFront && isFront) {
      ww = 2.2;
      sill = 0.55;
      top = 2.7;
      shop = true;
    } else if (kind !== 'house' && kind !== 'abandoned' && kind !== 'shed') {
      sill = 1.0;
      top = 2.3;
    }
    if (kind === 'church') {
      ww = 1.0;
      sill = 1.3;
      top = 4.1;
    }
    if (pr.kind === 'cell') continue;
    const blocked = extDoorSpans.filter((d) => d.axis === edge.axis && Math.abs(d.c - edge.c) < 1e-6).map((d) => d.t);
    const lo = edge.a + 0.55 + ww / 2;
    const hi = edge.b - 0.55 - ww / 2;
    if (hi < lo) continue;
    const len = edge.b - edge.a;
    let n = Math.max(1, Math.min(shop ? 3 : 3, Math.floor((len - 0.6) / (shop ? 3.2 : 3.4))));
    if (kind === 'shed' || pr.kind === 'bath') n = 1;
    if (kind === 'church') n = Math.max(1, Math.floor(len / 3));
    const placed: number[] = [];
    for (let k = 0; k < n; k++) {
      const target = lo + ((hi - lo) * (k + 0.5)) / n;
      const cands = cellCentres(lo, hi).filter(
        (t) => blocked.every((bt) => Math.abs(bt - t) > DOOR_W / 2 + ww / 2 + 0.3) && placed.every((p) => Math.abs(p - t) > ww + 0.5),
      );
      if (!cands.length) continue;
      cands.sort((p, q) => Math.abs(p - target) - Math.abs(q - target));
      const t = cands[0];
      placed.push(t);
      const wp = pointToWorld(frame, edge.axis, edge.c, t);
      const win: WindowState = {
        id: world.windows.length,
        buildingId: b.id,
        roomId: roomIds[room],
        axis: wp.axis,
        c: wp.c,
        t: wp.t,
        width: ww,
        sill,
        top,
        outside: wall.outside as 1 | -1,
        shop,
        damage: 0,
        hp: shop ? 45 : 30,
        boarded: false,
        boardHp: 0,
        curtain: rng.pick([0x8a3b3b, 0x3b5a8a, 0xd8c9a0, 0x5d7a4a, 0xe0d6c8, 0x6b4a6b]),
      };
      world.windows.push(win);
      b.windowIds.push(win.id);
      world.rooms[roomIds[room]].windowIds.push(win.id);
      wall.openings.push({ kind: 'window', id: win.id, t0: wp.t - ww / 2, t1: wp.t + ww / 2, bottom: sill, top });
    }
  }
  for (const w of b.wallIds) world.walls[w].openings.sort((p, q) => p.t0 - q.t0);
  return b;
}

export function buildingFrameFor(lotFrame: Frame, ox: number, oz: number, W: number, D: number, makeFrameFn: (r: Rect, f: Dir) => Frame): Frame {
  const r = lotFrame.rect(ox, oz, ox + W, oz + D);
  return makeFrameFn(r, lotFrame.front);
}

export { rect };
