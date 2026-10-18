import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { WorldData } from '../world/types';
import { crackTexture, glowTexture } from './textures';
import { flickerFactor } from './lights';

function vcolor(g: THREE.BufferGeometry, hex: number) {
  const ng = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(hex);
  const n = ng.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  ng.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  ng.deleteAttribute('uv');
  return ng;
}

function doorPanelGeometry(bars: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  if (bars) {
    for (let k = 0; k < 9; k++) {
      const g = new THREE.BoxGeometry(0.03, 2.08, 0.03);
      g.translate(0.06 + k * 0.125, 1.04, 0);
      parts.push(vcolor(g, 0x6a6e72));
    }
    for (const y of [0.1, 1.0, 2.0]) {
      const g = new THREE.BoxGeometry(1.1, 0.06, 0.05);
      g.translate(0.55, y, 0);
      parts.push(vcolor(g, 0x5a5e62));
    }
  } else {
    const g = new THREE.BoxGeometry(1.1, 2.1, 0.05);
    g.translate(0.55, 1.05, 0);
    parts.push(vcolor(g, 0xffffff));
    // raised panels
    for (const [y, h] of [
      [0.55, 0.75],
      [1.5, 0.85],
    ]) {
      const p = new THREE.BoxGeometry(0.8, h, 0.065);
      p.translate(0.55, y, 0);
      parts.push(vcolor(p, 0xe0e0e0));
    }
    const knob = new THREE.BoxGeometry(0.06, 0.06, 0.16);
    knob.translate(0.98, 1.0, 0);
    parts.push(vcolor(knob, 0xc8a850));
  }
  return mergeGeometries(parts)!;
}

const DOOR_COLORS = [0x6b4a32, 0x8a2a22, 0x2a4a3a, 0x3a3a4a, 0xe8e4dc, 0x5a3d29];

