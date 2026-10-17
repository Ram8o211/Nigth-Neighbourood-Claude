import { Rng } from '../../core/rng';
import { rect, snap, type Rect } from '../../core/math';
import { STREET_NAMES, STREET_TYPES } from '../../core/names';
import type { Block, Dir, Lot, LotKind, Road, GenParams, Surface } from '../types';

export type SegKind = 'main' | 'street' | 'path' | 'none';

export const CARRIAGE_HALF: Record<'main' | 'street', number> = { main: 4.5, street: 3.5 };
export const SIDEWALK_W: Record<'main' | 'street', number> = { main: 3.0, street: 2.0 };
export const FOREST_BAND = 34;

export function corridorHalf(k: SegKind): number {
  switch (k) {
    case 'main':
      return CARRIAGE_HALF.main + SIDEWALK_W.main;
    case 'street':
      return CARRIAGE_HALF.street + SIDEWALK_W.street;
    case 'path':
      return 2.5;
    default:
      return -3; // block extends past the grid line toward the woods
  }
}

export interface RowPlan {
  blockId: number;
  rect: Rect;
  front: Dir;
  street: string;
  commercial: boolean;
}

export interface Layout {
  width: number;
  depth: number;
  X: number[];
  Z: number[];
  hSeg: SegKind[][]; // [i][j] horizontal segment on line j between X[i], X[i+1]
  vSeg: SegKind[][]; // [i][j] vertical segment on line i between Z[j], Z[j+1]
  mainRow: number;
  roads: Road[];
  blocks: Block[];
  rows: RowPlan[];
  ground: { rect: Rect; surface: Surface; kind: string }[];
  hNames: string[];
  vNames: string[];
  parkBlock: number;
  wildAreas: Rect[];
  deadEnds: { x: number; z: number }[];
}

const SIZE_GRID: Record<GenParams['size'], [number, number]> = {
  small: [3, 2],
  medium: [3, 3],
  large: [4, 3],
};

