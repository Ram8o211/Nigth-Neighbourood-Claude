import type { Simulation } from '../sim/simulation';
import type { NpcState } from '../sim/types';
import type { HuntPlan } from '../sim/killer';
import type { Journal } from './journal';
import { fullName, heightClass } from '../sim/population';
import { formatClock } from '../core/math';
import { visibility } from '../sim/perception';
import { identifies } from '../sim/memory';

export type EndingKind = 'arrested' | 'police' | 'vigilante' | 'dead' | 'jailed' | 'timeout';

export interface Ending {
  kind: EndingKind;
  win: boolean;
  title: string;
  text: string;
}

export interface Objective {
  id: string;
  text: string;
  done: boolean;
  target?: { x: number; z: number };
}

export interface StoryData {
  flags: Record<string, number | boolean | string>;
  trust: number;
  accusations: { id: number; time: number; accepted: boolean }[];
  ending: Ending | null;
  playerThreat: number;
  stats: Record<string, number>;
}

/** narrative structure layered on top of the systemic simulation */
export class Story {
  flags: Record<string, number | boolean | string> = {};
  trust = 2;
  accusations: StoryData['accusations'] = [];
  ending: Ending | null = null;
  /** how close the player is getting; makes the killer turn on them */
  playerThreat = 0;
  stats: Record<string, number> = { clues: 0, talks: 0, kills: 0, nightsSurvived: 0 };
  objectives: Objective[] = [];
  private observeT = 0;

  constructor(
    private sim: Simulation,
    private journal: Journal,
    public nights: number,
  ) {
    sim.director = { plan: (s, n) => this.plan(n) };
  }

  get killer(): NpcState {
    return this.sim.npc(this.sim.killerId)!;
  }

  get chief(): NpcState | null {
    return this.sim.npcs.find((n) => n.job === 'chief') ?? null;
  }

  /** the director: how dangerous each night is */
  plan(night: number): HuntPlan {
    const kills = this.sim.incidents.filter((i) => i.kind === 'murder' && i.perp === this.sim.killerId);
    const lastNightKill = kills.some((i) => i.night === night - 1);
    const threat = this.playerThreat;
    return {
      hunt: night >= 0 && night < this.nights,
      start: [0.7, 1.2, 0.4, 1.0, 0.2][night % 5],
      maxKills: night >= 3 || (!lastNightKill && night > 0) ? 2 : 1,
      targetPlayer: (threat >= 2.5 && night >= 1) || (night >= this.nights - 1 && threat >= 1.2),
      watchPlayer: night >= 1 && threat >= 0.5,
      knock: night >= 2 && threat >= 1,
    };
  }

  // ------------------------------------------------------------------ setup

  /** place the player at the bus stop with the starting kit and the uncle's letter */
  begin(addLetter: (text: string) => void) {
    const sim = this.sim;
    const p = sim.player;
    const home = sim.world.buildings[sim.world.playerHouseId];
    // step out beside the shelter, on the side nearer home, so the view is open
    const side = home.outsideFront.x < sim.world.busStop.x ? -1 : 1;
    p.x = sim.world.busStop.x + side * 2.5;
    p.z = sim.world.busStop.z - 0.2;
    p.yaw = Math.atan2(home.outsideFront.x - p.x, -(home.outsideFront.z - p.z));
    p.inventory = [
      { item: 'sandwich', n: 1 },
      { item: 'key', n: 1, tag: home.id },
    ];
    p.money = 60;
    // the player's house: lights off, doors locked
    for (const d of home.doorIds) if (sim.world.doors[d].exterior) sim.world.doors[d].locked = true;
    const k = this.killer;
    const h = heightClass(k.app.height);
    const letter = `My dear nephew,

If you are reading this, the lawyers have found you and I am gone. Do not believe what they say about my heart. Something is wrong in ${sim.world.townName}.

People are vanishing at night. I have watched from my window. I saw them once, cutting through the back yards after midnight: a ${h === 'average' ? 'figure of ordinary height' : h + ' figure'} in a hooded coat. Whoever it is lives among us. They wave hello over the fence in the morning.

The police chief, ${this.chief ? fullName(this.chief) : 'at the station'}, will not listen without proof. Look for what they leave behind. Ask the neighbours what they saw, but trust what they SAW more than what they heard.

Lock the doors. Board the windows if you must. Buy a flashlight.

The house is yours now. I'm sorry.

- Uncle Ed`;
    addLetter(letter);
    this.journal.addLog(`Arrived in ${sim.world.townName}. Your late uncle left you the house at ${home.address}.`, 'note');
    this.flags.started = true;
  }

