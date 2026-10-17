import { yawTo } from '../core/math';
import type { Simulation } from './simulation';
import type { Memory, MemTopic, NpcState, PoliceCase, Task } from './types';
import { stepGoto, type TaskResult } from './tasks';
import { setActivity, inWindow } from './brain';
import { combatTask } from './combat';
import { visibility } from './perception';
import { fullName } from './population';
import { remember, trueDescription } from './memory';

const SERIOUS: MemTopic[] = ['murder', 'body', 'attack', 'breakin', 'trespass', 'prowler', 'glass', 'scream', 'fight', 'missing', 'theft', 'blood'];
const PRIORITY: Partial<Record<MemTopic, number>> = { murder: 3, body: 3, attack: 3, missing: 2, breakin: 2, scream: 2, fight: 2, theft: 1, glass: 1, prowler: 1, trespass: 1, blood: 1 };

function caseKind(topic: MemTopic) {
  if (topic === 'body' || topic === 'murder') return 'homicide';
  if (topic === 'attack' || topic === 'fight' || topic === 'scream') return 'assault';
  if (topic === 'breakin' || topic === 'glass' || topic === 'theft') return 'break-in';
  if (topic === 'missing') return 'missing person';
  return 'disturbance';
}

export function onDuty(sim: Simulation, o: NpcState) {
  return o.alive && !o.inCustody && (o.activity?.kind === 'work' || o.activity?.kind === 'patrol' || o.activity?.kind === 'respond' || o.activity?.kind === 'arrest' || (o.workId >= 0 && inWindow(sim.hour(), o.schedule.workStart, o.schedule.workEnd)));
}

/** an npc (or the player via `fromPlayer`) reports what they know */
export function policeCall(sim: Simulation, reporter: NpcState | null, memories?: Memory[], fromPlayer = false) {
  const mems = memories ?? (reporter ? reporter.memories.filter((m) => !m.reported && SERIOUS.includes(m.topic) && (m.source !== 'told' || IMPORTANT(m))) : []);
  let created = 0;
  for (const m of mems) {
    m.reported = true;
    let c = sim.cases.find(
      (k) =>
        k.status !== 'closed' &&
        ((m.incident >= 0 && k.incident === m.incident) || (Math.hypot(k.x - m.x, k.z - m.z) < 30 && Math.abs(k.opened - m.time) < 4 * 3600 && k.kind === caseKind(m.topic))),
    );
    if (m.topic === 'missing' && m.subject >= 0) {
      const v = sim.npc(m.subject);
      if (v) {
        const hb = sim.world.buildings[v.homeId];
        m.x = hb.insideFront.x;
        m.z = hb.insideFront.z;
      }
    }
    if (!c) {
      c = {
        id: sim.cases.length,
        incident: m.incident,
        kind: caseKind(m.topic),
        x: m.x,
        z: m.z,
        building: sim.grid.buildingAt(m.x, m.z),
        opened: sim.time,
        status: 'open',
        assigned: -1,
        suspect: -1,
        suspectScore: 0,
        reports: [],
        sceneChecked: false,
        bodyRemoved: false,
        interviewed: [],
        priority: PRIORITY[m.topic] ?? 1,
      };
      sim.cases.push(c);
      created++;
      if (m.incident >= 0) {
        const inc = sim.incidents[m.incident];
        if (inc) {
          inc.reported = true;
          inc.caseId = c.id;
        }
      }
    } else {
      c.priority = Math.max(c.priority, PRIORITY[m.topic] ?? 1);
      if (c.incident < 0 && m.incident >= 0) c.incident = m.incident;
      // a new first-hand witness re-opens a cold case
      const fresh = reporter && !c.reports.some((r) => r.from === reporter.id) && m.source !== 'told';
      if (c.status === 'investigating' && fresh && c.assigned < 0) c.status = 'open';
    }
    c.reports.push({ from: reporter ? reporter.id : 0, topic: m.topic, actor: m.actor, desc: { ...m.desc }, confidence: m.source === 'saw' ? m.confidence : m.confidence * 0.5, time: m.time });
    evaluateCase(sim, c);
  }
  if (created && (fromPlayer || reporter)) sim.emit({ type: 'police', s: 'report', a: reporter ? reporter.id : 0, text: `Police received a report (${sim.cases[sim.cases.length - 1].kind}).` });
}

function IMPORTANT(m: Memory) {
  return m.topic === 'murder' || m.topic === 'body' || m.topic === 'missing';
}

