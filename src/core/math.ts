export interface V2 {
  x: number;
  z: number;
}

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const dist = (ax: number, az: number, bx: number, bz: number) => Math.hypot(bx - ax, bz - az);
export const dist2 = (ax: number, az: number, bx: number, bz: number) => {
  const dx = bx - ax;
  const dz = bz - az;
  return dx * dx + dz * dz;
};

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** yaw such that forward vector is (sin(yaw), -cos(yaw)) i.e. yaw 0 looks toward -z */
export function yawTo(fx: number, fz: number, tx: number, tz: number): number {
  return Math.atan2(tx - fx, -(tz - fz));
}

export function forwardOf(yaw: number): V2 {
  return { x: Math.sin(yaw), z: -Math.cos(yaw) };
}

export function approachAngle(cur: number, target: number, maxStep: number): number {
  const d = wrapAngle(target - cur);
  if (Math.abs(d) <= maxStep) return target;
  return wrapAngle(cur + Math.sign(d) * maxStep);
}

export const rect = (x0: number, z0: number, x1: number, z1: number): Rect => ({
  x0: Math.min(x0, x1),
  z0: Math.min(z0, z1),
  x1: Math.max(x0, x1),
  z1: Math.max(z0, z1),
});

export const rw = (r: Rect) => r.x1 - r.x0;
export const rd = (r: Rect) => r.z1 - r.z0;
export const rcx = (r: Rect) => (r.x0 + r.x1) / 2;
export const rcz = (r: Rect) => (r.z0 + r.z1) / 2;

export function rectContains(r: Rect, x: number, z: number, margin = 0): boolean {
  return x >= r.x0 - margin && x <= r.x1 + margin && z >= r.z0 - margin && z <= r.z1 + margin;
}

export function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
  return a.x0 < b.x1 + margin && a.x1 > b.x0 - margin && a.z0 < b.z1 + margin && a.z1 > b.z0 - margin;
}

export function expandRect(r: Rect, m: number): Rect {
  return { x0: r.x0 - m, z0: r.z0 - m, x1: r.x1 + m, z1: r.z1 + m };
}

export function snap(v: number, step = 0.5): number {
  return Math.round(v / step) * step;
}

export function pointSegDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const l2 = vx * vx + vz * vz;
  let t = l2 > 0 ? ((px - ax) * vx + (pz - az) * vz) / l2 : 0;
  t = clamp(t, 0, 1);
  const cx = ax + vx * t;
  const cz = az + vz * t;
  return dist2(px, pz, cx, cz);
}

export function formatClock(gameSeconds: number): string {
  const daySec = ((gameSeconds % 86400) + 86400) % 86400;
  const h = Math.floor(daySec / 3600);
  const m = Math.floor((daySec % 3600) / 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}