export class DynamicObjects {
  group = new THREE.Group();
  private doorMesh: THREE.InstancedMesh;
  private barsMesh: THREE.InstancedMesh;
  private doorSlot: number[] = []; // door id -> instance index in its mesh
  private doorAngle: Float32Array;
  private doorSig: Float32Array;
  private glass: THREE.InstancedMesh;
  private cracks: THREE.InstancedMesh;
  private shards: THREE.InstancedMesh;
  private boards: THREE.InstancedMesh;
  private glowMesh: THREE.InstancedMesh;
  private winSig: Int32Array;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(private world: WorldData) {
    const nDoor = world.doors.filter((d) => !d.bars).length;
    const nBars = world.doors.filter((d) => d.bars).length;
    const dm = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.doorMesh = new THREE.InstancedMesh(doorPanelGeometry(false), dm, Math.max(1, nDoor));
    this.barsMesh = new THREE.InstancedMesh(doorPanelGeometry(true), dm, Math.max(1, nBars));
    let a = 0;
    let b = 0;
    const col = new THREE.Color();
    for (const d of world.doors) {
      if (d.bars) this.doorSlot.push(b++);
      else {
        const bld = world.buildings[d.buildingId];
        const c = d.exterior ? DOOR_COLORS[(d.buildingId * 7 + d.id) % DOOR_COLORS.length] : bld.kind === 'police' || bld.kind === 'clinic' ? 0xd8d8d0 : 0x8a6a4a;
        this.doorMesh.setColorAt(a, col.setHex(bld.kind === 'abandoned' ? 0x4a3e32 : c));
        this.doorSlot.push(a++);
      }
    }
    for (const im of [this.doorMesh, this.barsMesh]) {
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      this.group.add(im);
    }
    this.doorAngle = new Float32Array(world.doors.length).fill(-1);
    this.doorSig = new Float32Array(world.doors.length).fill(-1);

    const nw = Math.max(1, world.windows.length);
    const plane = new THREE.PlaneGeometry(1, 1);
    this.glass = new THREE.InstancedMesh(
      plane,
      new THREE.MeshStandardMaterial({ color: 0x8aa6bc, transparent: true, opacity: 0.2, roughness: 0.06, metalness: 0.2, side: THREE.DoubleSide, depthWrite: false }),
      nw,
    );
    this.cracks = new THREE.InstancedMesh(plane, new THREE.MeshBasicMaterial({ map: crackTexture(), transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false }), nw);
    // broken window shards: jagged triangles hugging the frame
    const shardParts: THREE.BufferGeometry[] = [];
    const tri = (pts: number[]) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      g.computeVertexNormals();
      return g;
    };
    shardParts.push(tri([-0.5, -0.5, 0, -0.1, -0.5, 0, -0.5, -0.05, 0]));
    shardParts.push(tri([0.5, 0.5, 0, 0.15, 0.5, 0, 0.5, 0.0, 0]));
    shardParts.push(tri([0.5, -0.5, 0, 0.5, -0.2, 0, 0.3, -0.5, 0]));
    shardParts.push(tri([-0.5, 0.5, 0, -0.5, 0.2, 0, -0.25, 0.5, 0]));
    this.shards = new THREE.InstancedMesh(
      mergeGeometries(shardParts)!,
      new THREE.MeshStandardMaterial({ color: 0xa8c0d0, transparent: true, opacity: 0.45, roughness: 0.05, side: THREE.DoubleSide, depthWrite: false }),
      nw,
    );
    const boardParts: THREE.BufferGeometry[] = [];
    for (const [y, r] of [
      [-0.3, 0.12],
      [0.05, -0.08],
      [0.35, 0.05],
    ]) {
      const g = new THREE.BoxGeometry(1.25, 0.16, 0.035);
      g.rotateZ(r);
      g.translate(0, y, 0);
      boardParts.push(vcolor(g, 0x8a6a48));
    }
    this.boards = new THREE.InstancedMesh(mergeGeometries(boardParts)!, new THREE.MeshLambertMaterial({ vertexColors: true }), nw);
    this.glowMesh = new THREE.InstancedMesh(
      plane,
      new THREE.MeshBasicMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
      nw,
    );
    for (const im of [this.glass, this.cracks, this.shards, this.boards, this.glowMesh]) {
      im.frustumCulled = false;
      this.group.add(im);
    }
    this.boards.castShadow = true;
    this.glass.renderOrder = 3;
    this.glowMesh.renderOrder = 4;
    this.winSig = new Int32Array(world.windows.length).fill(-1);
    for (let i = 0; i < world.windows.length; i++) this.glowMesh.setColorAt(i, new THREE.Color(0));
  }

  private windowMatrix(i: number, offset: number, sx: number, sy: number, yMid?: number) {
    const w = this.world.windows[i];
    const b = this.world.buildings[w.buildingId];
    const y = yMid ?? b.floorY + (w.sill + w.top) / 2;
    const ox = w.axis === 'x' ? w.t : w.c + offset;
    const oz = w.axis === 'x' ? w.c + offset : w.t;
    this.e.set(0, w.axis === 'x' ? 0 : Math.PI / 2, 0);
    this.q.setFromEuler(this.e);
    this.v.set(ox, y, oz);
    this.s.set(sx, sy, 1);
    return this.m.compose(this.v, this.q, this.s);
  }

  update(dt: number, t: number, night: number) {
    const world = this.world;
    // doors: animate visual angle toward the simulated open fraction
    for (let i = 0; i < world.doors.length; i++) {
      const d = world.doors[i];
      const target = d.broken ? 1.55 : d.open * 1.5;
      let ang = this.doorAngle[i];
      if (ang < 0) ang = target;
      else ang += (target - ang) * Math.min(1, dt * 10);
      this.doorAngle[i] = ang;
      const sig = ang + (d.broken ? 10 : 0);
      if (Math.abs(sig - this.doorSig[i]) < 1e-4) continue;
      this.doorSig[i] = sig;
      const b = world.buildings[d.buildingId];
      const hx = d.axis === 'x' ? (d.hingeLow ? d.t - 0.55 : d.t + 0.55) : d.c;
      const hz = d.axis === 'x' ? d.c : d.hingeLow ? d.t - 0.55 : d.t + 0.55;
      let yaw: number;
      if (d.axis === 'x') yaw = d.hingeLow ? -d.openSide * ang : Math.PI + d.openSide * ang;
      else yaw = d.hingeLow ? -Math.PI / 2 + d.openSide * ang : Math.PI / 2 - d.openSide * ang;
      this.e.set(d.broken ? 0.12 : 0, yaw, d.broken ? 0.05 : 0, 'YXZ');
      this.q.setFromEuler(this.e);
      this.v.set(hx, b.floorY + (d.broken ? -0.05 : 0.01), hz);
      this.s.set(1, 1, 1);
      this.m.compose(this.v, this.q, this.s);
      (d.bars ? this.barsMesh : this.doorMesh).setMatrixAt(this.doorSlot[i], this.m);
      (d.bars ? this.barsMesh : this.doorMesh).instanceMatrix.needsUpdate = true;
    }
    // windows
    const col = new THREE.Color();
    let glowDirty = false;
    for (let i = 0; i < world.windows.length; i++) {
      const w = world.windows[i];
      const sig = w.damage * 10 + (w.boarded ? 1 : 0);
      if (sig !== this.winSig[i]) {
        this.winSig[i] = sig;
        const h = w.top - w.sill;
        const inside = -w.outside;
        this.glass.setMatrixAt(i, w.damage < 2 ? this.windowMatrix(i, 0, w.width, h) : this.zero);
        this.cracks.setMatrixAt(i, w.damage === 1 ? this.windowMatrix(i, 0.004, w.width, h) : this.zero);
        this.shards.setMatrixAt(i, w.damage === 2 ? this.windowMatrix(i, 0, w.width, h) : this.zero);
        this.boards.setMatrixAt(i, w.boarded ? this.windowMatrix(i, inside * 0.2, w.width / 1.0, h / 1.0) : this.zero);
        this.glowMesh.setMatrixAt(i, this.windowMatrix(i, inside * 0.1, w.width * 1.6, h * 1.6));
        for (const im of [this.glass, this.cracks, this.shards, this.boards, this.glowMesh]) im.instanceMatrix.needsUpdate = true;
      }
      // glow from the room light behind the window
      const room = world.rooms[w.roomId];
      let lit = 0;
      let lc = 0xffd7a0;
      for (const lid of room.lightIds) {
        const l = world.lights[lid];
        if (l.on && !l.broken) {
          lit = Math.max(lit, flickerFactor(l, t) * (l.kind === 'room' ? 1 : 0.6));
          lc = l.color;
        }
      }
      const strength = lit * (0.15 + night * 0.85) * (w.boarded ? 0.15 : 0.55);
      col.setHex(lc).lerp(new THREE.Color(w.curtain), 0.35).multiplyScalar(strength);
      this.glowMesh.setColorAt(i, col);
      glowDirty = true;
    }
    if (glowDirty && this.glowMesh.instanceColor) this.glowMesh.instanceColor.needsUpdate = true;
  }
}
