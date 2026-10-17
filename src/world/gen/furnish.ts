import type { Rng } from '../../core/rng';
import { rect, rectsOverlap, type Rect } from '../../core/math';
import type { Building, Dir, Furniture, FurnitureUse, ItemStack, Room, WorldData } from '../types';
import { DIR_VEC } from '../types';

interface Spec {
  kind: string;
  use: FurnitureUse;
  w: number; // along wall
  d: number; // depth from wall
  h: number;
  solid?: boolean;
  colors: number[];
  hide?: boolean;
  container?: (rng: Rng, b: Building) => ItemStack[];
  light?: boolean;
}

const WOOD = [0x6b4a32, 0x7d5a3c, 0x5a3d29, 0x8b6a4a, 0x4a3324];
const FABRIC = [0x7a3a32, 0x3f5a6e, 0x5f6b45, 0x8a7a5a, 0x5a4a6a, 0x9a8a72, 0x3a3a3a];
const WHITE = [0xe8e4da, 0xd9d4c8, 0xf0ece2];
const METAL = [0x8a8f94, 0x6f757a, 0xa0a4a8];

const loot = {
  fridge: (rng: Rng): ItemStack[] => {
    const out: ItemStack[] = [];
    if (rng.chance(0.85)) out.push({ item: 'sandwich', n: rng.int(1, 2) });
    if (rng.chance(0.6)) out.push({ item: 'apple', n: rng.int(1, 3) });
    if (rng.chance(0.3)) out.push({ item: 'chocolate', n: 1 });
    return out;
  },
  kitchen: (rng: Rng): ItemStack[] => {
    const out: ItemStack[] = [];
    if (rng.chance(0.7)) out.push({ item: 'canned_beans', n: rng.int(1, 3) });
    if (rng.chance(0.5)) out.push({ item: 'coffee', n: 1 });
    if (rng.chance(0.35)) out.push({ item: 'kitchen_knife', n: 1 });
    if (rng.chance(0.2)) out.push({ item: 'silverware', n: 1 });
    return out;
  },
  dresser: (rng: Rng): ItemStack[] => {
    const out: ItemStack[] = [];
    if (rng.chance(0.6)) out.push({ item: 'cash', n: rng.int(5, 30) });
    if (rng.chance(0.25)) out.push({ item: 'watch', n: 1 });
    if (rng.chance(0.25)) out.push({ item: 'jewelry', n: 1 });
    return out;
  },
  wardrobe: (rng: Rng): ItemStack[] => {
    const out: ItemStack[] = [];
    if (rng.chance(0.15)) out.push({ item: 'baseball_bat', n: 1 });
    if (rng.chance(0.2)) out.push({ item: 'cash', n: rng.int(5, 20) });
    return out;
  },
  bath: (rng: Rng): ItemStack[] => {
    const out: ItemStack[] = [];
    if (rng.chance(0.7)) out.push({ item: 'bandage', n: rng.int(1, 2) });
    if (rng.chance(0.45)) out.push({ item: 'painkillers', n: 1 });
    return out;
  },
  desk: (rng: Rng): ItemStack[] => {
    const out: ItemStack[] = [];
    if (rng.chance(0.4)) out.push({ item: 'cash', n: rng.int(3, 15) });
    if (rng.chance(0.3)) out.push({ item: 'battery', n: 1 });
    if (rng.chance(0.2)) out.push({ item: 'cigarettes', n: 1 });
    return out;
  },
  shed: (rng: Rng): ItemStack[] => {
    const out: ItemStack[] = [];
    if (rng.chance(0.5)) out.push({ item: 'planks', n: rng.int(1, 3) });
    if (rng.chance(0.3)) out.push({ item: 'crowbar', n: 1 });
    if (rng.chance(0.35)) out.push({ item: 'battery', n: rng.int(1, 2) });
    return out;
  },
  abandoned: (rng: Rng): ItemStack[] => {
    const out: ItemStack[] = [];
    if (rng.chance(0.3)) out.push({ item: 'canned_beans', n: 1 });
    if (rng.chance(0.25)) out.push({ item: 'battery', n: 1 });
    if (rng.chance(0.15)) out.push({ item: 'watch', n: 1 });
    if (rng.chance(0.2)) out.push({ item: 'planks', n: 1 });
    return out;
  },
};