  readLetter() {
    if (this.flags.letterRead) return;
    this.flags.letterRead = true;
    const h = heightClass(this.killer.app.height);
    this.journal.addClue({ source: 'letter', attr: 'height', value: h, reliability: 0.55, text: `Uncle Ed saw a ${h === 'average' ? 'figure of average height' : h + ' figure'} in a hooded coat in the back yards.`, incident: -1, simClue: -1, from: -1 });
  }

  // ------------------------------------------------------------------ per-frame

  update(dt: number) {
    const sim = this.sim;
    const p = sim.player;
    this.observeT -= dt;
    if (this.observeT <= 0) {
      this.observeT = 0.4;
      this.observe();
    }
    this.updateThreat();
    this.updateObjectives();
    this.checkEndings();
    // nights survived
    const night = sim.nightIndex();
    if (sim.hour() > 6.5 && sim.hour() < 12 && Number(this.flags.lastNightCounted ?? -2) < night && p.alive) {
      this.flags.lastNightCounted = night;
      if (night >= 0) this.stats.nightsSurvived = night + 1;
    }
  }

  /** the player watches residents: learns their traits and records night sightings */
  private observe() {
    const sim = this.sim;
    const p = sim.player;
    if (!p.alive || p.stance === 'hidden') return;
    const h = sim.hour();
    const night = h >= 21 || h < 5.5;
    for (const n of sim.npcs) {
      if (!n.alive || n.inCustody) continue;
      if (Math.abs(n.x - p.x) > 40 || Math.abs(n.z - p.z) > 40) continue;
      const vis = visibility(sim, p, n);
      if (vis < 0.15) continue;
      const d = Math.hypot(n.x - p.x, n.z - p.z);
      this.journal.observe(n, vis, d);
      if (night && n.building < 0 && !(n.role === 'police' && n.outfit === 'day')) {
        const ident = n.outfit === 'night' ? vis > 0.85 && d < 3.5 : this.journal.residents.get(n.id)?.named === true && vis > 0.5 && d < 14;
        if (n.outfit === 'night' || ident) this.journal.sighting(n, vis, d, ident);
        if (n.outfit === 'night' && d < 25) p.fear = Math.min(100, p.fear + 20 * vis);
      }
    }
    void identifies;
  }

  /** the killer notices the player getting close */
  private updateThreat() {
    const sim = this.sim;
    const k = this.killer;
    if (!k) return;
    let t = Math.max(0, this.journal.fit(k.id).score) * 0.5;
    if (sim.player.building === k.homeId) t += 1.5;
    if (this.flags.searchedKillerHome) t += 1;
    if (this.accusations.some((a) => a.id === k.id)) t += 2;
    if (this.flags.talkedToKillerAboutMurder) t += 0.5;
    this.playerThreat = Math.max(this.playerThreat * 0.999, t);
  }

  // ------------------------------------------------------------------ objectives