/** weigh identified suspects reported by witnesses */
export function evaluateCase(sim: Simulation, c: PoliceCase) {
  const score = new Map<number, number>();
  // detectives also read the files of other open cases from the same couple of days
  const related = sim.cases.filter((k) => k === c || (k.status !== 'closed' && Math.abs(k.opened - c.opened) < 48 * 3600));
  const seen = new Set<string>();
  for (const k of related) {
    for (const r of k.reports) {
      if (r.actor < 0) continue;
      const named = sim.actors[r.actor];
      if (named?.kind === 'npc' && (named as NpcState).role === 'police') continue; // officers on duty are not suspects
      const key = `${r.from}:${r.actor}:${r.topic}:${Math.round(r.time / 600)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // eyewitnesses of violence carry weight; glimpses of a prowler or a weapon only make someone a person of interest,
      // unless they were hooded and armed in the middle of the night
      const w = r.topic === 'murder' || r.topic === 'attack' ? 1 : r.topic === 'breakin' || r.topic === 'theft' ? 0.7 : r.topic === 'weapon' && r.desc.hood ? 0.35 : r.topic === 'blood' ? 0.25 : 0.12;
      score.set(r.actor, (score.get(r.actor) ?? 0) + r.confidence * w * (k === c ? 1 : 0.8));
    }
  }
  let best = -1;
  let bs = 0;
  for (const [a, s] of score) if (s > bs) {
    bs = s;
    best = a;
  }
  if (bs < 0.9) {
    const d = describedSuspect(sim, c);
    if (d) {
      best = d.id;
      bs = d.score;
    }
  }
  if (best >= 0 && bs >= 0.9 && sim.actors[best]?.alive && !sim.actors[best].inCustody) {
    if (c.suspect !== best) sim.emit({ type: 'police', s: 'suspect', a: best, text: '' });
    c.suspect = best;
    c.suspectScore = bs;
    // violence and break-ins lead to an arrest; a prowler or trespasser only becomes a person of interest,
    // whose sightings count again if a violent case follows
    if (c.status !== 'closed' && ARRESTABLE.includes(c.kind)) c.status = 'suspect';
  }
}

const DESCRIBED: MemTopic[] = ['murder', 'attack', 'breakin', 'theft', 'prowler', 'weapon'];
const ARRESTABLE = ['homicide', 'assault', 'break-in'];
const DESC_KEYS = ['height', 'coat', 'hair', 'shoes', 'build'] as const;

/**
 * Nobody was named, but witnesses described someone. After some investigation
 * the police pick a suspect when the descriptions fit exactly one person: two
 * witnesses agreeing on three traits, or one witness who saw four.
 */
function describedSuspect(sim: Simulation, c: PoliceCase): { id: number; score: number } | null {
  if (c.kind === 'missing person' || sim.time - c.opened < 4 * 3600) return null;
  const reps = c.reports.filter((r) => r.actor < 0 && DESCRIBED.includes(r.topic) && r.confidence >= 0.3 && DESC_KEYS.some((k) => r.desc[k] !== undefined));
  const witnesses = new Set(reps.map((r) => r.from)).size;
  if (!witnesses) return null;
  const fits: { id: number; w: number }[] = [];
  for (const a of sim.actors) {
    if (!a.alive || a.inCustody) continue;
    if (a.kind === 'npc' && (a as NpcState).role === 'police') continue;
    const truth = trueDescription(sim, a);
    const attrs = new Set<string>();
    let w = 0;
    let conflict = false;
    for (const r of reps) {
      for (const k of DESC_KEYS) {
        const v = r.desc[k];
        if (v === undefined) continue;
        if (truth[k] !== v) conflict = true;
        else {
          attrs.add(k);
          w += r.confidence;
        }
      }
      if (conflict) break;
    }
    // two witnesses agreeing on three traits, or one witness who saw four
    if (!conflict && w >= 1.5 && (attrs.size >= 4 || (attrs.size >= 3 && witnesses >= 2))) fits.push({ id: a.id, w });
  }
  if (fits.length !== 1) return null;
  return { id: fits[0].id, score: 0.9 + 0.1 * Math.min(1, fits[0].w / 4) };
}

/** pick the next job for an on-duty officer */
export function policeThink(sim: Simulation, o: NpcState): boolean {
  if (!o.alive || o.inCustody || o.stance === 'downed') return false;
  const kind = o.activity?.kind;
  if ((kind === 'respond' || kind === 'arrest' || kind === 'fight' || kind === 'escort') && o.tasks.length > 0) return true;
  if (!onDuty(sim, o)) return false;
  // arrests first
  const wanted = sim.cases.find((c) => c.status === 'suspect' && c.suspect >= 0 && (c.assigned < 0 || c.assigned === o.id || !sim.actors[c.assigned]?.alive));
  if (wanted) {
    const sus = sim.actors[wanted.suspect];
    if (sus && sus.alive && !sus.inCustody && !sus.arrested) {
      // the chief stays at the desk unless nobody else is available
      if (o.job === 'chief' && sim.npcs.some((p) => p !== o && p.role === 'police' && p.alive && onDuty(sim, p) && p.activity?.kind !== 'arrest')) return false;
      wanted.assigned = o.id;
      setActivity(sim, o, 'arrest', 75, [{ kind: 'p_arrest', target: wanted.suspect, data: { caseId: wanted.id } }]);
      return true;
    }
    if (sus && sus.inCustody) wanted.status = 'closed';
  }
  const open = sim.cases
    .filter((c) => c.status === 'open' && (c.assigned < 0 || !sim.actors[c.assigned]?.alive))
    .sort((a, b) => b.priority - a.priority || a.opened - b.opened);
  if (open.length) {
    if (o.job === 'chief' && sim.npcs.some((p) => p !== o && p.role === 'police' && p.alive && onDuty(sim, p) && !['respond', 'arrest'].includes(p.activity?.kind ?? ''))) return false;
    const c = open[0];
    c.assigned = o.id;
    c.status = 'investigating';
    const tasks: Task[] = [];
    if (sim.isDarkNow()) tasks.push({ kind: 'equip', data: { item: 'flashlight', on: true } });
    tasks.push({ kind: 'goto', x: c.x, z: c.z, run: c.priority >= 2, arrive: 2.5 }, { kind: 'p_scene', target: c.id, dur: 240 }, { kind: 'p_interview', target: c.id }, { kind: 'equip', data: { item: 'flashlight', on: false } });
    setActivity(sim, o, 'respond', 60, tasks, { caseId: c.id });
    sim.emit({ type: 'police', s: 'dispatch', a: o.id, text: `${fullName(o)} is responding to a ${c.kind}.` });
    return true;
  }
  return false;
}

/** police seeing violence or a fleeing suspect */
export function policeReact(sim: Simulation, o: NpcState): boolean {
  const threat = o.threat >= 0 ? sim.actors[o.threat] : null;
  // only someone actually violent (or caught with a body / a drawn weapon) is taken down
  if (threat && threat.alive && !threat.inCustody && threat.stance !== 'downed' && (threat.swingT > 0 || threat.carrying >= 0 || (threat.weapon && threat.weapon !== 'baton' && o.alarm > 0.6))) {
    const d = Math.hypot(threat.x - o.x, threat.z - o.z);
    if (d < 25) {
      o.weapon = 'baton';
      setActivity(sim, o, 'arrest', 85, [{ kind: 'say', data: { text: 'Police! Stop right there!' } }, { kind: 'p_arrest', target: threat.id, data: { caseId: -1, force: true } }]);
      o.ctl.reactAlarm = o.alarm;
      return true;
    }
  }
  if (o.alarm > 0.45 && !['respond', 'arrest'].includes(o.activity?.kind ?? '')) {
    const tasks: Task[] = [];
    if (sim.isDarkNow()) tasks.push({ kind: 'equip', data: { item: 'flashlight', on: true } });
    tasks.push({ kind: 'goto', x: o.threatX, z: o.threatZ, run: o.alarm > 0.7, arrive: 2 }, { kind: 'look', dur: 300 });
    setActivity(sim, o, 'respond', 55, tasks);
    o.ctl.reactAlarm = o.alarm;
    // what an officer sees is effectively a report
    policeCall(sim, o);
    return true;
  }
  return false;
}

/** custom police tasks */
export function policeTask(sim: Simulation, o: NpcState, task: Task, dt: number): TaskResult {
  switch (task.kind) {
    case 'patrol': {
      // walk between random street points with a flashlight at night
      o.flashlight = sim.isDarkNow();
      if (task.x === undefined || Math.hypot(o.x - task.x, o.z - (task.z ?? 0)) < 1.5 || (task.t ?? 0) > 400) {
        const p = sim.randomStreetPoint();
        task.x = p.x;
        task.z = p.z;
        task.t = 0;
      }
      task.t = (task.t ?? 0) + dt;
      const r = stepGoto(sim, o, { ...task, arrive: 1.2 }, dt, task.x, task.z!);
      if (r === 'failed') task.x = undefined;
      if (o.activity && sim.time > o.activity.until) return 'done';
      return 'running';
    }
    case 'p_scene': {
      const c = sim.cases[task.target!];
      if (!c) return 'done';
      task.t = (task.t ?? 0) + dt * sim.timeScale();
      o.speed = 0;
      o.anim = 'look';
      o.yaw += dt * 0.6;
      if (!task.started) {
        task.started = true;
        sim.policeExamineScene(o, c);
      }
      return task.t >= (task.dur ?? 240) ? 'done' : 'running';
    }
    case 'p_interview': {
      const c = sim.cases[task.target!];
      if (!c) return 'done';
      // witnesses: anyone with first-hand memories of this incident / place
      // stick with the witness we chose until we have talked to them
      const fixed = task.data?.w !== undefined ? sim.npc(Number(task.data.w)) : null;
      const wit = fixed && fixed.alive && !c.interviewed.includes(fixed.id) ? [fixed] : sim.npcs.filter(
        (n) =>
          n !== o &&
          n.alive &&
          !n.inCustody &&
          !c.interviewed.includes(n.id) &&
          n.memories.some((m) => (c.incident >= 0 && m.incident === c.incident) || (Math.hypot(m.x - c.x, m.z - c.z) < 25 && Math.abs(m.time - c.opened) < 6 * 3600 && m.topic !== 'leftHome' && m.topic !== 'atBar')),
      );
      if (!fixed) wit.sort((a, b) => Math.hypot(a.x - o.x, a.z - o.z) - Math.hypot(b.x - o.x, b.z - o.z));
      const w = wit[0];
      if (w) task.data = { ...(task.data ?? {}), w: w.id };
      if (!w || c.interviewed.length >= 5) {
        // the case goes cold until new information arrives
        c.status = c.suspect >= 0 && ARRESTABLE.includes(c.kind) ? 'suspect' : 'investigating';
        c.assigned = -1;
        return 'done';
      }
      const d = Math.hypot(w.x - o.x, w.z - o.z);
      if (d > 1.8) {
        const r = stepGoto(sim, o, { ...task, arrive: 1.4 }, dt, w.x, w.z);
        if (r === 'failed') {
          c.interviewed.push(w.id);
          task.data = {};
        }
        return 'running';
      }
      o.speed = 0;
      o.anim = 'talk';
      o.yaw = yawTo(o.x, o.z, w.x, w.z);
      task.t = (task.t ?? 0) + dt * sim.timeScale();
      if (task.t > 150) {
        task.t = 0;
        task.data = {};
        c.interviewed.push(w.id);
        const mems = w.memories.filter((m) => (c.incident >= 0 && m.incident === c.incident) || (Math.hypot(m.x - c.x, m.z - c.z) < 25 && Math.abs(m.time - c.opened) < 6 * 3600));
        for (const m of mems) {
          c.reports.push({ from: w.id, topic: m.topic, actor: m.actor, desc: { ...m.desc }, confidence: m.source === 'saw' ? m.confidence : m.confidence * 0.5, time: m.time });
          m.reported = true;
        }
        evaluateCase(sim, c);
        sim.say(o, 'Thank you. We will be in touch.', 3);
      } else if (task.t < dt * sim.timeScale() * 1.5) sim.say(o, 'Did you see or hear anything unusual?', 3);
      return 'running';
    }
    case 'p_arrest': {
      const sus = sim.actors[task.target!];
      const caseId = Number(task.data?.caseId ?? -1);
      if (!sus || !sus.alive || sus.inCustody) {
        if (caseId >= 0 && sim.cases[caseId]) sim.cases[caseId].assigned = -1;
        o.weapon = null;
        return 'done';
      }
      if (sus.arrested) {
        // already in hand: escort to the station
        return escortStep(sim, o, sus.id, dt, task);
      }
      const d = Math.hypot(sus.x - o.x, sus.z - o.z);
      task.t = (task.t ?? 0) + dt;
      if (task.t > 240) {
        // lost them
        if (caseId >= 0 && sim.cases[caseId]) sim.cases[caseId].assigned = -1;
        o.weapon = null;
        return 'done';
      }
      if (sus.stance === 'downed' && d < 1.8) {
        sim.arrest(o, sus);
        return 'running';
      }
      if (d < 1.6) {
        if (!task.data?.warned) {
          task.data = { ...task.data, warned: true, warnT: sim.time };
          sim.say(o, sus.kind === 'player' ? 'You are under arrest. Hands where I can see them.' : `${sus.kind === 'npc' ? fullName(sus as NpcState) : ''}, you are under arrest.`, 4);
          sim.emit({ type: 'arrest_attempt', a: o.id, b: sus.id });
          if (sus.kind === 'npc') sim.suspectResponds(sus as NpcState, o);
        }
        o.speed = 0;
        o.anim = 'idle';
        o.yaw = yawTo(o.x, o.z, sus.x, sus.z);
        // resisting suspects get subdued
        const resisting = sus.swingT > 0 || (sus.kind === 'npc' && ['kfight', 'fight', 'flee'].includes((sus as NpcState).activity?.kind ?? ''));
        if (resisting || task.data?.force) {
          o.weapon = 'baton';
          combatTask(sim, o, { kind: 'attack', target: sus.id }, dt);
        } else if (sus.kind === 'npc' && sim.time - Number(task.data?.warnT ?? sim.time) > 20) sim.arrest(o, sus);
        return 'running';
      }
      if (d > 40 && !sim.grid.los(o.x, o.z, sus.x, sus.z) && task.t > 60) {
        if (caseId >= 0 && sim.cases[caseId]) sim.cases[caseId].assigned = -1;
        o.weapon = null;
        return 'done';
      }
      const r = stepGoto(sim, o, { ...task, run: d < 30 || task.data?.force === true, arrive: 1.3 }, dt, sus.x, sus.z);
      if (r === 'failed') task.t += 5;
      return 'running';
    }
  }
  return 'done';
}

function escortStep(sim: Simulation, o: NpcState, susId: number, dt: number, task: Task): TaskResult {
  const sus = sim.actors[susId] as NpcState;
  if (sus.activity?.data.wait) {
    // taking over a prisoner from a colleague: go and get them first
    stepGoto(sim, o, { ...task, arrive: 1.2 }, dt, sus.x, sus.z);
    return 'running';
  }
  const pol = sim.world.buildings[sim.world.policeId];
  const cell = sim.world.rooms.find((r) => r.buildingId === pol.id && r.kind === 'cell' && !sim.actors.some((a) => a.inCustody && a.room === r.id));
  const dest = cell ? sim.doorFrontOfRoom(cell.id) : pol.insideFront;
  const r = stepGoto(sim, o, { ...task, arrive: 0.8 }, dt, dest.x, dest.z);
  if (r === 'done' || (cell && Math.hypot(o.x - dest.x, o.z - dest.z) < 1.5)) {
    sim.jail(sim.actors[susId], cell ? cell.id : -1);
    o.weapon = null;
    sim.say(o, 'In you go.', 3);
    return 'done';
  }
  if (r === 'failed' && (task.t ?? 0) > 200) {
    sim.jail(sim.actors[susId], cell ? cell.id : -1);
    return 'done';
  }
  return 'running';
}

/** the chief's knowledge, used for dialogue */
export function caseSummary(sim: Simulation): string[] {
  const out: string[] = [];
  for (const c of sim.cases) {
    if (c.status === 'closed' && sim.time - c.opened > 86400 * 2) continue;
    const reps = c.reports.filter((r) => r.desc.height || r.desc.coat || r.actor >= 0);
    let line = `${c.kind[0].toUpperCase() + c.kind.slice(1)} reported ${sim.placeName(c.x, c.z)}`;
    if (c.suspect >= 0) line += c.status === 'suspect' || c.status === 'closed' ? `. Suspect: ${sim.actorName(c.suspect)}.` : `. Person of interest: ${sim.actorName(c.suspect)}.`;
    else if (reps.length) {
      const r = reps[reps.length - 1];
      line += `. A witness described ${sim.descText(r.desc)}.`;
    } else line += '. No leads yet.';
    out.push(line);
  }
  return out;
}

export function rememberArrest(sim: Simulation, who: number) {
  for (const n of sim.npcs) {
    if (!n.alive) continue;
    if (visibility(sim, n, sim.actors[who]) > 0.3) remember(sim, n, { topic: 'arrest', source: 'saw', actor: who, subject: -1, desc: {}, x: sim.actors[who].x, z: sim.actors[who].z, time: sim.time, confidence: 0.9, from: -1, incident: -1 });
  }
}