const S = {
  sofa: { kind: 'sofa', use: 'sofa', w: 2.0, d: 0.9, h: 0.85, colors: FABRIC } as Spec,
  armchair: { kind: 'armchair', use: 'sofa', w: 0.95, d: 0.9, h: 0.9, colors: FABRIC } as Spec,
  tv: { kind: 'tv', use: 'tv', w: 1.4, d: 0.5, h: 1.05, colors: WOOD } as Spec,
  bookshelf: { kind: 'bookshelf', use: 'bookshelf', w: 1.1, d: 0.38, h: 1.95, colors: WOOD } as Spec,
  floorlamp: { kind: 'floorlamp', use: 'lamp', w: 0.45, d: 0.45, h: 1.65, colors: [0xd8c8a0], light: true } as Spec,
  phone: { kind: 'phonetable', use: 'phone', w: 0.6, d: 0.45, h: 0.75, colors: WOOD } as Spec,
  plant: { kind: 'plant', use: 'decor', w: 0.5, d: 0.5, h: 1.1, colors: [0x3d6b3a, 0x4a7a40] } as Spec,
  fridge: { kind: 'fridge', use: 'fridge', w: 0.8, d: 0.72, h: 1.85, colors: WHITE, container: loot.fridge } as Spec,
  stove: { kind: 'stove', use: 'stove', w: 0.75, d: 0.65, h: 0.92, colors: WHITE } as Spec,
  sink: { kind: 'kitchensink', use: 'sink', w: 1.2, d: 0.65, h: 0.92, colors: WHITE, container: loot.kitchen } as Spec,
  counter: { kind: 'counter', use: 'cabinet', w: 1.2, d: 0.65, h: 0.92, colors: WOOD, container: loot.kitchen } as Spec,
  bed2: { kind: 'bed', use: 'bed', w: 1.6, d: 2.1, h: 0.6, colors: FABRIC } as Spec,
  bed1: { kind: 'bed', use: 'bed', w: 1.05, d: 2.0, h: 0.6, colors: FABRIC } as Spec,
  nightstand: { kind: 'nightstand', use: 'dresser', w: 0.5, d: 0.45, h: 0.6, colors: WOOD, container: loot.dresser, light: true } as Spec,
  wardrobe: { kind: 'wardrobe', use: 'wardrobe', w: 1.2, d: 0.62, h: 2.0, colors: WOOD, hide: true, container: loot.wardrobe } as Spec,
  dresser: { kind: 'dresser', use: 'dresser', w: 1.1, d: 0.5, h: 0.9, colors: WOOD, container: loot.dresser } as Spec,
  desk: { kind: 'desk', use: 'desk', w: 1.2, d: 0.65, h: 0.76, colors: WOOD, container: loot.desk } as Spec,
  toilet: { kind: 'toilet', use: 'toilet', w: 0.5, d: 0.7, h: 0.75, colors: WHITE } as Spec,
  bathsink: { kind: 'bathsink', use: 'sink', w: 0.65, d: 0.5, h: 0.9, colors: WHITE, container: loot.bath } as Spec,
  tub: { kind: 'tub', use: 'shower', w: 1.7, d: 0.8, h: 0.6, colors: WHITE } as Spec,
  shower: { kind: 'shower', use: 'shower', w: 0.9, d: 0.9, h: 2.1, colors: [0xb8c8d0] } as Spec,
  bathcab: { kind: 'bathcabinet', use: 'cabinet', w: 0.6, d: 0.35, h: 1.6, colors: WHITE, container: loot.bath } as Spec,
  coatrack: { kind: 'coatrack', use: 'decor', w: 0.45, d: 0.45, h: 1.8, colors: WOOD } as Spec,
  shelf: { kind: 'shelf', use: 'shelf', w: 1.2, d: 0.45, h: 1.9, colors: METAL } as Spec,
  shelfLoot: { kind: 'shelf', use: 'shelf', w: 1.2, d: 0.45, h: 1.9, colors: METAL, container: loot.shed } as Spec,
  crate: { kind: 'crate', use: 'crate', w: 0.8, d: 0.8, h: 0.7, colors: [0x8a6a40] } as Spec,
  workbench: { kind: 'workbench', use: 'workbench', w: 1.8, d: 0.75, h: 0.95, colors: WOOD, container: loot.shed } as Spec,
  shopcounter: { kind: 'shopcounter', use: 'register', w: 2.4, d: 0.75, h: 1.0, colors: WOOD } as Spec,
  barcounter: { kind: 'barcounter', use: 'bartap', w: 3.6, d: 0.8, h: 1.1, colors: [0x4a2e1e] } as Spec,
  frontdesk: { kind: 'frontdesk', use: 'register', w: 2.4, d: 0.8, h: 1.1, colors: [0x5a5048] } as Spec,
  cellbed: { kind: 'cellbed', use: 'cellbed', w: 0.8, d: 2.0, h: 0.5, colors: METAL } as Spec,
  filing: { kind: 'filing', use: 'cabinet', w: 0.6, d: 0.6, h: 1.35, colors: METAL, container: loot.desk } as Spec,
  examtable: { kind: 'examtable', use: 'exam', w: 0.8, d: 1.9, h: 0.8, colors: [0xd8dde0] } as Spec,
  medcab: { kind: 'medcabinet', use: 'cabinet', w: 1.0, d: 0.45, h: 1.8, colors: WHITE, container: (r: Rng) => [{ item: 'bandage', n: r.int(1, 3) }, ...(r.chance(0.5) ? [{ item: 'painkillers', n: 1 }] : [])] } as Spec,
  altar: { kind: 'altar', use: 'altar', w: 2.0, d: 0.9, h: 1.0, colors: [0xe0d8c8] } as Spec,
  jukebox: { kind: 'jukebox', use: 'decor', w: 0.9, d: 0.6, h: 1.5, colors: [0x8a2a2a] } as Spec,
  oil: { kind: 'oildrum', use: 'decor', w: 0.6, d: 0.6, h: 0.9, colors: [0x3a5a3a, 0x8a3a2a] } as Spec,
  bench: { kind: 'bench', use: 'chair', w: 1.6, d: 0.5, h: 0.5, colors: WOOD } as Spec,
};

