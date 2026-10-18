import type { Simulation } from '../sim/simulation';
import type { Clue, HeightClass, Memory, NpcState, ShoeType } from '../sim/types';
import { fullName, hairName, heightClass, JOB_TITLE } from '../sim/population';
import { formatClock } from '../core/math';
import { memoryLine } from '../sim/memory';

export type ClueAttr = 'coat' | 'shoes' | 'height' | 'hair' | 'smoker' | 'identity' | 'outside';

export interface JournalClue {
  id: number;
  source: 'physical' | 'witness' | 'sighting' | 'police' | 'letter';
  attr: ClueAttr;
  value: string;
  reliability: number;
  text: string;
  time: number;
  incident: number;
  simClue: number;
  from: number;
}

export interface ResidentInfo {
  id: number;
  named: boolean;
  height?: HeightClass;
  coat?: string;
  shoes?: ShoeType;
  hair?: string;
  smoker?: boolean;
  job?: string;
  address?: string;
  lastSeen: number;
}

export interface LogEntry {
  time: number;
  text: string;
  kind: 'event' | 'note' | 'sighting' | 'testimony';
}

export interface JournalData {
  clues: JournalClue[];
  residents: ResidentInfo[];
  log: LogEntry[];
  heard: string[];
}

/** what the player has learned; the basis of deductions and accusations */
export class Journal {
  clues: JournalClue[] = [];
  residents = new Map<number, ResidentInfo>();
  log: LogEntry[] = [];
  /** keys of testimony already converted, to avoid duplicates */
  heard = new Set<string>();
  private nextId = 1;

  constructor(private sim: Simulation) {}

  resident(id: number): ResidentInfo {
    let r = this.residents.get(id);
    if (!r) {
      r = { id, named: false, lastSeen: -1 };
      this.residents.set(id, r);
    }
    return r;
  }

  addLog(text: string, kind: LogEntry['kind'] = 'event') {
    const last = this.log[this.log.length - 1];
    if (last && last.text === text) return;
    this.log.push({ time: this.sim.time, text, kind });
    if (this.log.length > 300) this.log.shift();
  }

  addClue(c: Omit<JournalClue, 'id' | 'time'>): JournalClue | null {
    // de-duplicate identical facts about the same incident
    const dup = this.clues.find((x) => x.attr === c.attr && x.value === c.value && x.incident === c.incident && x.source === c.source && (c.simClue < 0 || x.simClue === c.simClue));
    if (dup) {
      dup.reliability = Math.max(dup.reliability, c.reliability);
      return null;
    }
    const clue: JournalClue = { ...c, id: this.nextId++, time: this.sim.time };
    this.clues.push(clue);
    return clue;
  }

  /** physical evidence found in the world */
  addSimClue(c: Clue): JournalClue | null {
    if (!c.found) {
      c.found = true;
      c.foundTime = this.sim.time;
    }
    const attr = (c.attr === 'none' ? 'outside' : c.attr) as ClueAttr;
    if (c.attr === 'none') {
      this.addLog(c.text, 'note');
      return null;
    }
    const added = this.addClue({ source: 'physical', attr, value: c.value, reliability: c.reliability, text: c.text, incident: c.incident, simClue: c.id, from: -1 });
    if (added) this.addLog(`Evidence: ${c.text}`, 'note');
    return added;
  }

