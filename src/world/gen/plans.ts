import type { Rng } from '../../core/rng';
import { rect, snap, type Rect } from '../../core/math';
import type { BuildingKind, RoomKind } from '../types';

/**
 * Floor plans are authored in a local frame: x along the frontage (0..W),
 * z from the front wall (0) to the back wall (D). Rooms tile the footprint.
 */
export interface PlanRoom {
  kind: RoomKind;
  r: Rect;
  name: string;
}

export interface PlanLink {
  a: number;
  b: number;
  type: 'door' | 'open' | 'bars';
}

export interface PlanExtDoor {
  room: number;
  /** local wall: 0 front, 1 right (x = W), 2 back, 3 left (x = 0) */
  side: 0 | 1 | 2 | 3;
  main: boolean;
}

export interface Plan {
  W: number;
  D: number;
  rooms: PlanRoom[];
  links: PlanLink[];
  ext: PlanExtDoor[];
  wallHeight: number;
  shopFront: boolean;
}

const s5 = (v: number) => snap(v, 0.5);

function housePlan(rng: Rng, W: number, D: number): Plan {
  const rooms: PlanRoom[] = [];
  const links: PlanLink[] = [];
  const ext: PlanExtDoor[] = [];
  const add = (kind: RoomKind, r: Rect, name: string) => rooms.push({ kind, r, name }) - 1;
  const template = W >= 10 && D >= 9 ? (rng.chance(0.5) ? 'hall' : 'frontLiving') : W >= 9.5 && D >= 9.5 ? 'frontLiving' : 'compact';

  if (template === 'hall') {
    const hw = 1.5;
    const leftW = s5(rng.range(3.8, W - hw - 3.2));
    const hx = leftW;
    const livD = s5(rng.range(D * 0.48, D * 0.6));
    const liv = add('living', rect(0, 0, hx, livD), 'Living room');
    const kit = add('kitchen', rect(0, livD, hx, D), 'Kitchen');
    const hall = add('hall', rect(hx, 0, hx + hw, D), 'Hallway');
    const rx = hx + hw;
    let rightRooms: number[];
    if (D >= 10.5) {
      const z1 = s5(rng.range(D * 0.36, D * 0.42));
      const z2 = s5(z1 + rng.range(2.5, 3));
      rightRooms = [
        add('bedroom', rect(rx, 0, W, z1), 'Bedroom'),
        add('bath', rect(rx, z1, W, z2), 'Bathroom'),
        add('bedroom', rect(rx, z2, W, D), 'Small bedroom'),
      ];
    } else {
      const z1 = s5(rng.range(D * 0.52, D * 0.62));
      rightRooms = [add('bedroom', rect(rx, 0, W, z1), 'Bedroom'), add('bath', rect(rx, z1, W, D), 'Bathroom')];
    }
    links.push({ a: hall, b: liv, type: rng.chance(0.35) ? 'open' : 'door' });
    links.push({ a: hall, b: kit, type: 'door' });
    if (rng.chance(0.5)) links.push({ a: liv, b: kit, type: rng.chance(0.4) ? 'open' : 'door' });
    for (const rr of rightRooms) links.push({ a: hall, b: rr, type: 'door' });
    ext.push({ room: hall, side: 0, main: true });
    ext.push({ room: rng.chance(0.5) ? kit : hall, side: 2, main: false });
  } else if (template === 'frontLiving') {
    const livD = s5(rng.range(4, Math.min(5.5, D - 1.5 - 3.5)));
    const hz = livD;
    const liv = add('living', rect(0, 0, W, livD), 'Living room');
    const hall = add('hall', rect(0, hz, W, hz + 1.5), 'Hallway');
    const bz = hz + 1.5;
    const back: number[] = [];
    // back strip split along x
    const bathW = 2.5;
    const parts: [RoomKind, number, string][] = [];
    if (W >= 12) {
      const kw = s5(rng.range(3.2, 4));
      const bw = s5((W - kw - bathW) / 2);
      parts.push(['kitchen', kw, 'Kitchen'], ['bath', bathW, 'Bathroom'], ['bedroom', bw, 'Bedroom'], ['bedroom', W - kw - bathW - bw, 'Small bedroom']);
    } else {
      const kw = s5(rng.range(3, 3.8));
      parts.push(['kitchen', kw, 'Kitchen'], ['bath', bathW, 'Bathroom'], ['bedroom', W - kw - bathW, 'Bedroom']);
    }
    if (rng.chance(0.5)) parts.reverse();
    let x = 0;
    let kit = -1;
    for (const [k, w, name] of parts) {
      const id = add(k, rect(x, bz, x + w, D), name);
      if (k === 'kitchen') kit = id;
      back.push(id);
      x += w;
    }
    links.push({ a: liv, b: hall, type: rng.chance(0.4) ? 'open' : 'door' });
    for (const b of back) links.push({ a: hall, b, type: 'door' });
    ext.push({ room: liv, side: 0, main: true });
    ext.push({ room: kit, side: 2, main: false });
  } else {
    const lw = s5(Math.max(4, W * 0.58));
    const fd = s5(Math.max(4, D * 0.52));
    const liv = add('living', rect(0, 0, lw, fd), 'Living room');
    const kit = add('kitchen', rect(lw, 0, W, fd), 'Kitchen');
    const bed = add('bedroom', rect(0, fd, lw, D), 'Bedroom');
    const bath = add('bath', rect(lw, fd, W, D), 'Bathroom');
    links.push({ a: liv, b: kit, type: 'open' });
    links.push({ a: liv, b: bed, type: 'door' });
    links.push({ a: kit, b: bath, type: 'door' });
    ext.push({ room: liv, side: 0, main: true });
    ext.push({ room: kit, side: 1, main: false });
  }
  return { W, D, rooms, links, ext, wallHeight: 2.8, shopFront: false };
}