function innerRect(room: Room): Rect {
  const m = 0.17;
  return rect(room.rect.x0 + m, room.rect.z0 + m, room.rect.x1 - m, room.rect.z1 - m);
}

interface Ctx {
  rng: Rng;
  world: WorldData;
  b: Building;
  room: Room;
  inner: Rect;
  placed: Rect[];
  winZones: Rect[];
}

function makeCtx(rng: Rng, world: WorldData, b: Building, room: Room): Ctx {
  const winZones: Rect[] = [];
  for (const wid of room.windowIds) {
    const w = world.windows[wid];
    const half = w.width / 2 + 0.15;
    winZones.push(w.axis === 'x' ? rect(w.t - half, w.c - 0.9, w.t + half, w.c + 0.9) : rect(w.c - 0.9, w.t - half, w.c + 0.9, w.t + half));
  }
  return { rng, world, b, room, inner: innerRect(room), placed: [], winZones };
}

function footprint(spec: Spec, wallSide: Dir) {
  // wall side N/S: width along x
  return wallSide === 0 || wallSide === 2 ? { fw: spec.w, fd: spec.d } : { fw: spec.d, fd: spec.w };
}

function canPlace(ctx: Ctx, r: Rect, spec: Spec, ignoreClear = false): boolean {
  const I = ctx.inner;
  if (r.x0 < I.x0 - 1e-6 || r.z0 < I.z0 - 1e-6 || r.x1 > I.x1 + 1e-6 || r.z1 > I.z1 + 1e-6) return false;
  for (const p of ctx.placed) if (rectsOverlap(p, r, 0.04)) return false;
  if (!ignoreClear) for (const c of ctx.room.clear) if (rectsOverlap(c, r)) return false;
  if (spec.h > 1.05) for (const z of ctx.winZones) if (rectsOverlap(z, r)) return false;
  return true;
}

function commit(ctx: Ctx, spec: Spec, cx: number, cz: number, fw: number, fd: number, face: Dir, useOverride?: { x: number; z: number }): Furniture {
  const r = rect(cx - fw / 2, cz - fd / 2, cx + fw / 2, cz + fd / 2);
  ctx.placed.push(r);
  const v = DIR_VEC[face];
  const depth = face === 0 || face === 2 ? fd : fw;
  const ux = useOverride ? useOverride.x : cx + v.x * (depth / 2 + 0.5);
  const uz = useOverride ? useOverride.z : cz + v.z * (depth / 2 + 0.5);
  const f: Furniture = {
    id: ctx.world.furniture.length,
    kind: spec.kind,
    use: spec.use,
    x: cx,
    z: cz,
    w: fw,
    d: fd,
    h: spec.h,
    face,
    buildingId: ctx.b.id,
    roomId: ctx.room.id,
    solid: spec.solid !== false,
    tall: spec.h > 1.5,
    color: ctx.rng.pick(spec.colors),
    container: spec.container ? spec.container(ctx.rng, ctx.b) : null,
    searched: false,
    hide: !!spec.hide,
    ux,
    uz,
    lightId: -1,
  };
  if (ctx.b.kind === 'abandoned' && f.container) f.container = loot.abandoned(ctx.rng);
  ctx.world.furniture.push(f);
  if (spec.light) addLamp(ctx, f);
  return f;
}

function addLamp(ctx: Ctx, f: Furniture) {
  const l = {
    id: ctx.world.lights.length,
    kind: 'lamp' as const,
    x: f.x,
    y: f.kind === 'floorlamp' ? 1.55 : 0.85,
    z: f.z,
    color: 0xffc98a,
    intensity: f.kind === 'floorlamp' ? 1.1 : 0.6,
    range: f.kind === 'floorlamp' ? 6 : 3.5,
    buildingId: ctx.b.id,
    roomId: ctx.room.id,
    auto: false,
    on: false,
    broken: false,
    flicker: 0,
  };
  ctx.world.lights.push(l);
  ctx.room.lightIds.push(l.id);
  f.lightId = l.id;
}

