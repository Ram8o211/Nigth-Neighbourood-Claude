import type { Rng } from '../../core/rng';
import { rect, rectsOverlap, rectContains, type Rect } from '../../core/math';
import type { Building, Dir, LightKind, Lot, Prop, WorldData } from '../types';
import { DIR_VEC } from '../types';
import type { Frame } from './frame';
import type { Layout } from './layout';
import { CARRIAGE_HALF, SIDEWALK_W } from './layout';

export class PropCtx {
  /** areas where no further props may be placed (buildings, paths, driveways) */
  reserved: Rect[] = [];
  constructor(
    public rng: Rng,
    public world: WorldData,
  ) {}

  free(r: Rect, margin = 0): boolean {
    for (const q of this.reserved) if (rectsOverlap(q, r, margin)) return false;
    return true;
  }

  reserve(r: Rect) {
    this.reserved.push(r);
  }

  prop(kind: string, x: number, z: number, opts: Partial<Prop> = {}): Prop {
    const p: Prop = {
      id: this.world.props.length,
      kind,
      x,
      z,
      rot: opts.rot ?? 0,
      s: opts.s ?? 1,
      color: opts.color ?? 0xffffff,
      solid: opts.solid ?? null,
      blocksSight: opts.blocksSight ?? false,
      hide: opts.hide ?? false,
      h: opts.h ?? 1,
    };
    this.world.props.push(p);
    return p;
  }

  light(kind: LightKind, x: number, y: number, z: number, color: number, intensity: number, range: number, opts: { flicker?: number; broken?: boolean; auto?: boolean } = {}) {
    const l = {
      id: this.world.lights.length,
      kind,
      x,
      y,
      z,
      color,
      intensity,
      range,
      buildingId: -1,
      roomId: -1,
      auto: opts.auto ?? true,
      on: false,
      broken: opts.broken ?? false,
      flicker: opts.flicker ?? 0,
    };
    this.world.lights.push(l);
    return l;
  }

  tree(x: number, z: number, kind?: string, scale?: number) {
    const k = kind ?? this.rng.pick(['tree_oak', 'tree_oak', 'tree_maple', 'tree_birch', 'tree_pine']);
    const s = scale ?? this.rng.range(0.8, 1.25);
    const t = 0.22 * s + 0.1;
    return this.prop(k, x, z, { rot: this.rng.range(0, Math.PI * 2), s, solid: rect(x - t, z - t, x + t, z + t), h: 7 * s });
  }

  bush(x: number, z: number, s?: number) {
    const sc = s ?? this.rng.range(0.7, 1.3);
    return this.prop('bush', x, z, { s: sc, rot: this.rng.range(0, 6.28), hide: sc > 1.0, h: 1.1 * sc, color: this.rng.pick([0x2f4a2a, 0x3a5530, 0x2a4030]) });
  }

  /** straight fence segment from (x0,z0) to (x1,z1) axis aligned */
  fence(kind: string, x0: number, z0: number, x1: number, z1: number, h: number, color = 0xffffff) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 0.3) return;
    const alongX = Math.abs(z1 - z0) < 1e-6;
    const th = kind === 'hedge' ? 0.45 : 0.06;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const solid = alongX ? rect(Math.min(x0, x1), cz - th, Math.max(x0, x1), cz + th) : rect(cx - th, Math.min(z0, z1), cx + th, Math.max(z0, z1));
    this.prop(kind, cx, cz, { rot: alongX ? 0 : Math.PI / 2, s: len, h, solid, blocksSight: h > 1.5, hide: kind === 'hedge', color });
  }

  /** fence with gaps (gaps given as [t0,t1] along the segment from the start) */
  fenceWithGaps(kind: string, x0: number, z0: number, x1: number, z1: number, h: number, gaps: [number, number][], color = 0xffffff) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const dx = (x1 - x0) / len;
    const dz = (z1 - z0) / len;
    const sorted = gaps.map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(len, Math.max(a, b))] as [number, number]).sort((a, b) => a[0] - b[0]);
    let t = 0;
    for (const [a, b] of sorted) {
      if (a > t) this.fence(kind, x0 + dx * t, z0 + dz * t, x0 + dx * a, z0 + dz * a, h, color);
      t = Math.max(t, b);
    }
    if (t < len) this.fence(kind, x0 + dx * t, z0 + dz * t, x1, z1, h, color);
  }
}

// --------------------------------------------------------------------------
// Lots

export interface LotInfo {
  lot: Lot;
  frame: Frame;
  building: Building | null;
  /** building footprint in lot-local coords */
  bl: Rect | null;
  shed: Building | null;
  shedLocal: Rect | null;
}

