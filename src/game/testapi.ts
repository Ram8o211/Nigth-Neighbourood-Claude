import type { Game } from './game';
import { F_BLOCK } from '../world/grid';
import { updateLocation } from '../sim/movement';
import { kill } from '../sim/combat';

/**
 * Small automation surface used by the browser smoke tests and the screenshot
 * script (window.__nnTest). It moves the player/camera and can stage a scene
 * for a screenshot; gameplay in the smoke test itself goes through real key
 * presses and UI clicks.
 */
export function installTestApi(game: Game) {
  const api = {
    /** is the 0.5 m nav cell at (x, z) free of static obstacles? */
    free(x: number, z: number) {
      const sim = game.sim;
      if (!sim) return false;
      const g = sim.grid;
      const r = 0.3;
      for (const [ox, oz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
        const i = g.cellAt(x + ox, z + oz);
        if (i < 0 || g.flags[i] & F_BLOCK) return false;
      }
      return !sim.colliders.segmentBlocked(x - r, z, x + r, z, 1) && !sim.colliders.segmentBlocked(x, z - r, x, z + r, 1);
    },
    /** a free spot near (x, z) at distance r..rMax, optionally inside building b */
    spotNear(x: number, z: number, r = 1.2, rMax = 2, building?: number) {
      const sim = game.sim!;
      for (let d = r; d <= rMax; d += 0.15)
        for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
          const px = x + Math.cos(a) * d;
          const pz = z + Math.sin(a) * d;
          if (!api.free(px, pz)) continue;
          if (building !== undefined && sim.grid.buildingAt(px, pz) !== building) continue;
          if (sim.colliders.segmentBlocked(px, pz, x, z, 1.0) && building === undefined) continue;
          return { x: px, z: pz };
        }
      return null;
    },
    /** move the player to (x, z) and look at (tx, ty, tz) */
    stand(x: number, z: number, tx: number, ty: number, tz: number) {
      const sim = game.sim!;
      const p = sim.player;
      p.x = x;
      p.z = z;
      p.y = sim.grid.heightAt(x, z);
      updateLocation(sim, p, 1);
      p.yaw = Math.atan2(tx - x, -(tz - z));
      p.pitch = Math.atan2(ty - (p.y + 1.62), Math.max(0.3, Math.hypot(tx - x, tz - z)));
      game.player?.findTarget();
    },
    /** staging for screenshots: a violent death with blood */
    kill(id: number, by: number) {
      const sim = game.sim!;
      const t = sim.actors[id];
      if (!t || !t.alive) return;
      sim.splatterBlood(t.x, t.z, t.y + 1.1, t.yaw + Math.PI, 1);
      kill(sim, t, by, 'stabbed');
    },
    /** staging: damage a window (1 cracks it, 99 shatters it) */
    hitWindow(id: number, dmg: number) {
      game.sim!.damageWindow(id, dmg, game.sim!.killerId);
    },
  };
  (window as unknown as { __nnTest: typeof api }).__nnTest = api;
  return api;
}
