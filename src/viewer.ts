// Developer viewer: renders a generated world from a fixed camera (used for screenshots).
import * as THREE from 'three';
import { generateWorld } from './world/gen/generator';
import { GameRenderer } from './render/renderer';

export function runViewer(params: URLSearchParams) {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block';
  const seed = params.get('seed') ?? 'hollow';
  const world = generateWorld({ seed, size: 'medium', density: 0.85, nights: 5 });
  const r = new GameRenderer(canvas);
  r.setQuality((params.get('q') as 'low' | 'medium' | 'high') ?? 'medium');
  r.setWorld(world);
  const hour = parseFloat(params.get('hour') ?? '12');
  const night = hour < 6.5 || hour > 19.5;
  for (const l of world.lights) l.on = l.auto ? night : l.kind === 'porch' ? night : l.kind === 'room' || l.kind === 'lamp' ? night && (l.id % 3 !== 0) : l.on;
  const home = world.buildings[world.playerHouseId];
  const cam = (params.get('cam') ?? '').split(',').map(Number);
  const pos = cam.length >= 3 && !isNaN(cam[0]) ? new THREE.Vector3(cam[0], cam[1], cam[2]) : new THREE.Vector3(home.outsideFront.x, 1.65, home.outsideFront.z);
  let yaw = cam.length >= 4 && !isNaN(cam[3]) ? cam[3] : 0;
  let pitch = cam.length >= 5 && !isNaN(cam[4]) ? cam[4] : 0;
  if (params.get('look') === 'street') {
    const fd = world.doors[home.frontDoorId];
    const out = { x: home.outsideFront.x - (fd.axis === 'z' ? fd.c : home.outsideFront.x), z: home.outsideFront.z - (fd.axis === 'x' ? fd.c : home.outsideFront.z) };
    const l = Math.hypot(out.x, out.z) || 1;
    pos.set(home.outsideFront.x + (out.x / l) * 14, 1.7, home.outsideFront.z + (out.z / l) * 14);
  }
  if (params.get('look') === 'inside') {
    pos.set(home.insideFront.x, 1.65, home.insideFront.z);
    const dx = (home.rect.x0 + home.rect.x1) / 2 - pos.x;
    const dz = (home.rect.z0 + home.rect.z1) / 2 - pos.z;
    yaw = Math.atan2(-dx, -dz) + parseFloat(params.get('turn') ?? '0');
    pitch = -0.15;
  }
  if (params.get('look') === 'home' || params.get('look') === 'street') {
    const dx = (home.rect.x0 + home.rect.x1) / 2 - pos.x;
    const dz = (home.rect.z0 + home.rect.z1) / 2 - pos.z;
    yaw = Math.atan2(-dx, -dz);
    pitch = -0.05;
  }
  const fl = params.get('flash') === '1';
  let t = 0;
  const frame = () => {
    t += 1 / 60;
    r.render({ pos, yaw, pitch, roll: 0, fov: 72, hour, time: t, insideBuilding: params.get('look') === 'inside' ? home.id : -1, flashlight: fl, flashPower: 1, damage: 0, fear: 0, lowHealth: 0, blur: 0 });
    (window as unknown as { __frames: number }).__frames = ((window as unknown as { __frames: number }).__frames ?? 0) + 1;
    requestAnimationFrame(frame);
  };
  window.addEventListener('resize', () => r.resize());
  (window as unknown as { __world: unknown }).__world = world;
  frame();
}
