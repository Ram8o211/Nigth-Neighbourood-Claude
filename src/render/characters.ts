import * as THREE from 'three';
import type { ActorState, Appearance, NpcState } from '../sim/types';
import { faceTexture } from './textures';

const matCache = new Map<string, THREE.Material>();
function mat(color: number, emissive = 0): THREE.MeshLambertMaterial {
  const key = `${color}:${emissive}`;
  let m = matCache.get(key) as THREE.MeshLambertMaterial | undefined;
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, emissive });
    matCache.set(key, m);
  }
  return m;
}
const boxGeo = new THREE.BoxGeometry(1, 1, 1);

/**
 * Unit cube with rounded edges: vertices are pulled towards a sphere. Keeps
 * the box's six material groups and UVs (the face texture stays on the front).
 */
function roundedBox(seg: number, k: number) {
  const g = new THREE.BoxGeometry(1, 1, 1, seg, seg, seg);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const t = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    if (v.lengthSq() < 1e-9) continue;
    // blend each vertex towards the inscribed sphere: face centres stay, edges and corners soften
    t.copy(v).normalize().multiplyScalar(0.5);
    v.lerp(t, k);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}
const softGeo = roundedBox(3, 0.6);
const coatGeo = roundedBox(3, 0.35);
const headGeo = roundedBox(4, 0.75);

function shade(c: number, f: number) {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * f));
  const b = Math.min(255, Math.round((c & 255) * f));
  return (r << 16) | (g << 8) | b;
}

/** a box mesh whose origin sits at its top centre so it hangs from a joint */
function hanging(w: number, h: number, d: number, m: THREE.Material) {
  const mesh = new THREE.Mesh(softGeo, m);
  mesh.scale.set(w, h, d);
  mesh.position.y = -h / 2;
  mesh.castShadow = true;
  return mesh;
}

export interface Rig {
  root: THREE.Group;
  body: THREE.Group; // everything above the feet, used to tilt / lay down
  hips: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  foreL: THREE.Group;
  foreR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  shinL: THREE.Group;
  shinR: THREE.Group;
  coat: THREE.Mesh;
  shirt: THREE.Mesh;
  /** upper and lower arm meshes: shirt colour indoors, coat colour outside */
  sleeves: THREE.Mesh[];
  shirtMat: THREE.Material;
  hood: THREE.Mesh;
  hair: THREE.Object3D;
  hand: THREE.Group; // right hand attach point
  items: Record<string, THREE.Object3D>;
  legLen: number;
  scale: number;
  phase: number;
  flash: THREE.Mesh;
  ember: THREE.Mesh;
  lastOutfit: string;
  lastItem: string;
}

function makeItems(hand: THREE.Group) {
  const items: Record<string, THREE.Object3D> = {};
  const knife = new THREE.Group();
  const blade = new THREE.Mesh(boxGeo, mat(0xc8ccd0));
  blade.scale.set(0.02, 0.22, 0.035);
  blade.position.set(0, -0.2, 0);
  const handle = new THREE.Mesh(boxGeo, mat(0x2a1a10));
  handle.scale.set(0.03, 0.1, 0.03);
  handle.position.set(0, -0.05, 0);
  knife.add(blade, handle);
  const bat = new THREE.Group();
  const bb = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.022, 0.85, 6), mat(0x8a6a40));
  bb.position.y = -0.38;
  bat.add(bb);
  const crow = new THREE.Group();
  const cb = new THREE.Mesh(boxGeo, mat(0x6a2a20));
  cb.scale.set(0.025, 0.7, 0.025);
  cb.position.y = -0.3;
  crow.add(cb);
  const baton = new THREE.Group();
  const tb = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.55, 6), mat(0x111111));
  tb.position.y = -0.22;
  baton.add(tb);
  const torch = new THREE.Group();
  const tt = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.2, 8), mat(0x2a2a2a));
  tt.rotation.x = Math.PI / 2;
  tt.position.set(0, -0.05, -0.08);
  torch.add(tt);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.028, 8), new THREE.MeshBasicMaterial({ color: 0xfff4d0 }));
  lens.position.set(0, -0.05, -0.181);
  lens.rotation.y = Math.PI;
  torch.add(lens);
  const cig = new THREE.Group();
  const c1 = new THREE.Mesh(boxGeo, mat(0xf0ece0));
  c1.scale.set(0.012, 0.07, 0.012);
  c1.position.y = -0.04;
  cig.add(c1);
  items.kitchen_knife = knife;
  items.baseball_bat = bat;
  items.crowbar = crow;
  items.baton = baton;
  items.flashlight = torch;
  items.cigarette = cig;
  for (const k in items) {
    items[k].visible = false;
    hand.add(items[k]);
  }
  return items;
}