/** place against one of the walls; returns null if no space */
function againstWall(ctx: Ctx, spec: Spec, sides?: Dir[], tries = 24, bedUse = false): Furniture | null {
  const I = ctx.inner;
  const sideList = sides ?? ([0, 1, 2, 3] as Dir[]);
  for (let k = 0; k < tries; k++) {
    const side = ctx.rng.pick(sideList);
    const { fw, fd } = footprint(spec, side);
    let cx: number;
    let cz: number;
    if (side === 0 || side === 2) {
      if (I.x1 - I.x0 < fw) continue;
      cx = ctx.rng.range(I.x0 + fw / 2, I.x1 - fw / 2);
      cz = side === 0 ? I.z0 + fd / 2 : I.z1 - fd / 2;
    } else {
      if (I.z1 - I.z0 < fd) continue;
      cz = ctx.rng.range(I.z0 + fd / 2, I.z1 - fd / 2);
      cx = side === 3 ? I.x0 + fw / 2 : I.x1 - fw / 2;
    }
    // snap only along the wall so pieces stay flush against it
    if (side === 0 || side === 2) cx = Math.min(I.x1 - fw / 2, Math.max(I.x0 + fw / 2, Math.round(cx * 20) / 20));
    else cz = Math.min(I.z1 - fd / 2, Math.max(I.z0 + fd / 2, Math.round(cz * 20) / 20));
    const r = rect(cx - fw / 2, cz - fd / 2, cx + fw / 2, cz + fd / 2);
    if (!canPlace(ctx, r, spec)) continue;
    const face = ((side + 2) % 4) as Dir;
    let use: { x: number; z: number } | undefined;
    if (bedUse) {
      // stand beside the bed: try both long sides
      const perp = DIR_VEC[((side + 1) % 4) as Dir];
      const halfW = side === 0 || side === 2 ? fw / 2 : fd / 2;
      const c1 = { x: cx + perp.x * (halfW + 0.45), z: cz + perp.z * (halfW + 0.45) };
      const c2 = { x: cx - perp.x * (halfW + 0.45), z: cz - perp.z * (halfW + 0.45) };
      const inside = (p: { x: number; z: number }) => p.x > I.x0 + 0.25 && p.x < I.x1 - 0.25 && p.z > I.z0 + 0.25 && p.z < I.z1 - 0.25;
      use = inside(c1) ? c1 : inside(c2) ? c2 : undefined;
      if (!use) continue;
    }
    // use point must be inside the room
    const v = DIR_VEC[face];
    const depth = face === 0 || face === 2 ? fd : fw;
    const ux = use ? use.x : cx + v.x * (depth / 2 + 0.5);
    const uz = use ? use.z : cz + v.z * (depth / 2 + 0.5);
    if (ux < I.x0 + 0.2 || ux > I.x1 - 0.2 || uz < I.z0 + 0.2 || uz > I.z1 - 0.2) continue;
    // a use point must not fall inside an existing piece
    if (ctx.placed.some((p) => ux > p.x0 - 0.2 && ux < p.x1 + 0.2 && uz > p.z0 - 0.2 && uz < p.z1 + 0.2)) continue;
    return commit(ctx, spec, cx, cz, fw, fd, face, use);
  }
  return null;
}

/** table with chairs near the centre; chairs are separate seat furniture */
function diningSet(ctx: Ctx, tw: number, td: number, chairs: number, color?: number): boolean {
  const I = ctx.inner;
  const groupW = tw + 1.1;
  const groupD = td + 1.1;
  for (let k = 0; k < 12; k++) {
    const cx = Math.round(ctx.rng.range(I.x0 + groupW / 2 + 0.7, I.x1 - groupW / 2 - 0.7) * 20) / 20;
    const cz = Math.round(ctx.rng.range(I.z0 + groupD / 2 + 0.7, I.z1 - groupD / 2 - 0.7) * 20) / 20;
    if (!isFinite(cx) || !isFinite(cz) || I.x1 - I.x0 < groupW + 1.4 || I.z1 - I.z0 < groupD + 1.4) return false;
    const group = rect(cx - groupW / 2 - 0.6, cz - groupD / 2 - 0.6, cx + groupW / 2 + 0.6, cz + groupD / 2 + 0.6);
    const tspec: Spec = { kind: 'table', use: 'table', w: tw, d: td, h: 0.76, colors: color ? [color] : WOOD };
    if (!canPlace(ctx, group, tspec)) continue;
    commit(ctx, tspec, cx, cz, tw, td, 2);
    // chairs: at the two long sides
    const cspec: Spec = { kind: 'chair', use: 'chair', w: 0.48, d: 0.48, h: 0.9, colors: WOOD };
    const spots: { x: number; z: number; face: Dir }[] = [
      { x: cx - tw / 4, z: cz - td / 2 - 0.4, face: 2 },
      { x: cx + tw / 4, z: cz + td / 2 + 0.4, face: 0 },
      { x: cx + tw / 4, z: cz - td / 2 - 0.4, face: 2 },
      { x: cx - tw / 4, z: cz + td / 2 + 0.4, face: 0 },
    ];
    for (let c = 0; c < Math.min(chairs, 4); c++) {
      const s = spots[c];
      const r = rect(s.x - 0.24, s.z - 0.24, s.x + 0.24, s.z + 0.24);
      ctx.placed.push(r);
      const f = commit(ctx, cspec, s.x, s.z, 0.48, 0.48, s.face, { x: s.x + (s.face === 2 ? 0 : 0), z: s.z + (s.face === 2 ? -0.55 : 0.55) });
      ctx.placed.pop();
      void f;
    }
    return true;
  }
  return false;
}

