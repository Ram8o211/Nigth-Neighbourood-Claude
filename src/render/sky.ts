import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../core/math';

/** Atmosphere parameters derived from the time of day. */
export interface Atmosphere {
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  fogColor: THREE.Color;
  fogDensity: number;
  skyTop: THREE.Color;
  skyHorizon: THREE.Color;
  night: number; // 0 day .. 1 full night
  exposure: number;
  isMoon: boolean;
}

const C = (h: number) => new THREE.Color(h);

const KEYS: { h: number; top: number; hor: number; sun: number; sunI: number; hs: number; hg: number; hi: number; fog: number; fogD: number; exp: number }[] = [
  { h: 0, top: 0x03050b, hor: 0x0a0f1c, sun: 0x8fa4d8, sunI: 0.55, hs: 0x3c4c72, hg: 0x1e1e26, hi: 0.8, fog: 0x080b14, fogD: 0.028, exp: 1.4 },
  { h: 4.5, top: 0x03050b, hor: 0x0c1220, sun: 0x8fa4d8, sunI: 0.52, hs: 0x3c4c72, hg: 0x1e1e26, hi: 0.78, fog: 0x080b14, fogD: 0.028, exp: 1.4 },
  { h: 5.8, top: 0x1a2240, hor: 0x8a5a5a, sun: 0xffa078, sunI: 0.5, hs: 0x5a5a78, hg: 0x2a2420, hi: 0.5, fog: 0x4a4250, fogD: 0.018, exp: 1.1 },
  { h: 7.0, top: 0x4a6a9a, hor: 0xd8b8a0, sun: 0xffd8b0, sunI: 2.2, hs: 0xa8b4c8, hg: 0x5a4e40, hi: 1.6, fog: 0xa8a8b0, fogD: 0.008, exp: 1.25 },
  { h: 12, top: 0x4a74a8, hor: 0xb8c4cc, sun: 0xfff2e0, sunI: 3.2, hs: 0xb8c4d4, hg: 0x6a5e4e, hi: 1.9, fog: 0xb0b8c0, fogD: 0.0055, exp: 1.3 },
  { h: 16.5, top: 0x4a6a98, hor: 0xc8c0b4, sun: 0xffe2c0, sunI: 2.9, hs: 0xb0b8c8, hg: 0x665848, hi: 1.75, fog: 0xa8a8ac, fogD: 0.0065, exp: 1.3 },
  { h: 18.6, top: 0x3a4a78, hor: 0xe08858, sun: 0xff9a5a, sunI: 1.9, hs: 0x9a8a9a, hg: 0x4e4038, hi: 1.15, fog: 0x8a6a68, fogD: 0.01, exp: 1.25 },
  { h: 19.7, top: 0x1a2048, hor: 0x8a4a52, sun: 0xd87a6a, sunI: 0.45, hs: 0x4a4a6a, hg: 0x1e1a1c, hi: 0.5, fog: 0x3a3048, fogD: 0.016, exp: 1.15 },
  { h: 20.8, top: 0x070a18, hor: 0x1a1a30, sun: 0x8fa4d8, sunI: 0.52, hs: 0x3c4c72, hg: 0x1e1e26, hi: 0.8, fog: 0x0c0e18, fogD: 0.026, exp: 1.4 },
  { h: 24, top: 0x03050b, hor: 0x0a0f1c, sun: 0x8fa4d8, sunI: 0.55, hs: 0x3c4c72, hg: 0x1e1e26, hi: 0.8, fog: 0x080b14, fogD: 0.028, exp: 1.4 },
];

const tmpA = new THREE.Color();
const tmpB = new THREE.Color();
function lerpColor(out: THREE.Color, a: number, b: number, t: number) {
  tmpA.setHex(a);
  tmpB.setHex(b);
  return out.copy(tmpA).lerp(tmpB, t);
}

