import { clamp, wrapAngle, yawTo } from '../core/math';
import type { Simulation } from '../sim/simulation';
import type { NpcState, PlayerState } from '../sim/types';
import type { Furniture, ItemStack } from '../world/types';
import { ITEMS, itemName } from '../sim/items';
import { moveActor, updateLocation } from '../sim/movement';
import { startAttack, kill } from '../sim/combat';
import { hearSound } from '../sim/perception';
import type { Input } from './input';
import { CFG } from '../sim/config';
import { fullName } from '../sim/population';

export type TargetKind = 'door' | 'window' | 'furniture' | 'npc' | 'body' | 'item' | 'none';

export interface Target {
  kind: TargetKind;
  id: number;
  prompt: string;
  alt: string;
  dist: number;
}

export interface PlayerHooks {
  talk(npc: NpcState): void;
  container(f: Furniture): void;
  sleep(f: Furniture): void;
  phone(): void;
  trade(npc: NpcState, f: Furniture): void;
  examineBody(id: number): void;
  pickup(itemId: number): void;
  message(text: string, kind?: 'info' | 'warn' | 'good'): void;
  wash(): void;
}

const HOLD_TIME: Record<string, number> = { lockpick: 4.5, board: 2.8, lock: 0.5, drag: 0.6 };

/** first person controller: movement, interaction, combat and needs */
export class PlayerController {
  target: Target = { kind: 'none', id: -1, prompt: '', alt: '', dist: 0 };
  holdAction = '';
  holdT = 0;
  holdNeeded = 0;
  bob = 0;
  stepAcc = 0;
  dodgeT = 0;
  dodgeDir = { x: 0, z: 0 };
  climbT = -1;
  climbFrom = { x: 0, z: 0 };
  climbTo = { x: 0, z: 0 };
  climbWindow = -1;
  landShake = 0;
  hurtShake = 0;
  lastHealth = 100;
  damageFlash = 0;
  breath = 0;
  /** seconds of sustained sprint (for breathing audio) */
  sprintT = 0;
  observeT = 0;
  hidingFurniture = -1;

  constructor(
    private sim: Simulation,
    private input: Input,
    private hooks: PlayerHooks,
  ) {}

  get p(): PlayerState {
    return this.sim.player;
  }

  // ------------------------------------------------------------------ inventory helpers

  count(item: string) {
    return this.p.inventory.filter((s) => s.item === item).reduce((a, s) => a + s.n, 0);
  }

  give(item: string, n = 1, tag?: number): boolean {
    const inv = this.p.inventory;
    if (item === 'cash') {
      this.p.money += n;
      return true;
    }
    const def = ITEMS[item];
    const stack = def?.stack ?? 1;
    const existing = inv.find((s) => s.item === item && s.tag === tag && s.n < stack);
    if (existing) {
      existing.n += n;
      return true;
    }
    if (inv.length >= 14) return false;
    inv.push({ item, n, tag });
    return true;
  }

  take(item: string, n = 1): boolean {
    const inv = this.p.inventory;
    const s = inv.find((x) => x.item === item);
    if (!s || s.n < n) return false;
    s.n -= n;
    if (s.n <= 0) {
      const idx = inv.indexOf(s);
      inv.splice(idx, 1);
      if (this.p.equipped === idx) this.equip(-1);
      else if (this.p.equipped > idx) this.p.equipped--;
    }
    return true;
  }

  equip(idx: number) {
    const p = this.p;
    if (idx < 0 || idx >= p.inventory.length) {
      p.equipped = -1;
      p.weapon = null;
      return;
    }
    const s = p.inventory[idx];
    const def = ITEMS[s.item];
    if (def?.weapon) {
      p.equipped = idx;
      p.weapon = s.item;
    } else if (s.item === 'flashlight') {
      this.toggleFlashlight();
    }
  }

  toggleFlashlight() {
    const p = this.p;
    if (!this.count('flashlight')) {
      this.hooks.message('You do not have a flashlight.', 'warn');
      return;
    }
    if (!p.flashlight && p.battery <= 0) {
      if (this.take('battery')) {
        p.battery = 100;
        this.hooks.message('You put in a fresh battery.');
      } else {
        this.hooks.message('The flashlight battery is dead.', 'warn');
        return;
      }
    }
    p.flashlight = !p.flashlight;
    this.sim.emit({ type: 'ui', s: 'click' });
  }