/** rows of free-standing units (shop shelving, pews) along the room depth */
function rows(ctx: Ctx, spec: Spec, axis: 'x' | 'z', aisle: number, margin: number, max = 99) {
  const I = ctx.inner;
  let count = 0;
  if (axis === 'x') {
    // units are long along x, stacked in z
    for (let z = I.z0 + margin + spec.d / 2; z + spec.d / 2 < I.z1 - margin && count < max; z += spec.d + aisle) {
      const usable = I.x1 - I.x0 - 2 * margin;
      const n = Math.max(1, Math.floor(usable / spec.w));
      const total = n * spec.w;
      for (let k = 0; k < n; k++) {
        const cx = I.x0 + margin + (usable - total) / 2 + spec.w * (k + 0.5);
        const r = rect(cx - spec.w / 2, z - spec.d / 2, cx + spec.w / 2, z + spec.d / 2);
        if (canPlace(ctx, r, { ...spec, h: 0 })) {
          commit(ctx, spec, cx, z, spec.w, spec.d, 0);
          count++;
        }
      }
    }
  } else {
    for (let x = I.x0 + margin + spec.d / 2; x + spec.d / 2 < I.x1 - margin && count < max; x += spec.d + aisle) {
      const usable = I.z1 - I.z0 - 2 * margin;
      const n = Math.max(1, Math.floor(usable / spec.w));
      const total = n * spec.w;
      for (let k = 0; k < n; k++) {
        const cz = I.z0 + margin + (usable - total) / 2 + spec.w * (k + 0.5);
        const r = rect(x - spec.d / 2, cz - spec.w / 2, x + spec.d / 2, cz + spec.w / 2);
        if (canPlace(ctx, r, { ...spec, h: 0 })) {
          commit(ctx, spec, x, cz, spec.d, spec.w, 3);
          count++;
        }
      }
    }
  }
}

function decor(ctx: Ctx, kind: string, w: number, d: number) {
  // non-solid flat decoration (rugs)
  const I = ctx.inner;
  const cx = (I.x0 + I.x1) / 2;
  const cz = (I.z0 + I.z1) / 2;
  if (I.x1 - I.x0 < w + 0.4 || I.z1 - I.z0 < d + 0.4) return;
  const f: Furniture = {
    id: ctx.world.furniture.length,
    kind,
    use: 'decor',
    x: cx,
    z: cz,
    w,
    d,
    h: 0.01,
    face: 0,
    buildingId: ctx.b.id,
    roomId: ctx.room.id,
    solid: false,
    tall: false,
    color: ctx.rng.pick([0x7a2e2a, 0x2e4a6a, 0x6a5a3a, 0x4a2e4a, 0x3a5a4a]),
    container: null,
    searched: false,
    hide: false,
    ux: cx,
    uz: cz,
    lightId: -1,
  };
  ctx.world.furniture.push(f);
}

function longestWallSide(ctx: Ctx): Dir[] {
  const I = ctx.inner;
  return I.x1 - I.x0 >= I.z1 - I.z0 ? [0, 2] : [1, 3];
}

/** which wall of the room is toward the building front (street) */
function frontSide(ctx: Ctx): Dir {
  return ctx.b.front;
}