/** gaps along a lot-local horizontal line expressed as lot-local x ranges */
export function decorateHouseLot(ctx: PropCtx, info: LotInfo, alleyBehind: boolean, firstInRow: boolean) {
  const { rng, world } = ctx;
  const { lot, frame } = info;
  const W = frame.w;
  const D = frame.d;
  const b = info.building;
  const bl = info.bl;
  const abandoned = lot.kind === 'abandoned';
  const vacant = !b;
  const L = (lx: number, lz: number) => frame.toWorld(lx, lz);
  const R = (x0: number, z0: number, x1: number, z1: number) => frame.rect(x0, z0, x1, z1);

  if (b && bl) ctx.reserve(rect(b.rect.x0 - 1.0, b.rect.z0 - 1.0, b.rect.x1 + 1.0, b.rect.z1 + 1.0));

  let walkX = W / 2;
  let driveX0 = -1;
  if (b && bl) {
    const fd = world.doors[b.frontDoorId];
    const fdw = { x: fd.axis === 'x' ? fd.t : fd.c, z: fd.axis === 'x' ? fd.c : fd.t };
    // lot local x of the front door
    // invert frame: try both coords
    walkX = localX(frame, fdw.x, fdw.z);
    // walkway + porch
    const porch = R(walkX - 1.3, bl.z0 - 1.6, walkX + 1.3, bl.z0);
    world.ground.push({ rect: porch, surface: 'wood', kind: abandoned ? 'porch_old' : 'porch' });
    ctx.reserve(porch);
    const walk = R(walkX - 0.6, 0, walkX + 0.6, bl.z0 - 1.6);
    world.ground.push({ rect: walk, surface: 'concrete', kind: 'walkway' });
    ctx.reserve(rect(walk.x0 - 0.3, walk.z0 - 0.3, walk.x1 + 0.3, walk.z1 + 0.3));
    // porch light
    const sideOff = walkX + 0.95 < bl.x1 ? 0.95 : -0.95;
    const pl = L(walkX + sideOff, bl.z0 - 0.2);
    const light = ctx.light('porch', pl.x, 2.25, pl.z, 0xffcf8a, 0.9, 7, { broken: abandoned || rng.chance(0.1), flicker: rng.chance(0.12) ? 0.5 : 0, auto: false });
    b.porchLightId = light.id;
    // driveway on the wider side
    const leftSpace = bl.x0;
    const rightSpace = W - bl.x1;
    if (!abandoned && Math.max(leftSpace, rightSpace) >= 3.6) {
      const left = leftSpace > rightSpace;
      driveX0 = left ? Math.max(0.4, bl.x0 - 3.3) : bl.x1 + 0.3;
      const dr = R(driveX0, 0, driveX0 + 3.0, Math.min(D - 2, bl.z0 + 5.5));
      world.ground.push({ rect: dr, surface: 'concrete', kind: 'driveway' });
      const c = L(driveX0 + 1.5, bl.z0 + 1.0);
      const along = frame.axis('z');
      const cw = along === 'x' ? 4.3 : 1.9;
      const cd = along === 'x' ? 1.9 : 4.3;
      if (rng.chance(0.55) && ctx.free(rect(c.x - cw / 2, c.z - cd / 2, c.x + cw / 2, c.z + cd / 2))) {
        ctx.prop('car', c.x, c.z, {
          rot: along === 'x' ? Math.PI / 2 : 0,
          color: rng.pick([0x7a2a22, 0x2a3a5a, 0x3a4a3a, 0xc8c0b0, 0x2a2a2a, 0x6a6a70, 0x8a7a3a]),
          solid: rect(c.x - cw / 2, c.z - cd / 2, c.x + cw / 2, c.z + cd / 2),
          h: 1.45,
        });
      }
    }
    // mailbox by the walkway at the street edge
    if (!vacant) {
      const mb = L(walkX + 1.1, 0.5);
      ctx.prop('mailbox', mb.x, mb.z, { rot: dirYaw(frame.dir(0)), color: rng.pick([0x2a3a5a, 0x5a2a2a, 0x3a3a3a]), h: 1.2 });
      const tc = L(driveX0 >= 0 ? driveX0 - 0.6 : walkX - 1.6, 0.8);
      if (rng.chance(0.6) && driveX0 >= 0.7) ctx.prop('trashcan', tc.x, tc.z, { solid: rect(tc.x - 0.3, tc.z - 0.3, tc.x + 0.3, tc.z + 0.3), h: 1 });
    }
  }

  // fences
  const fenceKindSide = abandoned ? 'fence_wood_broken' : rng.pick(['fence_wood', 'fence_wood', 'hedge', 'fence_wood']);
  const fenceColor = rng.pick([0x8a6a4a, 0x6a5038, 0x9a8a70, 0xe8e2d4]);
  const frontLine = bl ? bl.z0 : 4;
  // right side fence (local x = W) from the house front line to the back of the lot, gate near the front
  const sideH = fenceKindSide === 'hedge' ? 1.8 : 1.8;
  const sideLine = (lx: number) => {
    const a = L(lx, frontLine + 0.5);
    const c = L(lx, D);
    const gap: [number, number] = [0.6, 1.9];
    ctx.fenceWithGaps(fenceKindSide, a.x, a.z, c.x, c.z, sideH, abandoned ? [gap, [5, 7.5]] : [gap], fenceColor);
  };
  sideLine(W);
  if (firstInRow) sideLine(0);
  // back fence along the alley / lot rear with a gate behind the house
  const backH = 1.8;
  {
    const a = L(0, D);
    const c = L(W, D);
    const gateX = bl ? (bl.x0 + bl.x1) / 2 : W / 2;
    const gaps: [number, number][] = alleyBehind ? [[gateX - 0.7, gateX + 0.7]] : [];
    if (abandoned) gaps.push([W * 0.7, W * 0.7 + 2]);
    ctx.fenceWithGaps(fenceKindSide === 'hedge' ? 'hedge' : abandoned ? 'fence_wood_broken' : 'fence_wood', a.x, a.z, c.x, c.z, backH, gaps, fenceColor);
    if (alleyBehind && rng.chance(0.7)) {
      const tc = L(gateX + 1.4, D + 0.7);
      ctx.prop('trashcan', tc.x, tc.z, { solid: rect(tc.x - 0.3, tc.z - 0.3, tc.x + 0.3, tc.z + 0.3), h: 1, hide: false });
    }
  }
  // front picket fence / low hedge
  const frontStyle = abandoned ? 'fence_picket_broken' : rng.pick(['none', 'fence_picket', 'fence_picket', 'hedge_low', 'none']);
  if (frontStyle !== 'none') {
    const a = L(0, 0.15);
    const c = L(W, 0.15);
    const gaps: [number, number][] = [[walkX - 0.8, walkX + 0.8]];
    if (driveX0 >= 0) gaps.push([driveX0 - 0.2, driveX0 + 3.2]);
    const k = frontStyle === 'hedge_low' ? 'hedge' : frontStyle;
    ctx.fenceWithGaps(k, a.x, a.z, c.x, c.z, frontStyle === 'hedge_low' ? 0.9 : 1.0, gaps, frontStyle.startsWith('fence_picket') ? 0xece8de : fenceColor);
  }

  // trees and bushes
  const nTrees = vacant ? rng.int(2, 5) : rng.int(1, 4);
  for (let k = 0; k < nTrees * 3 && k < 20; k++) {
    const lx = rng.range(1.2, W - 1.2);
    const lz = rng.range(1.2, D - 1.2);
    const p = L(lx, lz);
    const r = rect(p.x - 1.4, p.z - 1.4, p.x + 1.4, p.z + 1.4);
    if (!ctx.free(r)) continue;
    ctx.reserve(rect(p.x - 0.8, p.z - 0.8, p.x + 0.8, p.z + 0.8));
    if (abandoned && rng.chance(0.4)) ctx.tree(p.x, p.z, 'tree_dead');
    else ctx.tree(p.x, p.z);
    if (k >= nTrees) break;
  }
  const nBush = rng.int(1, 4) + (abandoned || vacant ? 4 : 0);
  for (let k = 0; k < nBush * 2; k++) {
    const nearHouse = bl && rng.chance(0.6);
    let lx: number;
    let lz: number;
    if (nearHouse && bl) {
      lx = rng.range(bl.x0 - 0.9, bl.x1 + 0.9);
      lz = rng.chance(0.5) ? bl.z0 - 1.0 : rng.range(bl.z0, bl.z1);
      if (lz > bl.z0 - 0.2 && lx > bl.x0 - 0.5 && lx < bl.x1 + 0.5) continue;
    } else {
      lx = rng.range(0.8, W - 0.8);
      lz = rng.range(0.8, D - 0.8);
    }
    const p = L(lx, lz);
    const r = rect(p.x - 0.6, p.z - 0.6, p.x + 0.6, p.z + 0.6);
    if (!ctx.free(r)) continue;
    ctx.reserve(r);
    ctx.bush(p.x, p.z);
  }
  // backyard dressing
  if (b && bl && !abandoned) {
    const yardDepth = D - bl.z1;
    if (yardDepth > 4.5 && rng.chance(0.4)) {
      const p = L(rng.range(1.5, W - 1.5), bl.z1 + yardDepth * 0.5);
      if (ctx.free(rect(p.x - 1.2, p.z - 1.2, p.x + 1.2, p.z + 1.2))) {
        const k = rng.pick(['laundry', 'woodpile', 'picnic', 'swingset', 'gnome', 'grill']);
        const solid = k === 'gnome' || k === 'laundry' ? null : rect(p.x - 0.7, p.z - 0.5, p.x + 0.7, p.z + 0.5);
        ctx.prop(k, p.x, p.z, { rot: dirYaw(frame.dir(0)), solid, h: 1.2 });
        ctx.reserve(rect(p.x - 1, p.z - 1, p.x + 1, p.z + 1));
      }
    }
  }
  if (abandoned) {
    // junk in the yard
    for (let k = 0; k < 3; k++) {
      const p = L(rng.range(1.5, W - 1.5), rng.range(1, D - 1));
      if (!ctx.free(rect(p.x - 1, p.z - 1, p.x + 1, p.z + 1))) continue;
      ctx.reserve(rect(p.x - 1, p.z - 1, p.x + 1, p.z + 1));
      ctx.prop(rng.pick(['tire', 'junk', 'woodpile']), p.x, p.z, { rot: rng.range(0, 6), solid: rect(p.x - 0.5, p.z - 0.5, p.x + 0.5, p.z + 0.5), h: 0.6 });
    }
    world.ground.push({ rect: lot.rect, surface: 'dirt', kind: 'overgrown' });
  }
}

