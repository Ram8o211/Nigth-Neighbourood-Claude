import { generateWorld } from '../src/world/gen/generator';
import { Simulation } from '../src/sim/simulation';
import type { GenParams } from '../src/world/types';
import type { NpcState } from '../src/sim/types';

export function makeSim(seed: string, size: GenParams['size'] = 'medium', density = 0.7) {
  const world = generateWorld({ seed, size, density, nights: 5 });
  const sim = new Simulation(world);
  sim.populate();
  return sim;
}

/** run the simulation for a number of game hours at the normal step size */
export function runHours(sim: Simulation, hours: number, onStep?: () => boolean | void) {
  const end = sim.time + hours * 3600;
  while (sim.time < end) {
    sim.step(1 / 20);
    if (onStep && onStep()) break;
    sim.events.length = 0;
  }
}

/** run until the clock reaches the given hour of the day (0..24) */
export function runUntilHour(sim: Simulation, hour: number) {
  const day = Math.floor(sim.time / 86400);
  let target = day * 86400 + hour * 3600;
  if (target <= sim.time) target += 86400;
  runHours(sim, (target - sim.time) / 3600);
}

/** place an actor at a free outdoor spot near (x, z) */
export function freeSpot(sim: Simulation, x: number, z: number, maxR = 8) {
  for (let r = 0; r <= maxR; r += 0.5)
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      const i = sim.grid.cellAt(px, pz);
      if (i < 0 || sim.grid.flags[i] & 1) continue;
      if (sim.grid.buildingAt(px, pz) >= 0) continue;
      return { x: px, z: pz };
    }
  return null;
}

/** stop an npc's own agenda so tests can stage a scene */
export function hold(sim: Simulation, n: NpcState) {
  n.tasks = [];
  n.path = null;
  n.activity = null;
  n.sleeping = false;
  n.stance = 'stand';
  n.usingFurniture = -1;
  void sim;
}
