import { Rng, hashString } from '../../core/rng';
import { rect, snap, dist } from '../../core/math';
import { townName, SURNAMES } from '../../core/names';
import type { BuildingKind, GenParams, Lot, WorldData } from '../types';
import { generateLayout, subdivideRows, numberLots } from './layout';
import { makeFrame } from './frame';
import { footprintSize, makePlan } from './plans';
import { buildBuilding } from './buildings';
import { furnishBuilding } from './furnish';
import {
  PropCtx,
  decorateHouseLot,
  decorateCommercialLot,
  decorateChurchLot,
  decorateVacantLot,
  decorateStreets,
  decoratePark,
  decorateWild,
  decorateForest,
  placeBusStop,
  type LotInfo,
} from './props';
import { repairWorld } from './repair';

export const WORLD_VERSION = 3;

export const DEFAULT_PARAMS: GenParams = { seed: 'hollow', size: 'medium', density: 0.7, nights: 5 };

const REQUIRED_COMMERCIAL: BuildingKind[] = ['police', 'store', 'diner', 'bar', 'hardware', 'clinic', 'garage'];

function commercialName(rng: Rng, kind: BuildingKind, town: string): string {
  const sur = rng.pick(SURNAMES);
  switch (kind) {
    case 'police':
      return `${town} Police Department`;
    case 'store':
      return rng.pick([`${sur}'s General Store`, `${town} Market`, 'Corner Grocery']);
    case 'hardware':
      return rng.pick([`${sur} Hardware`, 'Nuts & Bolts Hardware', `${town} Hardware & Supply`]);
    case 'diner':
      return rng.pick(['The Blue Moon Diner', 'Rosie’s Diner', 'Night Owl Diner', 'The Silver Spoon']);
    case 'bar':
      return rng.pick(['The Crooked Lantern', 'The Rusty Nail', 'The Hollow Tap', 'Last Call Tavern']);
    case 'clinic':
      return `${town} Medical Clinic`;
    case 'garage':
      return `${sur} Auto Repair`;
    case 'church':
      return rng.pick(['St. Agnes Church', 'Church of the Vigil', 'Grace Chapel']);
    default:
      return kind;
  }
}