export function decorateCommercialLot(ctx: PropCtx, info: LotInfo) {
  const { rng, world } = ctx;
  const { frame } = info;
  const b = info.building!;
  const bl = info.bl!;
  const W = frame.w;
  const D = frame.d;
  const L = (lx: number, lz: number) => frame.toWorld(lx, lz);
  const R = (x0: number, z0: number, x1: number, z1: number) => frame.rect(x0, z0, x1, z1);
  ctx.reserve(rect(b.rect.x0 - 1, b.rect.z0 - 1, b.rect.x1 + 1, b.rect.z1 + 1));
  // forecourt
  world.ground.push({ rect: R(0, 0, W, bl.z0), surface: 'concrete', kind: 'forecourt' });
  // parking on wider side
  const left = bl.x0 > W - bl.x1;
  const px0 = left ? 0.3 : bl.x1 + 0.5;
  const px1 = left ? bl.x0 - 0.5 : W - 0.3;
  if (px1 - px0 > 3) {
    const pr = R(px0, 0.3, px1, Math.min(D - 1, bl.z1));
    world.ground.push({ rect: pr, surface: 'asphalt', kind: 'parking' });
    ctx.reserve(pr);
    if (rng.chance(0.6)) {
      const c = L((px0 + px1) / 2, bl.z0 + 2.5);
      const along = frame.axis('z');
      const cw = along === 'x' ? 4.3 : 1.9;
      const cd = along === 'x' ? 1.9 : 4.3;
      ctx.prop('car', c.x, c.z, { rot: along === 'x' ? Math.PI / 2 : 0, color: rng.pick([0x7a2a22, 0x2a3a5a, 0xc8c0b0, 0x2a2a2a]), solid: rect(c.x - cw / 2, c.z - cd / 2, c.x + cw / 2, c.z + cd / 2), h: 1.45 });
    }
  }
  // sign above door (sign light)
  const fd = world.doors[b.frontDoorId];
  const fdx = fd.axis === 'x' ? fd.t : fd.c;
  const fdz = fd.axis === 'x' ? fd.c : fd.t;
  const out = DIR_VEC[frame.dir(0)];
  const signColor: Record<string, number> = {
    diner: 0xff4a6a,
    bar: 0xff3a2a,
    police: 0x6a9aff,
    store: 0xfff0b0,
    hardware: 0xffb050,
    clinic: 0x9affd0,
    garage: 0xffd070,
    church: 0xffd8a0,
  };
  const sc = signColor[b.kind] ?? 0xffffff;
  ctx.prop('sign', fdx + out.x * 0.35, fdz + out.z * 0.35, { rot: dirYaw(frame.dir(0)), color: sc, h: b.wallHeight + 0.35, s: Math.min(6, (b.rect.x1 - b.rect.x0 + b.rect.z1 - b.rect.z0) / 4) });
  ctx.light('sign', fdx + out.x * 1.2, b.wallHeight - 0.2, fdz + out.z * 1.2, sc, b.kind === 'police' ? 1.2 : 1.6, 9, { flicker: b.kind === 'bar' || b.kind === 'diner' ? 0.15 : 0, auto: true });
  // dumpster behind
  const dp = L(bl.x1 - 1.5, Math.min(D - 1.2, bl.z1 + 1.8));
  if (ctx.free(rect(dp.x - 1.2, dp.z - 1.2, dp.x + 1.2, dp.z + 1.2))) {
    const along = frame.axis('x');
    const dw = along === 'x' ? 1.9 : 1.1;
    const dd = along === 'x' ? 1.1 : 1.9;
    ctx.prop('dumpster', dp.x, dp.z, { rot: dirYaw(frame.dir(0)), solid: rect(dp.x - dw / 2, dp.z - dd / 2, dp.x + dw / 2, dp.z + dd / 2), h: 1.3, hide: true, color: rng.pick([0x2f5a3a, 0x3a4a6a]) });
    world.pois.push({ kind: 'hide', x: dp.x, z: dp.z, buildingId: -1 });
    ctx.reserve(rect(dp.x - 1.2, dp.z - 1.2, dp.x + 1.2, dp.z + 1.2));
  }
  if (b.kind === 'bar' || b.kind === 'store' || b.kind === 'diner') {
    const pb = L(left ? bl.x1 + 1.2 : bl.x0 - 1.2, 1.2);
    if (ctx.free(rect(pb.x - 0.7, pb.z - 0.7, pb.x + 0.7, pb.z + 0.7))) {
      ctx.prop(b.kind === 'diner' ? 'bench' : 'phonebooth', pb.x, pb.z, {
        rot: dirYaw(frame.dir(0)),
        solid: rect(pb.x - 0.5, pb.z - 0.5, pb.x + 0.5, pb.z + 0.5),
        h: b.kind === 'diner' ? 0.9 : 2.3,
      });
      if (b.kind !== 'diner') {
        world.pois.push({ kind: 'phonebooth', x: pb.x + out.x * 0.9, z: pb.z + out.z * 0.9, buildingId: -1 });
        ctx.light('lamp', pb.x, 2.2, pb.z, 0xd8f0ff, 0.5, 4, { flicker: 0.2 });
      }
      ctx.reserve(rect(pb.x - 0.8, pb.z - 0.8, pb.x + 0.8, pb.z + 0.8));
    }
    if (b.kind === 'bar' || b.kind === 'store') world.pois.push({ kind: 'smoke', x: L(bl.x0 - 0.8, bl.z0 - 1).x, z: L(bl.x0 - 0.8, bl.z0 - 1).z, buildingId: b.id });
  }
  // back fence
  const a = L(0, D);
  const c = L(W, D);
  ctx.fenceWithGaps('fence_chain', a.x, a.z, c.x, c.z, 2.0, [[(bl.x0 + bl.x1) / 2 - 1, (bl.x0 + bl.x1) / 2 + 1]], 0x9a9a9a);
  // a few planters / trees at the side
  for (let k = 0; k < 3; k++) {
    const p = L(rng.range(0.8, W - 0.8), rng.range(bl.z1 + 1, D - 0.8));
    const r = rect(p.x - 1.2, p.z - 1.2, p.x + 1.2, p.z + 1.2);
    if (ctx.free(r)) {
      ctx.reserve(r);
      ctx.tree(p.x, p.z);
    }
  }
}

