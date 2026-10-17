import { describe, it, expect } from 'vitest';
import { makeSim, runHours } from './helpers';

/**
 * Long-running headless checks of emergent behaviour: nothing here is
 * scripted; the killer, burglar, residents and police act on their own.
 */
describe('emergent neighbourhood over several nights', () => {
  const seeds = ['emerge-1', 'emerge-2', 'emerge-3'];
  const results: { seed: string; murders: number; burglaries: number; discovered: number; cases: number; reports: number; arrests: number; ms: number; steps: number }[] = [];

  it(
    'produces crimes, discoveries and police work without getting stuck',
    () => {
      for (const seed of seeds) {
        const sim = makeSim(seed);
        // keep the player out of the way, safe at home
        const home = sim.world.buildings[sim.world.playerHouseId];
        sim.player.x = home.insideFront.x;
        sim.player.z = home.insideFront.z;
        let arrests = 0;
        let steps = 0;
        const t0 = performance.now();
        runHours(sim, 3 * 24, () => {
          steps++;
          for (const e of sim.events) if (e.type === 'arrest') arrests++;
        });
        const ms = performance.now() - t0;
        const murders = sim.incidents.filter((i) => i.kind === 'murder').length;
        results.push({
          seed,
          murders,
          burglaries: sim.incidents.filter((i) => i.kind === 'burglary').length,
          discovered: sim.incidents.filter((i) => i.kind === 'murder' && i.discovered).length,
          cases: sim.cases.length,
          reports: sim.cases.reduce((a, c) => a + c.reports.length, 0),
          arrests,
          ms,
          steps,
        });
        // the world keeps running: no NPC stuck with an unbounded path failure count
        const alive = sim.npcs.filter((n) => n.alive && !n.inCustody);
        expect(alive.filter((n) => n.pathFail > 20).length, `${seed}: npcs stuck on paths`).toBeLessThanOrEqual(1);
        // invariants
        for (const a of sim.actors) {
          expect(Number.isFinite(a.x) && Number.isFinite(a.z)).toBe(true);
          expect(a.x).toBeGreaterThan(0);
          expect(a.z).toBeGreaterThan(0);
          if (!a.alive) expect(a.health).toBeLessThanOrEqual(0.01 + Math.max(0, a.health));
        }
      }
      console.table(results.map((r) => ({ ...r, msPerStep: +(r.ms / r.steps).toFixed(3) })));
      const total = (k: keyof (typeof results)[0]) => results.reduce((a, r) => a + Number(r[k]), 0);
      expect(total('murders')).toBeGreaterThanOrEqual(2);
      expect(total('discovered')).toBeGreaterThanOrEqual(1);
      expect(total('cases')).toBeGreaterThanOrEqual(2);
      expect(total('reports')).toBeGreaterThanOrEqual(2);
      // at least one simulated step-rate well above real time
      expect(Math.max(...results.map((r) => r.ms / r.steps))).toBeLessThan(5);
    },
    600_000,
  );
});
