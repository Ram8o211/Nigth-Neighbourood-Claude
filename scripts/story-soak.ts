// Headless run of the full game director with a passive player who stays home
// and sleeps at night. usage: node scripts/run.mjs scripts/story-soak.ts <seed> [nights]
import { generateWorld } from '../src/world/gen/generator';
import { Simulation } from '../src/sim/simulation';
import { Journal } from '../src/game/journal';
import { Story } from '../src/game/story';
import { formatClock } from '../src/core/math';

const seed = process.argv[2] ?? 'story';
const nights = Number(process.argv[3] ?? 5);
const world = generateWorld({ seed, size: 'medium', density: 0.7, nights });
const sim = new Simulation(world);
sim.populate();
const journal = new Journal(sim);
const story = new Story(sim, journal, nights);
story.begin(() => {});
const home = world.buildings[world.playerHouseId];
const p = sim.player;
p.x = home.insideFront.x;
p.z = home.insideFront.z;
for (const d of home.doorIds) if (world.doors[d].exterior) world.doors[d].locked = true;
const log = (s: string) => console.log(`[d${sim.day()} ${formatClock(sim.time)}] ${s}`);
let lastPlan = -1;
while (!story.ending && sim.day() < nights + 1) {
  sim.step(1 / 20);
  story.update(1 / 20);
  const n = sim.nightIndex();
  if (n !== lastPlan && n >= 0) {
    lastPlan = n;
    log(`night ${n + 1}: plan ${JSON.stringify(story.plan(n))} threat ${story.playerThreat.toFixed(2)}`);
  }
  for (const e of sim.events) {
    if (['death', 'body_found', 'arrest', 'missing'].includes(e.type)) log(`${e.type} ${e.a !== undefined ? sim.actorName(e.a) : ''}${e.b !== undefined && e.b >= 0 ? ' by ' + sim.actorName(e.b) : ''}`);
    if (e.type === 'sound' && ['knock', 'handle', 'glass', 'door_force'].includes(e.s ?? '') && Math.hypot((e.x ?? 0) - p.x, (e.z ?? 0) - p.z) < 14) log(`near the player: ${e.s}`);
  }
  sim.events.length = 0;
}
log(`ending: ${story.ending ? story.ending.kind + ' — ' + story.ending.title : 'none'}; player alive ${p.alive}`);
