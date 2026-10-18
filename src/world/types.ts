import type { Rect } from '../core/math';

/** 0 = north (-z), 1 = east (+x), 2 = south (+z), 3 = west (-x) */
export type Dir = 0 | 1 | 2 | 3;

export type Surface = 'asphalt' | 'concrete' | 'grass' | 'dirt' | 'gravel' | 'wood' | 'tile' | 'carpet';

export type BuildingKind =
  | 'house'
  | 'abandoned'
  | 'store'
  | 'hardware'
  | 'diner'
  | 'bar'
  | 'police'
  | 'clinic'
  | 'garage'
  | 'church'
  | 'shed';

export type RoomKind =
  | 'hall'
  | 'living'
  | 'kitchen'
  | 'bath'
  | 'bedroom'
  | 'storage'
  | 'shopfloor'
  | 'backroom'
  | 'office'
  | 'cell'
  | 'dining'
  | 'lobby'
  | 'nave'
  | 'workshop'
  | 'exam'
  | 'barroom';

export type RoadKind = 'main' | 'street' | 'alley' | 'path';

export interface Road {
  id: number;
  kind: RoadKind;
  /** full corridor rect (carriageway + sidewalks) */
  rect: Rect;
  /** drivable / walkable core rect */
  core: Rect;
  axis: 'x' | 'z';
  name: string;
  lit: boolean;
}

export interface Opening {
  kind: 'door' | 'window';
  id: number;
  t0: number;
  t1: number;
  /** bottom of the opening above floor */
  bottom: number;
  /** top of the opening above floor */
  top: number;
}

export interface WallSeg {
  id: number;
  buildingId: number;
  /** 'x' runs along x at constant z = c; 'z' runs along z at constant x = c */
  axis: 'x' | 'z';
  c: number;
  a: number;
  b: number;
  thickness: number;
  height: number;
  exterior: boolean;
  /** sign of the normal pointing outside (exterior walls only) */
  outside: 1 | -1 | 0;
  openings: Opening[];
  /** material keys of the faces looking toward the negative / positive normal side */
  matNeg: string;
  matPos: string;
  /** extend the box at its ends (closes building corners) */
  extA: number;
  extB: number;
}

export interface Door {
  id: number;
  buildingId: number;
  axis: 'x' | 'z';
  c: number;
  t: number;
  width: number;
  height: number;
  exterior: boolean;
  /** rooms on the negative / positive side of the wall normal (-1 = outdoors) */
  roomNeg: number;
  roomPos: number;
  /** cell bars instead of a solid panel (see-through) */
  bars: boolean;
  /** hinge at the low end (a) or high end (b) of the opening */
  hingeLow: boolean;
  // dynamic state
  open: number; // 0 closed .. 1 open (current)
  target: number; // where the door is moving to
  openSide: 1 | -1; // which way it swings
  locked: boolean;
  broken: boolean;
  hp: number;
  /** household / building key that opens this lock */
  keyId: number;
}

export interface WindowState {
  id: number;
  buildingId: number;
  roomId: number;
  axis: 'x' | 'z';
  c: number;
  t: number;
  width: number;
  sill: number;
  top: number;
  outside: 1 | -1;
  shop: boolean;
  // dynamic
  damage: 0 | 1 | 2; // intact, cracked, broken
  hp: number;
  boarded: boolean;
  boardHp: number;
  curtain: number; // colour
}

export interface Room {
  id: number;
  buildingId: number;
  kind: RoomKind;
  rect: Rect;
  floor: Surface;
  doorIds: number[];
  windowIds: number[];
  lightIds: number[];
  name: string;
  /** clearance zones (in front of doors / open connections) furniture must avoid */
  clear: Rect[];
}

export type FurnitureUse =
  | 'bed'
  | 'sofa'
  | 'chair'
  | 'fridge'
  | 'stove'
  | 'sink'
  | 'toilet'
  | 'shower'
  | 'table'
  | 'tv'
  | 'wardrobe'
  | 'dresser'
  | 'cabinet'
  | 'counter'
  | 'shelf'
  | 'register'
  | 'desk'
  | 'phone'
  | 'bookshelf'
  | 'lamp'
  | 'pew'
  | 'workbench'
  | 'barstool'
  | 'bartap'
  | 'decor'
  | 'cellbed'
  | 'exam'
  | 'crate'
  | 'altar';