export function decorateChurchLot(ctx: PropCtx, info: LotInfo) {
  const { rng, world } = ctx;
  const { frame } = info;
  const bl = info.bl!;
  const b = info.building!;
  const W = frame.w;
  const D = frame.d;
  const L = (lx: number, lz: number) => frame.toWorld(lx, lz);
  ctx.reserve(rect(b.rect.x0 - 1, b.rect.z0 - 1, b.rect.x1 + 1, b.rect.z1 + 1));
  const walk = frame.rect((bl.x0 + bl.x1) / 2 - 1, 0, (bl.x0 + bl.x1) / 2 + 1, bl.z0);
  world.ground.push({ rect: walk, surface: 'gravel', kind: 'walkway' });
  ctx.reserve(walk);
  // iron fence around with gate
  const gx = (bl.x0 + bl.x1) / 2;
  const p00 = L(0, 0.2);
  const p10 = L(W, 0.2);
  const p11 = L(W, D);
  const p01 = L(0, D);
  ctx.fenceWithGaps('fence_iron', p00.x, p00.z, p10.x, p10.z, 1.6, [[gx - 1.1, gx + 1.1]], 0x222226);
  ctx.fence('fence_iron', p10.x, p10.z, p11.x, p11.z, 1.6, 0x222226);
  ctx.fence('fence_iron', p01.x, p01.z, p11.x, p11.z, 1.6, 0x222226);
  ctx.fence('fence_iron', p00.x, p00.z, p01.x, p01.z, 1.6, 0x222226);
  const gl = L(gx + 1.4, 0.4);
  ctx.prop('lamppost', gl.x, gl.z, { h: 3.2, solid: rect(gl.x - 0.15, gl.z - 0.15, gl.x + 0.15, gl.z + 0.15) });
  ctx.light('park', gl.x, 3.1, gl.z, 0xffd9a0, 1.0, 8, { flicker: 0.6 });
  // graveyard on the side / back
  const side = bl.x0 > W - bl.x1 ? 'left' : 'right';
  const gx0 = side === 'left' ? 1 : bl.x1 + 1.2;
  const gx1 = side === 'left' ? bl.x0 - 1.2 : W - 1;
  let n = 0;
  for (let lz = 3; lz < D - 1.5; lz += 2.2)
    for (let lx = gx0 + 0.6; lx < gx1 - 0.4; lx += 1.6) {
      const p = L(lx + rng.range(-0.15, 0.15), lz + rng.range(-0.2, 0.2));
      if (!ctx.free(rect(p.x - 0.5, p.z - 0.5, p.x + 0.5, p.z + 0.5))) continue;
      const k = rng.chance(0.15) ? 'cross' : 'headstone';
      ctx.prop(k, p.x, p.z, { rot: dirYaw(frame.dir(0)) + rng.range(-0.15, 0.15), s: rng.range(0.85, 1.15), solid: rect(p.x - 0.35, p.z - 0.15, p.x + 0.35, p.z + 0.15), h: 1, color: rng.pick([0x8a8a86, 0x6a6a68, 0x7a7670]) });
      n++;
    }
  if (n > 0) {
    const c = L((gx0 + gx1) / 2, D / 2);
    world.pois.push({ kind: 'graveyard', x: c.x, z: c.z, buildingId: -1 });
    world.landmarks.push({ name: 'the old churchyard', x: c.x, z: c.z, kind: 'graveyard' });
  }
  const dt = L(side === 'left' ? 2 : W - 2, D - 2);
  ctx.tree(dt.x, dt.z, 'tree_dead', 1.3);
}