export function buildRig(app: Appearance, police: boolean): Rig {
  const s = app.height / 1.75;
  const bw = app.build;
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const legLen = 0.86 * s;
  const hips = new THREE.Group();
  hips.position.y = legLen;
  body.add(hips);
  const pants = mat(police ? 0x1c2433 : app.pants);
  const shirtM = mat(police ? 0x2c3e5e : app.shirt);
  const skin = mat(app.skin);
  const shoeC = app.shoes === 'boots' ? 0x3a2616 : app.shoes === 'dress' ? 0x111111 : 0xd8d8d0;
  // pelvis
  const pelvis = new THREE.Mesh(softGeo, pants);
  pelvis.scale.set(0.34 * bw, 0.18 * s, 0.2 * bw);
  pelvis.position.y = 0.02;
  pelvis.castShadow = true;
  hips.add(pelvis);
  // legs
  const mkLeg = (side: number) => {
    const leg = new THREE.Group();
    leg.position.set(side * 0.1 * bw, -0.04, 0);
    hips.add(leg);
    leg.add(hanging(0.14 * bw, 0.44 * s, 0.15 * bw, pants));
    const shin = new THREE.Group();
    shin.position.y = -0.44 * s;
    leg.add(shin);
    shin.add(hanging(0.12 * bw, 0.4 * s, 0.13 * bw, pants));
    const shoe = new THREE.Mesh(softGeo, mat(shoeC));
    shoe.scale.set(0.12 * bw, 0.08, 0.26);
    shoe.position.set(0, -0.4 * s - 0.03, -0.05);
    shoe.castShadow = true;
    shin.add(shoe);
    return { leg, shin };
  };
  const L = mkLeg(-1);
  const R = mkLeg(1);
  // torso
  const torso = new THREE.Group();
  torso.position.y = 0.08;
  hips.add(torso);
  const shirt = new THREE.Mesh(softGeo, shirtM);
  shirt.scale.set(0.4 * bw, 0.56 * s, 0.24 * bw);
  shirt.position.y = 0.28 * s;
  shirt.castShadow = true;
  torso.add(shirt);
  const coat = new THREE.Mesh(coatGeo, mat(police ? 0x23304a : app.coat));
  coat.scale.set(0.44 * bw, 0.74 * s, 0.28 * bw);
  coat.position.y = 0.23 * s;
  coat.castShadow = true;
  torso.add(coat);
  if (police) {
    const badge = new THREE.Mesh(softGeo, mat(0xd8b040, 0x221a00));
    badge.scale.set(0.06, 0.07, 0.01);
    badge.position.set(-0.11 * bw, 0.45 * s, -0.15 * bw);
    torso.add(badge);
  }
  // head
  const head = new THREE.Group();
  head.position.y = 0.6 * s;
  torso.add(head);
  const neck = new THREE.Mesh(softGeo, skin);
  neck.scale.set(0.1, 0.1, 0.1);
  neck.position.y = 0.03;
  head.add(neck);
  const faceMat = new THREE.MeshLambertMaterial({ map: faceTexture(app.skin, app.face) });
  const headMesh = new THREE.Mesh(headGeo, [skin, skin, skin, skin, skin, faceMat]);
  headMesh.scale.set(0.22, 0.26, 0.23);
  headMesh.position.y = 0.2;
  headMesh.castShadow = true;
  head.add(headMesh);
  let hair: THREE.Object3D = new THREE.Group();
  const hm = mat(app.hair);
  if (police) {
    const cap = new THREE.Mesh(softGeo, mat(0x1c2433));
    cap.scale.set(0.25, 0.08, 0.26);
    cap.position.y = 0.36;
    const brim = new THREE.Mesh(softGeo, mat(0x111111));
    brim.scale.set(0.24, 0.02, 0.1);
    brim.position.set(0, 0.32, -0.15);
    hair = new THREE.Group();
    hair.add(cap, brim);
  } else if (app.hairStyle === 'cap') {
    const cap = new THREE.Mesh(softGeo, mat(shade(app.coat, 1.4)));
    cap.scale.set(0.24, 0.08, 0.25);
    cap.position.y = 0.35;
    const brim = new THREE.Mesh(softGeo, mat(shade(app.coat, 1.2)));
    brim.scale.set(0.2, 0.02, 0.12);
    brim.position.set(0, 0.32, -0.16);
    hair = new THREE.Group();
    hair.add(cap, brim);
  } else if (app.hairStyle !== 'bald') {
    const g = new THREE.Group();
    const top = new THREE.Mesh(softGeo, hm);
    top.scale.set(0.24, 0.07, 0.25);
    top.position.y = 0.345;
    g.add(top);
    const back = new THREE.Mesh(softGeo, hm);
    const long = app.hairStyle === 'long';
    back.scale.set(0.24, long ? 0.34 : 0.18, 0.07);
    back.position.set(0, long ? 0.16 : 0.24, 0.11);
    g.add(back);
    if (app.hairStyle === 'bun') {
      const bun = new THREE.Mesh(softGeo, hm);
      bun.scale.set(0.1, 0.1, 0.1);
      bun.position.set(0, 0.36, 0.14);
      g.add(bun);
    }
    hair = g;
  }
  head.add(hair);
  if (app.beard) {
    const beard = new THREE.Mesh(softGeo, hm);
    beard.scale.set(0.2, 0.09, 0.03);
    beard.position.set(0, 0.1, -0.11);
    head.add(beard);
  }
  if (app.glasses) {
    // two thin rims and a bridge
    for (const sx of [-1, 1]) {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.006, 4, 10), mat(0x1a1a1a));
      rim.position.set(sx * 0.05, 0.215, -0.118);
      head.add(rim);
    }
    const bridge = new THREE.Mesh(boxGeo, mat(0x1a1a1a));
    bridge.scale.set(0.04, 0.008, 0.008);
    bridge.position.set(0, 0.22, -0.118);
    head.add(bridge);
  }
  const hood = new THREE.Mesh(softGeo, mat(shade(app.coat, 0.7)));
  hood.scale.set(0.28, 0.32, 0.29);
  hood.position.set(0, 0.22, 0.02);
  hood.visible = false;
  head.add(hood);
  // arms
  const sleeves: THREE.Mesh[] = [];
  const mkArm = (side: number) => {
    const arm = new THREE.Group();
    arm.position.set(side * 0.25 * bw, 0.54 * s, 0);
    torso.add(arm);
    const upper = hanging(0.11 * bw, 0.32 * s, 0.12 * bw, shirtM);
    arm.add(upper);
    const fore = new THREE.Group();
    fore.position.y = -0.32 * s;
    arm.add(fore);
    const lower = hanging(0.1 * bw, 0.28 * s, 0.1 * bw, shirtM);
    fore.add(lower);
    sleeves.push(upper, lower);
    const handM = new THREE.Mesh(softGeo, skin);
    handM.scale.set(0.08, 0.09, 0.08);
    handM.position.y = -0.32 * s;
    fore.add(handM);
    const hand = new THREE.Group();
    hand.position.y = -0.33 * s;
    fore.add(hand);
    return { arm, fore, hand, upper };
  };
  const AL = mkArm(-1);
  const AR = mkArm(1);
  const items = makeItems(AR.hand);
  // glowing bits
  const flash = new THREE.Mesh(new THREE.ConeGeometry(0.9, 3.2, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0xfff0c8, transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
  flash.rotation.x = -Math.PI / 2;
  flash.position.set(0, -0.05, -1.75);
  flash.visible = false;
  AR.hand.add(flash);
  const ember = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial({ color: 0xff6a20 }));
  ember.scale.set(0.015, 0.015, 0.015);
  ember.position.y = -0.08;
  ember.visible = false;
  items.cigarette.add(ember);
  root.traverse((o) => {
    o.matrixAutoUpdate = true;
  });
  return {
    root,
    body,
    hips,
    torso,
    head,
    armL: AL.arm,
    armR: AR.arm,
    foreL: AL.fore,
    foreR: AR.fore,
    legL: L.leg,
    legR: R.leg,
    shinL: L.shin,
    shinR: R.shin,
    coat,
    shirt,
    sleeves,
    shirtMat: shirtM,
    hood,
    hair,
    hand: AR.hand,
    items,
    legLen,
    scale: s,
    phase: Math.random() * 6,
    flash,
    ember,
    lastOutfit: '',
    lastItem: '',
  };
}