export function atmosphereAt(hour: number, out?: Atmosphere): Atmosphere {
  const a: Atmosphere = out ?? {
    sunDir: new THREE.Vector3(),
    sunColor: new THREE.Color(),
    sunIntensity: 1,
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    hemiIntensity: 1,
    fogColor: new THREE.Color(),
    fogDensity: 0.01,
    skyTop: new THREE.Color(),
    skyHorizon: new THREE.Color(),
    night: 0,
    exposure: 1,
    isMoon: false,
  };
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].h <= h) i++;
  const k0 = KEYS[i];
  const k1 = KEYS[i + 1];
  const t = smoothstep(0, 1, (h - k0.h) / Math.max(1e-6, k1.h - k0.h));
  lerpColor(a.skyTop, k0.top, k1.top, t);
  lerpColor(a.skyHorizon, k0.hor, k1.hor, t);
  lerpColor(a.sunColor, k0.sun, k1.sun, t);
  a.sunIntensity = lerp(k0.sunI, k1.sunI, t);
  lerpColor(a.hemiSky, k0.hs, k1.hs, t);
  lerpColor(a.hemiGround, k0.hg, k1.hg, t);
  a.hemiIntensity = lerp(k0.hi, k1.hi, t);
  lerpColor(a.fogColor, k0.fog, k1.fog, t);
  a.fogDensity = lerp(k0.fogD, k1.fogD, t);
  a.exposure = lerp(k0.exp, k1.exp, t);
  // sun path: rises in the east (+x), sets in the west, tilted south
  const dayT = (h - 6.4) / 13.2; // 0 at sunrise, 1 at sunset
  const sunUp = dayT > 0 && dayT < 1;
  if (sunUp) {
    const ang = dayT * Math.PI;
    a.sunDir.set(Math.cos(ang), Math.sin(ang) * 0.78 + 0.04, 0.45).normalize();
    a.isMoon = false;
  } else {
    // moon high in the south-west at night
    const nt = ((h + 24 - 19.6) % 24) / 10.8;
    const ang = clamp(nt, 0, 1) * Math.PI;
    a.sunDir.set(-Math.cos(ang) * 0.6, 0.55 + Math.sin(ang) * 0.35, -0.5).normalize();
    a.isMoon = true;
  }
  a.night = 1 - smoothstep(0.3, 1.0, a.sunIntensity);
  return a;
}

/** gradient sky dome with sun / moon disc and stars */
export class Sky {
  mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  constructor() {
    this.mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color() },
        uNight: { value: 0 },
        uMoon: { value: 0 },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform vec3 uSunColor;
        uniform float uNight; uniform float uMoon; uniform float uTime;
        varying vec3 vDir;
        float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, -0.2, 1.0);
          vec3 col = mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55));
          if (d.y < 0.0) col = uHorizon * (1.0 + d.y * 2.0);
          float sd = max(dot(d, normalize(uSunDir)), 0.0);
          if (uMoon > 0.5) {
            col += uSunColor * smoothstep(0.9993, 0.9996, sd) * 0.9;
            col += uSunColor * pow(sd, 120.0) * 0.12;
          } else {
            col += uSunColor * smoothstep(0.9990, 0.9995, sd) * 3.0;
            col += uSunColor * pow(sd, 18.0) * 0.35;
          }
          // stars
          vec3 sp = floor(d * 380.0);
          float s = hash(sp);
          float tw = 0.6 + 0.4 * sin(uTime * 3.0 + s * 50.0);
          col += vec3(step(0.9975, s) * uNight * tw * smoothstep(0.05, 0.3, d.y)) * 0.9;
          // faint clouds band
          float c = sin(d.x * 6.0 + uTime * 0.01) * sin(d.z * 5.0 - uTime * 0.013) * 0.5 + 0.5;
          col = mix(col, uHorizon * 0.9, c * 0.15 * smoothstep(0.0, 0.4, d.y));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
  }

  update(a: Atmosphere, cam: THREE.Vector3, time: number) {
    this.mesh.position.copy(cam);
    const u = this.mat.uniforms;
    (u.uTop.value as THREE.Color).copy(a.skyTop);
    (u.uHorizon.value as THREE.Color).copy(a.skyHorizon);
    (u.uSunDir.value as THREE.Vector3).copy(a.sunDir);
    (u.uSunColor.value as THREE.Color).copy(a.isMoon ? C(0xc8d4ff) : a.sunColor);
    u.uNight.value = a.night;
    u.uMoon.value = a.isMoon ? 1 : 0;
    u.uTime.value = time;
  }
}