export function decorateVacantLot(ctx: PropCtx, info: LotInfo) {
  const { rng, world } = ctx;
  const { lot, frame } = info;
  world.ground.push({ rect: lot.rect, surface: 'dirt', kind: 'vacant' });
  const W = frame.w;
  const D = frame.d;
  for (let k = 0; k < 8; k++) {
    const p = frame.toWorld(rng.range(1, W - 1), rng.range(1, D - 1));
    if (!ctx.free(rect(p.x - 1, p.z - 1, p.x + 1, p.z + 1))) continue;
    ctx.reserve(rect(p.x - 0.8, p.z - 0.8, p.x + 0.8, p.z + 0.8));
    if (k < 3) ctx.tree(p.x, p.z, rng.pick(['tree_dead', 'tree_oak', 'tree_birch']));
    else ctx.bush(p.x, p.z, rng.range(1, 1.5));
  }
  if (rng.chance(0.6)) {
    const p = frame.toWorld(W / 2, D / 2);
    if (ctx.free(rect(p.x - 2.5, p.z - 2.5, p.x + 2.5, p.z + 2.5))) {
      ctx.prop('car_wreck', p.x, p.z, { rot: rng.range(0, 6.28), solid: rect(p.x - 1.6, p.z - 1.6, p.x + 1.6, p.z + 1.6), h: 1.3, hide: true, color: 0x5a3a2a });
      world.pois.push({ kind: 'hide', x: p.x, z: p.z, buildingId: -1 });
    }
  }
  const a = frame.toWorld(0, 0.2);
  const c = frame.toWorld(W, 0.2);
  ctx.fenceWithGaps('fence_chain', a.x, a.z, c.x, c.z, 1.9, [[W * 0.3, W * 0.3 + 1.6]], 0x8a8a8a);
}

function localX(frame: Frame, wx: number, wz: number): number {
  // solve toWorld(lx, 0) for lx along the frontage
  const o = frame.toWorld(0, 0);
  const e = frame.toWorld(1, 0);
  const dx = e.x - o.x;
  const dz = e.z - o.z;
  return (wx - o.x) * dx + (wz - o.z) * dz;
}

export function dirYaw(d: Dir): number {
  // yaw such that the prop's local -z faces direction d
  return [0, -Math.PI / 2, Math.PI, Math.PI / 2][d];
}

// --------------------------------------------------------------------------
// Streets, park, forest