  /** testimony from a resident's memory; keeps the distinction between saw / heard / told */
  addTestimony(npc: NpcState, m: Memory) {
    const key = `${npc.id}:${m.id}`;
    if (this.heard.has(key)) return 0;
    this.heard.add(key);
    const line = memoryLine(this.sim, npc, m);
    this.addLog(`${fullName(npc)}: "${line}"`, 'testimony');
    const rel = m.confidence * (m.source === 'saw' ? 1 : m.source === 'heard' ? 0.5 : m.source === 'told' ? 0.55 : 0.35);
    const serious = ['murder', 'attack', 'prowler', 'breakin', 'trespass', 'blood', 'weapon'].includes(m.topic);
    let n = 0;
    if (!serious && m.topic !== 'leftHome') return 0;
    const d = m.desc;
    const add = (attr: ClueAttr, value: string | undefined) => {
      if (!value) return;
      if (this.addClue({ source: 'witness', attr, value, reliability: rel * (m.topic === 'leftHome' ? 0.3 : 1), text: `${fullName(npc)} ${m.source === 'saw' ? 'saw' : 'heard about'} ${attrPhrase(attr, value)}.`, incident: m.incident, simClue: -1, from: npc.id })) n++;
    };
    if (m.topic === 'leftHome') {
      if (m.actor >= 0 && m.actor !== 0) add('outside', String(m.actor));
      return n;
    }
    if (d.height) add('height', d.height);
    if (d.coat) add('coat', d.coat);
    if (d.hair && d.hair !== 'a cap') add('hair', d.hair);
    if (d.shoes) add('shoes', d.shoes);
    if (m.actor >= 0 && m.actor !== 0 && (m.topic === 'murder' || m.topic === 'attack' || m.topic === 'prowler' || m.topic === 'breakin')) add('identity', String(m.actor));
    return n;
  }

  /** the player looks at a resident: learn their visible traits */
  observe(n: NpcState, clarity: number, dist: number) {
    const r = this.resident(n.id);
    r.lastSeen = this.sim.time;
    const hooded = n.outfit === 'night';
    if (clarity > 0.25 && dist < 18) r.height = heightClass(n.app.height);
    if (clarity > 0.45 && dist < 12 && (n.building < 0 || hooded)) r.coat = n.app.coatName;
    if (clarity > 0.55 && dist < 8 && !hooded && n.app.hairStyle !== 'bald' && n.app.hairStyle !== 'cap') r.hair = hairName(n.app.hair);
    if (clarity > 0.6 && dist < 4.5) r.shoes = n.app.shoes;
    if (n.anim === 'smoke' && dist < 15) {
      if (!r.smoker) this.addLog(`You noticed ${r.named ? fullName(n) : 'a neighbour'} smoking.`, 'note');
      r.smoker = true;
    }
  }

  meet(n: NpcState) {
    const r = this.resident(n.id);
    if (!r.named) this.addLog(`Met ${fullName(n)}, who ${JOB_TITLE[n.job]}.`, 'note');
    r.named = true;
    r.job = JOB_TITLE[n.job];
    r.address = this.sim.world.buildings[n.homeId].address;
  }

  /** a hooded figure or a resident seen out at night */
  sighting(n: NpcState, clarity: number, dist: number, identified: boolean) {
    const where = this.sim.placeName(n.x, n.z);
    const hooded = n.outfit === 'night';
    const when = formatClock(this.sim.time);
    const key = `sight:${n.id}:${Math.floor(this.sim.time / 1800)}`;
    if (this.heard.has(key)) return;
    this.heard.add(key);
    if (hooded) {
      const parts: string[] = [];
      if (clarity > 0.15) parts.push(heightClass(n.app.height) === 'average' ? 'average height' : heightClass(n.app.height));
      if (clarity > 0.4) parts.push(`${n.app.coatName} coat`);
      const desc = parts.length ? parts.join(', ') : 'too dark to make out';
      this.addLog(`${when} - You saw a hooded figure ${where} (${desc})${identified ? `. It was ${fullName(n)}!` : '.'}`, 'sighting');
      if (clarity > 0.15) this.addClue({ source: 'sighting', attr: 'height', value: heightClass(n.app.height), reliability: Math.min(1, clarity + 0.2), text: `You saw the hooded figure yourself: ${heightClass(n.app.height)}.`, incident: -1, simClue: -1, from: 0 });
      if (clarity > 0.4) this.addClue({ source: 'sighting', attr: 'coat', value: n.app.coatName, reliability: Math.min(1, clarity + 0.2), text: `You saw the hooded figure wearing a ${n.app.coatName} coat.`, incident: -1, simClue: -1, from: 0 });
      if (identified) this.addClue({ source: 'sighting', attr: 'identity', value: String(n.id), reliability: Math.min(1, clarity + 0.1), text: `You recognised ${fullName(n)} under the hood.`, incident: -1, simClue: -1, from: 0 });
    } else if (identified) {
      this.addLog(`${when} - You saw ${fullName(n)} out ${where}.`, 'sighting');
      this.addClue({ source: 'sighting', attr: 'outside', value: String(n.id), reliability: 0.4, text: `${fullName(n)} was out ${where} at ${when}.`, incident: -1, simClue: -1, from: 0 });
    }
  }

