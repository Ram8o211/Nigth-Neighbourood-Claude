import type { Quality } from '../render/renderer';
import { DEFAULT_BINDINGS, type Action } from './input';

export interface Settings {
  quality: Quality;
  brightness: number;
  fov: number;
  sensitivity: number;
  invertY: boolean;
  headBob: boolean;
  post: boolean;
  showFps: boolean;
  master: number;
  music: number;
  sfx: number;
  ambience: number;
  hrtf: boolean;
  bindings: Record<Action, string>;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'medium',
  brightness: 1,
  fov: 72,
  sensitivity: 1,
  invertY: false,
  headBob: true,
  post: true,
  showFps: false,
  master: 0.8,
  music: 0.55,
  sfx: 0.9,
  ambience: 0.7,
  hrtf: false,
  bindings: { ...DEFAULT_BINDINGS },
};

/**
 * All of an account's GitHub Pages sites share one origin (and so one
 * localStorage), so keys carry a project-specific prefix.
 */
const KEY = 'night-neighbour-beta/settings.v1';
const QUALITIES: Quality[] = ['low', 'medium', 'high'];
/** the same ranges the settings sliders allow */
const RANGES: Partial<Record<keyof Settings, [number, number]>> = {
  brightness: [0.6, 1.8],
  fov: [55, 95],
  sensitivity: [0.2, 3],
  master: [0, 1],
  music: [0, 1],
  sfx: [0, 1],
  ambience: [0, 1],
};

export function loadSettings(): Settings {
  const out = structuredClone(DEFAULT_SETTINGS);
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return out;
    const s = JSON.parse(raw) as Record<string, unknown> | null;
    if (!s || typeof s !== 'object') return out;
    // take only well-typed values; anything else keeps its default
    const o = out as unknown as Record<string, unknown>;
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      if (k === 'bindings' || !(k in s)) continue;
      const v = s[k];
      const def = DEFAULT_SETTINGS[k];
      if (typeof v !== typeof def) continue;
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) continue;
        const r = RANGES[k];
        o[k] = r ? Math.min(r[1], Math.max(r[0], v)) : v;
        continue;
      }
      o[k] = v;
    }
    if (!QUALITIES.includes(out.quality)) out.quality = DEFAULT_SETTINGS.quality;
    const b = s.bindings as Record<string, unknown> | undefined;
    if (b && typeof b === 'object')
      for (const a of Object.keys(DEFAULT_BINDINGS) as Action[]) if (typeof b[a] === 'string' && /^[A-Za-z0-9]+$/.test(b[a] as string)) out.bindings[a] = b[a] as string;
    return out;
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}