export function decorateStreets(ctx: PropCtx, layout: Layout) {
  const { rng, world } = ctx;
  const nodes: { x: number; z: number }[] = [];
  for (const x of layout.X) for (const z of layout.Z) nodes.push({ x, z });
  const nearNode = (x: number, z: number, d: number) => nodes.some((n) => Math.abs(n.x - x) < d && Math.abs(n.z - z) < d);
  for (const road of layout.roads) {
    if (road.kind !== 'main' && road.kind !== 'street') {
      if (road.kind === 'alley') {
        // power poles along the alley, one flickering lamp at a random point
        const alongX = road.axis === 'x';
        const len = alongX ? road.rect.x1 - road.rect.x0 : road.rect.z1 - road.rect.z0;
        const n = Math.floor(len / 18);
        for (let k = 0; k <= n; k++) {
          const t = (k + 0.5) * (len / (n + 1));
          const x = alongX ? road.rect.x0 + t : road.rect.x0 + 0.35;
          const z = alongX ? road.rect.z0 + 0.35 : road.rect.z0 + t;
          ctx.prop('powerpole', x, z, { rot: alongX ? 0 : Math.PI / 2, h: 7, solid: rect(x - 0.15, z - 0.15, x + 0.15, z + 0.15) });
          if (k === Math.floor(n / 2) && rng.chance(0.6)) ctx.light('street', x, 5.5, z + (alongX ? 0.6 : 0), 0xffb070, 0.9, 10, { flicker: 0.7, broken: rng.chance(0.25) });
        }
      }
      continue;
    }
    const kind = road.kind;
    const cw = CARRIAGE_HALF[kind];
    const sw = SIDEWALK_W[kind];
    const spacing = kind === 'main' ? 19 : 25;
    const alongX = road.axis === 'x';
    const a = alongX ? road.core.x0 : road.core.z0;
    const b = alongX ? road.core.x1 : road.core.z1;
    const c = alongX ? (road.core.z0 + road.core.z1) / 2 : (road.core.x0 + road.core.x1) / 2;
    let side = rng.chance(0.5) ? 1 : -1;
    for (let t = a + spacing * 0.5; t < b - 4; t += spacing) {
      const sides = kind === 'main' ? [1, -1] : [side];
      for (const sd of sides) {
        const off = cw + 0.45;
        const x = alongX ? t : c + sd * off;
        const z = alongX ? c + sd * off : t;
        if (nearNode(x, z, 9)) continue;
        if (x < 4 || z < 4 || x > world.width - 4 || z > world.depth - 4) continue;
        const outsideTown = x < layout.X[0] - 4 || x > layout.X[layout.X.length - 1] + 4;
        const broken = rng.chance(outsideTown ? 0.5 : 0.07);
        const flicker = rng.chance(0.14) ? rng.range(0.3, 0.9) : 0;
        ctx.prop('streetlamp', x, z, { rot: alongX ? (sd > 0 ? 0 : Math.PI) : sd > 0 ? Math.PI / 2 : -Math.PI / 2, h: 5.6, solid: rect(x - 0.15, z - 0.15, x + 0.15, z + 0.15) });
        // lamp head overhangs the road
        const hx = alongX ? x : x - sd * 1.1;
        const hz = alongX ? z - sd * 1.1 : z;
        ctx.light('street', hx, 5.4, hz, kind === 'main' ? 0xffc27a : 0xffb366, kind === 'main' ? 2.4 : 2.1, 16, { broken, flicker });
      }
      side = -side;
      // street trees in between
      if (kind === 'street' && rng.chance(0.55)) {
        const tt = t + spacing / 2;
        const sd = rng.chance(0.5) ? 1 : -1;
        const off = cw + sw * 0.6;
        const x = alongX ? tt : c + sd * off;
        const z = alongX ? c + sd * off : tt;
        if (!nearNode(x, z, 9) && tt < b - 4) ctx.tree(x, z, rng.pick(['tree_oak', 'tree_maple']), rng.range(0.9, 1.3));
      }
    }
    // parked cars along the curb
    if (kind === 'street') {
      for (let t = a + 12; t < b - 12; t += rng.range(14, 30)) {
        if (!rng.chance(0.35)) continue;
        const sd = rng.chance(0.5) ? 1 : -1;
        const off = cw - 1.1;
        const x = alongX ? t : c + sd * off;
        const z = alongX ? c + sd * off : t;
        if (nearNode(x, z, 10)) continue;
        const cwid = alongX ? 4.3 : 1.9;
        const cdep = alongX ? 1.9 : 4.3;
        ctx.prop('car', x, z, { rot: alongX ? Math.PI / 2 : 0, color: rng.pick([0x7a2a22, 0x2a3a5a, 0x3a4a3a, 0xc8c0b0, 0x2a2a2a, 0x6a6a70]), solid: rect(x - cwid / 2, z - cdep / 2, x + cwid / 2, z + cdep / 2), h: 1.45 });
      }
    }
  }
  // cul-de-sac ends get a "dead end" sign
  for (const de of layout.deadEnds) ctx.prop('sign_deadend', de.x + 4, de.z + 4, { h: 2.2, solid: rect(de.x + 3.9, de.z + 3.9, de.x + 4.1, de.z + 4.1) });
}

