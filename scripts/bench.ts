// Headless performance benchmark: world generation, population and simulation cost.
// usage: node scripts/run.mjs scripts/bench.ts [hours]
import { generateWorld } from '../src/world/gen/generator';
import { Simulation } from '../src/sim/simulation';

const hours = Number(process.argv[2] ?? 24);
const rows: Record<string, string | number>[] = [];
for (const size of ['small', 'medium', 'large'] as const) {
  for (const seed of ['bench-a', 'bench-b']) {
    const t0 = performance.now();
    const world = generateWorld({ seed, size, density: 0.7, nights: 5 });
    const t1 = performance.now();
    const sim = new Simulation(world);
    sim.populate();
    const t2 = performance.now();
    let steps = 0;
    let worst = 0;
    const end = sim.time + hours * 3600;
    while (sim.time < end) {
      const s = performance.now();
      sim.step(1 / 20);
      const d = performance.now() - s;
      if (d > worst) worst = d;
      steps++;
      sim.events.length = 0;
    }
    const t3 = performance.now();
    rows.push({
      size,
      seed,
      buildings: world.buildings.length,
      rooms: world.rooms.length,
      furniture: world.furniture.length,
      npcs: sim.npcs.length,
      genMs: Math.round(t1 - t0),
      populateMs: Math.round(t2 - t1),
      msPerStep: +((t3 - t2) / steps).toFixed(3),
      worstStepMs: +worst.toFixed(1),
      realTimeFactor: Math.round(((hours * 3600) / ((t3 - t2) / 1000)) / 60), // vs normal day speed (60x)
    });
  }
}
console.table(rows);