  use(idx: number) {
    const p = this.p;
    const s = p.inventory[idx];
    if (!s) return;
    const def = ITEMS[s.item];
    if (!def) return;
    if (def.cat === 'food') {
      p.hunger = clamp(p.hunger - (def.hunger ?? 0), 0, 100);
      if (def.energy) p.energy = clamp(p.energy + def.energy, 0, 100);
      if (def.stamina) p.stamina = Math.min(100, p.stamina + def.stamina);
      this.take(s.item);
      this.sim.emit({ type: 'ui', s: 'eat' });
      this.hooks.message(`You eat the ${def.name.toLowerCase()}.`);
    } else if (def.cat === 'medical') {
      if (def.stopsBleeding) p.bleeding = 0;
      p.healPool += def.heal ?? 0;
      this.take(s.item);
      this.sim.emit({ type: 'ui', s: 'bandage' });
      this.hooks.message(def.stopsBleeding ? 'You bandage your wounds.' : 'You swallow the painkillers.', 'good');
    } else if (def.weapon) this.equip(idx);
    else if (s.item === 'flashlight') this.toggleFlashlight();
    else if (s.item === 'battery') {
      if (!this.count('flashlight')) return;
      p.battery = 100;
      this.take('battery');
      this.hooks.message('Flashlight battery replaced.');
    }
  }

  drop(idx: number) {
    const p = this.p;
    const s = p.inventory[idx];
    if (!s) return;
    const fx = Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    this.sim.dropItem(s.item, p.x + fx * 0.7, p.z + fz * 0.7, s.n, s.tag ?? -1, itemName(s.item));
    p.inventory.splice(idx, 1);
    if (p.equipped === idx) this.equip(-1);
    else if (p.equipped > idx) p.equipped--;
  }

  // ------------------------------------------------------------------ update

