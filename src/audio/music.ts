// Generative, state-driven soundtrack. Each state has its own layer of
// synthesised voices; layers crossfade as the game state changes.

export type MusicState = 'silent' | 'menu' | 'day' | 'night' | 'tension' | 'danger';

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

interface Layer {
  gain: GainNode;
  next: number; // next scheduled event time
  step: number;
}

export class Music {
  out: GainNode;
  private layers = new Map<MusicState, Layer>();
  state: MusicState = 'silent';
  private reverb: ConvolverNode;
  private drones: { osc: OscillatorNode[]; gain: GainNode; state: MusicState }[] = [];
  private seed = 1;

  constructor(private ctx: AudioContext, dest: AudioNode) {
    this.out = ctx.createGain();
    this.out.gain.value = 0.5;
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(3.2, 2.2);
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    this.reverb.connect(wet);
    wet.connect(this.out);
    this.out.connect(dest);
    for (const s of ['menu', 'day', 'night', 'tension', 'danger'] as MusicState[]) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.out);
      g.connect(this.reverb);
      this.layers.set(s, { gain: g, next: 0, step: 0 });
    }
    // sustained drones per state
    this.addDrone('menu', [midi(38), midi(45)], 'sawtooth', 260, 0.05);
    this.addDrone('night', [midi(33), midi(33) * 1.006, midi(40)], 'sawtooth', 180, 0.06);
    this.addDrone('tension', [midi(36), midi(37)], 'sawtooth', 320, 0.05);
    this.addDrone('danger', [midi(31), midi(32)], 'sawtooth', 400, 0.08);
    this.addDrone('day', [midi(50), midi(57)], 'triangle', 900, 0.025);
  }

  private rand() {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  private impulse(sec: number, decay: number) {
    const len = Math.floor(this.ctx.sampleRate * sec);
    const b = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return b;
  }

  private addDrone(state: MusicState, freqs: number[], type: OscillatorType, cutoff: number, level: number) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = level;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07 + this.rand() * 0.05;
    const lfoG = ctx.createGain();
    lfoG.gain.value = cutoff * 0.4;
    lfo.connect(lfoG);
    lfoG.connect(f.frequency);
    lfo.start();
    const oscs = freqs.map((fr) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = fr;
      o.detune.value = (this.rand() - 0.5) * 12;
      o.connect(f);
      o.start();
      return o;
    });
    f.connect(g);
    g.connect(this.layers.get(state)!.gain);
    this.drones.push({ osc: oscs, gain: g, state });
  }

  setState(s: MusicState) {
    if (s === this.state) return;
    this.state = s;
    const now = this.ctx.currentTime;
    for (const [k, l] of this.layers) {
      const target = k === s ? 1 : 0;
      l.gain.gain.cancelScheduledValues(now);
      l.gain.gain.setValueAtTime(l.gain.gain.value, now);
      l.gain.gain.linearRampToValueAtTime(target, now + (target ? 3.5 : 2.5));
      if (target) l.next = Math.max(l.next, now + 0.1);
    }
  }

  private note(dest: AudioNode, t: number, freq: number, dur: number, type: OscillatorType, vol: number, attack = 0.005, cutoff = 4000) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    o.connect(f);
    f.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** a soft music-box / piano like pluck: fundamental + inharmonic partial */
  private pluck(dest: AudioNode, t: number, freq: number, vol: number, dur = 2.5) {
    this.note(dest, t, freq, dur, 'sine', vol, 0.003, 6000);
    this.note(dest, t, freq * 2.01, dur * 0.4, 'sine', vol * 0.25, 0.002, 6000);
    this.note(dest, t, freq * 4.2, dur * 0.15, 'sine', vol * 0.08, 0.001, 8000);
  }

  private kick(dest: AudioNode, t: number, vol: number) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + 0.4);
  }

  /** schedule upcoming events for the audible layers */
  update() {
    const now = this.ctx.currentTime;
    const ahead = now + 0.6;
    for (const [state, l] of this.layers) {
      if (l.gain.gain.value < 0.01 && state !== this.state) continue;
      while (l.next < ahead) {
        const t = Math.max(l.next, now + 0.02);
        this.schedule(state, l, t);
      }
    }
  }

  private schedule(state: MusicState, l: Layer, t: number) {
    const dest = l.gain;
    const r = () => this.rand();
    switch (state) {
      case 'menu': {
        // a slow, slightly broken lullaby in D minor
        const tune = [62, 65, 69, 67, 65, 64, 62, 57, 58, 62, 65, 64, 62, 61, 62, -1];
        const n = tune[l.step % tune.length];
        if (n > 0) this.pluck(dest, t, midi(n + 12) * (1 + (r() - 0.5) * 0.004), 0.12);
        if (l.step % 4 === 0) this.pluck(dest, t, midi(n > 0 ? n - 12 : 50), 0.07, 4);
        l.step++;
        l.next = t + (l.step % 8 === 7 ? 1.6 : 0.8);
        break;
      }
      case 'day': {
        // gentle, airy chords
        const chords = [
          [62, 66, 69, 73],
          [59, 62, 66, 69],
          [55, 59, 62, 66],
          [57, 61, 64, 69],
        ];
        const c = chords[Math.floor(l.step / 4) % chords.length];
        if (l.step % 4 === 0) for (const n of c) this.note(dest, t, midi(n), 5.5, 'triangle', 0.03, 1.6, 1800);
        if (r() < 0.45) this.pluck(dest, t + 0.1, midi(c[Math.floor(r() * c.length)] + 12), 0.05);
        l.step++;
        l.next = t + 1.4;
        break;
      }
      case 'night': {
        // sparse dissonant tones and silence
        if (r() < 0.55) {
          const base = [45, 46, 51, 52, 57, 58][Math.floor(r() * 6)];
          this.note(dest, t, midi(base), 6, 'sine', 0.06, 2, 1200);
          if (r() < 0.4) this.note(dest, t + 0.5, midi(base + 1), 6, 'sine', 0.035, 2.5, 1000);
        }
        if (r() < 0.2) this.pluck(dest, t, midi(81 + Math.floor(r() * 4)), 0.025, 4);
        l.step++;
        l.next = t + 4 + r() * 5;
        break;
      }
      case 'tension': {
        // pulse and tremolo cluster
        this.note(dest, t, midi(l.step % 2 ? 37 : 36), 0.9, 'sawtooth', 0.05, 0.02, 500);
        if (l.step % 8 === 0) for (const n of [72, 73, 75]) this.note(dest, t, midi(n), 3.5, 'sawtooth', 0.012, 1.2, 2200);
        l.step++;
        l.next = t + 0.85;
        break;
      }
      case 'danger': {
        // racing heart, stabs
        const beat = l.step % 4;
        if (beat === 0 || beat === 1) this.kick(dest, t, beat === 0 ? 0.5 : 0.35);
        if (l.step % 16 === 8) for (const n of [48, 49, 55, 60]) this.note(dest, t, midi(n), 0.6, 'sawtooth', 0.05, 0.005, 1800);
        if (l.step % 2 === 0) this.note(dest, t, midi(36 + (l.step % 8 < 4 ? 0 : 1)), 0.25, 'square', 0.04, 0.005, 300);
        l.step++;
        l.next = t + 0.24;
        break;
      }
    }
  }
}