export function generateWorld(params: GenParams): WorldData {
  const seedNum = hashString(`${params.seed}|${params.size}`);
  const rng = new Rng(seedNum);
  const layout = generateLayout(rng.fork('layout'), params);
  const world: WorldData = {
    version: WORLD_VERSION,
    params: { ...params },
    seedNum,
    width: layout.width,
    depth: layout.depth,
    townName: townName(rng.fork('town')),
    roads: layout.roads,
    blocks: layout.blocks,
    lots: [],
    buildings: [],
    rooms: [],
    walls: [],
    doors: [],
    windows: [],
    furniture: [],
    props: [],
    lights: [],
    pois: [],
    ground: [],
    playerHouseId: -1,
    policeId: -1,
    busStop: { x: 0, z: 0 },
    townEdge: { x: 0, z: 0 },
    landmarks: [],
  };
  // ground order matters for rendering and surface lookup: base -> town -> roads -> details
  world.ground.push({ rect: rect(0, 0, world.width, world.depth), surface: 'dirt', kind: 'forestfloor' });
  world.ground.push({ rect: rect(layout.X[0] - 6, layout.Z[0] - 6, layout.X[layout.X.length - 1] + 6, layout.Z[layout.Z.length - 1] + 6), surface: 'grass', kind: 'town' });
  world.ground.push(...layout.ground);

  const lotRng = rng.fork('lots');
  const lots = subdivideRows(lotRng, layout);
  numberLots(lots);
  world.lots = lots;

  const centre = { x: world.width / 2, z: world.depth / 2 };
  const lotCentre = (l: Lot) => ({ x: (l.rect.x0 + l.rect.x1) / 2, z: (l.rect.z0 + l.rect.z1) / 2 });
  const lotW = (l: Lot) => (l.front === 0 || l.front === 2 ? l.rect.x1 - l.rect.x0 : l.rect.z1 - l.rect.z0);
  const lotD = (l: Lot) => (l.front === 0 || l.front === 2 ? l.rect.z1 - l.rect.z0 : l.rect.x1 - l.rect.x0);

  // --- assign commercial kinds ---------------------------------------------
  const kindRng = rng.fork('kinds');
  const commercial = lots.filter((l) => l.kind === 'commercial').sort((a, b) => dist(lotCentre(a).x, lotCentre(a).z, centre.x, centre.z) - dist(lotCentre(b).x, lotCentre(b).z, centre.x, centre.z));
  const lotKind = new Map<number, BuildingKind>();
  const needed = [...REQUIRED_COMMERCIAL];
  // police near the centre, others shuffled a little
  const rest = kindRng.shuffle(needed.slice(1));
  const order: BuildingKind[] = ['police', ...rest];
  let ci = 0;
  for (const l of commercial) {
    if (ci < order.length) lotKind.set(l.id, order[ci++]);
    else l.kind = 'house';
  }
  // not enough commercial lots: convert houses closest to main street
  if (ci < order.length) {
    const houses = lots.filter((l) => l.kind === 'house').sort((a, b) => Math.abs(lotCentre(a).z - layout.Z[layout.mainRow]) - Math.abs(lotCentre(b).z - layout.Z[layout.mainRow]));
    for (const l of houses) {
      if (ci >= order.length) break;
      if (lotW(l) < 16 || lotD(l) < 18) continue;
      l.kind = 'commercial';
      lotKind.set(l.id, order[ci++]);
    }
  }

  // --- church, abandoned, vacant, player home -------------------------------
  const houseLots = lots.filter((l) => l.kind === 'house');
  const churchCands = houseLots.filter((l) => lotW(l) >= 15.5 && lotD(l) >= 23 && world.blocks[l.blockId].kind !== 'mixed');
  if (churchCands.length) {
    const ch = kindRng.pick(churchCands);
    ch.kind = 'church';
    lotKind.set(ch.id, 'church');
  }
  const edgeDist = (l: Lot) => {
    const c = lotCentre(l);
    return Math.min(c.x, c.z, world.width - c.x, world.depth - c.z);
  };
  const remaining = lots.filter((l) => l.kind === 'house').sort((a, b) => edgeDist(a) - edgeDist(b));
  const nAband = params.size === 'small' ? 1 : 2;
  for (let k = 0; k < nAband && remaining.length > 4; k++) {
    const idx = kindRng.int(0, Math.min(5, remaining.length - 1));
    const l = remaining.splice(idx, 1)[0];
    l.kind = 'abandoned';
  }
  for (const l of lots) if (l.kind === 'house' && kindRng.chance(0.06)) l.kind = 'vacant';

  // --- buildings -------------------------------------------------------------
  const bRng = rng.fork('buildings');
  const infos: LotInfo[] = [];
  for (const lot of lots) {
    const frame = makeFrame(lot.rect, lot.front);
    const info: LotInfo = { lot, frame, building: null, bl: null, shed: null, shedLocal: null };
    infos.push(info);
    if (lot.kind === 'vacant' || lot.kind === 'park') continue;
    const kind: BuildingKind = lot.kind === 'abandoned' ? 'abandoned' : lot.kind === 'house' ? 'house' : lotKind.get(lot.id) ?? 'house';
    const Lw = frame.w;
    const Ld = frame.d;
    const commercialLike = kind !== 'house' && kind !== 'abandoned';
    const setback = commercialLike ? (kind === 'church' ? 3.5 : 2.5) : snap(bRng.range(4.5, 7), 0.5);
    const maxW = Lw - (commercialLike ? 3 : 4.5);
    const maxD = Ld - setback - (commercialLike ? 3.5 : 6);
    if (maxW < 8.5 || maxD < 8) {
      lot.kind = 'vacant';
      continue;
    }
    const [W, D] = footprintSize(bRng, kind, snap(maxW - 0.25, 0.5), snap(maxD - 0.25, 0.5));
    const slack = Lw - W;
    const minSide = commercialLike ? 1.5 : 2.0;
    const ox = snap(bRng.pick([minSide + 0.5, slack / 2, slack - minSide - 0.5].filter((v) => v >= minSide && v <= slack - minSide)) ?? slack / 2, 0.5);
    const bFrame = makeFrame(frame.rect(ox, setback, ox + W, setback + D), lot.front);
    const plan = makePlan(bRng, kind, W, D);
    const name = kind === 'house' || kind === 'abandoned' ? lot.address : commercialName(bRng, kind, world.townName);
    const b = buildBuilding(bRng, world, { kind, name, address: lot.address, lotId: lot.id, frame: bFrame, plan, householdId: -1 });
    lot.buildingId = b.id;
    info.building = b;
    info.bl = rect(ox, setback, ox + W, setback + D);
    furnishBuilding(bRng, world, b);
    if (kind === 'police') world.policeId = b.id;
    // backyard shed
    const yard = Ld - setback - D;
    if ((kind === 'house' || kind === 'abandoned') && yard >= 7 && bRng.chance(kind === 'abandoned' ? 0.8 : 0.4)) {
      const sw = snap(bRng.range(3, 4), 0.5);
      const sd = snap(bRng.range(2.5, 3.5), 0.5);
      const sx = bRng.chance(0.5) ? 1.5 : snap(Lw - sw - 1.5, 0.5);
      const sz = snap(Ld - sd - 1.5, 0.5);
      const sFrame = makeFrame(frame.rect(sx, sz, sx + sw, sz + sd), lot.front);
      const shed = buildBuilding(bRng, world, { kind: 'shed', name: `Shed behind ${lot.address}`, address: lot.address, lotId: lot.id, frame: sFrame, plan: makePlan(bRng, 'shed', sw, sd), householdId: -1 });
      furnishBuilding(bRng, world, shed);
      info.shed = shed;
      info.shedLocal = rect(sx, sz, sx + sw, sz + sd);
    }
  }

  // --- player home: a house on a residential street near the middle --------
  const homeCands = infos.filter((i) => i.lot.kind === 'house' && i.building && i.lot.street !== 'Main Street');
  homeCands.sort((a, b) => dist(lotCentre(a.lot).x, lotCentre(a.lot).z, centre.x, centre.z) - dist(lotCentre(b.lot).x, lotCentre(b.lot).z, centre.x, centre.z));
  const home = homeCands[Math.min(homeCands.length - 1, kindRng.int(0, 3))] ?? infos.find((i) => i.building && i.lot.kind === 'house')!;
  world.playerHouseId = home.building!.id;

  // --- props -------------------------------------------------------------------
  const ctx = new PropCtx(rng.fork('props'), world);
  for (const info of infos) {
    if (info.building) ctx.reserve(rect(info.building.rect.x0 - 0.8, info.building.rect.z0 - 0.8, info.building.rect.x1 + 0.8, info.building.rect.z1 + 0.8));
    if (info.shed) ctx.reserve(rect(info.shed.rect.x0 - 1.2, info.shed.rect.z0 - 1.2, info.shed.rect.x1 + 1.2, info.shed.rect.z1 + 1.2));
  }
  // keep the outside of every exterior door clear
  for (const d of world.doors) {
    if (!d.exterior) continue;
    const out = d.roomPos >= 0 ? -1 : 1;
    const x = d.axis === 'x' ? d.t : d.c + out * 1.4;
    const z = d.axis === 'x' ? d.c + out * 1.4 : d.t;
    ctx.reserve(rect(x - 1.3, z - 1.3, x + 1.3, z + 1.3));
  }
  for (const road of world.roads) ctx.reserve(road.rect);
  for (const b of world.blocks) if (b.alley) ctx.reserve(b.alley);
  placeBusStop(ctx, layout);
  decorateStreets(ctx, layout);
  // lots
  const rowKey = (l: Lot) => `${l.blockId}:${l.front}`;
  const seenRow = new Set<string>();
  // first lot in row in local x order is the one whose local x=0 edge is not shared
  for (const info of infos) {
    const l = info.lot;
    const key = rowKey(l);
    const neighbours = lots.filter((o) => o !== l && rowKey(o) === key);
    const localLeft = info.frame.rect(-0.01, 1, 0, 2);
    const shared = neighbours.some((o) => o.rect.x0 <= localLeft.x1 + 0.02 && o.rect.x1 >= localLeft.x0 - 0.02 && o.rect.z0 <= localLeft.z1 + 0.02 && o.rect.z1 >= localLeft.z0 - 0.02);
    const first = !shared;
    seenRow.add(key);
    const blk = world.blocks[l.blockId];
    const alleyBehind = !!blk.alley;
    if (l.kind === 'house' || l.kind === 'abandoned') decorateHouseLot(ctx, info, alleyBehind, first);
    else if (l.kind === 'commercial') decorateCommercialLot(ctx, info);
    else if (l.kind === 'church') decorateChurchLot(ctx, info);
    else if (l.kind === 'vacant') decorateVacantLot(ctx, info);
  }
  if (layout.parkBlock >= 0) decoratePark(ctx, world.blocks[layout.parkBlock].rect);
  for (const w of layout.wildAreas) decorateWild(ctx, w);
  decorateForest(ctx, layout);

  // landmark entries for commercial buildings
  for (const b of world.buildings) {
    if (b.kind === 'house' || b.kind === 'shed' || b.kind === 'abandoned') continue;
    world.landmarks.push({ name: b.name, x: b.outsideFront.x, z: b.outsideFront.z, kind: b.kind });
  }
  for (const b of world.buildings) if (b.kind === 'abandoned') world.landmarks.push({ name: `the abandoned house at ${b.address}`, x: b.outsideFront.x, z: b.outsideFront.z, kind: 'abandoned' });
  // hide spots inside buildings (wardrobes)
  for (const f of world.furniture) if (f.hide) world.pois.push({ kind: 'hide', x: f.ux, z: f.uz, buildingId: f.buildingId });

  world.townEdge = { x: layout.width - 10, z: layout.Z[layout.mainRow] };
  repairWorld(world);
  return world;
}