function shopPlan(rng: Rng, W: number, D: number, kind: BuildingKind): Plan {
  const rooms: PlanRoom[] = [];
  const links: PlanLink[] = [];
  const ext: PlanExtDoor[] = [];
  const add = (k: RoomKind, r: Rect, name: string) => rooms.push({ kind: k, r, name }) - 1;
  const backD = 4;
  const fz = D - backD;
  const mainKind: RoomKind = kind === 'diner' ? 'dining' : kind === 'bar' ? 'barroom' : kind === 'garage' ? 'workshop' : 'shopfloor';
  const mainName = kind === 'diner' ? 'Dining room' : kind === 'bar' ? 'Bar room' : kind === 'garage' ? 'Workshop' : 'Shop floor';
  const main = add(mainKind, rect(0, 0, W, fz), mainName);
  const splitX = s5(W * rng.range(0.58, 0.68));
  const backKind: RoomKind = kind === 'diner' ? 'kitchen' : 'backroom';
  const back = add(backKind, rect(0, fz, splitX, D), kind === 'diner' ? 'Kitchen' : 'Stock room');
  const side = add(kind === 'garage' ? 'office' : 'bath', rect(splitX, fz, W, D), kind === 'garage' ? 'Office' : 'Restroom');
  links.push({ a: main, b: back, type: 'door' });
  links.push({ a: kind === 'garage' ? main : main, b: side, type: 'door' });
  ext.push({ room: main, side: 0, main: true });
  ext.push({ room: back, side: 2, main: false });
  return { W, D, rooms, links, ext, wallHeight: 3.4, shopFront: kind !== 'garage' };
}

function policePlan(rng: Rng, W: number, D: number): Plan {
  const rooms: PlanRoom[] = [];
  const links: PlanLink[] = [];
  const ext: PlanExtDoor[] = [];
  const add = (k: RoomKind, r: Rect, name: string) => rooms.push({ kind: k, r, name }) - 1;
  const fz = 6;
  const lw = s5(W * rng.range(0.45, 0.55));
  const lobby = add('lobby', rect(0, 0, lw, fz), 'Lobby');
  const office = add('office', rect(lw, 0, W, fz), 'Squad office');
  const corr = add('hall', rect(0, fz, W, fz + 1.5), 'Corridor');
  const bz = fz + 1.5;
  const cell1 = add('cell', rect(0, bz, 3, D), 'Holding cell A');
  const cell2 = add('cell', rect(3, bz, 6, D), 'Holding cell B');
  const evid = add('storage', rect(6, bz, W, D), 'Evidence room');
  links.push({ a: lobby, b: office, type: 'door' });
  links.push({ a: lobby, b: corr, type: 'door' });
  links.push({ a: office, b: corr, type: 'door' });
  links.push({ a: corr, b: cell1, type: 'bars' });
  links.push({ a: corr, b: cell2, type: 'bars' });
  links.push({ a: corr, b: evid, type: 'door' });
  ext.push({ room: lobby, side: 0, main: true });
  ext.push({ room: evid, side: 2, main: false });
  return { W, D, rooms, links, ext, wallHeight: 3.4, shopFront: false };
}