export function furnishRoom(rng: Rng, world: WorldData, b: Building, room: Room, needPhone: boolean) {
  const ctx = makeCtx(rng, world, b, room);
  const k = room.kind;
  const area = (ctx.inner.x1 - ctx.inner.x0) * (ctx.inner.z1 - ctx.inner.z0);
  const bk = b.kind;
  const house = bk === 'house' || bk === 'abandoned';
  if (house) {
    switch (k) {
      case 'living': {
        decor(ctx, 'rug', Math.min(2.6, ctx.inner.x1 - ctx.inner.x0 - 1.2), Math.min(1.8, ctx.inner.z1 - ctx.inner.z0 - 1.2));
        const sofa = againstWall(ctx, S.sofa);
        if (sofa) {
          const opp = ((sofa.face + 0) % 4) as Dir; // sofa faces into room; TV on the wall it faces
          againstWall(ctx, S.tv, [opp]) ?? againstWall(ctx, S.tv);
        }
        if (rng.chance(0.7)) againstWall(ctx, S.armchair);
        if (rng.chance(0.6)) againstWall(ctx, S.bookshelf);
        againstWall(ctx, S.floorlamp);
        if (needPhone) againstWall(ctx, S.phone, undefined, 40);
        if (rng.chance(0.5)) againstWall(ctx, S.plant);
        break;
      }
      case 'kitchen': {
        const wallSides = longestWallSide(ctx);
        const side = rng.pick(wallSides);
        againstWall(ctx, S.fridge, [side], 30) ?? againstWall(ctx, S.fridge, undefined, 40);
        againstWall(ctx, S.stove, [side], 30) ?? againstWall(ctx, S.stove);
        againstWall(ctx, S.sink, [side], 30) ?? againstWall(ctx, S.sink);
        againstWall(ctx, S.counter);
        if (area > 9) diningSet(ctx, 1.2, 0.8, rng.int(2, 4));
        else againstWall(ctx, S.counter);
        break;
      }
      case 'bedroom': {
        const big = area > 11;
        againstWall(ctx, big ? S.bed2 : S.bed1, undefined, 40, true) ?? againstWall(ctx, S.bed1, undefined, 40, true);
        againstWall(ctx, S.nightstand);
        againstWall(ctx, S.wardrobe, undefined, 40);
        if (rng.chance(0.6)) againstWall(ctx, S.dresser);
        if (rng.chance(0.4)) againstWall(ctx, S.desk);
        break;
      }
      case 'bath': {
        againstWall(ctx, S.toilet, undefined, 30);
        againstWall(ctx, S.bathsink, undefined, 30);
        againstWall(ctx, S.tub, undefined, 20) ?? againstWall(ctx, S.shower, undefined, 20);
        againstWall(ctx, S.bathcab);
        break;
      }
      case 'hall': {
        // corridors stay clear unless they are wide enough
        const narrow = Math.min(room.rect.x1 - room.rect.x0, room.rect.z1 - room.rect.z0);
        if (narrow >= 2.5) {
          if (needPhone) againstWall(ctx, S.phone, undefined, 40);
          if (rng.chance(0.6)) againstWall(ctx, S.coatrack);
        }
        break;
      }
      default:
        againstWall(ctx, S.shelfLoot);
        againstWall(ctx, S.crate);
    }
    if (bk === 'abandoned' && rng.chance(0.6)) againstWall(ctx, S.crate);
    return;
  }
  switch (bk) {
    case 'shed':
      againstWall(ctx, S.shelfLoot, undefined, 30);
      againstWall(ctx, S.crate);
      return;
    case 'store':
    case 'hardware': {
      if (k === 'shopfloor') {
        // counter beside the entrance, facing the door
        againstWall(ctx, S.shopcounter, [((frontSide(ctx) + 1) % 4) as Dir, ((frontSide(ctx) + 3) % 4) as Dir], 40) ?? againstWall(ctx, S.shopcounter, undefined, 40);
        const along: 'x' | 'z' = frontSide(ctx) === 0 || frontSide(ctx) === 2 ? 'x' : 'z';
        rows(ctx, { ...S.shelf, d: 0.6, w: 1.2 }, along, 1.6, 1.4);
        againstWall(ctx, S.shelf);
        againstWall(ctx, S.shelf);
      } else if (k === 'backroom') {
        againstWall(ctx, S.shelfLoot);
        againstWall(ctx, S.shelf);
        againstWall(ctx, S.crate);
        againstWall(ctx, S.crate);
      } else {
        againstWall(ctx, S.toilet);
        againstWall(ctx, S.bathsink);
      }
      return;
    }
    case 'diner': {
      if (k === 'dining') {
        againstWall(ctx, { ...S.barcounter, kind: 'dinercounter', colors: [0xb03a2e], use: 'register' }, [((frontSide(ctx) + 2) % 4) as Dir], 40) ??
          againstWall(ctx, { ...S.barcounter, kind: 'dinercounter', colors: [0xb03a2e], use: 'register' }, undefined, 40);
        for (let i = 0; i < 4; i++) diningSet(ctx, 1.1, 0.75, 2, 0xd8d0c0);
        againstWall(ctx, S.jukebox);
      } else if (k === 'kitchen') {
        againstWall(ctx, S.stove);
        againstWall(ctx, S.stove);
        againstWall(ctx, S.fridge);
        againstWall(ctx, S.sink);
        againstWall(ctx, S.counter);
      } else {
        againstWall(ctx, S.toilet);
        againstWall(ctx, S.bathsink);
      }
      return;
    }
    case 'bar': {
      if (k === 'barroom') {
        againstWall(ctx, S.barcounter, [((frontSide(ctx) + 2) % 4) as Dir], 40) ?? againstWall(ctx, S.barcounter, undefined, 40);
        for (let i = 0; i < 3; i++) diningSet(ctx, 0.9, 0.9, 2, 0x4a2e1e);
        againstWall(ctx, S.jukebox);
        if (needPhone) againstWall(ctx, S.phone, undefined, 40);
      } else if (k === 'backroom') {
        againstWall(ctx, S.crate);
        againstWall(ctx, S.shelf);
        againstWall(ctx, S.oil);
      } else {
        againstWall(ctx, S.toilet);
        againstWall(ctx, S.bathsink);
      }
      return;
    }
    case 'police': {
      if (k === 'lobby') {
        againstWall(ctx, S.frontdesk, undefined, 40);
        againstWall(ctx, S.bench);
        againstWall(ctx, S.plant);
      } else if (k === 'office') {
        againstWall(ctx, S.desk);
        againstWall(ctx, S.desk);
        againstWall(ctx, S.filing);
        againstWall(ctx, S.phone, undefined, 40);
      } else if (k === 'cell') {
        againstWall(ctx, S.cellbed, undefined, 40);
        againstWall(ctx, S.toilet);
      } else if (k === 'storage') {
        againstWall(ctx, S.shelf);
        againstWall(ctx, S.shelf);
        againstWall(ctx, S.filing);
      }
      return;
    }
    case 'clinic': {
      if (k === 'lobby') {
        againstWall(ctx, S.frontdesk, undefined, 40);
        againstWall(ctx, S.bench);
        againstWall(ctx, S.bench);
        againstWall(ctx, S.plant);
      } else if (k === 'exam') {
        againstWall(ctx, S.examtable, undefined, 40);
        againstWall(ctx, S.medcab, undefined, 30);
        againstWall(ctx, S.bathsink);
      } else {
        againstWall(ctx, S.desk);
        againstWall(ctx, S.filing);
        againstWall(ctx, S.phone);
        againstWall(ctx, S.bookshelf);
      }
      return;
    }
    case 'garage': {
      if (k === 'workshop') {
        againstWall(ctx, S.workbench, undefined, 30);
        againstWall(ctx, S.workbench);
        againstWall(ctx, S.shelfLoot);
        againstWall(ctx, S.oil);
        againstWall(ctx, S.oil);
        // car being repaired in the middle
        const I = ctx.inner;
        const cx = (I.x0 + I.x1) / 2;
        const cz = (I.z0 + I.z1) / 2;
        const alongX = I.x1 - I.x0 > I.z1 - I.z0;
        const cw = alongX ? 4.2 : 1.9;
        const cd = alongX ? 1.9 : 4.2;
        const cr = rect(cx - cw / 2 - 0.9, cz - cd / 2 - 0.9, cx + cw / 2 + 0.9, cz + cd / 2 + 0.9);
        const carSpec: Spec = { kind: 'car', use: 'decor', w: cw, d: cd, h: 1.4, colors: [0x6a2a2a, 0x2a4a6a, 0x4a5a3a] };
        if (canPlace(ctx, cr, carSpec)) commit(ctx, carSpec, cx, cz, cw, cd, 0);
      } else {
        againstWall(ctx, S.desk);
        againstWall(ctx, S.filing);
        againstWall(ctx, S.phone);
      }
      return;
    }
    case 'church': {
      if (k === 'nave') {
        const back = ((frontSide(ctx) + 2) % 4) as Dir;
        againstWall(ctx, S.altar, [back], 40);
        const along: 'x' | 'z' = frontSide(ctx) === 0 || frontSide(ctx) === 2 ? 'x' : 'z';
        rows(ctx, { kind: 'pew', use: 'pew', w: 1.9, d: 0.6, h: 0.9, colors: WOOD }, along, 1.0, 1.0);
      } else {
        againstWall(ctx, S.shelf);
        againstWall(ctx, S.dresser);
      }
      return;
    }
  }
}

