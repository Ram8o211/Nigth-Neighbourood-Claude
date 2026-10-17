import * as THREE from 'three';
import { tex } from './textures';

export interface MatDef {
  tex: string;
  tint: number;
  /** metres per texture repeat */
  scale: number;
  side?: THREE.Side;
  emissive?: number;
}

const D: Record<string, MatDef> = {
  // exterior cladding
  siding_white: { tex: 'siding', tint: 0xf0ece4, scale: 2.2 },
  siding_blue: { tex: 'siding', tint: 0x8ea4bc, scale: 2.2 },
  siding_green: { tex: 'siding', tint: 0x9cae8c, scale: 2.2 },
  siding_yellow: { tex: 'siding', tint: 0xdcc98c, scale: 2.2 },
  siding_grey: { tex: 'siding', tint: 0xa4a6a8, scale: 2.2 },
  siding_rotten: { tex: 'siding_rotten', tint: 0xa8a088, scale: 2.2 },
  brick_red: { tex: 'brick', tint: 0xf0e0d8, scale: 2.6 },
  brick_brown: { tex: 'brick', tint: 0xa08670, scale: 2.6 },
  brick_dark: { tex: 'brick', tint: 0x6e6460, scale: 2.6 },
  brick_police: { tex: 'brick', tint: 0xc8b4a4, scale: 2.6 },
  stucco: { tex: 'stucco', tint: 0xefe8da, scale: 3 },
  stucco_teal: { tex: 'stucco', tint: 0x98c4bc, scale: 3 },
  planks_dark: { tex: 'planks', tint: 0x7a6a5a, scale: 2 },
  planks_shed: { tex: 'planks', tint: 0xb4a490, scale: 2 },
  metal_siding: { tex: 'metal', tint: 0xc4c8cc, scale: 3 },
  stone: { tex: 'stone', tint: 0xe0dcd4, scale: 3 },
  // interior walls
  wall_stained: { tex: 'stained', tint: 0xc0b090, scale: 2.4 },
  wall_peeling: { tex: 'stained', tint: 0xa4ac94, scale: 2.4 },
  wall_stone_in: { tex: 'stone', tint: 0xd0c8b8, scale: 3 },
  wall_concrete: { tex: 'concrete', tint: 0xb4b4ac, scale: 3 },
  wall_institution: { tex: 'plaster', tint: 0xa4b89c, scale: 3 },
  wall_clinic: { tex: 'plaster', tint: 0xdcecee, scale: 3 },
  wall_dark_wood: { tex: 'planks', tint: 0x8a6a50, scale: 2 },
  wall_tile_white: { tex: 'wall_tile', tint: 0xffffff, scale: 2 },
  wall_tile_blue: { tex: 'wall_tile', tint: 0xa8c0d8, scale: 2 },
  wall_diner: { tex: 'wall_tile', tint: 0xf4e0cc, scale: 2 },
  wall_shop: { tex: 'plaster', tint: 0xe8e4d8, scale: 3 },
  wall_kitchen_yellow: { tex: 'plaster', tint: 0xe6d494, scale: 3 },
  wall_blue: { tex: 'plaster', tint: 0x98aec8, scale: 3 },
  wall_rose: { tex: 'stripes', tint: 0xe8c0bc, scale: 2.2 },
  wall_floral: { tex: 'floral', tint: 0xffffff, scale: 1.8 },
  wall_beige: { tex: 'plaster', tint: 0xd8ccb0, scale: 3 },
  wall_green: { tex: 'stripes', tint: 0xb0c8a0, scale: 2.2 },
  wall_stripes: { tex: 'stripes', tint: 0xffffff, scale: 2.2 },
  // floors
  floor_wood: { tex: 'wood_floor', tint: 0xffffff, scale: 2.4 },
  floor_tile: { tex: 'tile', tint: 0xffffff, scale: 1.6 },
  floor_carpet0: { tex: 'carpet', tint: 0xb06a60, scale: 2 },
  floor_carpet1: { tex: 'carpet', tint: 0x6a80a0, scale: 2 },
  floor_carpet2: { tex: 'carpet', tint: 0xc8b898, scale: 2 },
  floor_carpet3: { tex: 'carpet', tint: 0x7a9070, scale: 2 },
  floor_concrete: { tex: 'concrete', tint: 0xb0aea8, scale: 3 },
  ceiling: { tex: 'plaster', tint: 0xe8e4dc, scale: 3 },
  // ground
  g_grass: { tex: 'grass', tint: 0xc0b49a, scale: 4 },
  g_park: { tex: 'grass', tint: 0xb0c09a, scale: 4 },
  g_dirt: { tex: 'dirt', tint: 0xffffff, scale: 4 },
  g_forest: { tex: 'dirt', tint: 0x9a8a78, scale: 5 },
  g_asphalt: { tex: 'asphalt', tint: 0xffffff, scale: 5 },
  g_asphalt_light: { tex: 'asphalt', tint: 0xffffff, scale: 5 },
  g_concrete: { tex: 'concrete', tint: 0xffffff, scale: 1.5 },
  g_gravel: { tex: 'gravel', tint: 0xffffff, scale: 2.5 },
  g_wood: { tex: 'wood_floor', tint: 0xb09070, scale: 2 },
  // roofs & misc
  tar: { tex: 'tar', tint: 0xffffff, scale: 4 },
  foundation: { tex: 'concrete', tint: 0x8a8880, scale: 2 },
  curb: { tex: 'concrete', tint: 0xa8a6a0, scale: 1 },
  hedge: { tex: 'leaves', tint: 0x2a4426, scale: 1.5 },
  vc: { tex: 'detail', tint: 0xffffff, scale: 1.2 },
  chain: { tex: 'chain', tint: 0x9a9a9a, scale: 1.2 },
};

