import type { ItemStack } from '../world/types';
import type { PathPoint } from '../world/pathfinding';

export type Stance = 'stand' | 'crouch' | 'sit' | 'lie' | 'downed' | 'dead' | 'hidden';

export type HeightClass = 'short' | 'average' | 'tall';
export type ShoeType = 'boots' | 'sneakers' | 'dress';

export interface Appearance {
  female: boolean;
  height: number;
  build: number; // 0.85 slim .. 1.2 heavy
  skin: number;
  hair: number;
  hairStyle: 'short' | 'long' | 'bald' | 'bun' | 'cap';
  beard: boolean;
  glasses: boolean;
  shirt: number;
  pants: number;
  coat: number; // outdoor jacket colour
  coatName: string;
  shoes: ShoeType;
  face: number;
}

export interface Traits {
  bravery: number;
  curiosity: number;
  sociability: number;
  aggression: number;
  vigilance: number;
  gossip: number;
  careless: number;
}

export type Job =
  | 'shopkeeper'
  | 'clerk'
  | 'cook'
  | 'waiter'
  | 'bartender'
  | 'doctor'
  | 'mechanic'
  | 'officer'
  | 'chief'
  | 'pastor'
  | 'retired'
  | 'homemaker'
  | 'writer'
  | 'unemployed';

export interface Schedule {
  wake: number; // hour
  bed: number; // hour (may be > 24)
  workStart: number;
  workEnd: number; // may be > 24 for night shifts
  workDays: number; // bitmask of days (0 = day 1)
  evening: 'home' | 'bar' | 'visit' | 'walk' | 'church';
}

/** source of knowledge, the key distinction of the memory model */
export type MemSource = 'saw' | 'heard' | 'told' | 'suspect';

export type MemTopic =
  | 'murder'
  | 'attack'
  | 'body'
  | 'breakin'
  | 'glass'
  | 'scream'
  | 'fight'
  | 'prowler'
  | 'weapon'
  | 'trespass'
  | 'blood'
  | 'theft'
  | 'missing'
  | 'arrest'
  | 'footsteps'
  | 'knock'
  | 'leftHome'
  | 'atBar';

export interface Description {
  height?: HeightClass;
  coat?: string;
  hair?: string;
  shoes?: ShoeType;
  build?: string;
  hood?: boolean;
}

export interface Memory {
  id: number;
  topic: MemTopic;
  source: MemSource;
  /** actor seen doing it (identified), -1 unknown */
  actor: number;
  /** victim / subject actor */
  subject: number;
  desc: Description;
  x: number;
  z: number;
  time: number;
  /** 0..1 how certain this memory is */
  confidence: number;
  /** npc that told us (source 'told') */
  from: number;
  incident: number;
  reported: boolean;
  shared: number;
}

export interface Relationship {
  id: number;
  affinity: number; // -1..1
  familiarity: number; // 0..1
  kind: 'spouse' | 'friend' | 'neighbour' | 'coworker' | 'acquaintance';
}

/** serialisable task: logic lives in tasks.ts */
export interface Task {
  kind: string;
  x?: number;
  z?: number;
  run?: boolean;
  sneak?: boolean;
  target?: number; // furniture / actor / door / building id depending on kind
  dur?: number; // game seconds
  until?: number; // absolute game time
  pose?: Stance | 'use';
  effect?: string;
  t?: number; // elapsed
  started?: boolean;
  arrive?: number; // arrival radius
  data?: Record<string, number | string | boolean>;
}

export interface Activity {
  kind: string;
  priority: number;
  started: number;
  until: number;
  data: Record<string, number | string | boolean>;
}

export type Role = 'resident' | 'killer' | 'burglar' | 'police';

export interface ActorState {
  id: number;
  kind: 'player' | 'npc';
  x: number;
  z: number;
  y: number;
  yaw: number;
  vx: number;
  vz: number;
  speed: number;
  radius: number;
  health: number;
  maxHealth: number;
  alive: boolean;
  stance: Stance;
  downedT: number;
  bleeding: number;
  stamina: number;
  building: number;
  room: number;
  weapon: string | null;
  attackCd: number;
  swingT: number; // >0 while a swing animation plays
  hitPending: number; // seconds until the hit frame of the current swing (-1 none)
  swingItem: string | null;
  blocking: boolean;
  staggerT: number;
  hitFlash: number;
  lastAttacker: number;
  bloody: number; // visible blood on clothes 0..1
  flashlight: boolean;
  carrying: number; // body actor id being dragged
  hiddenIn: number; // furniture id when hidden
  noise: number;
  // used by the renderer for animation
  anim: string;
  animT: number;
  outfit: 'day' | 'night' | 'sleep';
  usingFurniture: number;
  deathTime: number;
  bodyRemoved: boolean;
  arrested: boolean;
  inCustody: boolean;
  /** generic controller memory (killer / burglar / police / timers) */
  ctl: Record<string, number | string | boolean>;
}

