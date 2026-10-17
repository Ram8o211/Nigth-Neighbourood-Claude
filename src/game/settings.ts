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

const KEY = 'nightneighbour.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const s = JSON.parse(raw) as Partial<Settings>;
    return { ...structuredClone(DEFAULT_SETTINGS), ...s, bindings: { ...DEFAULT_BINDINGS, ...(s.bindings ?? {}) } };
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