export function furnishBuilding(rng: Rng, world: WorldData, b: Building) {
  let phonePlaced = !(b.kind === 'house' || b.kind === 'bar');
  // ceiling lights per room
  for (const rid of b.roomIds) {
    const room = world.rooms[rid];
    const cx = (room.rect.x0 + room.rect.x1) / 2;
    const cz = (room.rect.z0 + room.rect.z1) / 2;
    const area = (room.rect.x1 - room.rect.x0) * (room.rect.z1 - room.rect.z0);
    const color =
      b.kind === 'police' || b.kind === 'clinic'
        ? 0xe6eeff
        : b.kind === 'bar'
          ? 0xff9a5a
          : b.kind === 'church'
            ? 0xffd090
            : b.kind === 'abandoned'
              ? 0xffe0b0
              : 0xffd7a0;
    const l = {
      id: world.lights.length,
      kind: 'room' as const,
      x: cx,
      y: b.wallHeight - 0.25,
      z: cz,
      color,
      intensity: b.kind === 'bar' ? 0.9 : Math.min(2.2, 0.8 + area / 25),
      range: Math.max(5, Math.sqrt(area) * 1.6),
      buildingId: b.id,
      roomId: rid,
      auto: false,
      on: false,
      broken: b.kind === 'abandoned' ? rng.chance(0.7) : false,
      flicker: b.kind === 'abandoned' ? 0.6 : rng.chance(0.05) ? 0.3 : 0,
    };
    world.lights.push(l);
    room.lightIds.push(l.id);
  }
  // living room first so the phone lands there for houses
  const order = [...b.roomIds].sort((a, c) => {
    const pa = world.rooms[a].kind === 'living' || world.rooms[a].kind === 'barroom' ? 0 : world.rooms[a].kind === 'hall' ? 1 : 2;
    const pc = world.rooms[c].kind === 'living' || world.rooms[c].kind === 'barroom' ? 0 : world.rooms[c].kind === 'hall' ? 1 : 2;
    return pa - pc;
  });
  for (const rid of order) {
    const room = world.rooms[rid];
    const before = world.furniture.length;
    furnishRoom(rng, world, b, room, !phonePlaced);
    for (let i = before; i < world.furniture.length; i++) if (world.furniture[i].use === 'phone') phonePlaced = true;
  }
  // every home has a telephone somewhere: fall back to any room, making space if needed
  if (!phonePlaced) addEssential(rng, world, b, S.phone, ['living', 'hall', 'kitchen', 'bedroom', 'barroom']);
}

