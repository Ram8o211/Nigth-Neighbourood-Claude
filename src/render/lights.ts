import * as THREE from 'three';
import type { LightSource, WorldData } from '../world/types';
import { glowTexture } from './textures';

/** deterministic flicker multiplier for a light at time t (seconds) */
export function flickerFactor(l: LightSource, t: number): number {
  if (!l.flicker) return 1;
  const n = Math.sin(t * 13.1 + l.id * 7.3) * Math.sin(t * 7.7 + l.id * 3.1) * Math.sin(t * 2.3 + l.id);
  if (n > 1 - l.flicker * 0.55) return 0.05;
  return 0.88 + 0.12 * Math.sin(t * 47 + l.id * 1.7);
}

const INTENSITY_SCALE: Record<string, number> = { street: 7, porch: 3.2, room: 3.4, lamp: 2.6, sign: 3, park: 5 };

/**
 * A fixed pool of real point lights assigned each frame to the most relevant
 * light sources near the camera (constant light count avoids shader
 * recompiles). All light sources additionally get a cheap glow sprite.
 */
export class LightPool {
  lights: THREE.PointLight[] = [];
  private assigned: number[] = [];
  glow: THREE.Points;
  private glowPos: Float32Array;
  private glowCol: Float32Array;
  private glowSize: Float32Array;
  pools: THREE.InstancedMesh;
  private poolIds: number[] = [];
  private cand: { id: number; score: number }[] = [];