export function generateLayout(rng: Rng, params: GenParams): Layout {
  const [C, R] = SIZE_GRID[params.size];
  const X: number[] = [FOREST_BAND];
  for (let i = 0; i < C; i++) X.push(X[i] + snap(rng.range(64, 76), 1));
  const Z: number[] = [FOREST_BAND];
  for (let j = 0; j < R; j++) Z.push(Z[j] + snap(rng.range(60, 70), 1));
  const width = X[C] + FOREST_BAND;
  const depth = Z[R] + FOREST_BAND;
  const mainRow = R === 2 ? 1 : rng.int(1, R - 1);

  // --- segment kinds -------------------------------------------------------
  const hSeg: SegKind[][] = [];
  const vSeg: SegKind[][] = [];
  for (let i = 0; i < C; i++) {
    hSeg.push([]);
    for (let j = 0; j <= R; j++) {
      const outer = j === 0 || j === R;
      let k: SegKind;
      if (j === mainRow) k = 'main';
      else if (outer) k = rng.chance(0.42) ? 'none' : rng.chance(0.12) ? 'path' : 'street';
      else k = rng.chance(0.14) ? 'path' : 'street';
      hSeg[i].push(k);
    }
  }
  for (let i = 0; i <= C; i++) {
    vSeg.push([]);
    for (let j = 0; j < R; j++) {
      const outer = i === 0 || i === C;
      let k: SegKind;
      if (outer) k = rng.chance(0.45) ? 'none' : rng.chance(0.12) ? 'path' : 'street';
      else k = rng.chance(0.16) ? 'path' : 'street';
      vSeg[i].push(k);
    }
  }

  const isRoad = (k: SegKind) => k === 'main' || k === 'street';
  // ensure connectivity of road graph (nodes (i,j)), starting from main street
  const nodeId = (i: number, j: number) => j * (C + 1) + i;
  const ensureConnected = () => {
    for (let guard = 0; guard < 200; guard++) {
      const seen = new Set<number>();
      const stack: [number, number][] = [[0, mainRow]];
      seen.add(nodeId(0, mainRow));
      while (stack.length) {
        const [i, j] = stack.pop()!;
        const nb: [number, number, SegKind][] = [];
        if (i < C) nb.push([i + 1, j, hSeg[i][j]]);
        if (i > 0) nb.push([i - 1, j, hSeg[i - 1][j]]);
        if (j < R) nb.push([i, j + 1, vSeg[i][j]]);
        if (j > 0) nb.push([i, j - 1, vSeg[i][j - 1]]);
        for (const [ni, nj, k] of nb) {
          if (!isRoad(k)) continue;
          const id = nodeId(ni, nj);
          if (!seen.has(id)) {
            seen.add(id);
            stack.push([ni, nj]);
          }
        }
      }
      // find a segment that is road-capable but not road, connecting seen to unseen node that has any road
      const candidates: (() => void)[] = [];
      const nodeHasRoad = (i: number, j: number) =>
        (i < C && isRoad(hSeg[i][j])) ||
        (i > 0 && isRoad(hSeg[i - 1][j])) ||
        (j < R && isRoad(vSeg[i][j])) ||
        (j > 0 && isRoad(vSeg[i][j - 1]));
      let disconnected = false;
      for (let j = 0; j <= R; j++)
        for (let i = 0; i <= C; i++) if (nodeHasRoad(i, j) && !seen.has(nodeId(i, j))) disconnected = true;
      if (!disconnected) return;
      for (let i = 0; i < C; i++)
        for (let j = 0; j <= R; j++)
          if (!isRoad(hSeg[i][j]) && seen.has(nodeId(i, j)) !== seen.has(nodeId(i + 1, j)))
            candidates.push(() => (hSeg[i][j] = 'street'));
      for (let i = 0; i <= C; i++)
        for (let j = 0; j < R; j++)
          if (!isRoad(vSeg[i][j]) && seen.has(nodeId(i, j)) !== seen.has(nodeId(i, j + 1)))
            candidates.push(() => (vSeg[i][j] = 'street'));
      if (!candidates.length) return;
      rng.pick(candidates)();
    }
  };
  ensureConnected();

  // every block needs at least one road side and residential blocks prefer two opposite sides
  for (let i = 0; i < C; i++)
    for (let j = 0; j < R; j++) {
      const sides = [hSeg[i][j], vSeg[i + 1][j], hSeg[i][j + 1], vSeg[i][j]];
      if (!sides.some(isRoad)) {
        if (j > 0) hSeg[i][j] = 'street';
        else hSeg[i][j + 1] = 'street';
      }
    }
  ensureConnected();

  // --- names ---------------------------------------------------------------
  const names = rng.shuffle([...STREET_NAMES]);
  let ni = 0;
  const nextName = () => `${names[ni++ % names.length]} ${rng.pick(STREET_TYPES)}`;
  const hNames: string[] = [];
  for (let j = 0; j <= R; j++) hNames.push(j === mainRow ? 'Main Street' : nextName());
  const vNames: string[] = [];
  for (let i = 0; i <= C; i++) vNames.push(nextName());

  // --- roads ---------------------------------------------------------------
  const roads: Road[] = [];
  const ground: Layout['ground'] = [];
  const deadEnds: { x: number; z: number }[] = [];
  const addRoad = (kind: Road['kind'], r: Rect, core: Rect, axis: 'x' | 'z', name: string, lit: boolean) => {
    roads.push({ id: roads.length, kind, rect: r, core, axis, name, lit });
  };
  const nodeDeg = (i: number, j: number) => {
    let d = 0;
    if (i < C && isRoad(hSeg[i][j])) d++;
    if (i > 0 && isRoad(hSeg[i - 1][j])) d++;
    if (j < R && isRoad(vSeg[i][j])) d++;
    if (j > 0 && isRoad(vSeg[i][j - 1])) d++;
    return d;
  };
  for (let j = 0; j <= R; j++) {
    for (let i = 0; i < C; i++) {
      const k = hSeg[i][j];
      const z = Z[j];
      if (isRoad(k)) {
        const cw = CARRIAGE_HALF[k as 'main' | 'street'];
        const hw = corridorHalf(k);
        let xa = X[i] - 3.5;
        let xb = X[i + 1] + 3.5;
        if (k === 'main') {
          if (i === 0) xa = 0;
          if (i === C - 1) xb = width;
        }
        addRoad(k, rect(xa, z - hw, xb, z + hw), rect(xa, z - cw, xb, z + cw), 'x', hNames[j], true);
        ground.push({ rect: rect(xa, z - cw, xb, z + cw), surface: 'asphalt', kind: k });
      } else if (k === 'path') {
        addRoad('path', rect(X[i], z - 2.5, X[i + 1], z + 2.5), rect(X[i], z - 1.2, X[i + 1], z + 1.2), 'x', 'footpath', false);
        ground.push({ rect: rect(X[i], z - 1.2, X[i + 1], z + 1.2), surface: 'gravel', kind: 'path' });
      }
    }
  }
  for (let i = 0; i <= C; i++) {
    for (let j = 0; j < R; j++) {
      const k = vSeg[i][j];
      const x = X[i];
      if (isRoad(k)) {
        const cw = CARRIAGE_HALF[k as 'main' | 'street'];
        const hw = corridorHalf(k);
        const za = Z[j] - 3.5;
        const zb = Z[j + 1] + 3.5;
        addRoad(k, rect(x - hw, za, x + hw, zb), rect(x - cw, za, x + cw, zb), 'z', vNames[i], true);
        ground.push({ rect: rect(x - cw, za, x + cw, zb), surface: 'asphalt', kind: k });
      } else if (k === 'path') {
        addRoad('path', rect(x - 2.5, Z[j], x + 2.5, Z[j + 1]), rect(x - 1.2, Z[j], x + 1.2, Z[j + 1]), 'z', 'footpath', false);
        ground.push({ rect: rect(x - 1.2, Z[j], x + 1.2, Z[j + 1]), surface: 'gravel', kind: 'path' });
      }
    }
  }
  for (let j = 0; j <= R; j++)
    for (let i = 0; i <= C; i++) if (nodeDeg(i, j) === 1 && !(j === mainRow && (i === 0 || i === C))) deadEnds.push({ x: X[i], z: Z[j] });

  // --- blocks ----------------------------------------------------------------
  const blocks: Block[] = [];
  const rows: RowPlan[] = [];
  const wildAreas: Rect[] = [];
  const blockGrid: number[][] = [];
  for (let i = 0; i < C; i++) {
    blockGrid.push([]);
    for (let j = 0; j < R; j++) {
      const n = hSeg[i][j];
      const s = hSeg[i][j + 1];
      const w = vSeg[i][j];
      const e = vSeg[i + 1][j];
      const r = rect(X[i] + corridorHalf(w), Z[j] + corridorHalf(n), X[i + 1] - corridorHalf(e), Z[j + 1] - corridorHalf(s));
      const touchesMain = n === 'main' || s === 'main';
      const b: Block = { id: blocks.length, rect: r, kind: touchesMain ? 'mixed' : 'residential', alley: null };
      blocks.push(b);
      blockGrid[i].push(b.id);
      // sidewalks
      const sides: [SegKind, Dir][] = [
        [n, 0],
        [e, 1],
        [s, 2],
        [w, 3],
      ];
      for (const [k, d] of sides) {
        if (!isRoad(k)) continue;
        const sw = SIDEWALK_W[k as 'main' | 'street'];
        const extW = isRoad(w) ? SIDEWALK_W[w as 'main' | 'street'] : 0;
        const extE = isRoad(e) ? SIDEWALK_W[e as 'main' | 'street'] : 0;
        const extN = isRoad(n) ? SIDEWALK_W[n as 'main' | 'street'] : 0;
        const extS = isRoad(s) ? SIDEWALK_W[s as 'main' | 'street'] : 0;
        let sr: Rect;
        if (d === 0) sr = rect(r.x0 - extW, r.z0 - sw, r.x1 + extE, r.z0);
        else if (d === 2) sr = rect(r.x0 - extW, r.z1, r.x1 + extE, r.z1 + sw);
        else if (d === 1) sr = rect(r.x1, r.z0 - extN, r.x1 + sw, r.z1 + extS);
        else sr = rect(r.x0 - sw, r.z0 - extN, r.x0, r.z1 + extS);
        ground.push({ rect: sr, surface: 'concrete', kind: 'sidewalk' });
      }
    }
  }

  // choose park block: prefer non-mixed blocks
  const nonMixed = blocks.filter((b) => b.kind === 'residential');
  let parkBlock = -1;
  if (nonMixed.length >= 2) {
    const pb = rng.pick(nonMixed);
    pb.kind = 'park';
    parkBlock = pb.id;
  }

  for (let i = 0; i < C; i++) {
    for (let j = 0; j < R; j++) {
      const b = blocks[blockGrid[i][j]];
      if (b.kind === 'park') continue;
      const n = hSeg[i][j];
      const s = hSeg[i][j + 1];
      const w = vSeg[i][j];
      const e = vSeg[i + 1][j];
      const r = b.rect;
      const nsOk = isRoad(n) && isRoad(s);
      const ewOk = isRoad(e) && isRoad(w);
      let orient: 'ns' | 'ew' | 'single';
      if (b.kind === 'mixed') orient = nsOk ? 'ns' : 'single';
      else if (nsOk && ewOk) orient = rng.chance(0.65) ? 'ns' : 'ew';
      else if (nsOk) orient = 'ns';
      else if (ewOk) orient = 'ew';
      else orient = 'single';
      const alleyHalf = 2;
      if (orient === 'ns') {
        const zm = snap((r.z0 + r.z1) / 2, 0.5);
        const alley = rect(r.x0 - (isRoad(w) ? 2 : 0), zm - alleyHalf, r.x1 + (isRoad(e) ? 2 : 0), zm + alleyHalf);
        b.alley = alley;
        addRoad('alley', alley, alley, 'x', 'alley', false);
        ground.push({ rect: alley, surface: 'gravel', kind: 'alley' });
        rows.push({ blockId: b.id, rect: rect(r.x0, r.z0, r.x1, zm - alleyHalf), front: 0, street: hNames[j], commercial: n === 'main' });
        rows.push({ blockId: b.id, rect: rect(r.x0, zm + alleyHalf, r.x1, r.z1), front: 2, street: hNames[j + 1], commercial: s === 'main' });
        if (!isRoad(w)) deadEnds.push({ x: r.x0 + 1, z: zm });
        if (!isRoad(e)) deadEnds.push({ x: r.x1 - 1, z: zm });
      } else if (orient === 'ew') {
        const xm = snap((r.x0 + r.x1) / 2, 0.5);
        const alley = rect(xm - alleyHalf, r.z0 - (isRoad(n) ? 2 : 0), xm + alleyHalf, r.z1 + (isRoad(s) ? 2 : 0));
        b.alley = alley;
        addRoad('alley', alley, alley, 'z', 'alley', false);
        ground.push({ rect: alley, surface: 'gravel', kind: 'alley' });
        rows.push({ blockId: b.id, rect: rect(r.x0, r.z0, xm - alleyHalf, r.z1), front: 3, street: vNames[i], commercial: false });
        rows.push({ blockId: b.id, rect: rect(xm + alleyHalf, r.z0, r.x1, r.z1), front: 1, street: vNames[i + 1], commercial: false });
      } else {
        // single row along best road side; remainder becomes a wild overgrown area
        const opts: [SegKind, Dir][] = (
          [
            [n, 0],
            [e, 1],
            [s, 2],
            [w, 3],
          ] as [SegKind, Dir][]
        ).filter(([k]) => isRoad(k));
        opts.sort((a, b2) => (b2[0] === 'main' ? 1 : 0) - (a[0] === 'main' ? 1 : 0));
        const [k, d] = opts[0];
        const isMain = k === 'main';
        let rr: Rect;
        let wild: Rect;
        const half = (d === 0 || d === 2 ? r.z1 - r.z0 : r.x1 - r.x0) * 0.5;
        const rowDepth = snap(Math.min(30, half + 2), 0.5);
        if (d === 0) {
          rr = rect(r.x0, r.z0, r.x1, r.z0 + rowDepth);
          wild = rect(r.x0, r.z0 + rowDepth, r.x1, r.z1);
        } else if (d === 2) {
          rr = rect(r.x0, r.z1 - rowDepth, r.x1, r.z1);
          wild = rect(r.x0, r.z0, r.x1, r.z1 - rowDepth);
        } else if (d === 1) {
          rr = rect(r.x1 - rowDepth, r.z0, r.x1, r.z1);
          wild = rect(r.x0, r.z0, r.x1 - rowDepth, r.z1);
        } else {
          rr = rect(r.x0, r.z0, r.x0 + rowDepth, r.z1);
          wild = rect(r.x0 + rowDepth, r.z0, r.x1, r.z1);
        }
        const street = d === 0 ? hNames[j] : d === 2 ? hNames[j + 1] : d === 1 ? vNames[i + 1] : vNames[i];
        rows.push({ blockId: b.id, rect: rr, front: d, street, commercial: isMain });
        wildAreas.push(wild);
      }
    }
  }

  return { width, depth, X, Z, hSeg, vSeg, mainRow, roads, blocks, rows, ground, hNames, vNames, parkBlock, wildAreas, deadEnds };
}