const matCache = new Map<string, THREE.Material>();

export function matDef(key: string): MatDef {
  if (D[key]) return D[key];
  if (key.startsWith('roof_')) return { tex: 'roof', tint: parseInt(key.slice(5), 10), scale: 2.5 };
  if (key.startsWith('trim_')) return { tex: 'plaster', tint: parseInt(key.slice(5), 10), scale: 2 };
  return { tex: 'plaster', tint: 0xcccccc, scale: 3 };
}

export function material(key: string): THREE.Material {
  const hit = matCache.get(key);
  if (hit) return hit;
  const d = matDef(key);
  let m: THREE.Material;
  if (key === 'chain') {
    m = new THREE.MeshLambertMaterial({ map: tex('chain'), color: 0x9a9a9a, transparent: false, alphaTest: 0.5, side: THREE.DoubleSide });
  } else if (key === 'vc') {
    m = new THREE.MeshLambertMaterial({ map: tex('detail'), vertexColors: true });
  } else {
    const color = new THREE.Color(d.tint);
    m = new THREE.MeshLambertMaterial({ map: tex(d.tex), color, side: d.side ?? THREE.FrontSide });
  }
  m.name = key;
  matCache.set(key, m);
  return m;
}

export function floorMat(surface: string, variant: number): string {
  switch (surface) {
    case 'wood':
      return 'floor_wood';
    case 'tile':
      return 'floor_tile';
    case 'carpet':
      return `floor_carpet${variant % 4}`;
    default:
      return 'floor_concrete';
  }
}

export function groundMat(kind: string, surface: string): string {
  if (kind === 'forestfloor') return 'g_forest';
  if (kind === 'park') return 'g_park';
  switch (surface) {
    case 'asphalt':
      return 'g_asphalt';
    case 'concrete':
      return 'g_concrete';
    case 'gravel':
      return 'g_gravel';
    case 'wood':
      return 'g_wood';
    case 'dirt':
      return 'g_dirt';
    default:
      return 'g_grass';
  }
}

export function texScale(key: string): number {
  return matDef(key).scale;
}
