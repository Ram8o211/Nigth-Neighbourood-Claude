import type { GenParams } from '../world/types';
import type { SimSnapshot } from '../sim/simulation';
import type { JournalData } from './journal';
import type { StoryData } from './story';
import { WORLD_VERSION } from '../world/gen/generator';
import { SIM_VERSION } from '../sim/simulation';

export const SAVE_VERSION = 2;

export interface SaveGame {
  saveVersion: number;
  worldVersion: number;
  simVersion: number;
  params: GenParams;
  savedAt: number;
  label: string;
  sim: SimSnapshot;
  journal: JournalData;
  story: StoryData;
  extra: { pitch: number; letter: string };
}

export interface SaveMeta {
  slot: string;
  label: string;
  savedAt: number;
  params: GenParams;
  valid: boolean;
  reason?: string;
}

const PREFIX = 'nightneighbour.save.';
export const SLOTS = ['auto', 'slot1', 'slot2', 'slot3'];

export function writeSave(slot: string, s: SaveGame): string | null {
  try {
    localStorage.setItem(PREFIX + slot, JSON.stringify(s));
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Storage is full or unavailable.';
  }
}

export function validate(s: unknown): string | null {
  if (!s || typeof s !== 'object') return 'Corrupt save data.';
  const g = s as Partial<SaveGame>;
  if (g.saveVersion !== SAVE_VERSION) return `Save format v${g.saveVersion ?? '?'} is outdated (current v${SAVE_VERSION}).`;
  if (g.worldVersion !== WORLD_VERSION) return 'This save was made with a different town generator and cannot be restored.';
  if (g.simVersion !== SIM_VERSION) return 'This save was made with an older simulation version.';
  if (!g.params || !g.sim || !g.journal || !g.story) return 'Save data is incomplete.';
  return null;
}

export function readSave(slot: string): { save: SaveGame | null; error: string | null } {
  try {
    const raw = localStorage.getItem(PREFIX + slot);
    if (!raw) return { save: null, error: 'Empty slot.' };
    const s = JSON.parse(raw);
    const err = validate(s);
    if (err) return { save: null, error: err };
    return { save: s as SaveGame, error: null };
  } catch {
    return { save: null, error: 'Corrupt save data.' };
  }
}

export function listSaves(): SaveMeta[] {
  const out: SaveMeta[] = [];
  for (const slot of SLOTS) {
    try {
      const raw = localStorage.getItem(PREFIX + slot);
      if (!raw) continue;
      const s = JSON.parse(raw) as SaveGame;
      const err = validate(s);
      out.push({ slot, label: s.label ?? slot, savedAt: s.savedAt ?? 0, params: s.params, valid: !err, reason: err ?? undefined });
    } catch {
      out.push({ slot, label: 'Corrupt save', savedAt: 0, params: { seed: '?', size: 'medium', density: 0.7, nights: 5 }, valid: false, reason: 'Corrupt save data.' });
    }
  }
  return out;
}

export function deleteSave(slot: string) {
  try {
    localStorage.removeItem(PREFIX + slot);
  } catch {
    /* ignore */
  }
}
