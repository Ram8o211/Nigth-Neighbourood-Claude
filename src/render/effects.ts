import * as THREE from 'three';
import type { Decal, SimEvent } from '../sim/types';
import type { Simulation } from '../sim/simulation';
import { bloodTexture, glowTexture } from './textures';
import { ITEMS } from '../sim/items';

// ---------------------------------------------------------------------------
// pooled particles

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  size: number;
  rot: number;
  vr: number;
  floor: number;
  stick: boolean;
}

class ParticlePool {
  mesh: THREE.InstancedMesh;
  parts: Particle[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  constructor(
    geo: THREE.BufferGeometry,
    material: THREE.Material,
    public cap: number,
    public gravity: number,
    public drag: number,
  ) {
    this.mesh = new THREE.InstancedMesh(geo, material, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, floor: number, stick = false) {
    if (this.parts.length >= this.cap) this.parts.shift();
    this.parts.push({ x, y, z, vx, vy, vz, life, max: life, size, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 12, floor, stick });
  }
  update(dt: number) {
    const ps = this.parts;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) {
        ps.splice(i, 1);
        continue;
      }
      p.vy -= this.gravity * dt;
      const d = Math.max(0, 1 - this.drag * dt);
      p.vx *= d;
      p.vz *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.rot += p.vr * dt;
      if (p.y < p.floor) {
        p.y = p.floor;
        if (p.stick) {
          p.vx = p.vy = p.vz = 0;
          p.vr = 0;
        } else {
          p.vy = -p.vy * 0.3;
          p.vx *= 0.5;
          p.vz *= 0.5;
          p.vr *= 0.5;
        }
      }
    }
    let n = 0;
    for (const p of ps) {
      const fade = Math.min(1, p.life / (p.max * 0.3));
      this.e.set(p.rot, p.rot * 0.7, 0);
      this.q.setFromEuler(this.e);
      this.p.set(p.x, p.y, p.z);
      const sc = p.size * (this.gravity < 0 ? 1 + (1 - p.life / p.max) * 2 : fade);
      this.s.set(sc, sc, sc);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(n++, this.m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// decals (instanced quads with an atlas offset per instance)

function atlasMaterial(map: THREE.Texture, color = 0xffffff, opacity = 0.95) {
  const m = new THREE.MeshLambertMaterial({ map, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, color });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aAtlas;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = uv * aAtlas.z + aAtlas.xy;\n#endif');
  };
  return m;
}

function chalkTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.strokeStyle = 'rgba(240,240,235,0.9)';
  g.lineWidth = 4;
  g.beginPath();
  // a rough human outline
  g.arc(64, 34, 20, 0, Math.PI * 2);
  g.moveTo(44, 60);
  g.lineTo(20, 120);
  g.lineTo(30, 124);
  g.lineTo(46, 90);
  g.lineTo(44, 160);
  g.lineTo(34, 240);
  g.lineTo(52, 242);
  g.lineTo(62, 170);
  g.lineTo(74, 242);
  g.lineTo(92, 240);
  g.lineTo(84, 160);
  g.lineTo(84, 90);
  g.lineTo(100, 126);
  g.lineTo(110, 120);
  g.lineTo(86, 60);
  g.closePath();
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function shardTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(200,225,240,${0.4 + Math.random() * 0.5})`;
    g.beginPath();
    const x = 20 + Math.random() * 88;
    const y = 20 + Math.random() * 88;
    g.moveTo(x, y);
    g.lineTo(x + Math.random() * 10 - 5, y + Math.random() * 10);
    g.lineTo(x + Math.random() * 8, y + Math.random() * 6 - 3);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

class DecalBatch {
  mesh: THREE.InstancedMesh;
  atlas: Float32Array;
  ids: number[] = [];
  constructor(
    material: THREE.Material,
    public cap: number,
    aspect = 1,
  ) {
    const g = new THREE.PlaneGeometry(1, aspect);
    this.atlas = new Float32Array(cap * 3);
    g.setAttribute('aAtlas', new THREE.InstancedBufferAttribute(this.atlas, 3));
    this.mesh = new THREE.InstancedMesh(g, material, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.receiveShadow = true;
  }
}

const DECAL_CELL: Record<string, (v: number) => [number, number, number]> = {
  blood: (v) => [(v % 4) * 0.25, 0.75 - 0.25 * (1 + (v % 2)), 0.25],
  pool: (v) => [(v % 4) * 0.25, 0.75, 0.25],
  footprint: (v) => [(2 + (v % 2)) * 0.25, 0, 0.25],
  drag: (v) => [(v % 2) * 0.25, 0.25, 0.25],
};

// ---------------------------------------------------------------------------

export class Effects {
  group = new THREE.Group();
  blood: ParticlePool;
  glass: ParticlePool;
  debris: ParticlePool;
  smoke: ParticlePool;
  dust: ParticlePool;
  private bloodDecals: DecalBatch;
  private chalk: DecalBatch;
  private shards: DecalBatch;
  private decalSig = '';
  private items = new Map<number, THREE.Object3D>();
  private tapeCount = 0;
  private sparkle: THREE.Points;
  private sparklePos: Float32Array;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();

  constructor(private sim: Simulation) {
    const cube = new THREE.BoxGeometry(1, 1, 1);
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.5, 0, -0.4, -0.4, 0, 0.45, -0.3, 0], 3));
    tri.computeVertexNormals();
    this.blood = new ParticlePool(new THREE.SphereGeometry(0.5, 5, 4), new THREE.MeshLambertMaterial({ color: 0x5a0408, emissive: 0x100000 }), 400, 9.8, 0.6);
    this.glass = new ParticlePool(tri, new THREE.MeshStandardMaterial({ color: 0xc0d8e8, roughness: 0.05, metalness: 0.4, transparent: true, opacity: 0.8, side: THREE.DoubleSide }), 260, 9.8, 0.3);
    this.debris = new ParticlePool(cube, new THREE.MeshLambertMaterial({ color: 0x6a5038 }), 160, 9.8, 0.4);
    this.dust = new ParticlePool(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x8a8070, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide }), 120, -0.2, 2.5);
    this.smoke = new ParticlePool(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: glowTexture(), color: 0x9a9a9a, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide }), 120, -0.35, 1.2);
    for (const p of [this.blood, this.glass, this.debris, this.dust, this.smoke]) this.group.add(p.mesh);
    this.bloodDecals = new DecalBatch(atlasMaterial(bloodTexture()), 1600);
    this.chalk = new DecalBatch(atlasMaterial(chalkTexture(), 0xffffff, 0.85), 64, 2);
    this.shards = new DecalBatch(atlasMaterial(shardTexture(), 0xffffff, 0.9), 400);
    this.group.add(this.bloodDecals.mesh, this.chalk.mesh, this.shards.mesh);
    this.sparklePos = new Float32Array(256 * 3);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(this.sparklePos, 3));
    sg.setDrawRange(0, 0);
    this.sparkle = new THREE.Points(sg, new THREE.PointsMaterial({ map: glowTexture(), color: 0xfff0b0, size: 0.18, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.sparkle.frustumCulled = false;
    this.group.add(this.sparkle);
  }

  /** react to presentation events */
  onEvent(e: SimEvent) {
    const r = (a: number) => (Math.random() * 2 - 1) * a;
    switch (e.type) {
      case 'blood': {
        const n = Math.round(8 + (e.v ?? 1) * 22);
        const dir = e.dir ?? 0;
        const fx = Math.sin(dir);
        const fz = -Math.cos(dir);
        const floor = this.sim.grid.heightAt(e.x!, e.z!) + 0.02;
        for (let i = 0; i < n; i++) {
          const sp = 1.2 + Math.random() * 3.5;
          this.blood.spawn(e.x! + r(0.1), e.y!, e.z! + r(0.1), fx * sp + r(1.5), Math.random() * 2.5, fz * sp + r(1.5), 1.5 + Math.random() * 2, 0.02 + Math.random() * 0.035, floor, true);
        }
        break;
      }
      case 'glass':
      case 'glass_crack': {
        const big = e.type === 'glass';
        const n = big ? Math.round(40 * (e.v ?? 1)) : 6;
        const floor = this.sim.grid.heightAt(e.x!, e.z!) + 0.02;
        for (let i = 0; i < n; i++) this.glass.spawn(e.x! + r(0.5), e.y! + r(0.5), e.z! + r(0.5), r(2.5), Math.random() * 1.5, r(2.5), 2 + Math.random() * 3, 0.03 + Math.random() * 0.07, floor);
        break;
      }
      case 'impact':
      case 'boards_break':
      case 'door_break': {
        const floor = this.sim.grid.heightAt(e.x!, e.z!) + 0.02;
        const n = e.type === 'impact' ? 6 : 18;
        for (let i = 0; i < n; i++) this.debris.spawn(e.x! + r(0.2), (e.y ?? 1) + r(0.2), e.z! + r(0.2), r(2), Math.random() * 2, r(2), 1.5 + Math.random(), 0.02 + Math.random() * 0.05, floor);
        for (let i = 0; i < 4; i++) this.dust.spawn(e.x! + r(0.3), (e.y ?? 1) + r(0.3), e.z! + r(0.3), r(0.3), 0.1, r(0.3), 1.2, 0.25 + Math.random() * 0.3, -10);
        break;
      }
      case 'smoke':
        this.smoke.spawn(e.x! + r(0.05), e.y!, e.z! + r(0.05), r(0.08), 0.15, r(0.08), 3, 0.18, -10);
        break;
      case 'step':
        if (e.s === 'dirt' || e.s === 'gravel') if (Math.random() < 0.3) this.dust.spawn(e.x! + r(0.2), (e.y ?? 0) + 0.05, e.z! + r(0.2), r(0.2), 0.2, r(0.2), 0.8, 0.12, -10);
        break;
    }
  }

  private syncDecals() {
    const ds = this.sim.decals;
    const sig = `${ds.length}:${ds.length ? ds[ds.length - 1].id : -1}`;
    const growing = ds.some((d) => d.grow > 0 && this.sim.time - d.time < 1800);
    if (sig === this.decalSig && !growing) return;
    this.decalSig = sig;
    let nb = 0;
    let nc = 0;
    let ns = 0;
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const e = new THREE.Euler();
    for (const d of ds) {
      let batch: DecalBatch;
      let idx: number;
      if (d.kind === 'chalk') {
        batch = this.chalk;
        idx = nc++;
      } else if (d.kind === 'glass') {
        batch = this.shards;
        idx = ns++;
      } else {
        batch = this.bloodDecals;
        idx = nb++;
      }
      if (idx >= batch.cap) continue;
      // orientation: floor decals lie flat, wall decals face their normal
      if (d.ny > 0.5) e.set(-Math.PI / 2, 0, d.rot, 'XYZ');
      else e.set(0, Math.atan2(d.nx, d.nz), d.rot, 'YXZ');
      this.q.setFromEuler(e);
      let size = d.size;
      if (d.grow > 0) size *= Math.min(1, 0.25 + (this.sim.time - d.time) / 900) * (1 + d.grow);
      pos.set(d.x, d.y + (d.ny > 0.5 ? (idx % 13) * 0.0004 : 0), d.z);
      scl.set(size, size, size);
      this.m.compose(pos, this.q, scl);
      batch.mesh.setMatrixAt(idx, this.m);
      const cell = DECAL_CELL[d.kind] ? DECAL_CELL[d.kind](d.variant) : [0, 0, 1];
      batch.atlas[idx * 3] = cell[0];
      batch.atlas[idx * 3 + 1] = cell[1];
      batch.atlas[idx * 3 + 2] = cell[2];
    }
    for (const [b, n] of [
      [this.bloodDecals, nb],
      [this.chalk, nc],
      [this.shards, ns],
    ] as [DecalBatch, number][]) {
      b.mesh.count = Math.min(n, b.cap);
      b.mesh.instanceMatrix.needsUpdate = true;
      (b.mesh.geometry.attributes.aAtlas as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
  }

  private itemMesh(item: string): THREE.Object3D {
    const def = ITEMS[item];
    const g = new THREE.Group();
    let mesh: THREE.Mesh;
    switch (item) {
      case 'evidence':
        mesh = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.02, 0.12), new THREE.MeshLambertMaterial({ color: 0xd8c890, emissive: 0x201800 }));
        break;
      case 'cigarette_butt':
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.04, 5), new THREE.MeshLambertMaterial({ color: 0xe8e0c8 }));
        mesh.rotation.z = Math.PI / 2;
        break;
      case 'key':
        mesh = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.01, 0.025), new THREE.MeshStandardMaterial({ color: 0xc8a040, metalness: 0.8, roughness: 0.3 }));
        break;
      default: {
        const col = def?.cat === 'food' ? 0xb0402a : def?.cat === 'weapon' ? 0x5a4a3a : def?.cat === 'medical' ? 0xe8e8e8 : def?.cat === 'valuable' ? 0xc8a040 : 0x6a6a6a;
        mesh = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.1, 0.12), new THREE.MeshLambertMaterial({ color: col }));
      }
    }
    mesh.castShadow = true;
    g.add(mesh);
    return g;
  }

  private syncItems() {
    const seen = new Set<number>();
    for (const it of this.sim.items) {
      if (it.taken) continue;
      seen.add(it.id);
      if (!this.items.has(it.id)) {
        const o = this.itemMesh(it.item);
        o.position.set(it.x, it.y + 0.01, it.z);
        o.rotation.y = (it.id * 1.7) % 6.28;
        this.group.add(o);
        this.items.set(it.id, o);
      }
    }
    for (const [id, o] of this.items)
      if (!seen.has(id)) {
        this.group.remove(o);
        this.items.delete(id);
      }
  }

  private syncTape() {
    if (this.sim.tape.length === this.tapeCount) return;
    for (let i = this.tapeCount; i < this.sim.tape.length; i++) {
      const t = this.sim.tape[i];
      const g = new THREE.Group();
      const postM = new THREE.MeshLambertMaterial({ color: 0x3a3a3a });
      const tapeM = new THREE.MeshLambertMaterial({ color: 0xe8c818, emissive: 0x2a2400, side: THREE.DoubleSide });
      const r = 1.6;
      const pts: [number, number][] = [];
      for (let k = 0; k < 4; k++) {
        const a = t.rot + (k / 4) * Math.PI * 2;
        let px = t.x + Math.cos(a) * r;
        let pz = t.z + Math.sin(a) * r;
        // keep posts out of walls
        const p = { x: px, z: pz };
        this.sim.colliders.resolveCircle(p, 0.08);
        px = p.x;
        pz = p.z;
        pts.push([px, pz]);
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.0, 5), postM);
        post.position.set(px, this.sim.grid.heightAt(px, pz) + 0.5, pz);
        g.add(post);
      }
      for (let k = 0; k < 4; k++) {
        const [ax, az] = pts[k];
        const [bx, bz] = pts[(k + 1) % 4];
        const len = Math.hypot(bx - ax, bz - az);
        const strip = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.07), tapeM);
        strip.position.set((ax + bx) / 2, this.sim.grid.heightAt(ax, az) + 0.85, (az + bz) / 2);
        strip.rotation.y = -Math.atan2(bz - az, bx - ax);
        g.add(strip);
      }
      this.group.add(g);
    }
    this.tapeCount = this.sim.tape.length;
  }

  update(dt: number, cam: THREE.Vector3, time: number) {
    for (const p of [this.blood, this.glass, this.debris, this.dust, this.smoke]) p.update(dt);
    this.syncDecals();
    this.syncItems();
    this.syncTape();
    // sparkles over nearby uncollected items so they can be found
    let n = 0;
    for (const it of this.sim.items) {
      if (it.taken || n >= 256) continue;
      const d = Math.hypot(it.x - cam.x, it.z - cam.z);
      if (d > 7) continue;
      const tw = Math.sin(time * 3 + it.id) > 0.2;
      if (!tw) continue;
      this.sparklePos[n * 3] = it.x;
      this.sparklePos[n * 3 + 1] = it.y + 0.12;
      this.sparklePos[n * 3 + 2] = it.z;
      n++;
    }
    this.sparkle.geometry.setDrawRange(0, n);
    (this.sparkle.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  reset() {
    this.decalSig = '';
    for (const o of this.items.values()) this.group.remove(o);
    this.items.clear();
    this.tapeCount = 0;
  }
}

export type { Decal };