/** subdivide rows into lots */
export function subdivideRows(rng: Rng, layout: Layout): Lot[] {
  const lots: Lot[] = [];
  for (const row of layout.rows) {
    const along = row.front === 0 || row.front === 2 ? 'x' : 'z';
    const r = row.rect;
    const L = along === 'x' ? r.x1 - r.x0 : r.z1 - r.z0;
    const target = row.commercial ? rng.range(19, 23) : rng.range(15.5, 19);
    const n = Math.max(1, Math.round(L / target));
    const cuts: number[] = [0];
    for (let k = 1; k < n; k++) cuts.push(snap((L * k) / n + rng.range(-1.2, 1.2), 0.5));
    cuts.push(L);
    for (let k = 0; k < n; k++) {
      const a = cuts[k];
      const b = cuts[k + 1];
      const lr = along === 'x' ? rect(r.x0 + a, r.z0, r.x0 + b, r.z1) : rect(r.x0, r.z0 + a, r.x1, r.z0 + b);
      const kind: LotKind = row.commercial ? 'commercial' : 'house';
      lots.push({ id: lots.length, rect: lr, blockId: row.blockId, front: row.front, kind, buildingId: -1, street: row.street, number: 0, address: '' });
    }
  }
  return lots;
}

export function numberLots(lots: Lot[]) {
  const byStreet = new Map<string, Lot[]>();
  for (const l of lots) {
    if (!byStreet.has(l.street)) byStreet.set(l.street, []);
    byStreet.get(l.street)!.push(l);
  }
  for (const [street, ls] of byStreet) {
    const key = (l: Lot) => (l.front === 0 || l.front === 2 ? l.rect.x0 : l.rect.z0);
    const sideA = ls.filter((l) => l.front === 0 || l.front === 3).sort((a, b) => key(a) - key(b));
    const sideB = ls.filter((l) => l.front === 2 || l.front === 1).sort((a, b) => key(a) - key(b));
    sideA.forEach((l, i) => {
      l.number = 2 + i * 2;
      l.address = `${l.number} ${street}`;
    });
    sideB.forEach((l, i) => {
      l.number = 1 + i * 2;
      l.address = `${l.number} ${street}`;
    });
  }
}