export interface NpcState extends ActorState {
  first: string;
  last: string;
  age: number;
  job: Job;
  role: Role;
  homeId: number;
  workId: number;
  household: number;
  app: Appearance;
  traits: Traits;
  smoker: boolean;
  drinker: boolean;
  schedule: Schedule;
  money: number;
  needs: { hunger: number; energy: number; social: number; fear: number };
  rel: Relationship[];
  memories: Memory[];
  nextMemId: number;
  activity: Activity | null;
  tasks: Task[];
  path: PathPoint[] | null;
  pathIdx: number;
  pathGoal: { x: number; z: number } | null;
  pathFail: number;
  thinkT: number;
  perceiveT: number;
  /** awareness of each actor (0..1) for sight detection */
  aware: Record<number, number>;
  alarm: number;
  /** remembered threat target */
  threat: number;
  threatX: number;
  threatZ: number;
  sleeping: boolean;
  metPlayer: boolean;
  suspicionOfPlayer: number;
  carriesGroceries: number;
  keys: number[];
  talkT: number;
  sayText: string;
  sayT: number;
  doorWait: number;
  stuckT: number;
  lastX: number;
  lastZ: number;
  missing: boolean;
  wanted: number; // police: level of interest in this actor as a suspect
  avoidNightOut: boolean;
  /** exterior doors to close once passed */
  closeDoors: number[];
  /** door to lock after passing (own empty home) */
  lockBehind: number;
  /** building containing the current path goal (lets the agent use its doors) */
  pathGoalBuilding: number;
}

export interface PlayerState extends ActorState {
  hunger: number;
  energy: number;
  fear: number;
  money: number;
  inventory: ItemStack[];
  equipped: number; // inventory index or -1
  battery: number;
  crouching: boolean;
  sprinting: boolean;
  pitch: number;
  wantedLevel: number;
  knownTo: number[]; // npc ids who know the player by name
  sleepUntil: number;
  /** painkiller healing pool */
  healPool: number;
  boardTarget: number;
}

export interface Incident {
  id: number;
  kind: 'murder' | 'attack' | 'burglary' | 'breakin' | 'assault' | 'vandalism' | 'missing' | 'theft';
  perp: number;
  victim: number;
  x: number;
  z: number;
  building: number;
  time: number;
  discovered: boolean;
  reported: boolean;
  caseId: number;
  night: number;
  clues: number[];
  bodyHidden: boolean;
}

export type ClueKind = 'fabric' | 'footprint' | 'cigarette' | 'hair' | 'button' | 'witness' | 'sighting' | 'lair' | 'weapon' | 'stolen' | 'note' | 'alibi';

export interface Clue {
  id: number;
  kind: ClueKind;
  incident: number;
  attr: 'coat' | 'shoes' | 'smoker' | 'hair' | 'height' | 'identity' | 'none';
  value: string;
  /** actor this clue truly points to (for scoring) */
  points: number;
  reliability: number;
  text: string;
  found: boolean;
  foundTime: number;
  x: number;
  z: number;
  /** world item id carrying this clue, -1 if not physical */
  item: number;
}

export interface WorldItem {
  id: number;
  item: string;
  n: number;
  x: number;
  y: number;
  z: number;
  tag: number; // clue id / key building id
  taken: boolean;
  label: string;
}

export interface Decal {
  id: number;
  kind: 'blood' | 'pool' | 'footprint' | 'chalk' | 'glass' | 'drag' | 'scorch';
  x: number;
  y: number;
  z: number;
  /** surface normal: 'floor' or wall normal axis */
  nx: number;
  ny: number;
  nz: number;
  size: number;
  rot: number;
  variant: number;
  time: number;
  grow: number;
}

export interface PoliceCase {
  id: number;
  incident: number;
  kind: string;
  x: number;
  z: number;
  building: number;
  opened: number;
  status: 'open' | 'investigating' | 'suspect' | 'closed';
  assigned: number;
  suspect: number;
  suspectScore: number;
  reports: { from: number; topic: MemTopic; actor: number; desc: Description; confidence: number; time: number }[];
  sceneChecked: boolean;
  bodyRemoved: boolean;
  interviewed: number[];
  priority: number;
}

export interface SimEvent {
  type: string;
  x?: number;
  y?: number;
  z?: number;
  a?: number; // actor
  b?: number;
  v?: number; // magnitude / volume
  s?: string; // sub kind
  dir?: number;
  text?: string;
}
