import * as THREE from 'three';
import type { Game } from './game';
import { F_BLOCK, F_DOOR, F_WINDOW } from '../world/grid';

/**
 * Observer / inspection mode: a free (or following) camera over the running
 * simulation, time controls and debug overlays. Uses the live simulation.
 */
export class Observer {
  pos = new THREE.Vector3();
  yaw = 0;
  pitch = -0.6;
  speed = 1;
  selected = -1;
  follow = false;
  showPaths = true;
  showSight = false;
  showNav = false;
  private group = new THREE.Group();
  private pathLine: THREE.Line;
  private cone: THREE.Mesh;
  private navPoints: THREE.Points;
  private navT = 0;
  private markers: THREE.InstancedMesh;

  constructor(private game: Game) {
    const sim = game.sim!;
    const p = sim.player;
    this.pos.set(p.x, 30, p.z + 25);
    this.yaw = 0;
    this.pitch = -0.8;
    this.pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x66ffcc, depthTest: false, transparent: true }));
    this.pathLine.renderOrder = 20;
    this.pathLine.frustumCulled = false;
    const cg = new THREE.ConeGeometry(Math.tan(1.05) * 12, 12, 24, 1, true);
    cg.translate(0, -6, 0);
    cg.rotateX(-Math.PI / 2);
    this.cone = new THREE.Mesh(cg, new THREE.MeshBasicMaterial({ color: 0xffee88, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide }));
    this.navPoints = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 0.18, vertexColors: true, depthTest: true }));
    this.navPoints.frustumCulled = false;
    this.markers = new THREE.InstancedMesh(new THREE.ConeGeometry(0.35, 0.7, 4), new THREE.MeshBasicMaterial({ color: 0xffffff }), 128);
    this.markers.frustumCulled = false;
    this.group.add(this.pathLine, this.cone, this.navPoints, this.markers);
    game.renderer.layers.add(this.group);
  }

  dispose() {
    this.game.renderer.layers.remove(this.group);
  }

  select(id: number) {
    this.selected = id;
  }

  camera() {
    const sim = this.game.sim!;
    if (this.follow && this.selected >= 0) {
      const a = sim.actors[this.selected];
      if (a) {
        const back = 6;
        const target = new THREE.Vector3(a.x - Math.sin(a.yaw) * back, a.y + 4.5, a.z + Math.cos(a.yaw) * back);
        this.pos.lerp(target, 0.08);
        const dx = a.x - this.pos.x;
        const dz = a.z - this.pos.z;
        this.yaw = Math.atan2(-dx, -dz);
        this.pitch = Math.atan2(a.y + 1.2 - this.pos.y, Math.hypot(dx, dz));
      }
    }
    return { pos: this.pos.clone(), yaw: this.yaw, pitch: this.pitch, roll: 0 };
  }

  update(dt: number) {
    const inp = this.game.input;
    const sens = 0.0022 * inp.sensitivity;
    if (inp.locked) {
      this.yaw -= inp.mouseDX * sens;
      this.pitch = Math.max(-1.5, Math.min(1.4, this.pitch - inp.mouseDY * sens));
    }
    const fast = inp.held('sprint') ? 40 : 14;
    const f = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const r = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const mv = new THREE.Vector3();
    if (inp.held('forward')) mv.add(f);
    if (inp.held('back')) mv.sub(f);
    if (inp.held('right')) mv.add(r);
    if (inp.held('left')) mv.sub(r);
    if (inp.held('dodge')) mv.y += 1;
    if (inp.held('crouch')) mv.y -= 1;
    if (mv.lengthSq() > 0) {
      this.follow = false;
      this.pos.addScaledVector(mv.normalize(), fast * dt);
    }
    this.pos.y = Math.max(0.6, this.pos.y);
    this.updateOverlays(dt);
  }

  private updateOverlays(dt: number) {
    const sim = this.game.sim!;
    // markers above heads: colour by role / state
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    let n = 0;
    for (const a of sim.npcs) {
      if (n >= 128) break;
      if (a.bodyRemoved && !a.alive) continue;
      m.makeRotationX(Math.PI);
      m.setPosition(a.x, a.y + (a.alive ? 2.4 : 0.9), a.z);
      this.markers.setMatrixAt(n, m);
      const c = !a.alive ? 0x555555 : a.role === 'killer' ? 0xff3a2a : a.role === 'police' ? 0x5a8aff : a.role === 'burglar' ? 0xffc040 : a.alarm > 0.5 ? 0xff9a4a : a.sleeping ? 0x406080 : 0x88ff88;
      col.setHex(a.id === this.selected ? 0xffffff : c);
      this.markers.setColorAt(n, col);
      n++;
    }
    this.markers.count = n;
    this.markers.instanceMatrix.needsUpdate = true;
    if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true;
    const sel = this.selected >= 0 ? sim.npc(this.selected) : null;
    // path of the selected resident
    if (sel && this.showPaths && sel.path && sel.path.length) {
      const pts = [new THREE.Vector3(sel.x, sel.y + 0.2, sel.z)];
      for (let i = sel.pathIdx; i < sel.path.length; i++) pts.push(new THREE.Vector3(sel.path[i].x, sim.grid.heightAt(sel.path[i].x, sel.path[i].z) + 0.2, sel.path[i].z));
      this.pathLine.geometry.dispose();
      this.pathLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      this.pathLine.visible = true;
    } else this.pathLine.visible = false;
    // view cone
    if (sel && this.showSight && sel.alive && !sel.sleeping) {
      this.cone.visible = true;
      this.cone.position.set(sel.x, sel.y + 1.6, sel.z);
      this.cone.rotation.set(0, -sel.yaw, 0);
    } else this.cone.visible = false;
    // navigation grid around the camera
    this.navT -= dt;
    if (this.showNav && this.navT <= 0) {
      this.navT = 0.5;
      const g = sim.grid;
      const pos: number[] = [];
      const cols: number[] = [];
      const cx = g.cx(this.pos.x);
      const cz = g.cz(this.pos.z);
      for (let z = cz - 50; z <= cz + 50; z++)
        for (let x = cx - 50; x <= cx + 50; x++) {
          if (x < 0 || z < 0 || x >= g.w || z >= g.h) continue;
          const i = g.idx(x, z);
          const f = g.flags[i];
          if (!(f & (F_BLOCK | F_DOOR | F_WINDOW))) continue;
          pos.push((x + 0.5) * 0.5, g.floorH[i] / 100 + 0.05, (z + 0.5) * 0.5);
          if (f & F_DOOR) cols.push(1, 0.2, 0.2);
          else if (f & F_WINDOW) cols.push(0.2, 0.5, 1);
          else cols.push(0.6, 0.6, 0.6);
        }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      this.navPoints.geometry.dispose();
      this.navPoints.geometry = geo;
    }
    this.navPoints.visible = this.showNav;
  }
}