function clinicPlan(rng: Rng, W: number, D: number): Plan {
  const rooms: PlanRoom[] = [];
  const links: PlanLink[] = [];
  const ext: PlanExtDoor[] = [];
  const add = (k: RoomKind, r: Rect, name: string) => rooms.push({ kind: k, r, name }) - 1;
  const fz = s5(rng.range(4.5, 5.5));
  const wait = add('lobby', rect(0, 0, W, fz), 'Waiting room');
  const mx = s5(W / 2);
  const exam = add('exam', rect(0, fz, mx, D), 'Examination room');
  const off = add('office', rect(mx, fz, W, D), 'Doctor’s office');
  links.push({ a: wait, b: exam, type: 'door' });
  links.push({ a: wait, b: off, type: 'door' });
  links.push({ a: exam, b: off, type: 'door' });
  ext.push({ room: wait, side: 0, main: true });
  ext.push({ room: off, side: 2, main: false });
  return { W, D, rooms, links, ext, wallHeight: 3.2, shopFront: true };
}

function churchPlan(_rng: Rng, W: number, D: number): Plan {
  const rooms: PlanRoom[] = [];
  const add = (k: RoomKind, r: Rect, name: string) => rooms.push({ kind: k, r, name }) - 1;
  const vz = D - 3.5;
  const nave = add('nave', rect(0, 0, W, vz), 'Nave');
  const vest = add('storage', rect(0, vz, W, D), 'Vestry');
  return {
    W,
    D,
    rooms,
    links: [{ a: nave, b: vest, type: 'door' }],
    ext: [
      { room: nave, side: 0, main: true },
      { room: vest, side: 2, main: false },
    ],
    wallHeight: 5,
    shopFront: false,
  };
}

function shedPlan(W: number, D: number): Plan {
  return {
    W,
    D,
    rooms: [{ kind: 'storage', r: rect(0, 0, W, D), name: 'Shed' }],
    links: [],
    ext: [{ room: 0, side: 0, main: true }],
    wallHeight: 2.3,
    shopFront: false,
  };
}

export function footprintSize(rng: Rng, kind: BuildingKind, maxW: number, maxD: number): [number, number] {
  const pick = (a: number, b: number, max: number) => s5(Math.min(max, rng.range(a, b)));
  switch (kind) {
    case 'house':
    case 'abandoned':
      return [pick(8.5, 13, maxW), pick(8.5, 12, maxD)];
    case 'police':
      return [pick(14, 17, maxW), pick(11.5, 13, maxD)];
    case 'church':
      return [pick(10, 11, maxW), pick(17, 20, maxD)];
    case 'clinic':
      return [pick(12, 15, maxW), pick(10, 12, maxD)];
    case 'shed':
      return [pick(3, 4, maxW), pick(2.5, 3.5, maxD)];
    default:
      return [pick(13, 18, maxW), pick(11, 14, maxD)];
  }
}

export function makePlan(rng: Rng, kind: BuildingKind, W: number, D: number): Plan {
  switch (kind) {
    case 'house':
    case 'abandoned':
      return housePlan(rng, W, D);
    case 'police':
      return policePlan(rng, W, D);
    case 'clinic':
      return clinicPlan(rng, W, D);
    case 'church':
      return churchPlan(rng, W, D);
    case 'shed':
      return shedPlan(W, D);
    default:
      return shopPlan(rng, W, D, kind);
  }
}
