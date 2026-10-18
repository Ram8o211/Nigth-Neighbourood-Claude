import type { LightSource } from '../world/types';

/** average brightness factor of a (possibly flickering) light for gameplay purposes */
export function flickerLevel(l: LightSource): number {
  return l.flicker ? 1 - l.flicker * 0.35 : 1;
}