  constructor(
    private world: WorldData,
    public size: number,
    scene: THREE.Scene,
  ) {
    for (let i = 0; i < size; i++) {
      const pl = new THREE.PointLight(0xffffff, 0, 10, 2);
      pl.castShadow = false;
      scene.add(pl);
      this.lights.push(pl);
      this.assigned.push(-1);
    }
    const n = world.lights.length;
    this.glowPos = new Float32Array(n * 3);
    this.glowCol = new Float32Array(n * 3);
    this.glowSize = new Float32Array(n);
    world.lights.forEach((l, i) => {
      this.glowPos[i * 3] = l.x;
      this.glowPos[i * 3 + 1] = l.y - (l.kind === 'street' ? 0.12 : 0);
      this.glowPos[i * 3 + 2] = l.z;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.glowPos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.glowCol, 3));
    g.setAttribute('size', new THREE.BufferAttribute(this.glowSize, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: glowTexture() }, scale: { value: 600 } },
      vertexShader: /* glsl */ `
        attribute float size; attribute vec3 color; varying vec3 vColor;
        uniform float scale;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * scale / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map; varying vec3 vColor;
        void main() {
          vec4 t = texture2D(map, gl_PointCoord);
          gl_FragColor = vec4(vColor * t.a, 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.glow = new THREE.Points(g, mat);
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 5;
    scene.add(this.glow);
    // ground light pools under exterior lights
    const poolSrc = world.lights.filter((l) => l.kind === 'street' || l.kind === 'porch' || l.kind === 'park');
    this.poolIds = poolSrc.map((l) => l.id);
    const pg = new THREE.PlaneGeometry(1, 1);
    pg.rotateX(-Math.PI / 2);
    const pm = new THREE.MeshBasicMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: true, fog: true });
    this.pools = new THREE.InstancedMesh(pg, pm, Math.max(1, poolSrc.length));
    const m = new THREE.Matrix4();
    poolSrc.forEach((l, i) => {
      const s = l.kind === 'street' ? 13 : l.kind === 'park' ? 9 : 6;
      m.makeScale(s, 1, s);
      m.setPosition(l.x, 0.06 + (i % 7) * 0.002, l.z);
      this.pools.setMatrixAt(i, m);
      this.pools.setColorAt(i, new THREE.Color(0));
    });
    this.pools.frustumCulled = false;
    this.pools.renderOrder = 2;
    scene.add(this.pools);
  }

  setSize(n: number, scene: THREE.Scene) {
    while (this.lights.length > n) {
      const l = this.lights.pop()!;
      scene.remove(l);
      this.assigned.pop();
    }
    while (this.lights.length < n) {
      const pl = new THREE.PointLight(0xffffff, 0, 10, 2);
      scene.add(pl);
      this.lights.push(pl);
      this.assigned.push(-1);
    }
    this.size = n;
  }

  update(cam: THREE.Vector3, camDir: THREE.Vector3, t: number, night: number, insideBuilding: number) {
    const world = this.world;
    const cand = this.cand;
    cand.length = 0;
    const tmp = new THREE.Color();
    for (let i = 0; i < world.lights.length; i++) {
      const l = world.lights[i];
      const on = l.on && !l.broken;
      const f = on ? flickerFactor(l, t) : 0;
      // glow sprites
      const glowStrength = on ? f * (l.kind === 'room' || l.kind === 'lamp' ? 0.25 : 1) * (l.kind === 'sign' ? 0.8 : 1) : 0;
      tmp.setHex(l.color).multiplyScalar(glowStrength * (0.35 + night * 0.65));
      this.glowCol[i * 3] = tmp.r;
      this.glowCol[i * 3 + 1] = tmp.g;
      this.glowCol[i * 3 + 2] = tmp.b;
      this.glowSize[i] = l.kind === 'street' ? 1.6 : l.kind === 'room' ? 0.5 : l.kind === 'sign' ? 1.4 : 0.9;
      if (!on) continue;
      const dx = l.x - cam.x;
      const dz = l.z - cam.z;
      const d2 = dx * dx + dz * dz + (l.y - cam.y) ** 2;
      if (d2 > 70 * 70) continue;
      const d = Math.sqrt(d2);
      const facing = (dx * camDir.x + dz * camDir.z) / (d + 1e-6);
      // interior lights of other buildings matter little from outside and vice versa
      let w = 1;
      if (l.buildingId >= 0 && l.buildingId !== insideBuilding) w = insideBuilding >= 0 ? 0.15 : 0.45;
      if (l.buildingId < 0 && insideBuilding >= 0) w = 0.5;
      const score = (w * l.intensity * l.range * l.range) / (d2 + 4) * (facing > -0.2 || d < l.range ? 1 : 0.3);
      cand.push({ id: i, score });
    }
    (this.glow.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (this.glow.geometry.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    cand.sort((a, b) => b.score - a.score);
    const n = Math.min(this.size, cand.length);
    const cutoff = cand.length > this.size ? cand[this.size].score : 0;
    for (let k = 0; k < this.size; k++) {
      const pl = this.lights[k];
      if (k >= n) {
        pl.intensity = 0;
        pl.visible = false;
        this.assigned[k] = -1;
        continue;
      }
      const c = cand[k];
      const l = world.lights[c.id];
      pl.visible = true;
      pl.position.set(l.x, l.y - 0.2, l.z);
      pl.color.setHex(l.color);
      pl.distance = l.range * 1.4;
      const fade = cutoff > 0 ? Math.min(1, (c.score - cutoff) / (cutoff * 0.6 + 1e-6)) : 1;
      pl.intensity = l.intensity * (INTENSITY_SCALE[l.kind] ?? 3) * flickerFactor(l, t) * (l.buildingId < 0 ? 0.35 + night * 0.65 : 1) * Math.max(0.15, fade);
      this.assigned[k] = c.id;
    }
    // ground pools
    const col = new THREE.Color();
    this.poolIds.forEach((id, i) => {
      const l = world.lights[id];
      const on = l.on && !l.broken;
      const f = on ? flickerFactor(l, t) : 0;
      col.setHex(l.color).multiplyScalar(f * night * (l.kind === 'street' ? 0.22 : 0.16));
      this.pools.setColorAt(i, col);
    });
    if (this.pools.instanceColor) this.pools.instanceColor.needsUpdate = true;
  }
}