const tmpV = new THREE.Vector3();

/** pose a rig from simulation state; dt in real seconds */
export function animateRig(r: Rig, a: ActorState, dt: number, time: number, deadPose: number) {
  const anim = a.alive ? a.anim : 'dead';
  const speed = a.speed;
  r.phase += dt * (speed > 3 ? speed * 1.55 : Math.max(0.6, speed) * 2.2 + (speed > 0.2 ? 2.3 : 0));
  const ph = r.phase;
  // reset
  r.body.rotation.set(0, 0, 0);
  r.body.position.set(0, 0, 0);
  r.hips.position.y = r.legLen;
  r.hips.rotation.set(0, 0, 0);
  r.torso.rotation.set(0, 0, 0);
  r.head.rotation.set(0, 0, 0);
  r.armL.rotation.set(0, 0, 0.08);
  r.armR.rotation.set(0, 0, -0.08);
  r.foreL.rotation.set(-0.15, 0, 0);
  r.foreR.rotation.set(-0.15, 0, 0);
  r.legL.rotation.set(0, 0, 0);
  r.legR.rotation.set(0, 0, 0);
  r.shinL.rotation.set(0, 0, 0);
  r.shinR.rotation.set(0, 0, 0);
  const walkCycle = (amp: number, bend: number, armAmp: number) => {
    const s1 = Math.sin(ph);
    r.legL.rotation.x = s1 * amp;
    r.legR.rotation.x = -s1 * amp;
    r.shinL.rotation.x = Math.max(0, -Math.cos(ph)) * bend;
    r.shinR.rotation.x = Math.max(0, Math.cos(ph)) * bend;
    r.armL.rotation.x = -s1 * armAmp;
    r.armR.rotation.x = s1 * armAmp;
    r.hips.position.y = r.legLen - Math.abs(Math.cos(ph)) * 0.03;
  };
  switch (anim) {
    case 'walk':
      walkCycle(0.45, 0.6, 0.35);
      break;
    case 'run':
      walkCycle(0.85, 1.3, 0.8);
      r.torso.rotation.x = -0.18;
      r.foreL.rotation.x = -1.1;
      r.foreR.rotation.x = -1.1;
      break;
    case 'sneak':
    case 'crouch':
    case 'pick':
    case 'search':
    case 'climb': {
      r.hips.position.y = r.legLen * 0.62;
      r.legL.rotation.x = -0.9;
      r.legR.rotation.x = -0.5;
      r.shinL.rotation.x = 1.5;
      r.shinR.rotation.x = 1.2;
      r.torso.rotation.x = -0.45;
      if (anim === 'sneak') {
        r.legL.rotation.x += Math.sin(ph) * 0.3;
        r.legR.rotation.x -= Math.sin(ph) * 0.3;
      }
      if (anim === 'pick' || anim === 'search') {
        r.armL.rotation.x = -1.2 + Math.sin(time * 9) * 0.1;
        r.armR.rotation.x = -1.3 + Math.cos(time * 7) * 0.12;
      }
      break;
    }
    case 'sit':
      r.hips.position.y = 0.48;
      r.legL.rotation.x = -1.5;
      r.legR.rotation.x = -1.5;
      r.shinL.rotation.x = 1.45;
      r.shinR.rotation.x = 1.45;
      r.armL.rotation.x = -0.5;
      r.armR.rotation.x = -0.5;
      r.foreL.rotation.x = -0.6;
      r.foreR.rotation.x = -0.6;
      r.head.rotation.y = Math.sin(time * 0.3 + r.phase) * 0.3;
      break;
    case 'lie':
    case 'dead':
    case 'downed': {
      // lie on the back along the body axis (feet toward forward)
      // feet toward the actor's forward, head toward its back, centred on the actor position
      const onBed = anim === 'lie';
      r.body.rotation.x = Math.PI / 2 - (anim === 'downed' ? 0.3 : 0);
      r.body.position.y = onBed ? 0.62 : 0.13;
      r.body.position.z = -r.legLen;
      r.armL.rotation.z = anim === 'dead' ? 0.9 + deadPose * 0.5 : 0.25;
      r.armR.rotation.z = anim === 'dead' ? -0.4 - deadPose * 0.7 : -0.25;
      r.legL.rotation.z = anim === 'dead' ? -0.15 : 0;
      r.legR.rotation.z = anim === 'dead' ? 0.25 * deadPose : 0;
      r.head.rotation.y = anim === 'dead' ? 0.7 * (deadPose - 0.5) : 0;
      if (anim === 'downed') {
        r.armL.rotation.x = Math.sin(time * 3) * 0.3 - 0.8;
        r.legR.rotation.x = Math.sin(time * 2) * 0.15;
      }
      break;
    }
    case 'talk':
      r.armR.rotation.x = -0.4 + Math.sin(time * 4 + r.phase) * 0.25;
      r.foreR.rotation.x = -0.9;
      r.head.rotation.x = Math.sin(time * 5) * 0.05;
      break;
    case 'use':
      r.armL.rotation.x = -0.9 + Math.sin(time * 3) * 0.08;
      r.armR.rotation.x = -0.95 + Math.cos(time * 3.4) * 0.08;
      r.foreL.rotation.x = -0.5;
      r.foreR.rotation.x = -0.5;
      r.head.rotation.x = 0.25;
      break;
    case 'smoke': {
      const lift = Math.max(0, Math.sin(time * 0.8 + r.phase)) ** 3;
      r.armR.rotation.x = -0.3 - lift * 1.3;
      r.foreR.rotation.x = -0.5 - lift * 1.6;
      r.armL.rotation.z = 0.25;
      break;
    }
    case 'phone':
      r.armR.rotation.x = -0.4;
      r.armR.rotation.z = -0.5;
      r.foreR.rotation.x = -2.4;
      break;
    case 'knock':
      r.armR.rotation.x = -1.2;
      r.foreR.rotation.x = -0.6 + Math.abs(Math.sin(time * 9)) * -0.6;
      break;
    case 'look':
      r.head.rotation.y = Math.sin(time * 1.2 + r.phase) * 0.8;
      break;
    case 'fight':
    case 'hit':
      r.armL.rotation.x = -1.3;
      r.foreL.rotation.x = -1.2;
      r.armR.rotation.x = -1.1;
      r.foreR.rotation.x = -1.0;
      r.legL.rotation.x = -0.25;
      r.legR.rotation.x = 0.2;
      r.hips.position.y = r.legLen - 0.05;
      if (anim === 'hit') r.torso.rotation.x = 0.3;
      break;
    default: {
      // idle breathing
      const br = Math.sin(time * 1.6 + r.phase) * 0.02;
      r.torso.rotation.x = br;
      r.armL.rotation.x = br;
      r.armR.rotation.x = br;
    }
  }
  if (a.blocking) {
    r.armL.rotation.x = -1.6;
    r.armR.rotation.x = -1.6;
    r.foreL.rotation.x = -1.2;
    r.foreR.rotation.x = -1.2;
  }
  if (a.swingT > 0 && a.alive) {
    // windup then strike
    const t = Math.max(0, Math.min(1, 1 - a.swingT / 0.5));
    const swing = t < 0.4 ? -2.6 * (t / 0.4) : -2.6 + (t - 0.4) * 5.5;
    r.armR.rotation.x = swing;
    r.armR.rotation.z = -0.3;
    r.foreR.rotation.x = -0.4;
    r.torso.rotation.y = t < 0.4 ? 0.35 : -0.35;
  }
  if (a.hitFlash > 0 && a.alive) r.torso.rotation.x += a.hitFlash * 1.2;
  if (a.flashlight && a.alive && a.swingT <= 0) {
    r.armR.rotation.x = -1.35;
    r.foreR.rotation.x = -0.2;
  }
  void tmpV;
}