  /** how well a resident fits the evidence: positive supports guilt (uses true traits, as the police would check) */
  fit(id: number): { score: number; matches: string[]; conflicts: string[] } {
    const n = this.sim.npc(id);
    const res = { score: 0, matches: [] as string[], conflicts: [] as string[] };
    if (!n) return res;
    const seen = new Set<string>();
    for (const c of this.clues) {
      const key = `${c.attr}:${c.value}:${c.source}:${c.incident}:${c.from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const val = trait(n, c.attr);
      if (c.attr === 'identity') {
        if (c.value === String(id)) {
          res.score += 2.6 * c.reliability;
          res.matches.push(c.text);
        } else res.score -= 0.4 * c.reliability;
        continue;
      }
      if (c.attr === 'outside') {
        if (c.value === String(id)) {
          res.score += 0.4 * c.reliability;
          res.matches.push(c.text);
        }
        continue;
      }
      if (val === undefined) continue;
      if (val === c.value) {
        res.score += c.reliability;
        res.matches.push(c.text);
      } else {
        res.score -= 1.6 * c.reliability;
        res.conflicts.push(c.text);
      }
    }
    return res;
  }

  /** what the player knows about a resident (for the suspects page) */
  knownFit(id: number) {
    const r = this.residents.get(id);
    const out: { attr: ClueAttr; value: string; state: 'match' | 'conflict' | 'unknown' }[] = [];
    const attrs = new Map<ClueAttr, string>();
    for (const c of this.clues) if (c.attr !== 'identity' && c.attr !== 'outside' && c.reliability > 0.3) attrs.set(c.attr, c.value);
    for (const [attr, value] of attrs) {
      const known = r ? (attr === 'smoker' ? (r.smoker === undefined ? undefined : r.smoker ? 'smoker' : 'non-smoker') : (r as unknown as Record<string, string | undefined>)[attr]) : undefined;
      out.push({ attr, value, state: known === undefined ? 'unknown' : known === value ? 'match' : 'conflict' });
    }
    return out;
  }

  toData(): JournalData {
    return { clues: this.clues, residents: [...this.residents.values()], log: this.log, heard: [...this.heard] };
  }

  fromData(d: JournalData) {
    this.clues = d.clues;
    this.residents = new Map(d.residents.map((r) => [r.id, r]));
    this.log = d.log;
    this.heard = new Set(d.heard);
    this.nextId = Math.max(0, ...this.clues.map((c) => c.id)) + 1;
  }
}

export function trait(n: NpcState, attr: ClueAttr): string | undefined {
  switch (attr) {
    case 'coat':
      return n.app.coatName;
    case 'shoes':
      return n.app.shoes;
    case 'height':
      return heightClass(n.app.height);
    case 'hair':
      return n.app.hairStyle === 'bald' ? 'bald' : hairName(n.app.hair);
    case 'smoker':
      return n.smoker ? 'smoker' : 'non-smoker';
    default:
      return undefined;
  }
}

export function attrPhrase(attr: ClueAttr, value: string) {
  switch (attr) {
    case 'coat':
      return `a ${value} coat`;
    case 'shoes':
      return value === 'dress' ? 'dress shoes' : value;
    case 'height':
      return value === 'average' ? 'someone of average height' : `someone ${value}`;
    case 'hair':
      return `${value} hair`;
    case 'smoker':
      return 'a smoker';
    case 'identity':
      return 'who it was';
    case 'outside':
      return 'someone out at night';
  }
}

export const ATTR_LABEL: Record<ClueAttr, string> = {
  coat: 'Coat',
  shoes: 'Shoes',
  height: 'Height',
  hair: 'Hair',
  smoker: 'Smoker',
  identity: 'Identified',
  outside: 'Out at night',
};