export function decoratePark(ctx: PropCtx, r: Rect) {
  const { rng, world } = ctx;
  world.ground.push({ rect: r, surface: 'grass', kind: 'park' });
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  // cross paths
  const ph = rect(r.x0, cz - 1.2, r.x1, cz + 1.2);
  const pv = rect(cx - 1.2, r.z0, cx + 1.2, r.z1);
  world.ground.push({ rect: ph, surface: 'gravel', kind: 'parkpath' });
  world.ground.push({ rect: pv, surface: 'gravel', kind: 'parkpath' });
  ctx.reserve(ph);
  ctx.reserve(pv);
  // pond in one quadrant
  const qx = rng.chance(0.5) ? -1 : 1;
  const qz = rng.chance(0.5) ? -1 : 1;
  const pondX = cx + qx * (r.x1 - r.x0) * 0.25;
  const pondZ = cz + qz * (r.z1 - r.z0) * 0.25;
  const pr = Math.min(8, (r.x1 - r.x0) * 0.16, (r.z1 - r.z0) * 0.16);
  ctx.prop('pond', pondX, pondZ, { s: pr, h: 0 });
  // approximate the pond collision with a few boxes
  for (let k = -2; k <= 2; k++) {
    const zz = pondZ + (k * pr) / 2.6;
    const half = Math.sqrt(Math.max(0, pr * pr - ((k * pr) / 2.6) ** 2)) * 0.92;
    ctx.prop('collider', pondX, zz, { solid: rect(pondX - half, zz - pr / 5.2, pondX + half, zz + pr / 5.2), h: 0 });
  }
  ctx.reserve(rect(pondX - pr - 1.5, pondZ - pr - 1.5, pondX + pr + 1.5, pondZ + pr + 1.5));
  world.pois.push({ kind: 'pond', x: pondX + pr + 1.2, z: pondZ, buildingId: -1 });
  world.landmarks.push({ name: 'the park pond', x: pondX, z: pondZ, kind: 'pond' });
  // gazebo at the centre
  ctx.prop('gazebo', cx, cz, { s: 1, h: 3.5 });
  for (const [ox, oz] of [
    [-2.2, -2.2],
    [2.2, -2.2],
    [-2.2, 2.2],
    [2.2, 2.2],
  ])
    ctx.prop('collider', cx + ox, cz + oz, { solid: rect(cx + ox - 0.15, cz + oz - 0.15, cx + ox + 0.15, cz + oz + 0.15), h: 0 });
  ctx.light('park', cx, 3.0, cz, 0xffd9a8, 1.2, 9, { flicker: 0.1 });
  world.pois.push({ kind: 'park', x: cx + 1, z: cz + 1, buildingId: -1 });
  world.landmarks.push({ name: 'the bandstand', x: cx, z: cz, kind: 'gazebo' });
  // playground in the opposite quadrant
  const plx = cx - qx * (r.x1 - r.x0) * 0.25;
  const plz = cz - qz * (r.z1 - r.z0) * 0.25;
  ctx.prop('swingset', plx - 2, plz, { solid: rect(plx - 3.3, plz - 0.4, plx - 0.7, plz + 0.4), h: 2.4 });
  ctx.prop('slide', plx + 2.5, plz, { solid: rect(plx + 2, plz - 1.5, plx + 3, plz + 1.5), h: 2.2 });
  ctx.prop('sandbox', plx, plz + 3, { h: 0.3 });
  ctx.reserve(rect(plx - 4, plz - 2, plx + 4, plz + 5));
  world.pois.push({ kind: 'playground', x: plx, z: plz - 2, buildingId: -1 });
  // benches and lamps along the paths
  for (const [bx, bz, rot] of [
    [cx - 8, cz - 2.2, 0],
    [cx + 8, cz + 2.2, Math.PI],
    [cx - 2.2, cz + 9, Math.PI / 2],
    [cx + 2.2, cz - 9, -Math.PI / 2],
  ] as [number, number, number][]) {
    ctx.prop('bench', bx, bz, { rot, solid: rect(bx - 0.8, bz - 0.35, bx + 0.8, bz + 0.35), h: 0.9 });
    world.pois.push({ kind: 'bench', x: bx, z: bz, buildingId: -1 });
  }
  for (const [lx, lz] of [
    [r.x0 + 6, cz + 1.8],
    [r.x1 - 6, cz - 1.8],
    [cx + 1.8, r.z0 + 6],
    [cx - 1.8, r.z1 - 6],
  ]) {
    ctx.prop('lamppost', lx, lz, { h: 3.4, solid: rect(lx - 0.15, lz - 0.15, lx + 0.15, lz + 0.15) });
    ctx.light('park', lx, 3.3, lz, 0xffd9a8, 1.1, 10, { broken: rng.chance(0.3), flicker: rng.chance(0.3) ? 0.6 : 0 });
  }
  // trees, with one dense dark grove
  const gx = cx - qx * (r.x1 - r.x0) * 0.27;
  const gz = cz + qz * (r.z1 - r.z0) * 0.27;
  for (let k = 0; k < 80; k++) {
    const grove = k < 35;
    const x = grove ? gx + rng.range(-9, 9) : rng.range(r.x0 + 1.5, r.x1 - 1.5);
    const z = grove ? gz + rng.range(-8, 8) : rng.range(r.z0 + 1.5, r.z1 - 1.5);
    if (!rectContains(r, x, z, -1)) continue;
    const rr = rect(x - 1.3, z - 1.3, x + 1.3, z + 1.3);
    if (!ctx.free(rr)) continue;
    ctx.reserve(rect(x - 0.9, z - 0.9, x + 0.9, z + 0.9));
    if (grove && rng.chance(0.45)) ctx.bush(x, z, rng.range(1.1, 1.6));
    else ctx.tree(x, z, grove ? rng.pick(['tree_pine', 'tree_pine', 'tree_oak']) : undefined);
  }
  world.pois.push({ kind: 'hide', x: gx, z: gz, buildingId: -1 });
  world.landmarks.push({ name: 'the pine grove', x: gx, z: gz, kind: 'grove' });
  // low hedge border around the park, with openings at the paths
  const hh = 1.1;
  ctx.fenceWithGaps('hedge', r.x0, r.z0 + 0.5, r.x1, r.z0 + 0.5, hh, [[cx - r.x0 - 2, cx - r.x0 + 2]]);
  ctx.fenceWithGaps('hedge', r.x0, r.z1 - 0.5, r.x1, r.z1 - 0.5, hh, [[cx - r.x0 - 2, cx - r.x0 + 2]]);
  ctx.fenceWithGaps('hedge', r.x0 + 0.5, r.z0, r.x0 + 0.5, r.z1, hh, [[cz - r.z0 - 2, cz - r.z0 + 2]]);
  ctx.fenceWithGaps('hedge', r.x1 - 0.5, r.z0, r.x1 - 0.5, r.z1, hh, [[cz - r.z0 - 2, cz - r.z0 + 2]]);
}