  private updateObjectives() {
    const sim = this.sim;
    const p = sim.player;
    const home = sim.world.buildings[sim.world.playerHouseId];
    const day = sim.day();
    const h = sim.hour();
    const objs: Objective[] = [];
    const reachedHome = !!this.flags.reachedHome || p.building === home.id;
    if (p.building === home.id) this.flags.reachedHome = true;
    if (!reachedHome) objs.push({ id: 'home', text: `Find your late uncle's house: ${home.address}`, done: false, target: home.outsideFront });
    else if (!this.flags.letterRead) {
      const note = sim.items.find((i) => i.item === 'note' && !i.taken);
      objs.push({ id: 'letter', text: "Read the letter your uncle left on the table", done: false, target: note ? { x: note.x, z: note.z } : undefined });
    }
    const hasLight = p.inventory.some((s) => s.item === 'flashlight');
    if (this.flags.letterRead && !hasLight) {
      const shop = sim.world.buildings.find((b) => b.kind === 'hardware') ?? sim.world.buildings.find((b) => b.kind === 'store');
      objs.push({ id: 'flashlight', text: `Buy a flashlight (${shop?.name ?? 'store'})`, done: false, target: shop?.outsideFront });
    }
    const met = [...this.journal.residents.values()].filter((r) => r.named).length;
    if (this.flags.letterRead && met < 3 && day === 0) objs.push({ id: 'meet', text: `Introduce yourself to the neighbours (${met}/3)`, done: false });
    // evening safety
    const ext = home.doorIds.filter((d) => sim.world.doors[d].exterior);
    const locked = ext.every((d) => sim.world.doors[d].locked);
    if (reachedHome && (h >= 19 || h < 5) && p.building === home.id && !locked) objs.push({ id: 'lock', text: 'Lock your doors for the night (hold E at a door)', done: false });
    // investigation
    const found = sim.incidents.filter((i) => i.kind === 'murder' && i.discovered);
    const missing = sim.npcs.filter((n) => n.missing && sim.incidents.some((i) => i.victim === n.id && i.kind === 'murder' && !i.discovered));
    if (found.length || missing.length) {
      const latest = found[found.length - 1];
      if (latest && !this.flags[`scene_${latest.id}`]) {
        if (Math.hypot(p.x - latest.x, p.z - latest.z) < 6) this.flags[`scene_${latest.id}`] = true;
        else objs.push({ id: 'scene', text: `Examine the scene where ${sim.actorName(latest.victim)} was found`, done: false, target: { x: latest.x, z: latest.z } });
      }
      if (!this.flags.metChief && this.chief) objs.push({ id: 'chief', text: `Talk to Chief ${this.chief.last} at the police station`, done: false, target: sim.world.buildings[sim.world.policeId].outsideFront });
      if (missing.length) objs.push({ id: 'missing', text: `Find out what happened to ${fullName(missing[0])}`, done: false });
      const clues = this.journal.clues.filter((c) => c.attr !== 'outside').length;
      objs.push({ id: 'evidence', text: `Gather evidence about the Night Neighbour (${clues} clue${clues === 1 ? '' : 's'})`, done: false });
      if (clues >= 3) objs.push({ id: 'accuse', text: 'When you are sure, accuse the culprit to the police chief', done: false, target: sim.world.buildings[sim.world.policeId].outsideFront });
    }
    const nightsLeft = Math.max(0, this.nights - Math.max(0, sim.nightIndex() + (h >= 12 ? 0 : 1)));
    objs.push({ id: 'survive', text: `Survive and stop the Night Neighbour (${nightsLeft} night${nightsLeft === 1 ? '' : 's'} left)`, done: false });
    this.objectives = objs;
  }

  // ------------------------------------------------------------------ accusation

  /** the chief weighs the player's evidence against the accused */
  accuse(id: number): { accepted: boolean; reply: string } {
    const sim = this.sim;
    const n = sim.npc(id);
    if (!n) return { accepted: false, reply: 'Who?' };
    if (this.trust <= 0) return { accepted: false, reply: "I've arrested enough innocent people on your word. Bring me the killer in handcuffs or don't come back." };
    if (!n.alive) return { accepted: false, reply: `${fullName(n)} is dead. Whoever did this is still out there.` };
    if (n.inCustody) return { accepted: false, reply: `${fullName(n)} is already in a cell.` };
    const fit = this.journal.fit(id);
    const strong = fit.score >= 3.0 && fit.conflicts.length <= 1;
    this.accusations.push({ id, time: sim.time, accepted: strong });
    if (!strong) {
      const need = fit.conflicts.length > 1 ? `Some of what you have points away from ${n.first}: ${fit.conflicts[0]}` : `That's not enough to hold ${n.first}. I need more evidence that fits.`;
      return { accepted: false, reply: `${need} (Evidence strength ${fit.score.toFixed(1)} / 3.0)` };
    }
    // open a case with the player's evidence and send officers
    const c = {
      id: sim.cases.length,
      incident: -1,
      kind: 'homicide',
      x: n.x,
      z: n.z,
      building: n.homeId,
      opened: sim.time,
      status: 'suspect' as const,
      assigned: -1,
      suspect: id,
      suspectScore: fit.score,
      reports: [],
      sceneChecked: true,
      bodyRemoved: false,
      interviewed: [],
      priority: 3,
    };
    sim.cases.push(c);
    if (id !== sim.killerId) this.flags.wrongArrest = id;
    return { accepted: true, reply: `...Alright. That's enough to bring ${fullName(n)} in for questioning. My officers will pick them up.` };
  }