  update(dt: number, inputEnabled: boolean) {
    const p = this.p;
    const sim = this.sim;
    if (!p.alive) return;
    const inp = this.input;
    // health feedback
    if (p.health < this.lastHealth - 0.5) {
      this.damageFlash = Math.min(1, this.damageFlash + (this.lastHealth - p.health) / 25);
      this.hurtShake = 0.25;
    }
    this.lastHealth = p.health;
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.2);
    this.hurtShake = Math.max(0, this.hurtShake - dt);
    // needs
    const gdt = dt * sim.timeScale();
    const hrs = gdt / 3600;
    p.hunger = clamp(p.hunger + hrs * 3.4, 0, 100);
    p.energy = clamp(p.energy - hrs * (p.sprinting ? 7 : 4.5), 0, 100);
    p.fear = Math.max(0, p.fear - dt * 4);
    if (p.hunger >= 100) p.health -= hrs * 6;
    if (p.healPool > 0) {
      const h = Math.min(p.healPool, dt * 6);
      p.healPool -= h;
      p.health = Math.min(p.maxHealth, p.health + h);
    }
    if (p.health <= 0) {
      // starvation or wounds: the same death as anybody else (body, sound, ending)
      kill(sim, p, p.lastAttacker, p.hunger >= 100 ? 'starvation' : 'wounds');
      return;
    }
    if (p.hunger < 75 && p.bleeding <= 0 && p.health < p.maxHealth) p.health = Math.min(p.maxHealth, p.health + hrs * 5);
    // flashlight battery
    if (p.flashlight) {
      p.battery = Math.max(0, p.battery - dt * 0.22);
      if (p.battery <= 0) {
        p.flashlight = false;
        this.hooks.message('The flashlight flickers and dies.', 'warn');
      }
    }
    if (p.stance === 'downed') {
      p.speed = 0;
      return;
    }
    // climbing through a window
    if (this.climbT >= 0) {
      this.climbT += dt / 0.9;
      const t = Math.min(1, this.climbT);
      p.x = this.climbFrom.x + (this.climbTo.x - this.climbFrom.x) * t;
      p.z = this.climbFrom.z + (this.climbTo.z - this.climbFrom.z) * t;
      updateLocation(sim, p, dt);
      if (t >= 1) this.climbT = -1;
      return;
    }
    // hidden in furniture
    if (p.stance === 'hidden') {
      if (inputEnabled) this.look(dt);
      if (inputEnabled && inp.hit('interact')) this.leaveHiding();
      p.speed = 0;
      return;
    }
    if (!inputEnabled) {
      p.speed = 0;
      p.sprinting = false;
      return;
    }
    this.look(dt);
    // stance
    if (inp.hit('crouch')) p.crouching = !p.crouching;
    p.stance = p.crouching ? 'crouch' : 'stand';
    // movement
    let mx = 0;
    let mz = 0;
    if (inp.held('forward')) mz -= 1;
    if (inp.held('back')) mz += 1;
    if (inp.held('left')) mx -= 1;
    if (inp.held('right')) mx += 1;
    const ml = Math.hypot(mx, mz);
    const wantSprint = inp.held('sprint') && ml > 0 && !p.crouching && mz <= 0 && p.stamina > 1 && p.carrying < 0;
    p.sprinting = wantSprint;
    let speed = p.crouching ? CFG.playerCrouch : wantSprint ? CFG.playerSprint : CFG.playerWalk;
    if (p.carrying >= 0) speed = 1.1;
    if (p.blocking) speed *= 0.5;
    if (p.energy < 10) speed *= 0.8;
    if (p.health < 30) speed *= 0.85;
    if (wantSprint) {
      p.stamina = Math.max(0, p.stamina - dt * 16);
      this.sprintT += dt;
    } else {
      this.sprintT = Math.max(0, this.sprintT - dt * 2);
      const regen = (p.energy < 20 ? 7 : 16) * (p.hunger > 85 ? 0.5 : 1);
      p.stamina = Math.min(100, p.stamina + dt * regen * (ml > 0 ? 0.6 : 1));
    }
    // dodge
    if (this.dodgeT > 0) {
      this.dodgeT -= dt;
      moveActor(sim, p, this.dodgeDir.x * dt * 7, this.dodgeDir.z * dt * 7);
    } else if (inp.hit('dodge') && p.stamina > 20) {
      p.stamina -= 20;
      this.dodgeT = 0.22;
      const dx = ml > 0 ? mx / ml : 0;
      const dz = ml > 0 ? mz / ml : 1;
      const s = Math.sin(p.yaw);
      const c = Math.cos(p.yaw);
      this.dodgeDir = { x: dx * c - dz * s, z: dx * s + dz * c };
      sim.emit({ type: 'player', s: 'dodge' });
    }
    const ox = p.x;
    const oz = p.z;
    if (ml > 0 && this.dodgeT <= 0) {
      const lx = mx / ml;
      const lz = mz / ml;
      const s = Math.sin(p.yaw);
      const c = Math.cos(p.yaw);
      // local (x right, z back) to world
      const wx = lx * c - lz * s;
      const wz = lx * s + lz * c;
      moveActor(sim, p, wx * speed * dt, wz * speed * dt);
    }
    const moved = Math.hypot(p.x - ox, p.z - oz);
    p.speed = moved / Math.max(dt, 1e-4);
    updateLocation(sim, p, dt);
    // head bob and footsteps
    if (p.speed > 0.3) {
      this.bob += dt * p.speed * 2.4;
      this.stepAcc += moved;
      const stride = p.sprinting ? 0.95 : p.crouching ? 0.6 : 0.75;
      if (this.stepAcc > stride) {
        this.stepAcc = 0;
        const loud = p.crouching ? 2 : p.sprinting ? 13 : 6;
        const surface = sim.grid.surfaceAt(p.x, p.z);
        sim.emit({ type: 'step', a: 0, x: p.x, y: p.y, z: p.z, v: loud, s: surface });
        p.noise = loud;
        if (p.building >= 0) hearSound(sim, 'footstep', p.x, p.z, loud, 0);
        if (p.bloody > 0.5 && Math.random() < 0.5) sim.addDecal('footprint', p.x, p.y + 0.013, p.z, 0, 1, 0, 0.28, p.yaw);
      }
    } else p.noise = Math.max(0, p.noise - dt * 10);
    // combat
    p.blocking = inp.rmb && p.stamina > 3 && p.carrying < 0;
    if (inp.lmbPressed && inp.locked && !p.blocking && p.carrying < 0) {
      if (startAttack(sim, p)) this.hurtShake = Math.max(this.hurtShake, 0.05);
    }
    // hotbar
    for (let i = 0; i < 6; i++) if (inp.hit(`slot${i + 1}` as 'slot1')) this.selectSlot(i);
    if (inp.hit('holster')) this.equip(-1);
    if (inp.wheel !== 0) this.cycleWeapon(inp.wheel);
    if (inp.hit('flashlight')) this.toggleFlashlight();
    // interaction
    this.findTarget();
    this.handleInteract(dt);
    // periodic observation of residents for the journal
    this.observeT -= dt;
  }

  look(dt: number) {
    const p = this.p;
    const inp = this.input;
    const sens = 0.0022 * inp.sensitivity;
    p.yaw = wrapAngle(p.yaw + inp.mouseDX * sens);
    p.pitch = clamp(p.pitch - inp.mouseDY * sens * (inp.invertY ? -1 : 1), -1.45, 1.45);
    // keyboard look fallback (arrow keys) for players without a mouse
    const turn = (inp.raw('ArrowRight') ? 1 : 0) - (inp.raw('ArrowLeft') ? 1 : 0);
    const tilt = (inp.raw('ArrowUp') ? 1 : 0) - (inp.raw('ArrowDown') ? 1 : 0);
    if (turn) p.yaw = wrapAngle(p.yaw + turn * dt * 2.2 * inp.sensitivity);
    if (tilt) p.pitch = clamp(p.pitch + tilt * dt * 1.6 * inp.sensitivity, -1.45, 1.45);
  }

  weaponSlots() {
    return this.p.inventory.map((s, i) => ({ s, i })).filter(({ s }) => ITEMS[s.item]?.weapon || s.item === 'flashlight');
  }

  selectSlot(n: number) {
    const slots = this.weaponSlots();
    const pick = slots[n];
    if (!pick) return;
    if (pick.s.item === 'flashlight') this.toggleFlashlight();
    else if (this.p.equipped === pick.i) this.equip(-1);
    else this.equip(pick.i);
    this.sim.emit({ type: 'ui', s: 'equip' });
  }

  cycleWeapon(dir: number) {
    const ws = this.weaponSlots().filter(({ s }) => ITEMS[s.item]?.weapon);
    if (!ws.length) return;
    const cur = ws.findIndex(({ i }) => i === this.p.equipped);
    const next = cur < 0 ? (dir > 0 ? 0 : ws.length - 1) : cur + dir;
    if (next < 0 || next >= ws.length) this.equip(-1);
    else this.equip(ws[next].i);
  }

  // ------------------------------------------------------------------ targeting

  findTarget() {
    const p = this.p;
    const sim = this.sim;
    const fx = Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    let best: Target = { kind: 'none', id: -1, prompt: '', alt: '', dist: 0 };
    let bestScore = Infinity;
    const eyeY = p.y + (p.crouching ? 1.0 : 1.62);
    const consider = (kind: TargetKind, id: number, x: number, z: number, y: number, maxD: number, prompt: string, alt = '', ignoreLos = false) => {
      const dx = x - p.x;
      const dz = z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > maxD) return;
      // horizontal angle and vertical aim
      const ang = d > 0.3 ? Math.abs(wrapAngle(Math.atan2(dx, -dz) - p.yaw)) : 0;
      const vang = Math.abs(Math.atan2(y - eyeY, Math.max(0.3, d)) - p.pitch);
      if (ang > 0.55 || vang > 0.7) return;
      if (!ignoreLos && d > 0.6 && sim.colliders.segmentBlocked(p.x, p.z, p.x + dx * 0.85, p.z + dz * 0.85, 1.0)) return;
      // small things lying on furniture win over the furniture itself
      const score = ang * 2 + vang + d * 0.25 - (kind === 'item' ? 0.35 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = { kind, id, prompt, alt, dist: d };
      }
    };
    for (const a of sim.actors) {
      if (a === p || Math.abs(a.x - p.x) > 3 || Math.abs(a.z - p.z) > 3) continue;
      if (a.inCustody && a.alive) {
        consider('npc', a.id, a.x, a.z, a.y + 1.4, 2.6, `[E] Talk to ${sim.actorName(a.id)} (in custody)`, '', true);
        continue;
      }
      if (!a.alive) {
        if (a.bodyRemoved) continue;
        consider('body', a.id, a.x, a.z, a.y + 0.2, 2.2, `[E] Examine the body of ${sim.actorName(a.id)}`, p.carrying === a.id ? '[E] Let go' : '[Hold E] Drag body');
      } else if (a.kind === 'npc' && a.stance !== 'hidden') {
        const n = a as NpcState;
        consider('npc', a.id, a.x, a.z, a.y + 1.5, 2.4, `[E] Talk to ${p.knownTo.includes(n.id) ? fullName(n) : 'stranger'}`);
      }
    }
    for (const it of sim.items) {
      if (it.taken || Math.abs(it.x - p.x) > 2.5 || Math.abs(it.z - p.z) > 2.5) continue;
      consider('item', it.id, it.x, it.z, it.y, 2.0, `[E] Pick up ${it.label || itemName(it.item)}`);
    }
    for (const d of sim.world.doors) {
      const x = d.axis === 'x' ? d.t : d.c;
      const z = d.axis === 'x' ? d.c : d.t;
      if (Math.abs(x - p.x) > 2.6 || Math.abs(z - p.z) > 2.6) continue;
      const fy = sim.world.buildings[d.buildingId].floorY;
      const key = sim.playerHasKey(d.keyId);
      const inside = p.building === d.buildingId;
      let prompt: string;
      let alt = '';
      if (d.broken) prompt = 'The door hangs off its hinges';
      else if (d.open > 0.5) prompt = '[E] Close door';
      else if (d.locked) {
        prompt = key || (inside && d.exterior) ? '[E] Unlock and open' : this.count('lockpick') ? '[Hold E] Pick the lock' : d.bars ? 'Cell door (locked)' : '[E] Knock';
      } else {
        prompt = '[E] Open door';
        if ((key || inside) && !d.bars) alt = '[Hold E] Lock';
      }
      consider('door', d.id, x, z, fy + 1.2, 2.2, prompt, alt, true);
    }
    for (const w of sim.world.windows) {
      const x = w.axis === 'x' ? w.t : w.c;
      const z = w.axis === 'x' ? w.c : w.t;
      if (Math.abs(x - p.x) > 2.5 || Math.abs(z - p.z) > 2.5) continue;
      const fy = sim.world.buildings[w.buildingId].floorY;
      const inside = p.building === w.buildingId;
      let prompt = '';
      if (w.boarded) prompt = inside ? 'Boarded up' : 'Boarded up from inside';
      else if (w.damage === 2) prompt = w.width >= 1 && w.sill < 1.3 ? '[E] Climb through the window' : 'Broken window';
      else if (inside && this.count('planks')) prompt = '[Hold E] Board up window (planks)';
      else prompt = w.damage === 1 ? 'Cracked window' : '';
      if (prompt) consider('window', w.id, x, z, fy + (w.sill + w.top) / 2, 2.0, prompt, '', true);
    }
    for (const f of sim.world.furniture) {
      if (f.kind === 'none' || Math.abs(f.x - p.x) > 3 || Math.abs(f.z - p.z) > 3) continue;
      const prompt = this.furniturePrompt(f);
      if (!prompt) continue;
      const fy = sim.world.buildings[f.buildingId]?.floorY ?? 0;
      // aim at the nearest point of the furniture box
      const cx = clamp(p.x, f.x - f.w / 2, f.x + f.w / 2);
      const cz = clamp(p.z, f.z - f.d / 2, f.z + f.d / 2);
      const nx = (cx + f.x) / 2;
      const nz = (cz + f.z) / 2;
      consider('furniture', f.id, nx, nz, fy + Math.min(1.2, f.h * 0.7), 2.1, prompt, '', true);
    }
    this.target = best;
    void fx;
    void fz;
  }

  furniturePrompt(f: Furniture): string {
    const p = this.p;
    const sim = this.sim;
    switch (f.use) {
      case 'bed':
        return '[E] Sleep';
      case 'wardrobe':
        return f.hide ? '[E] Hide inside   [Hold E] Search' : '[E] Search';
      case 'fridge':
        return '[E] Open the fridge';
      case 'sink':
        return p.bloody > 0.05 ? '[E] Wash the blood off' : f.container ? '[E] Search the cupboard' : '[E] Wash up';
      case 'phone':
        return '[E] Call the police';
      case 'register':
      case 'bartap': {
        const keeper = this.keeperAt(f);
        if (keeper) return `[E] Talk to ${p.knownTo.includes(keeper.id) ? fullName(keeper) : 'the clerk'} at the counter`;
        return f.container ? '[E] Search' : '';
      }
      case 'lamp':
        return f.lightId >= 0 ? `[E] Turn ${sim.world.lights[f.lightId].on ? 'off' : 'on'} the lamp` : '';
      case 'dresser':
      case 'desk':
      case 'cabinet':
      case 'shelf':
      case 'counter':
      case 'workbench':
        return f.container ? (f.searched ? '[E] Search again' : '[E] Search') : '';
      default:
        return f.container ? '[E] Search' : '';
    }
  }

  keeperAt(f: Furniture): NpcState | null {
    for (const n of this.sim.npcs) {
      if (!n.alive || n.inCustody) continue;
      if (n.usingFurniture === f.id || (n.workId === f.buildingId && n.building === f.buildingId && Math.hypot(n.x - f.x, n.z - f.z) < 3 && n.activity?.kind === 'work')) return n;
    }
    return null;
  }

  // ------------------------------------------------------------------ interaction

  private handleInteract(dt: number) {
    const inp = this.input;
    const t = this.target;
    const holding = inp.held('interact');
    // hold actions
    if (this.holdAction) {
      if (!holding || t.kind === 'none') {
        // released early: short press behaviour
        const action = this.holdAction;
        const short = this.holdT < 0.25;
        this.holdAction = '';
        this.holdT = 0;
        if (short) this.pressAction(action);
        return;
      }
      this.holdT += dt;
      if (this.holdAction === 'lockpick' && Math.floor(this.holdT * 2) !== Math.floor((this.holdT - dt) * 2)) {
        const d = this.sim.world.doors[t.id];
        this.sim.sound('lockpick', d.axis === 'x' ? d.t : d.c, d.axis === 'x' ? d.c : d.t, 4, 0);
      }
      if (this.holdT >= this.holdNeeded) {
        const a = this.holdAction;
        this.holdAction = '';
        this.holdT = 0;
        this.completeHold(a);
      }
      return;
    }
    if (!inp.hit('interact')) return;
    if (this.p.carrying >= 0) {
      this.p.carrying = -1;
      this.hooks.message('You let go of the body.');
      return;
    }
    if (t.kind === 'none') {
      this.toggleRoomLight();
      return;
    }
    // decide whether this target supports a hold action
    let hold = '';
    if (t.kind === 'door') {
      const d = this.sim.world.doors[t.id];
      if (!d.broken && d.locked && !this.sim.playerHasKey(d.keyId) && !(this.p.building === d.buildingId && d.exterior) && this.count('lockpick')) hold = 'lockpick';
      else if (!d.broken && d.open < 0.5 && !d.locked && !d.bars && (this.sim.playerHasKey(d.keyId) || this.p.building === d.buildingId)) hold = 'lock';
    } else if (t.kind === 'window') {
      const w = this.sim.world.windows[t.id];
      if (!w.boarded && w.damage < 2 && this.p.building === w.buildingId && this.count('planks')) hold = 'board';
    } else if (t.kind === 'body') hold = 'drag';
    else if (t.kind === 'furniture') {
      const f = this.sim.world.furniture[t.id];
      if (f.use === 'wardrobe' && f.hide) hold = 'search';
    }
    if (hold) {
      this.holdAction = `${hold}`;
      this.holdNeeded = HOLD_TIME[hold] ?? 0.6;
      this.holdT = 0;
      if (hold === 'lockpick' || hold === 'board') {
        // these only make sense as holds
        this.holdT = 0.26;
      }
      return;
    }
    this.pressAction('');
  }

  private pressAction(hold: string) {
    const t = this.target;
    const sim = this.sim;
    const p = this.p;
    if (hold === 'lockpick' || hold === 'board') return;
    switch (t.kind) {
      case 'door': {
        const d = sim.world.doors[t.id];
        if (d.broken) return;
        const x = d.axis === 'x' ? d.t : d.c;
        const z = d.axis === 'x' ? d.c : d.t;
        if (d.open > 0.5) {
          d.target = 0;
          sim.sound('door_close', x, z, 7, 0);
        } else if (d.locked) {
          if (sim.playerHasKey(d.keyId) || (p.building === d.buildingId && d.exterior)) {
            d.locked = false;
            d.target = 1;
            sim.sound('unlock', x, z, 4, 0);
            sim.sound('door_open', x, z, 7, 0);
          } else if (d.bars) this.hooks.message('The cell door is locked.', 'warn');
          else {
            sim.sound('knock', x, z, 14, 0);
            this.knockResponse(d.buildingId);
          }
        } else {
          d.target = 1;
          sim.sound('door_open', x, z, 7, 0);
        }
        return;
      }
      case 'window': {
        const w = sim.world.windows[t.id];
        if (w.damage === 2 && !w.boarded && w.width >= 1 && w.sill < 1.3) {
          const out = w.outside;
          const inside = p.building === w.buildingId;
          const s = inside ? out : -out;
          this.climbFrom = { x: p.x, z: p.z };
          this.climbTo = w.axis === 'x' ? { x: w.t, z: w.c + s * 0.9 } : { x: w.c + s * 0.9, z: w.t };
          this.climbT = 0;
          sim.sound('climb', p.x, p.z, 6, 0);
          // cutting yourself on broken glass
          if (Math.random() < 0.25) {
            p.health -= 4;
            p.bleeding = Math.max(p.bleeding, 0.3);
            this.hooks.message('You cut yourself on the broken glass.', 'warn');
          }
        }
        return;
      }
      case 'npc': {
        const n = sim.npc(t.id);
        if (n) this.hooks.talk(n);
        return;
      }
      case 'body':
        this.hooks.examineBody(t.id);
        return;
      case 'item':
        this.hooks.pickup(t.id);
        return;
      case 'furniture': {
        const f = sim.world.furniture[t.id];
        this.useFurniture(f);
        return;
      }
    }
  }

  private completeHold(a: string) {
    const t = this.target;
    const sim = this.sim;
    const p = this.p;
    switch (a) {
      case 'lockpick': {
        const d = sim.world.doors[t.id];
        if (Math.random() < 0.8) {
          d.locked = false;
          this.hooks.message('The lock gives with a click.', 'good');
          sim.markForced(d.id);
        } else this.hooks.message('The pick slips. Try again.', 'warn');
        return;
      }
      case 'lock': {
        const d = sim.world.doors[t.id];
        if (d.open > 0.1) d.target = 0;
        d.locked = !d.locked;
        const x = d.axis === 'x' ? d.t : d.c;
        const z = d.axis === 'x' ? d.c : d.t;
        sim.sound('lock', x, z, 4, 0);
        this.hooks.message(d.locked ? 'Door locked.' : 'Door unlocked.');
        return;
      }
      case 'board': {
        const w = sim.world.windows[t.id];
        if (this.take('planks')) {
          w.boarded = true;
          w.boardHp = 45;
          const x = w.axis === 'x' ? w.t : w.c;
          const z = w.axis === 'x' ? w.c : w.t;
          sim.sound('hammer', x, z, 16, 0);
          this.hooks.message('You nail planks across the window.', 'good');
        }
        return;
      }
      case 'drag':
        p.carrying = t.id;
        this.hooks.message('You start dragging the body. [E] to let go.');
        return;
      case 'search': {
        const f = sim.world.furniture[t.id];
        this.hooks.container(f);
        return;
      }
    }
  }

  private useFurniture(f: Furniture) {
    const sim = this.sim;
    const p = this.p;
    switch (f.use) {
      case 'bed':
        this.hooks.sleep(f);
        return;
      case 'wardrobe':
        if (f.hide) {
          this.enterHiding(f);
          return;
        }
        this.hooks.container(f);
        return;
      case 'sink':
        if (p.bloody > 0.05 || !f.container) {
          this.hooks.wash();
          return;
        }
        this.hooks.container(f);
        return;
      case 'phone':
        this.hooks.phone();
        return;
      case 'register':
      case 'bartap': {
        const keeper = this.keeperAt(f);
        if (keeper) {
          this.hooks.trade(keeper, f);
          return;
        }
        if (f.container) this.hooks.container(f);
        return;
      }
      case 'lamp':
        if (f.lightId >= 0) {
          sim.world.lights[f.lightId].on = !sim.world.lights[f.lightId].on;
          sim.emit({ type: 'ui', s: 'switch' });
        }
        return;
      default:
        if (f.container) this.hooks.container(f);
    }
  }

  private toggleRoomLight() {
    const p = this.p;
    if (p.room < 0) return;
    const room = this.sim.world.rooms[p.room];
    const l = room.lightIds.map((id) => this.sim.world.lights[id]).find((x) => x.kind === 'room');
    if (!l) return;
    if (l.broken) {
      this.hooks.message('The bulb is dead.', 'warn');
      return;
    }
    l.on = !l.on;
    this.sim.emit({ type: 'ui', s: 'switch' });
  }

  private knockResponse(bId: number) {
    const sim = this.sim;
    const b = sim.world.buildings[bId];
    const home = sim.npcs.filter((n) => n.alive && n.homeId === bId && n.building === bId && !n.sleeping);
    if (b.kind !== 'house') {
      this.hooks.message('Nobody answers. The place is closed.');
      return;
    }
    if (!home.length) {
      this.hooks.message('You knock. Nobody answers.');
      return;
    }
    const n = home[0];
    const night = sim.hour() >= 21 || sim.hour() < 6;
    if (night || n.suspicionOfPlayer > 0.5) {
      sim.say(n, night ? 'Who is it?! Go away or I call the police!' : 'Leave us alone.', 4);
      n.alarm = Math.max(n.alarm, night ? 0.4 : 0.1);
      return;
    }
    // they let you in
    const d = sim.world.doors[b.frontDoorId];
    d.locked = false;
    n.ctl.lastTalkPlayer = sim.time;
    sim.say(n, 'Come in, it is open.', 4);
  }

  enterHiding(f: Furniture) {
    const p = this.p;
    if (this.sim.npcs.some((n) => n.usingFurniture === f.id)) {
      this.hooks.message('Someone is already in there!', 'warn');
      return;
    }
    p.stance = 'hidden';
    p.hiddenIn = f.id;
    p.usingFurniture = f.id;
    this.hidingFurniture = f.id;
    p.x = f.x;
    p.z = f.z;
    p.flashlight = false;
    p.yaw = [0, Math.PI / 2, Math.PI, -Math.PI / 2][f.face];
    p.pitch = 0;
    this.sim.sound('wardrobe', f.x, f.z, 4, 0);
    this.hooks.message('You hide inside. Hold your breath. [E] to come out.');
  }

  leaveHiding() {
    const p = this.p;
    const f = this.sim.world.furniture[this.hidingFurniture];
    p.stance = 'stand';
    p.hiddenIn = -1;
    p.usingFurniture = -1;
    if (f) {
      p.x = f.ux;
      p.z = f.uz;
      this.sim.sound('wardrobe', f.x, f.z, 5, 0);
    }
    this.hidingFurniture = -1;
  }

  /** camera height including crouch, bob and hurt shake */
  eye(): { y: number; roll: number; bobX: number } {
    const p = this.p;
    if (p.stance === 'hidden') return { y: p.y + 1.55, roll: 0, bobX: 0 };
    if (!p.alive) return { y: p.y + 0.3, roll: 0.5, bobX: 0 };
    const base = p.y + (p.crouching ? 1.0 : 1.62);
    const amp = p.sprinting ? 0.06 : 0.035;
    const bobY = p.speed > 0.3 ? Math.abs(Math.sin(this.bob)) * amp : 0;
    const bobX = p.speed > 0.3 ? Math.cos(this.bob) * amp * 0.6 : 0;
    const shake = this.hurtShake > 0 ? (Math.random() - 0.5) * this.hurtShake * 0.2 : 0;
    return { y: base + bobY + shake, roll: bobX * 0.15 + shake * 0.3, bobX };
  }

  /** looking at an npc's face up close (for introductions / recognition) */
  facing(id: number) {
    const a = this.sim.actors[id];
    const p = this.p;
    return Math.abs(wrapAngle(yawTo(p.x, p.z, a.x, a.z) - p.yaw)) < 0.5;
  }
}

export type { ItemStack };
