import * as THREE from 'three';
import { generateWorld, DEFAULT_PARAMS } from '../world/gen/generator';
import type { Furniture, GenParams, WorldData } from '../world/types';
import { Simulation } from '../sim/simulation';
import type { ActorState, Memory, NpcState, SimEvent } from '../sim/types';
import { GameRenderer } from '../render/renderer';
import { buildRig, animateRig, dressRig, type Rig } from '../render/characters';
import { Effects } from '../render/effects';
import { AudioEngine } from '../audio/audio';
import type { MusicState } from '../audio/music';
import { Input } from './input';
import { PlayerController } from './player';
import { Journal } from './journal';
import { Story } from './story';
import { loadSettings, saveSettings, type Settings } from './settings';
import { writeSave, readSave, type SaveGame, SAVE_VERSION } from './save';
import { WORLD_VERSION } from '../world/gen/generator';
import { SIM_VERSION } from '../sim/simulation';
import { CFG, isDark } from '../sim/config';
import { ITEMS, itemName } from '../sim/items';
import { fullName, JOB_TITLE, heightClass } from '../sim/population';
import { formatClock, clamp } from '../core/math';
import { policeCall, caseSummary } from '../sim/police';
import { visibility } from '../sim/perception';
import type { UI } from '../ui/ui';
import { Observer } from './observer';
import { atmosphereAt } from '../render/sky';
import { memoryLine } from '../sim/memory';

export type Mode = 'menu' | 'loading' | 'playing' | 'paused' | 'dialog' | 'ending' | 'observer';

export interface DialogueOption {
  text: string;
  action: () => void;
  disabled?: boolean;
}

export const SHOP_STOCK: Record<string, string[]> = {
  store: ['sandwich', 'canned_beans', 'apple', 'coffee', 'chocolate', 'bandage', 'battery', 'flashlight', 'cigarettes', 'kitchen_knife'],
  hardware: ['flashlight', 'battery', 'planks', 'lockpick', 'crowbar', 'baseball_bat'],
  diner: ['sandwich', 'coffee', 'apple'],
  bar: ['coffee', 'chocolate'],
  clinic: ['bandage', 'painkillers'],
  garage: ['crowbar', 'battery'],
  police: [],
};