  /** an innocent was arrested and the killing continued */
  onMurderWhileWrongInCustody() {
    const wrong = Number(this.flags.wrongArrest ?? -1);
    if (wrong < 0) return;
    const n = this.sim.npc(wrong);
    if (n && n.inCustody) {
      this.sim.release(n);
      this.trust -= 1;
      this.flags.wrongArrest = -1;
      this.journal.addLog(`${fullName(n)} was released after another killing. The chief is losing patience with you.`, 'event');
    }
  }

  // ------------------------------------------------------------------ endings

  private checkEndings() {
    if (this.ending) return;
    const sim = this.sim;
    const p = sim.player;
    const k = this.killer;
    if (!p.alive) {
      this.ending = {
        kind: 'dead',
        win: false,
        title: 'You did not survive',
        text: `Your body was found ${sim.placeName(p.x, p.z)} at ${formatClock(sim.time)}. ${sim.world.townName} added your name to the list of the missing and the dead.`,
      };
      return;
    }
    if (k.inCustody) {
      const byPlayer = this.accusations.some((a) => a.id === k.id && a.accepted);
      this.ending = {
        kind: byPlayer ? 'arrested' : 'police',
        win: true,
        title: byPlayer ? 'The Night Neighbour is caught' : 'The police got there first',
        text: byPlayer
          ? `Acting on your evidence, the police arrested ${fullName(k)}. In ${sim.world.buildings[sim.lair.building].kind === 'shed' ? 'the shed behind their house' : 'an abandoned house'} they found what was left of the missing. ${sim.world.townName} sleeps with its doors unlocked again.`
          : `${fullName(k)} was arrested after witnesses identified them. You were there, and you lived through it.`,
      };
      return;
    }
    if (!k.alive) {
      const fit = this.journal.fit(k.id).score;
      const caught = k.outfit === 'night' || fit >= 1.5 || k.lastAttacker === 0;
      if (k.lastAttacker === 0 || sim.incidents.some((i) => i.victim === k.id && i.perp === 0)) {
        this.ending = caught
          ? {
              kind: 'vigilante',
              win: true,
              title: 'The Night Neighbour is dead',
              text: `You killed ${fullName(k)}. When the police searched their home and ${sim.world.buildings[sim.lair.building].kind === 'shed' ? 'shed' : 'hiding place'}, the truth came out. Nobody blames you. Nobody quite looks you in the eye either.`,
            }
          : {
              kind: 'jailed',
              win: false,
              title: 'Murderer',
              text: `You killed ${fullName(k)} without proof. They were the Night Neighbour, but nobody will ever know: you are going to prison for murder.`,
            };
        return;
      }
    }
    if (p.wantedLevel >= 2 && p.inCustody) {
      this.ending = { kind: 'jailed', win: false, title: 'Arrested for murder', text: 'Witnesses saw you kill. The Night Neighbour is still out there, and you will be watching the news from a cell.' };
      return;
    }
    // ran out of time
    const lastNight = this.nights - 1;
    if (sim.nightIndex() > lastNight || (sim.nightIndex() === lastNight && sim.hour() >= 7.5 && sim.hour() < 12)) {
      this.ending = {
        kind: 'timeout',
        win: false,
        title: 'The Night Neighbour got away',
        text: `After ${this.nights} nights the killings stop as suddenly as they started. ${fullName(k)} moves away a month later. Nobody ever finds out why.`,
      };
    }
  }

  toData(): StoryData {
    return { flags: this.flags, trust: this.trust, accusations: this.accusations, ending: this.ending, playerThreat: this.playerThreat, stats: this.stats };
  }

  fromData(d: StoryData) {
    this.flags = d.flags;
    this.trust = d.trust;
    this.accusations = d.accusations;
    this.ending = d.ending;
    this.playerThreat = d.playerThreat;
    this.stats = d.stats;
  }
}
