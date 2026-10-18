import { describe, it, expect } from 'vitest';
import { makeSim } from './helpers';
import { PlayerController, type PlayerHooks } from '../src/game/player';
import type { Input } from '../src/game/input';

function controller() {
  const sim = makeSim('inventory');
  const noop = () => {};
  const hooks: PlayerHooks = { talk: noop, container: noop, sleep: noop, phone: noop, trade: noop, examineBody: noop, pickup: noop, message: noop, wash: noop };
  const pl = new PlayerController(sim, {} as Input, hooks);
  sim.player.inventory.length = 0;
  sim.player.equipped = -1;
  sim.player.weapon = null;
  return { sim, pl, p: sim.player };
}

describe('player inventory', () => {
  it('keeps the equipped weapon when an earlier slot is removed', () => {
    const { pl, p } = controller();
    pl.give('sandwich');
    pl.give('kitchen_knife');
    pl.equip(1);
    expect(p.weapon).toBe('kitchen_knife');
    pl.removeStack(0); // e.g. the sandwich is stored in a container
    expect(p.inventory[p.equipped]?.item).toBe('kitchen_knife');
    pl.drop(p.equipped);
    expect(p.inventory).toHaveLength(0);
    expect(p.weapon).toBeNull();
    expect(p.equipped).toBe(-1);
  });

  it('switches the flashlight off when the last one leaves the inventory', () => {
    const { pl, p } = controller();
    pl.give('flashlight');
    p.battery = 1;
    pl.toggleFlashlight();
    expect(p.flashlight).toBe(true);
    pl.drop(0);
    expect(p.flashlight).toBe(false);

    pl.give('flashlight');
    pl.toggleFlashlight();
    expect(pl.take('flashlight')).toBe(true); // sold
    expect(p.flashlight).toBe(false);
  });
});