/** updates outfit / held item visibility */
export function dressRig(r: Rig, a: ActorState, outdoors: boolean) {
  const npc = a as NpcState;
  const night = a.outfit === 'night';
  const outfitKey = `${a.outfit}:${outdoors}:${a.bloody > 0.3}`;
  if (outfitKey !== r.lastOutfit) {
    r.lastOutfit = outfitKey;
    r.coat.visible = outdoors || night;
    r.hood.visible = night;
    r.hair.visible = !night;
    if (a.bloody > 0.3) {
      (r.coat.material as THREE.MeshLambertMaterial) = mat(shade(npc.app?.coat ?? 0x333333, 0.6) | 0x200000);
    } else if (npc.app) {
      r.coat.material = mat(npc.role === 'police' ? 0x23304a : npc.app.coat);
    }
    const sleeve = r.coat.visible ? r.coat.material : r.shirtMat;
    for (const m of r.sleeves) m.material = sleeve;
  }
  let item = '';
  if (a.alive) {
    if (a.anim === 'smoke') item = 'cigarette';
    else if (a.weapon && r.items[a.weapon]) item = a.weapon;
    else if (a.flashlight) item = 'flashlight';
  }
  if (item !== r.lastItem) {
    for (const k in r.items) r.items[k].visible = k === item;
    r.lastItem = item;
  }
  r.flash.visible = a.alive && a.flashlight && item === 'flashlight';
  r.ember.visible = item === 'cigarette';
}
