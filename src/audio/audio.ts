import { synthesizeAll, SR } from './synth';
import { Music, type MusicState } from './music';
import type { SimEvent } from '../sim/types';
import type { WorldGrid } from '../world/grid';

interface Loop {
  src: AudioBufferSourceNode;
  gain: GainNode;
  target: number;
}

const SURFACE_STEP: Record<string, string> = {
  grass: 'step_grass',
  dirt: 'step_dirt',
  gravel: 'step_gravel',
  asphalt: 'step_asphalt',
  concrete: 'step_concrete',
  wood: 'step_wood',
  tile: 'step_tile',
  carpet: 'step_carpet',
};

/** maps simulation sound kinds onto synthesized samples */
const KIND_SAMPLE: Record<string, string> = {
  door_open: 'door_open',
  door_close: 'door_close',
  lock: 'lock',
  unlock: 'unlock',
  knock: 'knock',
  handle: 'handle',
  glass: 'glass',
  glass_crack: 'glass_crack',
  hit: 'hit',
  thud: 'thud',
  block: 'block',
  swing: 'swing',
  hurt: 'hurt',
  scream: 'scream',
  death: 'death',
  kick: 'kick',
  door_force: 'door_force',
  board_hit: 'board_hit',
  boards_break: 'boards_break',
  hammer: 'hammer',
  pry: 'pry',
  lockpick: 'lockpick',
  rummage: 'rummage',
  wardrobe: 'wardrobe',
  climb: 'climb',
};

/**
 * Web Audio engine: synthesized sample bank, positional playback with wall
 * occlusion, ambience beds and the generative music.
 */
export class AudioEngine {
  ctx: AudioContext | null = null;
  master!: GainNode;
  sfx!: GainNode;
  amb!: GainNode;
  ui!: GainNode;
  music: Music | null = null;
  buffers = new Map<string, AudioBuffer[]>();
  private loops = new Map<string, Loop>();
  volumes = { master: 0.8, music: 0.55, sfx: 0.9, ambience: 0.7 };
  hrtf = false;
  grid: WorldGrid | null = null;
  private listener = { x: 0, y: 0, z: 0, yaw: 0 };
  private voices = 0;
  private heartT = 0;
  private breathT = 0;
  ready = false;
  private randomT = 8;

