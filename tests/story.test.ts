import { describe, it, expect, beforeAll } from 'vitest';
import { makeSim, runHours } from './helpers';
import { Journal, trait, type ClueAttr } from '../src/game/journal';
import { Story } from '../src/game/story';
import { validate, readSave, writeSave, listSaves, SAVE_VERSION } from '../src/game/save';
import { loadSettings, DEFAULT_SETTINGS } from '../src/game/settings';
import { WORLD_VERSION } from '../src/world/gen/generator';
import { SIM_VERSION } from '../src/sim/simulation';
import type { NpcState } from '../src/sim/types';

function setup(seed: string, nights = 5) {
  const sim = makeSim(seed);
  const journal = new Journal(sim);
  const story = new Story(sim, journal, nights);
  let letter = '';
  story.begin((t) => (letter = t));
  return { sim, journal, story, letter: () => letter };
}

/** give the player physical evidence that matches a resident */
function evidenceAbout(journal: Journal, n: NpcState, attrs: ClueAttr[]) {
  for (const attr of attrs) {
    const value = trait(n, attr)!;
    journal.addClue({ source: 'physical', attr, value, reliability: 0.95, text: `${attr}: ${value}`, incident: 0, simClue: -1, from: -1 });
  }
}

describe('story setup', () => {
  it('starts the player at the bus stop with a key and the uncle’s letter', () => {
    const { sim, story, letter } = setup('story-a');
    const p = sim.player;
    expect(Math.hypot(p.x - sim.world.busStop.x, p.z - sim.world.busStop.z)).toBeLessThan(4);
    expect(p.inventory.some((s) => s.item === 'key' && s.tag === sim.world.playerHouseId)).toBe(true);
    expect(letter()).toContain('My dear nephew');
    // the letter carries a true hint about the killer
    const k = story.killer;
    expect(k.role).toBe('killer');
    story.update(0.5);
    expect(story.objectives[0].id).toBe('home');
    expect(story.ending).toBeNull();
  });
});

describe('accusation and endings', () => {
  it('rejects weak or contradictory accusations', () => {
    const { sim, journal, story } = setup('story-b');
    const k = story.killer;
    const innocent = sim.npcs.find((n) => n.role === 'resident' && n.app.coatName !== k.app.coatName && n.app.shoes !== k.app.shoes)!;
    // no evidence at all
    expect(story.accuse(innocent.id).accepted).toBe(false);
    // evidence points at the killer and away from the innocent
    evidenceAbout(journal, k, ['coat', 'shoes', 'height', 'hair']);
    const r = story.accuse(innocent.id);
    expect(r.accepted).toBe(false);
    expect(journal.fit(k.id).score).toBeGreaterThanOrEqual(3);
    expect(journal.fit(innocent.id).score).toBeLessThan(journal.fit(k.id).score);
  });

  it('a well-supported accusation gets the killer arrested and wins the game', () => {
    const { sim, journal, story } = setup('story-c');
    const k = story.killer;
    evidenceAbout(journal, k, ['coat', 'shoes', 'height', 'hair']);
    const r = story.accuse(k.id);
    expect(r.accepted).toBe(true);
    expect(sim.cases.some((c) => c.suspect === k.id)).toBe(true);
    // police go and pick the suspect up
    runHours(sim, 30, () => {
      story.update(0.05);
      return k.inCustody;
    });
    expect(k.inCustody).toBe(true);
    story.update(0.5);
    expect(story.ending?.kind).toBe('arrested');
    expect(story.ending?.win).toBe(true);
  });

  it('ends the game when the player dies', () => {
    const { sim, story } = setup('story-d');
    sim.player.alive = false;
    sim.player.health = 0;
    story.update(0.1);
    expect(story.ending?.kind).toBe('dead');
    expect(story.ending?.win).toBe(false);
  });

  it('ends the game when the nights run out', () => {
    const { sim, story } = setup('story-e', 3);
    sim.time = 3 * 86400 + 9 * 3600; // morning after the third night
    story.update(0.1);
    expect(story.ending?.kind).toBe('timeout');
  });

  it('saves and restores story and journal state', () => {
    const { journal, story, sim } = setup('story-f');
    evidenceAbout(journal, story.killer, ['coat']);
    story.flags.letterRead = true;
    story.trust = 1;
    const j2 = new Journal(sim);
    j2.fromData(JSON.parse(JSON.stringify(journal.toData())));
    const s2 = new Story(sim, j2, 5);
    s2.fromData(JSON.parse(JSON.stringify(story.toData())));
    expect(j2.clues.length).toBe(journal.clues.length);
    expect(s2.flags.letterRead).toBe(true);
    expect(s2.trust).toBe(1);
    expect(j2.fit(story.killer.id).score).toBeCloseTo(journal.fit(story.killer.id).score);
  });
});