export interface ItemStack {
  item: string;
  n: number;
  /** optional link (e.g. clue id or owner npc) */
  tag?: number;
}

export interface Furniture {
  id: number;
  kind: string;
  use: FurnitureUse;
  x: number;
  z: number;
  /** footprint dimensions in world space (already rotated) */
  w: number;
  d: number;
  h: number;
  /** direction the usable face points to */
  face: Dir;
  buildingId: number;
  roomId: number;
  solid: boolean;
  tall: boolean;
  color: number;
  container: ItemStack[] | null;
  searched: boolean;
  hide: boolean;
  /** world position where an actor stands to use it */
  ux: number;
  uz: number;
  lightId: number;
}

export type LightKind = 'street' | 'porch' | 'room' | 'lamp' | 'sign' | 'park';

export interface LightSource {
  id: number;
  kind: LightKind;
  x: number;
  y: number;
  z: number;
  color: number;
  intensity: number;
  range: number;
  buildingId: number;
  roomId: number;
  /** auto lights switch on at dusk */
  auto: boolean;
  on: boolean;
  broken: boolean;
  flicker: number;
}

export interface Prop {
  id: number;
  kind: string;
  x: number;
  z: number;
  rot: number;
  s: number;
  color: number;
  /** collision footprint if solid */
  solid: Rect | null;
  blocksSight: boolean;
  hide: boolean;
  h: number;
}

export type LotKind = 'house' | 'commercial' | 'park' | 'vacant' | 'abandoned' | 'church' | 'landmark';

export interface Lot {
  id: number;
  rect: Rect;
  blockId: number;
  front: Dir;
  kind: LotKind;
  buildingId: number;
  street: string;
  number: number;
  address: string;
}

export interface Block {
  id: number;
  rect: Rect;
  kind: 'residential' | 'mixed' | 'park' | 'church';
  alley: Rect | null;
}

export interface Building {
  id: number;
  kind: BuildingKind;
  name: string;
  rect: Rect;
  lotId: number;
  front: Dir;
  roomIds: number[];
  doorIds: number[];
  windowIds: number[];
  wallIds: number[];
  frontDoorId: number;
  backDoorId: number;
  wallHeight: number;
  roof: 'gable' | 'flat' | 'steeple' | 'shed';
  roofColor: number;
  wallMat: string;
  trimColor: number;
  address: string;
  /** household living here (houses) */
  householdId: number;
  /** points just outside / inside the front door */
  outsideFront: { x: number; z: number };
  insideFront: { x: number; z: number };
  porchLightId: number;
  /** lair flag for the killer's stash */
  floorY: number;
}

export interface Poi {
  kind: 'bus' | 'bench' | 'park' | 'phonebooth' | 'hide' | 'lookout' | 'smoke' | 'playground' | 'pond' | 'graveyard';
  x: number;
  z: number;
  buildingId: number;
}

export interface GenParams {
  seed: string;
  size: 'small' | 'medium' | 'large';
  density: number; // 0.5..1 occupancy
  nights: number;
}

export interface WorldData {
  version: number;
  params: GenParams;
  seedNum: number;
  width: number;
  depth: number;
  townName: string;
  roads: Road[];
  blocks: Block[];
  lots: Lot[];
  buildings: Building[];
  rooms: Room[];
  walls: WallSeg[];
  doors: Door[];
  windows: WindowState[];
  furniture: Furniture[];
  props: Prop[];
  lights: LightSource[];
  pois: Poi[];
  /** ground surface patches (drawn and used for footsteps) */
  ground: { rect: Rect; surface: Surface; kind: string }[];
  playerHouseId: number;
  policeId: number;
  busStop: { x: number; z: number };
  townEdge: { x: number; z: number };
  landmarks: { name: string; x: number; z: number; kind: string }[];
}

export const DIR_VEC: ReadonlyArray<{ x: number; z: number }> = [
  { x: 0, z: -1 },
  { x: 1, z: 0 },
  { x: 0, z: 1 },
  { x: -1, z: 0 },
];