export class Game {
  canvas: HTMLCanvasElement;
  renderer: GameRenderer;
  input: Input;
  audio = new AudioEngine();
  settings: Settings;
  ui!: UI;
  mode: Mode = 'menu';
  world: WorldData | null = null;
  sim: Simulation | null = null;
  player: PlayerController | null = null;
  journal: Journal | null = null;
  story: Story | null = null;
  effects: Effects | null = null;
  observer: Observer | null = null;
  rigs = new Map<number, Rig>();
  params: GenParams = { ...DEFAULT_PARAMS };
  letter = '';
  /** fast-forward: target game time and speed multiplier */
  ff: { until: number; speed: number; reason: 'sleep' | 'wait' | 'custody'; interrupted: boolean } | null = null;
  private last = performance.now();
  private fpsAcc = 0;
  private fpsN = 0;
  fps = 0;
  private menuWorld: WorldData | null = null;
  private menuT = 0;
  time = 0;
  arrestOfficer = -1;
  private autosaveDay = -1;
  dialogNpc = -1;
  private discovered = new Set<number>();
  frames = 0;
  lastError = '';
  /** smoothed per-frame timings in ms (CPU side); interval = real time between frames */
  perf = { sim: 0, render: 0, hud: 0, cpu: 0, interval: 16 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.settings = loadSettings();
    this.renderer = new GameRenderer(canvas);
    this.input = new Input(canvas);
    this.applySettings();
    window.addEventListener('resize', () => this.renderer.resize());
    canvas.addEventListener('click', () => {
      if (this.mode === 'playing' || this.mode === 'observer') this.input.lock();
    });
    // losing the pointer lock (Esc in most browsers) pauses the game
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && this.mode === 'playing' && !this.ff) this.pause();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.mode === 'playing') this.pause();
    });
  }

  attachUI(ui: UI) {
    this.ui = ui;
  }

  applySettings() {
    const s = this.settings;
    this.renderer.setQuality(s.quality);
    this.renderer.brightness = s.brightness;
    this.renderer.postEnabled = s.post;
    this.input.sensitivity = s.sensitivity;
    this.input.invertY = s.invertY;
    this.input.bindings = { ...s.bindings };
    this.audio.volumes = { master: s.master, music: s.music, sfx: s.sfx, ambience: s.ambience };
    this.audio.hrtf = s.hrtf;
    this.audio.applyVolumes();
    saveSettings(s);
  }

  // ------------------------------------------------------------------ lifecycle

  start() {
    this.showMenuScene();
    const loop = () => {
      try {
        this.frame();
      } catch (e) {
        this.lastError = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
        console.error(e);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** a slowly drifting night view of a town behind the main menu */
  showMenuScene() {
    this.mode = 'menu';
    this.input.unlock();
    if (!this.menuWorld) this.menuWorld = generateWorld({ ...DEFAULT_PARAMS, seed: 'menu-night', size: 'small' });
    this.clearGame();
    this.renderer.setWorld(this.menuWorld);
    for (const l of this.menuWorld.lights) l.on = l.auto || l.kind === 'porch' || (l.kind === 'room' && l.id % 3 === 0);
    this.ui?.showMainMenu();
    this.audio.music?.setState('menu');
  }

  private clearGame() {
    this.tips = [];
    for (const r of this.rigs.values()) this.renderer.layers.remove(r.root);
    this.rigs.clear();
    if (this.effects) this.renderer.layers.remove(this.effects.group);
    this.effects = null;
    this.sim = null;
    this.player = null;
    this.journal = null;
    this.story = null;
    this.observer?.dispose();
    this.observer = null;
    this.ff = null;
    this.discovered.clear();
    // an ending can arrive while the arrest or conversation dialog is open
    this.arrestOfficer = -1;
    this.dialogNpc = -1;
  }

  async ensureAudio() {
    try {
      await this.audio.init();
      this.audio.applyVolumes();
    } catch (e) {
      console.warn('audio unavailable', e);
    }
  }

  private setupSession(world: WorldData, sim: Simulation) {
    // the ending screen's buttons start a new session without passing through the main menu
    this.ui.endingShown = false;
    this.world = world;
    this.sim = sim;
    this.renderer.setWorld(world);
    this.journal = new Journal(sim);
    this.story = new Story(sim, this.journal, world.params.nights);
    this.player = new PlayerController(sim, this.input, {
      talk: (n) => this.talk(n),
      container: (f) => this.ui.showContainer(f),
      sleep: (f) => this.ui.showSleep(f),
      phone: () => this.ui.showPhone(),
      trade: (n, f) => this.ui.showTrade(n, f),
      examineBody: (id) => this.examineBody(id),
      pickup: (id) => this.pickup(id),
      message: (t, k) => this.ui.message(t, k),
      wash: () => this.wash(),
    });
    this.effects = new Effects(sim);
    this.renderer.layers.add(this.effects.group);
    for (const n of sim.npcs) {
      const rig = buildRig(n.app, n.role === 'police');
      this.rigs.set(n.id, rig);
      this.renderer.layers.add(rig.root);
    }
    this.audio.grid = sim.grid;
    sim.onPlayerArrestAttempt = (o) => this.arrestAttempt(o);
    this.autosaveDay = sim.day();
  }

  newGame(params: GenParams) {
    this.mode = 'loading';
    this.ui.showLoading('Building the neighbourhood...');
    // let the loading screen paint before the heavy work
    setTimeout(() => {
      try {
        this.clearGame();
        this.params = { ...params };
        const world = generateWorld(this.params);
        const sim = new Simulation(world);
        sim.populate();
        this.setupSession(world, sim);
        this.story!.begin((text) => (this.letter = text));
        this.placeLetter();
        this.mode = 'playing';
        this.ui.hideAll();
        this.ui.banner(world.townName, `Day 1 — ${formatClock(sim.time)}`);
        this.ui.message('Your uncle’s house is waiting. Follow the marker on the compass. [Click to look around]');
        this.queueTips();
        this.input.lock();
        this.audio.music?.setState('day');
        this.autosaveNow('Arrival');
      } catch (e) {
        console.error(e);
        this.ui.showError(`Failed to start a new game: ${e instanceof Error ? e.message : e}`);
        this.showMenuScene();
      }
    }, 30);
  }

  private placeLetter() {
    const sim = this.sim!;
    const home = sim.world.buildings[sim.world.playerHouseId];
    const inHome = sim.world.furniture.filter((x) => x.buildingId === home.id && x.kind !== 'none');
    let f: Furniture | undefined;
    for (const use of ['table', 'desk', 'phone', 'dresser']) {
      f = inHome.find((x) => x.use === use && x.h < 1.2);
      if (f) break;
    }
    const x = f ? f.x : home.insideFront.x;
    const z = f ? f.z : home.insideFront.z;
    const it = sim.dropItem('note', x, z, 1, -1, "Uncle Ed's letter");
    it.y = (f ? home.floorY + f.h : home.floorY) + 0.02;
  }

  // ------------------------------------------------------------------ save / load

  /** autosave; a failure (e.g. browser storage full) is reported, not swallowed */
  autosaveNow(label?: string) {
    const err = this.saveTo('auto', label);
    if (err && err !== 'Nothing to save.') this.ui.message(`Autosave failed: ${err}`, 'warn');
  }

  saveTo(slot: string, label?: string): string | null {
    const sim = this.sim;
    if (!sim || !this.journal || !this.story || this.story.ending) return 'Nothing to save.';
    const save: SaveGame = {
      saveVersion: SAVE_VERSION,
      worldVersion: WORLD_VERSION,
      simVersion: SIM_VERSION,
      params: this.params,
      savedAt: Date.now(),
      label: label ?? `${sim.world.townName} — Day ${sim.day() + 1}, ${formatClock(sim.time)}`,
      sim: sim.snapshot(),
      journal: this.journal.toData(),
      story: this.story.toData(),
      extra: { pitch: sim.player.pitch, letter: this.letter },
    };
    save.label = `${save.label}`;
    return writeSave(slot, save);
  }

  loadFrom(slot: string): string | null {
    const { save, error } = readSave(slot);
    if (!save) return error ?? 'Could not load.';
    try {
      this.clearGame();
      this.params = { ...save.params };
      const world = generateWorld(this.params);
      const sim = new Simulation(world);
      sim.populate();
      sim.restore(save.sim);
      this.setupSession(world, sim);
      this.journal!.fromData(save.journal);
      this.story!.fromData(save.story);
      this.letter = save.extra?.letter ?? '';
      sim.player.pitch = save.extra?.pitch ?? 0;
      this.mode = 'playing';
      this.ui.hideAll();
      this.ui.message('Game loaded.');
      this.input.lock();
      return null;
    } catch (e) {
      console.error(e);
      this.showMenuScene();
      return `Could not restore the save: ${e instanceof Error ? e.message : e}`;
    }
  }

  // ------------------------------------------------------------------ modes

  pause() {
    if (this.mode !== 'playing') return;
    this.mode = 'paused';
    this.input.unlock();
    this.ui.showPause();
    this.audio.suspend();
  }

  resume() {
    if (!this.sim) return;
    this.mode = 'playing';
    this.ui.hideAll();
    this.input.lock();
    this.audio.resume();
  }

  openDialog() {
    if (this.mode === 'playing') this.mode = 'dialog';
    this.input.unlock();
  }

  closeDialog() {
    if (this.mode === 'dialog') {
      this.mode = 'playing';
      this.input.lock();
    }
    this.dialogNpc = -1;
  }

  startObserver(params?: GenParams) {
    if (params) {
      this.clearGame();
      this.params = { ...params };
      const world = generateWorld(this.params);
      const sim = new Simulation(world);
      sim.populate();
      this.setupSession(world, sim);
      // the player is a ghost in observer-only games
      sim.player.x = sim.world.busStop.x;
      sim.player.z = sim.world.busStop.z - 1.2;
      sim.player.stance = 'hidden';
      sim.player.ctl.ghost = 1;
      this.story!.flags.observerOnly = true;
    }
    if (!this.sim) return;
    this.observer = new Observer(this);
    this.mode = 'observer';
    // free the mouse for the inspector panel; clicking the view captures it again for flying
    this.input.unlock();
    this.ui.hideAll();
    this.ui.showObserver();
  }

  exitObserver() {
    this.observer?.dispose();
    this.observer = null;
    if (this.story?.flags.observerOnly) {
      this.showMenuScene();
      return;
    }
    this.mode = 'playing';
    this.ui.hideAll();
    this.input.lock();
  }

  // ------------------------------------------------------------------ frame

  private frame() {
    const now = performance.now();
    const pf = this.perf;
    const real = now - this.last;
    pf.interval += (real - pf.interval) * 0.1;
    const dt = Math.min(0.1, real / 1000);
    this.last = now;
    this.time += dt;
    this.frames++;
    (window as unknown as { __frames: number }).__frames = this.frames;
    this.fpsAcc += real / 1000;
    this.fpsN++;
    if (this.fpsAcc > 0.5) {
      this.fps = this.fpsN / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsN = 0;
    }
    if (this.mode === 'menu' || this.mode === 'loading') {
      this.renderMenu(dt);
      this.input.endFrame();
      return;
    }
    const sim = this.sim;
    if (!sim || !this.player || !this.story) {
      this.input.endFrame();
      return;
    }
    this.handleKeys();
    if (this.mode === 'observer' && this.observer) {
      this.observer.update(dt);
      this.stepSim(dt * this.observer.speed, this.observer.speed > 6);
      this.processEvents();
      this.story.update(dt);
      this.renderGame(dt, this.observer.camera());
      this.ui.updateObserver();
      this.input.endFrame();
      return;
    }
    const playing = this.mode === 'playing';
    if (playing || this.mode === 'dialog') {
      const ts = performance.now();
      if (this.ff) this.runFastForward();
      else {
        this.player.update(dt, playing);
        this.stepSim(this.mode === 'dialog' ? dt * 0.35 : dt, false);
      }
      pf.sim += (performance.now() - ts - pf.sim) * 0.1;
      this.processEvents();
      this.checkDiscoveries();
      this.story.update(dt);
      this.autosave();
      this.showTips();
      if (this.story.ending && !this.ui.endingShown) {
        this.mode = 'ending';
        this.input.unlock();
        this.ui.showEnding(this.story.ending);
      }
    }
    const p = sim.player;
    const eye = this.player.eye();
    const view = {
      pos: new THREE.Vector3(p.x, eye.y, p.z),
      yaw: -p.yaw,
      pitch: p.pitch,
      roll: this.settings.headBob ? eye.roll : 0,
    };
    if (this.settings.headBob && p.speed > 0.3) {
      view.pos.x += Math.cos(p.yaw) * eye.bobX * 0.5;
      view.pos.z += Math.sin(p.yaw) * eye.bobX * 0.5;
    }
    const tr = performance.now();
    this.renderGame(dt, view);
    const th = performance.now();
    this.ui.updateHud();
    const te = performance.now();
    pf.render += (th - tr - pf.render) * 0.1;
    pf.hud += (te - th - pf.hud) * 0.1;
    pf.cpu += (te - now - pf.cpu) * 0.1;
    this.input.endFrame();
  }

  private handleKeys() {
    const inp = this.input;
    if (inp.hit('pause')) {
      if (this.mode === 'playing') this.pause();
      else if (this.mode === 'paused') this.resume();
      else if (this.mode === 'dialog') this.ui.closeDialog();
      else if (this.mode === 'observer') this.exitObserver();
    }
    if (this.mode === 'playing') {
      if (inp.hit('inventory')) this.ui.showInventory();
      else if (inp.hit('journal')) this.ui.showJournal('objectives');
      else if (inp.hit('map')) this.ui.showJournal('map');
      else if (inp.hit('observer')) this.startObserver();
      else if (inp.hit('wait')) this.ui.showWait();
    } else if (this.mode === 'dialog' && (inp.hit('inventory') || inp.hit('journal'))) this.ui.closeDialog();
  }

  /** advance the simulation by dt real seconds, in safe sub-steps */
  stepSim(dt: number, coarse: boolean) {
    const sim = this.sim!;
    let left = dt;
    const step = coarse ? CFG.maxStep : Math.min(CFG.maxStep, 1 / 30);
    let guard = 0;
    while (left > 1e-5 && guard++ < 400) {
      const d = Math.min(step, left);
      sim.step(d);
      left -= d;
    }
  }

  /** sleeping / waiting: run the world fast within a frame time budget */
  private runFastForward() {
    const ff = this.ff!;
    const sim = this.sim!;
    const t0 = performance.now();
    const before = sim.time;
    let steps = 0;
    while (performance.now() - t0 < 14 && sim.time < ff.until && !ff.interrupted && steps < ff.speed) {
      sim.step(CFG.maxStep);
      steps++;
      // anything threatening near the player wakes them up
      for (const e of sim.events) {
        if (e.type !== 'sound' || ff.reason === 'custody') continue;
        const d = Math.hypot((e.x ?? 0) - sim.player.x, (e.z ?? 0) - sim.player.z);
        const loud = e.v ?? 0;
        if (['glass', 'knock', 'door_force', 'scream', 'kick', 'boards_break', 'board_hit', 'handle'].includes(e.s ?? '') && d < loud * 0.9) {
          ff.interrupted = true;
          this.ui.message(e.s === 'knock' ? 'Someone is knocking at the door...' : e.s === 'handle' ? 'Someone is trying the door handle.' : 'A noise wakes you!', 'warn');
          break;
        }
      }
      if (sim.player.hitFlash > 0 || sim.player.health < this.player!.lastHealth - 1) ff.interrupted = true;
    }
    if (sim.time >= ff.until || ff.interrupted) {
      if (ff.reason === 'sleep') {
        const slept = (sim.time - (ff as unknown as { start: number }).start) / 3600;
        sim.player.energy = clamp(sim.player.energy + slept * 13, 0, 100);
        this.ui.message(ff.interrupted ? `You slept ${slept.toFixed(1)} hours.` : 'You wake up.', ff.interrupted ? 'warn' : 'info');
        sim.player.stance = 'stand';
        if (!ff.interrupted) this.autosaveNow();
      }
      if (ff.reason === 'custody') this.releasePlayer();
      this.ff = null;
      this.ui.fade(false);
    }
    void before;
  }

  sleepUntil(hours: number) {
    const sim = this.sim!;
    const target = hours < 0 ? this.nextMorning() : sim.time + hours * 3600;
    this.ff = { until: target, speed: 60, reason: 'sleep', interrupted: false };
    (this.ff as unknown as { start: number }).start = sim.time;
    sim.player.stance = 'lie';
    sim.player.flashlight = false;
    this.ui.fade(true, 'Sleeping...');
    this.autosaveNow();
  }

  waitHours(hours: number) {
    const sim = this.sim!;
    this.ff = { until: sim.time + hours * 3600, speed: 40, reason: 'wait', interrupted: false };
    (this.ff as unknown as { start: number }).start = sim.time;
    this.ui.fade(true, 'Waiting...');
  }

  nextMorning() {
    const sim = this.sim!;
    const day0 = Math.floor(sim.time / 86400) * 86400;
    let t = day0 + 7.25 * 3600;
    if (t <= sim.time + 1800) t += 86400;
    return t;
  }

  /** first-minute onboarding: a few control tips, using the player's own key bindings */
  private tips: { at: number; text: string }[] = [];
  private queueTips() {
    const k = (a: Parameters<Input['keyName']>[0]) => this.input.keyName(a);
    const t0 = this.time;
    this.tips = [
      { at: t0 + 5, text: `Move with ${k('forward')}${k('left')}${k('back')}${k('right')} and the mouse. ${k('sprint')} sprints, ${k('crouch')} crouches.` },
      { at: t0 + 14, text: `${k('interact')} interacts with doors, people and things. Hold ${k('interact')} for more (lock doors, pick locks...).` },
      { at: t0 + 24, text: `${k('journal')} journal, ${k('map')} map, ${k('inventory')} inventory, ${k('wait')} wait, ${k('pause')} pause and save.` },
      { at: t0 + 36, text: 'The clock is ticking. Night falls around 19:30. Find a flashlight before then.' },
    ];
  }
  private showTips() {
    while (this.tips.length && this.time >= this.tips[0].at && this.mode === 'playing') this.ui.message(this.tips.shift()!.text, 'info');
  }

  private autosave() {
    const sim = this.sim!;
    if (sim.day() !== this.autosaveDay && sim.hour() > 7 && sim.hour() < 9 && sim.player.alive) {
      this.autosaveDay = sim.day();
      this.autosaveNow();
      this.ui.message('Autosaved.');
    }
  }

  // ------------------------------------------------------------------ events

  private processEvents() {
    const sim = this.sim!;
    const evs = sim.events;
    for (const e of evs) {
      this.audio.onEvent(e, 0);
      this.effects?.onEvent(e);
      this.onEvent(e);
    }
    evs.length = 0;
  }

  private onEvent(e: SimEvent) {
    const sim = this.sim!;
    const j = this.journal!;
    switch (e.type) {
      case 'body_found':
        if (e.text) {
          j.addLog(e.text, 'event');
          this.ui.message(e.text, 'event');
        }
        if (Number(this.story!.flags.wrongArrest ?? -1) >= 0) this.story!.onMurderWhileWrongInCustody();
        break;
      case 'missing':
      case 'arrest':
      case 'jailed':
      case 'released':
        if (e.text) {
          j.addLog(e.text, 'event');
          this.ui.message(e.text, 'event');
        }
        break;
      case 'police':
        if (e.s === 'dispatch' && e.text && Math.hypot((sim.actors[e.a ?? 0]?.x ?? 0) - sim.player.x, (sim.actors[e.a ?? 0]?.z ?? 0) - sim.player.z) < 40) this.ui.message(e.text);
        break;
      case 'death':
        if (e.a === 0) {
          sim.player.alive = false;
        } else if (e.b === 0) {
          this.story!.stats.kills++;
          this.ui.message(`${sim.actorName(e.a ?? -1)} is dead.`, 'warn');
        }
        break;
      case 'witness':
        if (e.b === 0 && (e.s === 'attack' || e.s === 'murder')) this.ui.message('Someone saw that.', 'warn');
        break;
      case 'say': {
        const a = sim.actors[e.a ?? -1];
        if (a && Math.hypot(a.x - sim.player.x, a.z - sim.player.z) < 14) this.ui.speech(e.a!, e.text ?? '');
        break;
      }
      case 'found_hiding':
        if (e.a === 0) this.player?.leaveHiding();
        break;
      case 'wake':
        break;
    }
  }

  /** the player stumbles on bodies (including hidden ones) */
  private checkDiscoveries() {
    const sim = this.sim!;
    const p = sim.player;
    if (!p.alive) return;
    for (const inc of sim.incidents) {
      if (inc.kind !== 'murder' || this.discovered.has(inc.victim)) continue;
      const v = sim.actors[inc.victim];
      if (!v || v.alive || v.bodyRemoved) continue;
      const d = Math.hypot(v.x - p.x, v.z - p.z);
      if (d > 8) continue;
      if (visibility(sim, p, v) < 0.05 && d > 2) continue;
      this.discovered.add(inc.victim);
      const first = !inc.discovered;
      inc.discovered = true;
      p.fear = Math.min(100, p.fear + 60);
      sim.emit({ type: 'stinger' });
      this.journal!.addLog(`You found the body of ${sim.actorName(inc.victim)} ${sim.placeName(v.x, v.z)}.`, 'event');
      this.ui.message(`You found the body of ${sim.actorName(inc.victim)}.${first ? ' Report it to the police.' : ''}`, 'event');
      if (first) this.story!.flags[`unreported_${inc.id}`] = true;
      if (sim.lair.building >= 0 && v.building === sim.lair.building) {
        this.journal!.addLog("This is where the Night Neighbour hides the missing. Search the place.", 'note');
        this.story!.flags.foundLair = true;
      }
    }
  }

  // ------------------------------------------------------------------ rendering

  private renderGame(dt: number, view: { pos: THREE.Vector3; yaw: number; pitch: number; roll: number }) {
    const sim = this.sim!;
    const p = sim.player;
    const hour = sim.hour();
    const cam = view.pos;
    // characters
    for (const n of sim.npcs) {
      const rig = this.rigs.get(n.id);
      if (!rig) continue;
      const d = Math.hypot(n.x - cam.x, n.z - cam.z);
      const vis = d < 75 && !(n.bodyRemoved && !n.alive) && n.stance !== 'hidden';
      rig.root.visible = vis;
      if (!vis) continue;
      rig.root.position.set(n.x, n.y, n.z);
      rig.root.rotation.y = -n.yaw;
      dressRig(rig, n, n.building < 0 || n.building === sim.world.policeId);
      animateRig(rig, n, dt, this.time, (n.id * 0.37) % 1);
    }
    const pl = p.alive ? p : p;
    const insideB = this.mode === 'observer' ? sim.grid.buildingAt(cam.x, cam.z) : pl.building;
    const night = atmosphereAt(hour).night;
    this.effects?.update(dt, cam, this.time);
    const fear = this.mode === 'observer' ? 0 : p.fear / 100;
    this.renderer.render({
      pos: cam,
      yaw: view.yaw,
      pitch: view.pitch,
      roll: view.roll,
      fov: this.settings.fov + (p.sprinting ? 4 : 0),
      hour,
      time: this.time,
      insideBuilding: insideB,
      flashlight: this.mode !== 'observer' && p.flashlight,
      flashPower: Math.min(1, 0.35 + p.battery / 60) * (p.battery < 12 && Math.sin(this.time * 23) > 0.6 ? 0.2 : 1),
      damage: this.player ? this.player.damageFlash : 0,
      fear: Math.min(1, fear),
      lowHealth: clamp(1 - p.health / 50, 0, 1),
      blur: 0,
    });
    // audio listener and mix
    this.audio.setListener(cam.x, cam.y, cam.z, -view.yaw);
    this.audio.updateAmbience(dt, {
      indoor: insideB >= 0,
      night,
      hour,
      fear: this.mode === 'observer' ? 0 : p.fear,
      stamina: this.mode === 'observer' ? 100 : p.stamina,
      health: this.mode === 'observer' ? 100 : p.health,
      music: this.musicState(),
      sprinting: p.sprinting,
    });
  }

  private musicState(): MusicState {
    const sim = this.sim!;
    const p = sim.player;
    if (this.mode === 'observer') return isDark(sim.hour()) ? 'night' : 'day';
    if (!p.alive || this.ff) return 'silent';
    // danger: somebody hostile closing in, or fighting
    const hostile = sim.npcs.some((n) => n.alive && (n.activity?.kind === 'kfight' || n.activity?.kind === 'fight' || n.activity?.kind === 'arrest' || (n.role === 'killer' && n.activity?.kind === 'hunt' && Number(n.ctl.tgt) === 0)) && Math.hypot(n.x - p.x, n.z - p.z) < 22 && (n.tasks[0]?.target === 0 || Number(n.ctl.tgt) === 0));
    if (hostile || p.hitFlash > 0 || p.swingT > 0) return 'danger';
    if (p.fear > 35) return 'tension';
    if (isDark(sim.hour())) return p.building >= 0 && p.fear < 10 ? 'silent' : 'night';
    return 'day';
  }

  private renderMenu(dt: number) {
    this.menuT += dt;
    const w = this.menuWorld!;
    const cx = w.width / 2;
    const cz = w.depth / 2;
    const a = this.menuT * 0.02;
    const pos = new THREE.Vector3(cx + Math.cos(a) * 55, 9 + Math.sin(this.menuT * 0.1) * 1.5, cz + Math.sin(a) * 55);
    const yaw = Math.atan2(pos.x - cx, pos.z - cz);
    this.renderer.render({ pos, yaw, pitch: -0.12, roll: 0, fov: 60, hour: 22.5, time: this.menuT, insideBuilding: -1, flashlight: false, flashPower: 0, damage: 0, fear: 0, lowHealth: 0, blur: 0 });
    if (this.audio.ready) {
      this.audio.setListener(pos.x, pos.y, pos.z, 0);
      this.audio.updateAmbience(dt, { indoor: false, night: 1, hour: 22.5, fear: 0, stamina: 100, health: 100, music: 'menu', sprinting: false });
    }
  }

  // ------------------------------------------------------------------ interactions with the world

  pickup(itemId: number) {
    const sim = this.sim!;
    const it = sim.items[itemId];
    if (!it || it.taken) return;
    const pl = this.player!;
    if (it.item === 'evidence') {
      const c = sim.clues[it.tag];
      it.taken = true;
      if (c) {
        this.journal!.addSimClue(c);
        this.story!.stats.clues++;
        this.ui.message(`Evidence: ${c.text}`, 'good');
      }
      sim.emit({ type: 'ui', s: 'pickup' });
      return;
    }
    if (it.item === 'note') {
      it.taken = true;
      this.ui.showLetter(this.letter);
      this.story!.readLetter();
      sim.emit({ type: 'ui', s: 'page' });
      return;
    }
    if (it.item === 'cigarette_butt') {
      it.taken = true;
      this.journal!.addLog(`Cigarette butts ${sim.placeName(it.x, it.z)}.`, 'note');
      this.ui.message('Just a cigarette butt. Someone smokes around here.');
      return;
    }
    if (!pl.give(it.item, it.n, it.tag >= 0 ? it.tag : undefined)) {
      this.ui.message('Your pockets are full.', 'warn');
      return;
    }
    it.taken = true;
    sim.emit({ type: 'ui', s: 'pickup' });
    this.ui.message(`Picked up ${it.n > 1 ? it.n + ' x ' : ''}${it.label || itemName(it.item)}.`);
  }

  /** take an item from a container */
  takeFromContainer(f: Furniture, idx: number) {
    const sim = this.sim!;
    const s = f.container?.[idx];
    if (!s) return;
    const pl = this.player!;
    if (s.item === 'evidence') {
      const c = sim.clues[s.tag ?? -1];
      f.container!.splice(idx, 1);
      if (c) {
        this.journal!.addSimClue(c);
        this.story!.stats.clues++;
        this.ui.message(`Evidence: ${c.text}`, 'good');
        sim.emit({ type: 'stinger' });
        if (f.buildingId === sim.lair.building) this.story!.flags.foundLair = true;
      }
      return;
    }
    if (!pl.give(s.item, s.n, s.tag)) {
      this.ui.message('Your pockets are full.', 'warn');
      return;
    }
    f.container!.splice(idx, 1);
    this.noteTheft(f);
    sim.emit({ type: 'ui', s: s.item === 'cash' ? 'coins' : 'pickup' });
  }

  putIntoContainer(f: Furniture, invIdx: number) {
    const pl = this.player!;
    const s = this.sim!.player.inventory[invIdx];
    if (!s) return;
    if (!f.container) f.container = [];
    f.container.push({ ...s });
    pl.removeStack(invIdx);
  }

  onOpenContainer(f: Furniture) {
    const sim = this.sim!;
    f.searched = true;
    sim.sound('rummage', f.x, f.z, 5, 0);
    const k = sim.npc(sim.killerId)!;
    if (f.buildingId === k.homeId) this.story!.flags.searchedKillerHome = true;
  }

  private noteTheft(f: Furniture) {
    const sim = this.sim!;
    const b = sim.world.buildings[f.buildingId];
    if (!b || b.id === sim.world.playerHouseId) return;
    // stealing in front of the owners is noticed
    for (const n of sim.npcs) {
      if (!n.alive || n.sleeping) continue;
      if (visibility(sim, n, sim.player) > 0.4 && Math.hypot(n.x - sim.player.x, n.z - sim.player.z) < 10) {
        n.suspicionOfPlayer = Math.min(1, n.suspicionOfPlayer + 0.4);
        sim.say(n, 'Hey! That is not yours!', 3);
      }
    }
  }

  wash() {
    const sim = this.sim!;
    sim.player.bloody = 0;
    this.ui.message('You scrub the blood off your hands and clothes.');
    sim.sound('rummage', sim.player.x, sim.player.z, 4, 0);
  }

  examineBody(id: number) {
    const sim = this.sim!;
    const v = sim.actors[id];
    if (!v) return;
    const inc = sim.incidents[sim.incidentForVictim(id)];
    const name = sim.actorName(id);
    const lines: string[] = [];
    lines.push(`${name}.`);
    if (inc) {
      const weapon = sim.actors[inc.perp]?.kind === 'npc' && (sim.actors[inc.perp] as NpcState).role === 'killer' ? 'Deep stab wounds to the chest and throat.' : 'Bruises and wounds from a struggle.';
      lines.push(weapon);
      const hrs = (sim.time - (v.deathTime > 0 ? v.deathTime : inc.time)) / 3600;
      const tod = (v.deathTime > 0 ? v.deathTime : inc.time) + (Math.random() - 0.5) * 3600;
      lines.push(hrs < 1.5 ? 'The body is still warm. This happened very recently.' : `The body is cold. Death was probably around ${formatClock(tod)}.`);
      if (sim.forcedDoors.length || inc.building >= 0) {
        const b = inc.building >= 0 ? sim.world.buildings[inc.building] : null;
        if (b) {
          const broken = b.windowIds.some((w) => sim.world.windows[w].damage === 2);
          const forced = b.doorIds.some((d) => sim.forcedDoors.includes(d));
          if (broken) lines.push('A window in the house has been smashed in.');
          if (forced) lines.push('Scratches around a door lock: somebody picked it.');
          if (!broken && !forced) lines.push('No sign of forced entry. Was the door left unlocked?');
        }
      }
      const clueItems = sim.items.filter((i) => i.item === 'evidence' && !i.taken && Math.hypot(i.x - v.x, i.z - v.z) < 12);
      if (clueItems.length) lines.push('Something on the floor nearby catches your eye.');
    } else lines.push('You cannot tell what happened.');
    this.journal!.addLog(`Examined the body of ${name}: ${lines.slice(1).join(' ')}`, 'note');
    this.ui.showText(`The body of ${name}`, lines);
    sim.player.fear = Math.min(100, sim.player.fear + 15);
  }

  // ------------------------------------------------------------------ conversation

  talk(n: NpcState) {
    const sim = this.sim!;
    if (!n.alive) return;
    this.openDialog();
    this.dialogNpc = n.id;
    n.ctl.lastTalkPlayer = sim.time;
    this.story!.stats.talks++;
    const p = sim.player;
    // the npc turns to face the player and pauses briefly
    n.yaw = Math.atan2(p.x - n.x, -(p.z - n.z));
    this.ui.showDialogue(n, this.greeting(n), this.dialogueOptions(n));
  }

  private greeting(n: NpcState): string {
    const sim = this.sim!;
    const p = sim.player;
    const h = sim.hour();
    if (n.inCustody) return n.role === 'killer' ? '...' : 'Get me out of here. I did nothing!';
    if (p.bloody > 0.3) return 'Oh god, you are covered in blood! Stay back!';
    if (sim.playerWeaponDrawn()) return 'Why are you waving that thing around? Put it away.';
    if (n.suspicionOfPlayer > 0.6) return 'I know what you have been up to. I have nothing to say to you.';
    if (p.building === n.homeId && !sim.isInvited(n, 0)) return 'What are you doing in my house?!';
    if (n.sleeping) return '...mm? What? It is the middle of the night!';
    if (!n.metPlayer) return h < 12 ? 'Morning. Can I help you?' : h < 18 ? 'Afternoon. Do I know you?' : 'Evening. You are not from around here, are you?';
    const fearful = sim.incidents.some((i) => i.kind === 'murder' && i.discovered);
    if (fearful) return n.needs.fear > 40 ? `Oh, it's you. Sorry. Everybody is on edge since what happened.` : `${p.knownTo.includes(n.id) ? 'Hello again.' : 'Hello.'} Terrible business, all of this.`;
    return `Hello again. How are you settling in at Ed's old place?`;
  }

  dialogueOptions(n: NpcState): import('../game/game').DialogueOption[] {
    const sim = this.sim!;
    const j = this.journal!;
    const story = this.story!;
    const p = sim.player;
    const opts: DialogueOption[] = [];
    const say = (lines: string[], back = true) => this.ui.showDialogue(n, lines.join('\n'), back ? this.dialogueOptions(n) : [{ text: 'Goodbye.', action: () => this.ui.closeDialog() }]);
    const refuses = n.suspicionOfPlayer > 0.6 || p.bloody > 0.3 || (p.building === n.homeId && !sim.isInvited(n, 0) && sim.hour() > 21);
    if (refuses) {
      opts.push({ text: 'Leave.', action: () => this.ui.closeDialog() });
      return opts;
    }
    if (!n.metPlayer || !p.knownTo.includes(n.id)) {
      opts.push({
        text: 'Introduce yourself.',
        action: () => {
          n.metPlayer = true;
          if (!p.knownTo.includes(n.id)) p.knownTo.push(n.id);
          j.meet(n);
          const lines = [
            `Oh! You must be Ed's nephew. I'm ${fullName(n)}. I ${JOB_TITLE[n.job].replace(/^is /, 'am ').replace(/^runs/, 'run').replace(/^works/, 'work').replace(/^cooks/, 'cook').replace(/^waits/, 'wait').replace(/^tends/, 'tend').replace(/^fixes/, 'fix').replace(/^keeps/, 'keep').replace(/^writes/, 'write')}.`,
            `I live at ${sim.world.buildings[n.homeId].address}.`,
            n.traits.sociability > 0.6 ? 'Ed was a good man. A little paranoid towards the end, maybe. Come by any time.' : 'Well. Welcome to the neighbourhood, I suppose.',
          ];
          say(lines);
        },
      });
    }
    opts.push({
      text: 'Did you see or hear anything unusual lately?',
      action: () => {
        const mems = n.memories
          .filter((m) => ['murder', 'attack', 'body', 'breakin', 'glass', 'scream', 'fight', 'prowler', 'blood', 'theft', 'missing', 'trespass', 'weapon', 'leftHome'].includes(m.topic) && !(m.topic === 'leftHome' && m.actor < 0) && !(m.actor === 0 && m.topic === 'trespass'))
          .sort((a, b) => importanceOf(b) - importanceOf(a) || b.time - a.time)
          .slice(0, 4);
        if (n.role === 'killer') {
          // the killer deflects and quietly takes note
          story.flags.talkedToKillerAboutMurder = true;
          const fake = mems.filter((m) => m.topic !== 'murder' && m.actor !== n.id).slice(0, 1);
          const lines = fake.length ? fake.map((m) => this.memoryLine(n, m)) : ['No. I keep to myself. I sleep with earplugs these days.'];
          lines.push(sim.incidents.some((i) => i.kind === 'murder' && i.discovered) ? '...You ask a lot of questions for a newcomer.' : '');
          say(lines.filter(Boolean));
          return;
        }
        if (!mems.length) {
          say([n.sleeping ? 'I was asleep! I heard nothing.' : 'No, nothing out of the ordinary. Why? Should I be worried?']);
          return;
        }
        let gained = 0;
        const lines = mems.map((m) => {
          gained += j.addTestimony(n, m);
          return this.memoryLine(n, m);
        });
        if (gained) lines.push(`(Journal updated: ${gained} new detail${gained > 1 ? 's' : ''})`);
        say(lines);
      },
    });
    // a cigarette shared with a smoker loosens their tongue: they pass on what they have heard
    if (n.smoker && this.player!.count('cigarettes') && n.ctl.cigDay !== sim.day()) {
      opts.push({
        text: 'Offer a cigarette.',
        action: () => {
          this.player!.take('cigarettes');
          n.ctl.cigDay = sim.day();
          n.suspicionOfPlayer = Math.max(0, n.suspicionOfPlayer - 0.2);
          const talk = n.role === 'killer' ? [] : n.memories
            .filter((m) => (m.source === 'told' || m.topic === 'prowler' || m.topic === 'leftHome') && m.actor !== n.id)
            .sort((a, b) => importanceOf(b) - importanceOf(a) || b.time - a.time)
            .slice(0, 2);
          let gained = 0;
          const lines = ['Thanks. Don\'t mind if I do.', ...talk.map((m) => {
            gained += j.addTestimony(n, m);
            return this.memoryLine(n, m);
          })];
          if (!talk.length) lines.push("Haven't heard anything worth repeating, though.");
          if (gained) lines.push(`(Journal updated: ${gained} new detail${gained > 1 ? 's' : ''})`);
          say(lines);
        },
      });
    }
    const known = [...j.residents.values()].filter((r) => r.named && r.id !== n.id);
    if (known.length) {
      opts.push({
        text: 'Ask about someone...',
        action: () => {
          const sub: DialogueOption[] = known.slice(0, 14).map((r) => ({
            text: fullName(sim.npc(r.id)!),
            action: () => say(this.aboutPerson(n, sim.npc(r.id)!)),
          }));
          sub.push({ text: 'Never mind.', action: () => this.ui.showDialogue(n, 'Anything else?', this.dialogueOptions(n)) });
          this.ui.showDialogue(n, 'Who do you want to know about?', sub);
        },
      });
    }
    const coatClue = j.clues.find((c) => c.attr === 'coat' && c.reliability > 0.3);
    if (coatClue) {
      opts.push({
        text: `Do you know anyone who wears a ${coatClue.value} coat?`,
        action: () => {
          const who = sim.npcs.filter((o) => o.alive && o.id !== n.id && o.app.coatName === coatClue.value && n.rel.some((r) => r.id === o.id && r.familiarity > 0.55));
          if (!who.length) {
            say([`A ${coatClue.value} coat? Can't say I've noticed.`]);
            return;
          }
          for (const o of who) {
            const r = j.resident(o.id);
            r.coat = o.app.coatName;
            if (!r.named) {
              r.named = true;
              r.address = sim.world.buildings[o.homeId].address;
            }
          }
          say([`${who.map((o) => fullName(o)).join(', ')} ${who.length > 1 ? 'wear' : 'wears'} one like that.`, '(Journal updated)']);
        },
      });
    }
    if (j.clues.some((c) => c.attr === 'smoker')) {
      opts.push({
        text: 'Who smokes around here?',
        action: () => {
          const who = sim.npcs.filter((o) => o.alive && o.id !== n.id && o.smoker && n.rel.some((r) => r.id === o.id && r.familiarity > 0.6)).slice(0, 5);
          for (const o of who) {
            const r = j.resident(o.id);
            r.smoker = true;
            r.named = true;
            r.address = sim.world.buildings[o.homeId].address;
          }
          say(who.length ? [`${who.map((o) => fullName(o)).join(', ')}. Filthy habit.`, '(Journal updated)'] : ['Nobody I know of. Not anymore.']);
        },
      });
    }
    opts.push({
      text: 'Where were you last night?',
      action: () => say([this.alibi(n)]),
    });
    if (n.role === 'police') {
      opts.push({ text: 'I want to report something.', action: () => say(this.playerReport(n)) });
    }
    if (n.job === 'chief') {
      story.flags.metChief = true;
      opts.push({
        text: 'Any progress on the case?',
        action: () => {
          const s = caseSummary(sim);
          say(s.length ? s.slice(-5) : ['Nothing yet. People are scared and nobody saw anything.']);
        },
      });
      opts.push({
        text: 'I know who the Night Neighbour is.',
        disabled: j.clues.length < 2,
        action: () => {
          const cands = sim.npcs.filter((o) => o.alive && !o.inCustody && o.role !== 'police' && j.residents.get(o.id)?.named);
          const sub: DialogueOption[] = cands.map((o) => {
            const fit = j.fit(o.id);
            return {
              text: `${fullName(o)}  (evidence: ${fit.score.toFixed(1)})`,
              action: () => {
                const r = story.accuse(o.id);
                say([r.reply], true);
                if (r.accepted) {
                  j.addLog(`You accused ${fullName(o)}. The police are bringing them in.`, 'event');
                  this.ui.message(`The police are going to arrest ${fullName(o)}.`, 'event');
                }
              },
            };
          });
          sub.push({ text: 'Not yet.', action: () => this.ui.showDialogue(n, 'Then stop wasting my time.', this.dialogueOptions(n)) });
          this.ui.showDialogue(n, 'Go on then. Who?', sub);
        },
      });
    }
    const station = this.stationOf(n);
    if (station) opts.push({ text: 'I would like to buy something.', action: () => this.ui.showTrade(n, station) });
    if (n.job === 'doctor' && n.activity?.kind === 'work') {
      opts.push({
        text: `Can you patch me up? ($25)`,
        disabled: p.money < 25 || p.health >= p.maxHealth - 1,
        action: () => {
          p.money -= 25;
          p.health = p.maxHealth;
          p.bleeding = 0;
          sim.emit({ type: 'ui', s: 'bandage' });
          say(['Hold still... There. Try not to get stabbed again.']);
        },
      });
    }
    opts.push({ text: 'Goodbye.', action: () => this.ui.closeDialog() });
    return opts;
  }

  stationOf(n: NpcState): Furniture | null {
    const sim = this.sim!;
    if (n.workId < 0 || n.building !== n.workId || n.activity?.kind !== 'work') return null;
    const b = sim.world.buildings[n.workId];
    if (!SHOP_STOCK[b.kind]?.length) return null;
    return sim.world.furniture.find((f) => f.buildingId === b.id && (f.use === 'register' || f.use === 'bartap' || f.use === 'stove' || f.use === 'exam' || f.use === 'desk' || f.use === 'workbench')) ?? null;
  }

  memoryLine(n: NpcState, m: Memory) {
    return memoryLine(this.sim!, n, m);
  }

  private aboutPerson(n: NpcState, o: NpcState): string[] {
    const sim = this.sim!;
    const j = this.journal!;
    const rel = n.rel.find((r) => r.id === o.id);
    const r = j.resident(o.id);
    const lines: string[] = [];
    if (!o.alive) return [`${o.first}? ${o.missing ? 'Nobody has seen them since that night.' : 'They are dead. I still cannot believe it.'}`];
    if (!rel || rel.familiarity < 0.45) return [`${o.first} ${o.last}? I don't really know them.`];
    lines.push(`${o.first} ${JOB_TITLE[o.job]} and lives at ${sim.world.buildings[o.homeId].address}.`);
    r.job = JOB_TITLE[o.job];
    r.address = sim.world.buildings[o.homeId].address;
    if (rel.familiarity > 0.6) {
      lines.push(`Always wears that ${o.app.coatName} coat of theirs when it's cold.`);
      r.coat = o.app.coatName;
    }
    if (o.smoker && rel.familiarity > 0.55) {
      lines.push('Smokes like a chimney.');
      r.smoker = true;
    } else if (rel.familiarity > 0.8) {
      lines.push("Never touches cigarettes, as far as I know.");
      r.smoker = false;
    }
    if (rel.kind === 'spouse') lines.push('We have been together for years.');
    else if (rel.affinity > 0.4) lines.push('A good friend.');
    else if (rel.affinity < -0.15) lines.push("Between you and me, I don't trust them.");
    if (o.role === 'killer' && rel.familiarity > 0.7 && n.traits.gossip > 0.55) lines.push(`Keeps odd hours lately. I've seen lights off over there when they should be home.`);
    if (o.role === 'burglar' && n.traits.gossip > 0.5) lines.push('Always short of money, that one. Asked me for a loan twice.');
    lines.push('(Journal updated)');
    return lines;
  }

  private alibi(n: NpcState): string {
    const sim = this.sim!;
    const lastNight = sim.nightIndex() - (sim.hour() > 12 ? 1 : 0);
    if (n.role === 'killer') return 'Home, asleep. Same as every night. Why do you ask?';
    if (n.role === 'burglar' && n.ctl.didNight === lastNight) return 'At home. Asleep. ...What, is that a crime now?';
    if (n.job === 'bartender') return 'Behind the bar until closing, then home.';
    if (n.job === 'officer' && n.schedule.workStart > 18) return 'On patrol, all night.';
    if (n.schedule.evening === 'bar') return 'At the bar for a while, then home to bed.';
    const hh = sim.households[n.household];
    return hh && hh.members.length > 1 ? 'At home, with my family.' : 'At home, alone. I went to bed early.';
  }

  /** the player reports what they know to an officer */
  private playerReport(o: NpcState): string[] {
    const sim = this.sim!;
    const lines: string[] = [];
    let n = 0;
    for (const inc of sim.incidents) {
      if (!this.story!.flags[`unreported_${inc.id}`]) continue;
      const v = sim.actors[inc.victim];
      if (!v) continue;
      const m = this.syntheticMemory('body', inc.victim, v.x, v.z, inc.id);
      policeCall(sim, null, [m], true);
      delete this.story!.flags[`unreported_${inc.id}`];
      lines.push(`You tell ${o.first} about the body of ${sim.actorName(inc.victim)}.`);
      n++;
    }
    if (!n) lines.push('You have nothing new to report. Evidence about the culprit should go to the chief.');
    else lines.push('"We are on it. Stay inside after dark."');
    return lines;
  }

  syntheticMemory(topic: Memory['topic'], subject: number, x: number, z: number, incident: number): Memory {
    return { id: -1, topic, source: 'saw', actor: -1, subject, desc: {}, x, z, time: this.sim!.time, confidence: 1, from: -1, incident, reported: false, shared: 0 };
  }

  /** phone call to the police station */
  phoneReport(kind: 'body' | 'prowler' | 'status'): string[] {
    const sim = this.sim!;
    sim.emit({ type: 'ui', s: 'phone' });
    if (kind === 'status') {
      const s = caseSummary(sim);
      return s.length ? s.slice(-4) : ['"Police. ...No, nothing new. Lock your doors."'];
    }
    if (kind === 'body') {
      const lines: string[] = [];
      for (const inc of sim.incidents) {
        if (!this.story!.flags[`unreported_${inc.id}`]) continue;
        const v = sim.actors[inc.victim];
        policeCall(sim, null, [this.syntheticMemory('body', inc.victim, v.x, v.z, inc.id)], true);
        delete this.story!.flags[`unreported_${inc.id}`];
        lines.push(`You report the body of ${sim.actorName(inc.victim)}. "Don't touch anything. Officers are on their way."`);
      }
      return lines.length ? lines : ['You have no body to report.'];
    }
    // prowler: the last hooded sighting
    const sight = [...this.journal!.log].reverse().find((l) => l.kind === 'sighting' && sim.time - l.time < 3 * 3600);
    if (!sight) return ['"Did you actually see someone? Call back when you have something."'];
    policeCall(sim, null, [{ ...this.syntheticMemory('prowler', -1, sim.player.x, sim.player.z, -1), source: 'saw', confidence: 0.6 }], true);
    return ['You describe the hooded figure. "We will send someone to take a look."'];
  }

  // ------------------------------------------------------------------ trade

  buy(item: string, price: number) {
    const p = this.sim!.player;
    if (p.money < price) {
      this.ui.message('You cannot afford that.', 'warn');
      return;
    }
    if (!this.player!.give(item, 1)) {
      this.ui.message('Your pockets are full.', 'warn');
      return;
    }
    p.money -= price;
    this.sim!.emit({ type: 'ui', s: 'coins' });
    this.ui.message(`Bought ${itemName(item)}.`);
  }

  sell(idx: number) {
    const p = this.sim!.player;
    const s = p.inventory[idx];
    if (!s) return;
    const def = ITEMS[s.item];
    if (!def || def.cat !== 'valuable') return;
    const price = Math.round(def.price * 0.7);
    this.player!.take(s.item, 1);
    p.money += price;
    this.sim!.emit({ type: 'ui', s: 'coins' });
    this.ui.message(`Sold ${def.name} for $${price}.`);
  }

  // ------------------------------------------------------------------ arrest of the player

  private arrestAttempt(o: NpcState) {
    if (this.arrestOfficer >= 0) return;
    this.arrestOfficer = o.id;
    this.openDialog();
    this.ui.showArrest(o);
  }

  comply() {
    const sim = this.sim!;
    const o = sim.npc(this.arrestOfficer);
    this.arrestOfficer = -1;
    this.ui.closeDialog();
    const p = sim.player;
    if (p.wantedLevel >= 2) {
      sim.jail(p, -1);
      return;
    }
    const pol = sim.world.buildings[sim.world.policeId];
    const cell = sim.world.rooms.find((r) => r.buildingId === pol.id && r.kind === 'cell');
    sim.jail(p, cell ? cell.id : -1);
    if (o) {
      o.activity = null;
      o.tasks = [];
    }
    this.ff = { until: this.nextMorning() + 1800, speed: 80, reason: 'custody', interrupted: false };
    this.ui.fade(true, 'A night in the cells...');
  }

  resist() {
    this.arrestOfficer = -1;
    this.ui.closeDialog();
    this.ui.message('Run!', 'warn');
  }

  private releasePlayer() {
    const sim = this.sim!;
    const p = sim.player;
    sim.release(p);
    p.wantedLevel = 0;
    p.money = Math.max(0, p.money - 40);
    this.story!.trust = Math.max(0, this.story!.trust - 1);
    for (const c of sim.cases) if (c.suspect === 0) c.status = 'closed';
    for (const n of sim.npcs) n.suspicionOfPlayer *= 0.5;
    this.ui.message('Released with a $40 fine. The chief will not forget this.', 'warn');
  }

  // ------------------------------------------------------------------ misc

  respawnFromSave() {
    const err = this.loadFrom('auto');
    if (err) this.ui.showError(err);
  }

  heightName(n: NpcState) {
    return heightClass(n.app.height);
  }

  actorsNear(x: number, z: number, r: number): ActorState[] {
    return this.sim ? this.sim.actors.filter((a) => Math.hypot(a.x - x, a.z - z) < r) : [];
  }
}

function importanceOf(m: Memory) {
  const order: Record<string, number> = { murder: 10, attack: 9, body: 8, missing: 7, breakin: 6, prowler: 6, blood: 5, scream: 4, glass: 4, fight: 4, theft: 4, trespass: 3, weapon: 3, leftHome: 2 };
  return (order[m.topic] ?? 1) + (m.source === 'saw' ? 0.5 : 0);
}