export function decorateWild(ctx: PropCtx, r: Rect) {
  const { rng, world } = ctx;
  world.ground.push({ rect: r, surface: 'dirt', kind: 'wild' });
  const area = (r.x1 - r.x0) * (r.z1 - r.z0);
  const n = Math.floor(area / 22);
  // a winding dirt trail through it
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  const trail = r.x1 - r.x0 > r.z1 - r.z0 ? rect(r.x0, cz - 0.8, r.x1, cz + 0.8) : rect(cx - 0.8, r.z0, cx + 0.8, r.z1);
  ctx.reserve(rect(trail.x0 - 0.6, trail.z0 - 0.6, trail.x1 + 0.6, trail.z1 + 0.6));
  for (let k = 0; k < n; k++) {
    const x = rng.range(r.x0 + 1, r.x1 - 1);
    const z = rng.range(r.z0 + 1, r.z1 - 1);
    const rr = rect(x - 1.1, z - 1.1, x + 1.1, z + 1.1);
    if (!ctx.free(rr)) continue;
    ctx.reserve(rect(x - 0.7, z - 0.7, x + 0.7, z + 0.7));
    if (rng.chance(0.4)) ctx.bush(x, z, rng.range(1, 1.6));
    else ctx.tree(x, z, rng.pick(['tree_pine', 'tree_dead', 'tree_oak', 'tree_birch']));
  }
  // environmental storytelling: an abandoned camp
  const p = { x: cx + rng.range(-4, 4), z: cz + rng.range(-4, 4) };
  if (ctx.free(rect(p.x - 2, p.z - 2, p.x + 2, p.z + 2))) {
    ctx.prop('tent', p.x, p.z, { rot: rng.range(0, 6.28), solid: rect(p.x - 1, p.z - 1, p.x + 1, p.z + 1), h: 1.3, hide: true });
    ctx.prop('campfire', p.x + 2, p.z + 0.5, { h: 0.3 });
    world.pois.push({ kind: 'hide', x: p.x, z: p.z, buildingId: -1 });
  }
}

export function decorateForest(ctx: PropCtx, layout: Layout) {
  const { rng, world } = ctx;
  const W = world.width;
  const D = world.depth;
  const inner = rect(layout.X[0] - 6, layout.Z[0] - 6, layout.X[layout.X.length - 1] + 6, layout.Z[layout.Z.length - 1] + 6);
  const mainZ = layout.Z[layout.mainRow];
  const isMainCorridor = (x: number, z: number) => Math.abs(z - mainZ) < 8 && (x < inner.x0 + 6 || x > inner.x1 - 6);
  const step = 3.1;
  for (let x = 1; x < W - 1; x += step)
    for (let z = 1; z < D - 1; z += step) {
      const jx = x + rng.range(-1.2, 1.2);
      const jz = z + rng.range(-1.2, 1.2);
      if (rectContains(inner, jx, jz)) continue;
      if (isMainCorridor(jx, jz)) continue;
      if (!ctx.free(rect(jx - 0.6, jz - 0.6, jx + 0.6, jz + 0.6))) continue;
      if (rng.chance(0.18)) continue;
      const deep = Math.min(jx, jz, W - jx, D - jz) < 14;
      const k = rng.chance(0.62) ? 'tree_pine' : rng.chance(0.25) ? 'tree_dead' : rng.chance(0.5) ? 'tree_birch' : 'tree_oak';
      ctx.tree(jx, jz, k, rng.range(0.9, deep ? 1.6 : 1.3));
    }
  // blocked roads out of town
  for (const ex of [6, W - 6]) {
    const x = ex;
    for (let k = -2; k <= 2; k++) ctx.prop('barrier', x, mainZ + k * 1.7, { rot: Math.PI / 2, solid: rect(x - 0.3, mainZ + k * 1.7 - 0.9, x + 0.3, mainZ + k * 1.7 + 0.9), h: 1.1 });
    ctx.light('sign', x, 1.4, mainZ, 0xff7a20, 0.8, 6, { flicker: 0.95, auto: false });
    world.lights[world.lights.length - 1].on = true;
    ctx.prop('sign_roadclosed', x + (ex < W / 2 ? 2 : -2), mainZ - 5, { h: 2, solid: rect(x - 0.1, mainZ - 5.1, x + 0.1, mainZ - 4.9) });
  }
  // world boundary
  const m = 3;
  ctx.prop('collider', W / 2, m / 2, { solid: rect(0, 0, W, m), h: 0 });
  ctx.prop('collider', W / 2, D - m / 2, { solid: rect(0, D - m, W, D), h: 0 });
  ctx.prop('collider', m / 2, D / 2, { solid: rect(0, 0, m, D), h: 0 });
  ctx.prop('collider', W - m / 2, D / 2, { solid: rect(W - m, 0, W, D), h: 0 });
  // water tower landmark in a forest clearing at a corner, radio mast far away
  const corner = rng.int(0, 3);
  const tx = corner % 2 === 0 ? inner.x0 - 14 : inner.x1 + 14;
  const tz = corner < 2 ? inner.z0 - 14 : inner.z1 + 14;
  ctx.prop('watertower', tx, tz, { h: 22, solid: rect(tx - 3, tz - 3, tx + 3, tz + 3) });
  world.landmarks.push({ name: 'the water tower', x: tx, z: tz, kind: 'watertower' });
  ctx.light('sign', tx, 21, tz, 0xff2020, 1.0, 4, { flicker: 0, auto: true });
  const mx = corner % 2 === 0 ? W + 120 : -120;
  ctx.prop('radiomast', mx, D / 2, { h: 60 });
}

export function placeBusStop(ctx: PropCtx, layout: Layout) {
  const { world } = ctx;
  const mainZ = layout.Z[layout.mainRow];
  const x = layout.X[layout.X.length - 1] - 18;
  const z = mainZ + CARRIAGE_HALF.main + 1.4;
  ctx.prop('busstop', x, z, { rot: Math.PI, solid: rect(x - 1.6, z + 0.2, x + 1.6, z + 0.9), h: 2.5 });
  world.busStop = { x, z: z - 0.3 };
  world.pois.push({ kind: 'bus', x, z: z - 0.4, buildingId: -1 });
  world.landmarks.push({ name: 'the bus stop on Main Street', x, z, kind: 'busstop' });
}
