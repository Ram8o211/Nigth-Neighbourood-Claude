import type { Rect } from '../../core/math';
import type { Dir } from '../types';

/**
 * A local frame attached to a lot or building footprint. Local x runs along the
 * street frontage, local z runs from the street (z = 0) into the lot. The
 * mapping is always a proper rotation so floor plans are never mirrored.
 */
export interface Frame {
  front: Dir;
  /** local width along frontage and depth into lot */
  w: number;
  d: number;
  toWorld(lx: number, lz: number): { x: number; z: number };
  rect(lx0: number, lz0: number, lx1: number, lz1: number): Rect;
  /** maps a local axis ('x' along frontage, 'z' into lot) to a world axis */
  axis(local: 'x' | 'z'): 'x' | 'z';
  /** maps a local direction (0 = toward street) to world Dir */
  dir(local: Dir): Dir;
}

export function makeFrame(r: Rect, front: Dir): Frame {
  const W = r.x1 - r.x0;
  const D = r.z1 - r.z0;
  let toWorld: (lx: number, lz: number) => { x: number; z: number };
  let w: number;
  let d: number;
  switch (front) {
    case 0:
      toWorld = (lx, lz) => ({ x: r.x0 + lx, z: r.z0 + lz });
      w = W;
      d = D;
      break;
    case 2:
      toWorld = (lx, lz) => ({ x: r.x1 - lx, z: r.z1 - lz });
      w = W;
      d = D;
      break;
    case 1:
      toWorld = (lx, lz) => ({ x: r.x1 - lz, z: r.z0 + lx });
      w = D;
      d = W;
      break;
    default:
      toWorld = (lx, lz) => ({ x: r.x0 + lz, z: r.z1 - lx });
      w = D;
      d = W;
      break;
  }
  const swap = front === 1 || front === 3;
  return {
    front,
    w,
    d,
    toWorld,
    rect(lx0, lz0, lx1, lz1) {
      const a = toWorld(lx0, lz0);
      const b = toWorld(lx1, lz1);
      return { x0: Math.min(a.x, b.x), z0: Math.min(a.z, b.z), x1: Math.max(a.x, b.x), z1: Math.max(a.z, b.z) };
    },
    axis(local) {
      if (!swap) return local;
      return local === 'x' ? 'z' : 'x';
    },
    dir(local) {
      // local 0 = toward street (local -z). Rotate by the frame's front direction.
      return ((local + front) % 4) as Dir;
    },
  };
}
