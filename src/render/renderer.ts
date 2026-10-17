import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { WorldData } from '../world/types';
import { buildWorldMeshes, type WorldMeshes } from './worldMesh';
import { Sky, atmosphereAt, type Atmosphere } from './sky';
import { LightPool } from './lights';
import { DynamicObjects } from './dynamic';
import { setAnisotropy } from './textures';

export type Quality = 'low' | 'medium' | 'high';

export interface ViewState {
  pos: THREE.Vector3;
  yaw: number;
  pitch: number;
  roll: number;
  fov: number;
  hour: number;
  time: number;
  insideBuilding: number;
  flashlight: boolean;
  flashPower: number;
  damage: number;
  fear: number;
  lowHealth: number;
  blur: number;
}

const FX_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.35 },
    uGrain: { value: 0.045 },
    uDamage: { value: 0 },
    uDesat: { value: 0 },
    uAberr: { value: 1 },
    uBrightness: { value: 1 },
    uFear: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime, uVignette, uGrain, uDamage, uDesat, uAberr, uBrightness, uFear;
    varying vec2 vUv;
    float rnd(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float pulse = uFear * (0.5 + 0.5 * sin(uTime * 7.0));
      uv -= c * pulse * 0.006;
      float ab = uAberr * (0.0015 + uDamage * 0.008 + uFear * 0.003);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * ab).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * ab).b;
      col = pow(max(col, 0.0), vec3(1.0 / uBrightness));
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(l) * vec3(0.92, 0.96, 1.04), uDesat);
      // gentle split toning: cool shadows, warm highlights
      col = mix(col * vec3(0.94, 0.98, 1.08), col * vec3(1.05, 1.0, 0.92), smoothstep(0.1, 0.7, l));
      float d = length(c);
      float v = smoothstep(0.95, 0.25, d * (1.0 + uVignette + uFear * 0.6));
      col *= mix(1.0, v, 0.9);
      col = mix(col, vec3(0.32, 0.0, 0.01), clamp(uDamage, 0.0, 1.0) * smoothstep(0.15, 0.7, d));
      float n = rnd(uv * vec2(1920.0, 1080.0) + fract(uTime * 13.7)) - 0.5;
      col += n * uGrain * (1.0 + uFear);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class GameRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer;
  fx: ShaderPass;
  sky = new Sky();
  sun = new THREE.DirectionalLight(0xffffff, 1);
  hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  flashlight = new THREE.SpotLight(0xfff2dc, 0, 30, 0.44, 0.55, 1.6);
  fog = new THREE.FogExp2(0x000000, 0.01);
  atm: Atmosphere = atmosphereAt(12);
  world: WorldData | null = null;
  meshes: WorldMeshes | null = null;
  pool: LightPool | null = null;
  dynamic: DynamicObjects | null = null;
  /** extra groups (characters, effects) owned by other modules */
  layers = new THREE.Group();
  quality: Quality = 'medium';
  brightness = 1;
  postEnabled = true;
  private lastT = 0;
  private camDir = new THREE.Vector3();
  stats = { calls: 0, tris: 0 };

  constructor(public canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.08, 460);
    this.camera.rotation.order = 'YXZ';
    this.scene.fog = this.fog;
    this.scene.add(this.sky.mesh);
    this.scene.add(this.hemi);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    const sc = this.sun.shadow.camera;
    sc.left = -42;
    sc.right = 42;
    sc.top = 42;
    sc.bottom = -42;
    sc.near = 1;
    sc.far = 260;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.set(512, 512);
    this.flashlight.shadow.bias = -0.0008;
    this.flashlight.shadow.camera.near = 0.2;
    this.flashlight.shadow.camera.far = 30;
    this.scene.add(this.flashlight);
    this.scene.add(this.flashlight.target);
    this.scene.add(this.layers);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new OutputPass());
    this.fx = new ShaderPass(FX_SHADER);
    this.composer.addPass(this.fx);
    this.setQuality('medium');
    this.resize();
  }

  setQuality(q: Quality) {
    this.quality = q;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const pr = q === 'low' ? Math.min(dpr, 1) * 0.75 : q === 'medium' ? Math.min(dpr, 1.25) : Math.min(dpr, 2);
    this.renderer.setPixelRatio(pr);
    this.composer.setPixelRatio(pr);
    this.renderer.shadowMap.enabled = q !== 'low';
    const ms = q === 'high' ? 2048 : 1024;
    this.sun.shadow.mapSize.set(ms, ms);
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
    this.sun.castShadow = q !== 'low';
    this.flashlight.castShadow = q !== 'low';
    this.flashlight.shadow.mapSize.set(q === 'high' ? 1024 : 512, q === 'high' ? 1024 : 512);
    if (this.flashlight.shadow.map) {
      this.flashlight.shadow.map.dispose();
      this.flashlight.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
    setAnisotropy(q === 'high' ? 8 : q === 'medium' ? 4 : 1);
    if (this.pool) this.pool.setSize(q === 'low' ? 4 : q === 'medium' ? 8 : 12, this.scene);
    const rt = (this.composer as unknown as { renderTarget1: THREE.WebGLRenderTarget; renderTarget2: THREE.WebGLRenderTarget });
    rt.renderTarget1.samples = q === 'high' ? 4 : 0;
    rt.renderTarget2.samples = q === 'high' ? 4 : 0;
    // material shader variants depend on the shadow configuration
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && 'needsUpdate' in m) m.needsUpdate = true;
    });
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  setWorld(world: WorldData) {
    this.clearWorld();
    this.world = world;
    this.meshes = buildWorldMeshes(world);
    this.scene.add(this.meshes.group);
    this.pool = new LightPool(world, this.quality === 'low' ? 4 : this.quality === 'medium' ? 8 : 12, this.scene);
    this.dynamic = new DynamicObjects(world);
    this.scene.add(this.dynamic.group);
  }

  clearWorld() {
    const disposeTree = (o: THREE.Object3D) => {
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
    };
    if (this.meshes) {
      this.scene.remove(this.meshes.group);
      disposeTree(this.meshes.group);
    }
    if (this.pool) {
      for (const l of this.pool.lights) this.scene.remove(l);
      this.scene.remove(this.pool.glow);
      this.scene.remove(this.pool.pools);
    }
    if (this.dynamic) {
      this.scene.remove(this.dynamic.group);
      disposeTree(this.dynamic.group);
    }
    this.meshes = null;
    this.pool = null;
    this.dynamic = null;
    this.world = null;
  }

  render(v: ViewState) {
    const dt = Math.min(0.1, Math.max(0, v.time - this.lastT));
    this.lastT = v.time;
    const cam = this.camera;
    cam.position.copy(v.pos);
    cam.rotation.set(v.pitch, v.yaw, v.roll, 'YXZ');
    if (Math.abs(cam.fov - v.fov) > 0.01) {
      cam.fov = v.fov;
      cam.updateProjectionMatrix();
    }
    cam.getWorldDirection(this.camDir);
    const a = atmosphereAt(v.hour, this.atm);
    this.sky.update(a, cam.position, v.time);
    const inside = v.insideBuilding >= 0;
    this.sun.color.copy(a.sunColor);
    this.sun.intensity = a.sunIntensity;
    this.sun.position.copy(cam.position).addScaledVector(a.sunDir, 120);
    this.sun.target.position.copy(cam.position);
    // snap shadow camera to texels to avoid shimmering
    const ts = 84 / this.sun.shadow.mapSize.x;
    this.sun.target.position.x = Math.round(this.sun.target.position.x / ts) * ts;
    this.sun.target.position.z = Math.round(this.sun.target.position.z / ts) * ts;
    this.sun.position.x = this.sun.target.position.x + a.sunDir.x * 120;
    this.sun.position.z = this.sun.target.position.z + a.sunDir.z * 120;
    this.hemi.color.copy(a.hemiSky);
    this.hemi.groundColor.copy(a.hemiGround);
    // interiors receive less sky light
    this.hemi.intensity = a.hemiIntensity * (inside ? 0.55 : 1);
    this.fog.color.copy(a.fogColor);
    this.fog.density = a.fogDensity * (inside ? 0.6 : 1);
    this.renderer.toneMappingExposure = a.exposure;
    // flashlight
    const fl = this.flashlight;
    fl.intensity = v.flashlight ? 38 * v.flashPower : 0;
    fl.visible = v.flashlight;
    const right = new THREE.Vector3(Math.cos(v.yaw), 0, -Math.sin(v.yaw));
    fl.position.copy(cam.position).addScaledVector(right, 0.18).add(new THREE.Vector3(0, -0.15, 0));
    fl.target.position.copy(cam.position).addScaledVector(this.camDir, 10);
    if (this.pool) this.pool.update(cam.position, this.camDir, v.time, a.night, v.insideBuilding);
    if (this.dynamic) this.dynamic.update(dt, v.time, a.night);
    if (this.meshes) {
      for (const s of this.meshes.signs) {
        const mat = s.material as THREE.MeshBasicMaterial;
        mat.color.setScalar(0.35 + a.night * 0.9);
      }
    }
    const u = this.fx.uniforms;
    u.uTime.value = v.time;
    u.uDamage.value = v.damage;
    u.uDesat.value = Math.min(0.85, v.lowHealth * 0.7 + v.fear * 0.25);
    u.uFear.value = v.fear;
    u.uBrightness.value = this.brightness;
    this.fx.enabled = this.postEnabled;
    this.renderer.info.autoReset = false;
    this.renderer.info.reset();
    this.composer.render();
    this.stats.calls = this.renderer.info.render.calls;
    this.stats.tris = this.renderer.info.render.triangles;
  }
}
