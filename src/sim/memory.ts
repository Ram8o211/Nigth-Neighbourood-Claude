import type { Simulation } from './simulation';
import type { ActorState, Description, Memory, MemTopic, NpcState } from './types';
import { fullName, hairName, heightClass } from './population';
import { formatClock } from '../core/math';

export const IMPORTANCE: Record<MemTopic, number> = {
  murder: 1,
  attack: 0.9,
  body: 0.95,
  breakin: 0.7,
  glass: 0.5,
  scream: 0.6,
  fight: 0.55,
  prowler: 0.55,
  weapon: 0.35,
  trespass: 0.6,
  blood: 0.6,
  theft: 0.5,
  missing: 0.7,
  arrest: 0.5,
  footsteps: 0.4,
  knock: 0.2,
  leftHome: 0.3,
  atBar: 0.15,
};

const MAX_MEM = 48;

export function remember(sim: Simulation, npc: NpcState, m: Omit<Memory, 'id' | 'reported' | 'shared'>): Memory {
  // merge with a matching recent memory instead of duplicating
  for (const e of npc.memories) {
    const sameInc = m.incident >= 0 && e.incident === m.incident && e.topic === m.topic;
    const similar =
      e.topic === m.topic &&
      e.actor === m.actor &&
      e.subject === m.subject &&
      Math.abs(e.time - m.time) < 1800 &&
      Math.hypot(e.x - m.x, e.z - m.z) < 25;
    if (sameInc || similar) {
      // first-hand knowledge beats hearsay
      const rank = (s: Memory['source']) => (s === 'saw' ? 3 : s === 'heard' ? 2 : s === 'suspect' ? 1 : 0);
      if (rank(m.source) > rank(e.source) || (rank(m.source) === rank(e.source) && m.confidence > e.confidence)) {
        e.source = m.source;
        e.confidence = m.confidence;
        e.from = m.from;
      }
      if (m.actor >= 0 && e.actor < 0) e.actor = m.actor;
      e.desc = mergeDesc(e.desc, m.desc);
      if (m.incident >= 0) e.incident = m.incident;
      e.time = Math.max(e.time, m.time);
      return e;
    }
  }
  const mem: Memory = { ...m, id: npc.nextMemId++, reported: false, shared: 0 };
  npc.memories.push(mem);
  if (npc.memories.length > MAX_MEM) {
    // forget the least important / oldest
    let worst = 0;
    let worstScore = Infinity;
    npc.memories.forEach((x, i) => {
      const score = IMPORTANCE[x.topic] * x.confidence - (sim.time - x.time) / 86400;
      if (score < worstScore) {
        worstScore = score;
        worst = i;
      }
    });
    npc.memories.splice(worst, 1);
  }
  return mem;
}

function mergeDesc(a: Description, b: Description): Description {
  return {
    height: a.height ?? b.height,
    coat: a.coat ?? b.coat,
    hair: a.hair ?? b.hair,
    shoes: a.shoes ?? b.shoes,
    build: a.build ?? b.build,
    hood: a.hood ?? b.hood,
  };
}

/** what an observer can make out about a target at a given clarity (0..1) */
export function describeActor(sim: Simulation, target: ActorState, clarity: number, dist: number): Description {
  const d: Description = {};
  const app = sim.appearanceOf(target);
  if (!app) return d;
  const hooded = target.outfit === 'night';
  if (clarity > 0.15) d.height = heightClass(app.height);
  if (clarity > 0.35) d.coat = sim.coatNameOf(target);
  if (clarity > 0.55 && !hooded) d.hair = app.hairStyle === 'bald' ? 'bald' : app.hairStyle === 'cap' ? 'a cap' : hairName(app.hair);
  if (clarity > 0.7 && dist < 6) d.shoes = app.shoes;
  if (clarity > 0.3) d.build = app.build > 1.1 ? 'heavy-set' : app.build < 0.93 ? 'thin' : 'medium build';
  d.hood = hooded;
  return d;
}

/** everything a perfect witness could say about someone (no hood, close, in daylight) */
export function trueDescription(sim: Simulation, target: ActorState): Description {
  const app = sim.appearanceOf(target);
  if (!app) return {};
  return {
    height: heightClass(app.height),
    coat: sim.coatNameOf(target),
    hair: app.hairStyle === 'bald' ? 'bald' : app.hairStyle === 'cap' ? 'a cap' : hairName(app.hair),
    shoes: app.shoes,
    build: app.build > 1.1 ? 'heavy-set' : app.build < 0.93 ? 'thin' : 'medium build',
  };
}

/** can the observer put a name to the target? */
export function identifies(sim: Simulation, observer: NpcState, target: ActorState, clarity: number, dist: number): boolean {
  if (target.kind === 'player') {
    if (!observer.metPlayer && clarity < 0.8) return false;
  } else {
    const rel = observer.rel.find((r) => r.id === target.id);
    if (!rel || rel.familiarity < 0.4) return false;
  }
  if (target.outfit === 'night') return clarity > 0.9 && dist < 2.5;
  return clarity > 0.62 && dist < 14;
}