  /**
   * Create (or wake) the audio context. Cheap; call it synchronously inside the tap or click that
   * starts the game, because iOS only lets a context start from within a user gesture.
   */
  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      try {
        this.ctx = new Ctx();
      } catch {
        return;
      }
    }
    this.wake();
  }

  /** resume a context the browser suspended or interrupted (iOS after a call) */
  wake() {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  /** builds the sound bank and mixer; call after unlock() */
  async init() {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.ready) {
      if (ctx.state !== 'running') await ctx.resume();
      return;
    }
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp);
    comp.connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.amb = ctx.createGain();
    this.ui = ctx.createGain();
    this.sfx.connect(this.master);
    this.amb.connect(this.master);
    this.ui.connect(this.master);
    const raw = synthesizeAll();
    for (const [k, list] of raw) {
      this.buffers.set(
        k,
        list.map((d) => {
          const b = ctx.createBuffer(1, d.length, SR);
          b.copyToChannel(d as Float32Array<ArrayBuffer>, 0);
          return b;
        }),
      );
    }
    this.music = new Music(ctx, this.master);
    for (const k of ['amb_wind', 'amb_crickets', 'amb_birds', 'amb_traffic', 'amb_hum']) this.startLoop(k);
    this.applyVolumes();
    this.ready = true;
    if (ctx.state !== 'running') await ctx.resume();
  }

  applyVolumes() {
    if (!this.ctx || !this.ready) return;
    this.master.gain.value = this.volumes.master;
    this.sfx.gain.value = this.volumes.sfx;
    this.amb.gain.value = this.volumes.ambience;
    this.ui.gain.value = Math.min(1, this.volumes.sfx);
    if (this.music) this.music.out.gain.value = this.volumes.music * 0.6;
  }

  private startLoop(name: string) {
    const ctx = this.ctx!;
    const b = this.buffers.get(name)?.[0];
    if (!b) return;
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain);
    gain.connect(this.amb);
    src.start(0, Math.random() * b.duration);
    this.loops.set(name, { src, gain, target: 0 });
  }

  setListener(x: number, y: number, z: number, yaw: number) {
    this.listener = { x, y, z, yaw };
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const fx = Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(x, t, 0.02);
      l.positionY.setTargetAtTime(y, t, 0.02);
      l.positionZ.setTargetAtTime(z, t, 0.02);
      l.forwardX.setTargetAtTime(fx, t, 0.02);
      l.forwardY.setTargetAtTime(0, t, 0.02);
      l.forwardZ.setTargetAtTime(fz, t, 0.02);
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      l.setPosition(x, y, z);
      l.setOrientation(fx, 0, fz, 0, 1, 0);
    }
  }

  /** play a sample, optionally at a world position (radius = audible distance) */
  play(name: string, opts: { x?: number; y?: number; z?: number; radius?: number; gain?: number; rate?: number; ui?: boolean } = {}) {
    if (!this.ctx || !this.ready) return;
    const list = this.buffers.get(name);
    if (!list || !list.length) return;
    if (this.voices > 40) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = list[Math.floor(Math.random() * list.length)];
    src.playbackRate.value = (opts.rate ?? 1) * (0.94 + Math.random() * 0.12);
    const g = ctx.createGain();
    g.gain.value = opts.gain ?? 1;
    let node: AudioNode = src;
    if (opts.x !== undefined && opts.z !== undefined) {
      const r = opts.radius ?? 15;
      const dx = opts.x - this.listener.x;
      const dz = opts.z - this.listener.z;
      const d = Math.hypot(dx, dz);
      if (d > r * 2.2) return;
      // walls muffle sound
      let occ = 1;
      if (this.grid && d > 1.5) occ = this.grid.soundOcclusion(this.listener.x, this.listener.z, opts.x, opts.z);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 400 + 19000 * occ * occ;
      node.connect(lp);
      node = lp;
      g.gain.value *= 0.35 + 0.65 * occ;
      const p = ctx.createPanner();
      p.panningModel = this.hrtf ? 'HRTF' : 'equalpower';
      p.distanceModel = 'inverse';
      p.refDistance = Math.max(1, r / 7);
      p.maxDistance = r * 2.5;
      p.rolloffFactor = 1.4;
      p.positionX.value = opts.x;
      p.positionY.value = opts.y ?? this.listener.y;
      p.positionZ.value = opts.z;
      node.connect(p);
      node = p;
    }
    node.connect(g);
    g.connect(opts.ui ? this.ui : this.sfx);
    this.voices++;
    src.onended = () => {
      this.voices--;
      g.disconnect();
    };
    src.start();
  }

  /** translate simulation events into sound */
  onEvent(e: SimEvent, playerId = 0) {
    switch (e.type) {
      case 'sound': {
        const k = e.s ?? '';
        if (k === 'footstep') return;
        const name = KIND_SAMPLE[k];
        if (!name) return;
        const rad = Math.max(6, e.v ?? 10);
        const gain = k === 'lockpick' ? 0.5 : k === 'scream' || k === 'glass' ? 1 : 0.85;
        this.play(name, { x: e.x, y: e.y, z: e.z, radius: rad, gain });
        break;
      }
      case 'step': {
        const name = SURFACE_STEP[e.s ?? 'grass'] ?? 'step_grass';
        const own = e.a === playerId;
        const loud = e.v ?? 5;
        this.play(name, { x: e.x, y: e.y, z: e.z, radius: own ? 8 : 6 + loud * 1.6, gain: own ? 0.35 + loud / 40 : 0.25 + loud / 30 });
        break;
      }
      case 'ui':
        if (e.s === 'click' || e.s === 'switch') this.play(e.s === 'click' ? 'click' : 'switch', { ui: true, gain: 0.6 });
        else if (e.s === 'eat') this.play('eat', { ui: true });
        else if (e.s === 'bandage') this.play('bandage', { ui: true });
        else if (e.s === 'equip') this.play('equip', { ui: true });
        else if (e.s === 'pickup') this.play('pickup', { ui: true });
        else if (e.s === 'coins') this.play('coins', { ui: true });
        else if (e.s === 'page') this.play('page', { ui: true });
        else if (e.s === 'phone') this.play('phone', { ui: true, gain: 0.5 });
        break;
      case 'smoke':
        break;
      case 'body_found':
      case 'missing':
      case 'stinger':
        this.play('stinger', { ui: true, gain: 0.7 });
        break;
    }
  }

  /** ambience mix and body sounds driven by the game state */
  updateAmbience(dt: number, s: { indoor: boolean; night: number; hour: number; fear: number; stamina: number; health: number; music: MusicState; sprinting: boolean }) {
    if (!this.ctx || !this.ready) return;
    const day = 1 - s.night;
    const set = (k: string, v: number) => {
      const l = this.loops.get(k);
      if (!l) return;
      l.target = v;
      l.gain.gain.value += (v - l.gain.gain.value) * Math.min(1, dt * 1.5);
    };
    const out = s.indoor ? 0.25 : 1;
    set('amb_wind', (0.25 + s.night * 0.35) * out + (s.indoor ? 0.04 : 0));
    set('amb_crickets', s.night * 0.35 * out);
    set('amb_birds', day * (s.hour > 6 && s.hour < 19 ? 0.3 : 0) * out);
    set('amb_traffic', day * 0.12 * out);
    set('amb_hum', s.indoor ? 0.25 : 0);
    this.music?.setState(s.music);
    this.music?.update();
    // heartbeat when afraid or badly hurt
    const heart = Math.max(s.fear / 100, s.health < 35 ? 1 - s.health / 35 : 0);
    if (heart > 0.25) {
      this.heartT -= dt;
      if (this.heartT <= 0) {
        this.heartT = 1.1 - heart * 0.55;
        this.play('heartbeat', { ui: true, gain: 0.25 + heart * 0.5 });
      }
    }
    if (s.stamina < 35 || (s.sprinting && s.stamina < 60)) {
      this.breathT -= dt;
      if (this.breathT <= 0) {
        this.breathT = 1.3 + s.stamina / 60;
        this.play('breath', { ui: true, gain: 0.35 * (1 - s.stamina / 70) + 0.08 });
      }
    }
    // distant night sounds: dogs, owls, the odd creak
    this.randomT -= dt;
    if (this.randomT <= 0) {
      this.randomT = 12 + Math.random() * 25;
      if (s.night > 0.5 && !s.indoor) {
        const a = Math.random() * Math.PI * 2;
        const d = 35 + Math.random() * 40;
        const x = this.listener.x + Math.cos(a) * d;
        const z = this.listener.z + Math.sin(a) * d;
        this.play(Math.random() < 0.5 ? 'dog' : 'owl', { x, z, y: 3, radius: 90, gain: 0.5 });
      } else if (s.indoor && s.night > 0.5 && Math.random() < 0.5) this.play('creak', { ui: true, gain: 0.25 });
    }
  }

  suspend() {
    this.ctx?.suspend().catch(() => {});
  }

  resume() {
    this.ctx?.resume().catch(() => {});
  }
}