const ROOM_DECOR = new Set(['plant', 'floorlamp', 'armchair', 'bookshelf', 'coatrack', 'dresser', 'jukebox']);

/** a context for a room that already has furniture in it */
function ctxWithExisting(rng: Rng, world: WorldData, b: Building, room: Room): Ctx {
  const ctx = makeCtx(rng, world, b, room);
  for (const f of world.furniture) {
    if (f.roomId !== room.id || f.kind === 'none' || f.use === 'decor' && f.kind === 'rug') continue;
    ctx.placed.push(rect(f.x - f.w / 2, f.z - f.d / 2, f.x + f.w / 2, f.z + f.d / 2));
  }
  return ctx;
}

/**
 * Make sure a building has a piece of furniture: try the preferred rooms,
 * then retire a decorative piece to make room.
 */
export function addEssential(rng: Rng, world: WorldData, b: Building, spec: Spec, roomKinds: string[]): Furniture | null {
  const rooms = roomKinds.flatMap((k) => b.roomIds.map((id) => world.rooms[id]).filter((r) => r.kind === k));
  for (const room of rooms) {
    const f = againstWall(ctxWithExisting(rng, world, b, room), spec, undefined, 60);
    if (f) return f;
  }
  for (const room of rooms) {
    for (const old of world.furniture) {
      if (old.roomId !== room.id || old.kind === 'none' || !ROOM_DECOR.has(old.kind)) continue;
      const kind = old.kind;
      old.kind = 'none';
      old.solid = false;
      const f = againstWall(ctxWithExisting(rng, world, b, room), spec, undefined, 60);
      if (f) {
        if (old.lightId >= 0) world.lights[old.lightId].broken = true;
        return f;
      }
      old.kind = kind;
      old.solid = true;
    }
  }
  return null;
}

/** the player's inherited house needs a telephone and a table for the uncle's letter */
export function ensureHomeEssentials(rng: Rng, world: WorldData, b: Building) {
  const has = (use: string) => world.furniture.some((f) => f.buildingId === b.id && f.kind !== 'none' && f.use === use);
  if (!has('phone')) addEssential(rng, world, b, S.phone, ['living', 'hall', 'kitchen', 'bedroom']);
  if (!has('table') && !has('desk')) {
    const side: Spec = { kind: 'table', use: 'table', w: 0.9, d: 0.6, h: 0.76, colors: WOOD };
    addEssential(rng, world, b, side, ['kitchen', 'living', 'bedroom']) ?? addEssential(rng, world, b, S.desk, ['bedroom', 'living']);
  }
}
