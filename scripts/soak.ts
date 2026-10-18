// Headless soak test: runs the living neighbourhood and prints a timeline.
// usage: node scripts/run.mjs scripts/soak.ts <seed> <hours>
import { generateWorld } from '../src/world/gen/generator';
import { Simulation } from '../src/sim/simulation';
import { formatClock } from '../src/core/math';
import { fullName } from '../src/sim/population';

const seed = process.argv[2] ?? 'hollow';
const hours = Number(process.argv[3] ?? 30);
const world = generateWorld({ seed, size: 'medium', density: 0.7, nights: 5 });
const sim = new Simulation(world);
sim.populate();
const home = world.buildings[world.playerHouseId];
sim.player.x = home.insideFront.x;
sim.player.z = home.insideFront.z;
const k = sim.npc(sim.killerId)!;
console.log(`seed=${seed} npcs=${sim.npcs.length} killer=${fullName(k)} (${k.job}) burglar=${sim.burglarId >= 0 ? fullName(sim.npc(sim.burglarId)!) : '-'} lair=${world.buildings[sim.lair.building].kind}`);
const failLog: Record<string, number> = {};
sim.onPathFail = (n, x, z) => {
  const key = `${n.activity?.kind}:${n.tasks[0]?.kind}:${sim.grid.buildingAt(n.x, n.z) >= 0 ? world.buildings[sim.grid.buildingAt(n.x, n.z)].kind : 'out'}->${sim.grid.buildingAt(x, z) >= 0 ? world.buildings[sim.grid.buildingAt(x, z)].kind : 'out'}`;
  failLog[key] = (failLog[key] ?? 0) + 1;
};
let lastHs = '';
const REACT = new Set(['flee', 'fight', 'report', 'investigate', 'lockdown', 'hide', 'confront']);
sim.onActivity = (n, kind) => {
  if (!REACT.has(kind) && kind !== 'kfight') return;
  const m = [...n.memories].sort((a, b) => b.time - a.time)[0];
  console.log(`      ${formatClock(sim.time)} ${fullName(n)} -> ${kind} (alarm ${n.alarm.toFixed(2)} threat=${n.threat >= 0 ? sim.actorName(n.threat) : '-'}) mem=${m ? `${m.source}:${m.topic}:${m.actor >= 0 ? sim.actorName(m.actor) : '?'}` : ''}`);
};
const t0 = performance.now();
const end = sim.time + hours * 3600;
let lastLog = 0;
let steps = 0;
const actCount: Record<string, number> = {};
const interesting = new Set(['incident', 'death', 'body_found', 'arrest', 'jailed', 'police', 'killer', 'missing', 'glass', 'released', 'door_break']);
while (sim.time < end) {
  sim.step(1 / 20);
  steps++;
  for (const e of sim.events) {
    if (interesting.has(e.type)) console.log(`[${formatClock(sim.time)} d${sim.day()}] ${e.type} ${e.s ?? ''} a=${e.a ?? ''} ${e.a !== undefined && e.a > 0 ? sim.actorName(e.a) : ''} ${e.text ?? ''}`);
  }
  sim.events.length = 0;
  const hs = `${k.activity?.kind}/${k.ctl.hs ?? ''}`;
  if (hs !== lastHs) {
    lastHs = hs;
    if (k.activity?.kind === 'hunt' || k.activity?.kind?.startsWith('k')) console.log(`    [${formatClock(sim.time)}] killer -> ${hs} tgt=${k.ctl.tgt ?? ''} pos=${k.x.toFixed(0)},${k.z.toFixed(0)}`);
  }
  if (sim.time - lastLog > 3 * 3600) {
    lastLog = sim.time;
    for (const n of sim.npcs) actCount[n.activity?.kind ?? 'none'] = (actCount[n.activity?.kind ?? 'none'] ?? 0) + 1;
    const acts: Record<string, number> = {};
    for (const n of sim.npcs) acts[n.activity?.kind ?? 'none'] = (acts[n.activity?.kind ?? 'none'] ?? 0) + 1;
    const lit = world.lights.filter((l) => l.on).length;
    console.log(`  ${formatClock(sim.time)} d${sim.day()} acts=${JSON.stringify(acts)} lightsOn=${lit} killer=${k.activity?.kind}/${k.ctl.hs ?? ''} alive=${sim.npcs.filter((n) => n.alive).length}`);
  }
}
const ms = performance.now() - t0;
console.log(`simulated ${hours}h in ${steps} steps, ${(ms / 1000).toFixed(1)}s real (${(ms / steps).toFixed(3)} ms/step)`);
console.log('incidents', sim.incidents.map((i) => `${i.kind}:${i.perp}->${i.victim} disc=${i.discovered}`).join(' | '));
console.log('cases', sim.cases.map((c) => `${c.kind}/${c.status}/suspect=${c.suspect}/reports=${c.reports.length}`).join(' | '));
console.log('clues', sim.clues.map((c) => `${c.kind}:${c.attr}=${c.value}`).join(' | '));
const stuck = sim.npcs.filter((n) => n.alive && n.pathFail > 2).map((n) => fullName(n) + ':' + n.activity?.kind);
console.log('pathFail>2:', stuck.join(', '));
console.log('path failures:', JSON.stringify(failLog));