describe('save files', () => {
  beforeAll(() => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    } as Storage;
  });

  const good = () => ({ saveVersion: SAVE_VERSION, worldVersion: WORLD_VERSION, simVersion: SIM_VERSION, params: { seed: 'x', size: 'small', density: 0.7, nights: 5 }, savedAt: 1, label: 'test', sim: { version: SIM_VERSION }, journal: {}, story: {}, extra: { pitch: 0, letter: '' } });

  it('accepts current saves and rejects outdated or broken ones', () => {
    expect(validate(good())).toBeNull();
    expect(validate({ ...good(), saveVersion: SAVE_VERSION - 1 })).toMatch(/outdated/);
    expect(validate({ ...good(), worldVersion: WORLD_VERSION + 1 })).toMatch(/generator/);
    expect(validate({ ...good(), simVersion: SIM_VERSION - 1 })).toMatch(/older simulation/);
    expect(validate({ ...good(), sim: undefined })).toMatch(/incomplete/);
    expect(validate({ saveVersion: SAVE_VERSION })).toMatch(/incomplete/);
    expect(validate({ ...good(), sim: { bogus: true } })).toMatch(/damaged/);
    expect(validate(null)).toMatch(/Corrupt/);
  });

  it('ignores foreign or malformed settings (Pages sites share one origin)', () => {
    const KEY = 'night-neighbour-beta/settings.v1';
    localStorage.setItem(KEY, JSON.stringify({ quality: 'ultra', fov: 'wide', brightness: 1.3, master: null, sensitivity: -50, music: 1e6, bindings: { forward: 42, back: 'KeyX', left: '<img>' } }));
    const s = loadSettings();
    expect(s.quality).toBe(DEFAULT_SETTINGS.quality);
    expect(s.fov).toBe(DEFAULT_SETTINGS.fov);
    expect(s.master).toBe(DEFAULT_SETTINGS.master);
    expect(s.brightness).toBe(1.3);
    expect(s.bindings.forward).toBe('KeyW');
    expect(s.bindings.back).toBe('KeyX');
    expect(s.bindings.left).toBe('KeyA');
    expect(s.sensitivity).toBe(0.2); // clamped to the slider range
    expect(s.music).toBe(1);
    localStorage.setItem(KEY, 'null');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    localStorage.setItem(KEY, '{broken');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    localStorage.removeItem(KEY);
  });

  it('reports corrupt and empty slots without throwing', () => {
    expect(readSave('slot2').error).toMatch(/Empty/);
    localStorage.setItem('night-neighbour-beta/save.slot3', '{not json');
    expect(readSave('slot3').error).toMatch(/Corrupt/);
    expect(writeSave('slot1', good() as never)).toBeNull();
    expect(readSave('slot1').save?.label).toBe('test');
    const list = listSaves();
    expect(list.find((s) => s.slot === 'slot1')?.valid).toBe(true);
    expect(list.find((s) => s.slot === 'slot3')?.valid).toBe(false);
  });
});