export function descText(d: Description): string {
  const parts: string[] = [];
  if (d.height) parts.push(d.height === 'average' ? 'average height' : d.height);
  if (d.build) parts.push(d.build);
  let s = parts.length ? `a ${parts.join(', ')} figure` : 'someone';
  if (d.coat) s += ` in a ${d.coat} coat`;
  if (d.hood) s += ' with the hood up';
  if (d.hair) s += d.hair === 'bald' ? ', bald' : d.hair === 'a cap' ? ' wearing a cap' : ` with ${d.hair} hair`;
  if (d.shoes) s += `, wearing ${d.shoes === 'dress' ? 'dress shoes' : d.shoes}`;
  return s;
}

export function placeName(sim: Simulation, x: number, z: number): string {
  const room = sim.grid.roomAt(x, z);
  if (room >= 0) {
    const b = sim.world.buildings[sim.world.rooms[room].buildingId];
    return b.kind === 'house' || b.kind === 'abandoned' ? `inside ${b.address}` : `inside ${b.name}`;
  }
  let best = '';
  let bd = Infinity;
  for (const l of sim.world.landmarks) {
    const d = Math.hypot(l.x - x, l.z - z);
    if (d < bd && d < 18) {
      bd = d;
      best = `near ${l.name}`;
    }
  }
  for (const b of sim.world.buildings) {
    if (b.kind === 'shed') continue;
    const d = Math.hypot(b.outsideFront.x - x, b.outsideFront.z - z);
    if (d < bd) {
      bd = d;
      best = d < 10 ? `outside ${b.kind === 'house' || b.kind === 'abandoned' ? b.address : b.name}` : `near ${b.address}`;
    }
  }
  return best || 'out on the street';
}

const VERB: Record<MemTopic, string> = {
  murder: 'kill someone',
  attack: 'attack',
  body: 'a body',
  breakin: 'break in',
  glass: 'glass breaking',
  scream: 'a scream',
  fight: 'sounds of a fight',
  prowler: 'prowling around',
  weapon: 'carrying a weapon',
  trespass: 'inside my home',
  blood: 'covered in blood',
  theft: 'stealing',
  missing: 'missing',
  arrest: 'arrested',
  footsteps: 'footsteps inside the house',
  knock: 'knocking at the door',
  leftHome: 'out walking',
  atBar: 'at the bar',
};

export function actorLabel(sim: Simulation, id: number): string {
  if (id < 0) return 'someone';
  if (id === 0) return 'the new neighbour';
  const n = sim.npc(id);
  return n ? fullName(n) : 'someone';
}

/** turns a memory into a line of dialogue that keeps the source distinction */
export function memoryLine(sim: Simulation, owner: NpcState, m: Memory): string {
  const when = `around ${formatClock(m.time)}${dayWord(sim, m.time)}`;
  const where = placeName(sim, m.x, m.z);
  const who = m.actor >= 0 ? actorLabel(sim, m.actor) : descText(m.desc);
  const victim = m.subject >= 0 ? actorLabel(sim, m.subject) : 'someone';
  let core = '';
  switch (m.topic) {
    case 'murder':
      core = `${who} killing ${victim}`;
      break;
    case 'attack':
      core = `${who} attack ${victim}`;
      break;
    case 'body':
      core = `the body of ${victim}`;
      break;
    case 'glass':
    case 'scream':
    case 'fight':
    case 'footsteps':
    case 'knock':
      core = VERB[m.topic];
      break;
    case 'leftHome':
      core = `${who} out walking`;
      break;
    case 'atBar':
      core = `${who} at the bar`;
      break;
    case 'trespass':
      core = `${who} inside ${owner.homeId >= 0 ? 'my home' : 'a house'}`;
      break;
    default:
      core = `${who} ${VERB[m.topic]}`;
  }
  const certainty = m.confidence < 0.45 ? " I couldn't see well, though." : '';
  switch (m.source) {
    case 'saw':
      return `I saw ${core} ${where}, ${when}.${certainty}`;
    case 'heard':
      return `I heard ${m.topic === 'glass' || m.topic === 'scream' || m.topic === 'fight' || m.topic === 'footsteps' || m.topic === 'knock' ? core : `about ${core}`} ${where}, ${when}.`;
    case 'told':
      return `${actorLabel(sim, m.from)} told me about ${core} ${where}, ${when}.`;
    default:
      return `I can't prove it, but I think it was ${who}. Something about ${where} ${when}.`;
  }
}

export function dayWord(sim: Simulation, t: number) {
  const d = Math.floor(t / 86400);
  const today = Math.floor(sim.time / 86400);
  const h = (t % 86400) / 3600;
  if (d === today) return h < 6 ? ' last night' : ' today';
  if (d === today - 1) return h >= 18 ? ' last night' : ' yesterday';
  return ` ${today - d} days ago`;
}

/** NPCs share what they know when they talk; hearsay is marked as 'told' */
export function shareGossip(sim: Simulation, a: NpcState, b: NpcState) {
  const worth = a.memories
    .filter((m) => IMPORTANCE[m.topic] >= 0.45 && sim.time - m.time < 86400 * 2)
    .sort((x, y) => IMPORTANCE[y.topic] - IMPORTANCE[x.topic]);
  let n = 0;
  for (const m of worth) {
    if (n >= 2 + Math.round(a.traits.gossip * 2)) break;
    remember(sim, b, {
      topic: m.topic,
      source: 'told',
      actor: m.actor,
      subject: m.subject,
      desc: { ...m.desc },
      x: m.x,
      z: m.z,
      time: m.time,
      confidence: m.confidence * 0.75,
      from: a.id,
      incident: m.incident,
    });
    m.shared++;
    n++;
  }
}
