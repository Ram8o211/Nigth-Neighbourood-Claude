// Keyboard / mouse input with pointer lock and rebindable actions.

export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'sprint'
  | 'crouch'
  | 'interact'
  | 'flashlight'
  | 'inventory'
  | 'journal'
  | 'dodge'
  | 'drop'
  | 'map'
  | 'pause'
  | 'slot1'
  | 'slot2'
  | 'slot3'
  | 'slot4'
  | 'slot5'
  | 'slot6'
  | 'holster'
  | 'observer'
  | 'wait';

export const DEFAULT_BINDINGS: Record<Action, string> = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  sprint: 'ShiftLeft',
  crouch: 'KeyC',
  interact: 'KeyE',
  flashlight: 'KeyF',
  inventory: 'Tab',
  journal: 'KeyJ',
  dodge: 'Space',
  drop: 'KeyG',
  map: 'KeyM',
  pause: 'Escape',
  slot1: 'Digit1',
  slot2: 'Digit2',
  slot3: 'Digit3',
  slot4: 'Digit4',
  slot5: 'Digit5',
  slot6: 'Digit6',
  holster: 'KeyH',
  observer: 'F2',
  wait: 'KeyT',
};

/** largest believable mouse movement in one event, in CSS pixels */
const MAX_MOUSE_STEP = 400;

export class Input {
  bindings: Record<Action, string> = { ...DEFAULT_BINDINGS };
  private down = new Set<string>();
  private pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  lmb = false;
  rmb = false;
  lmbPressed = false;
  wheel = 0;
  sensitivity = 1;
  invertY = false;
  locked = false;
  enabled = true;
  /** set while a text field / rebind capture wants raw keys */
  capture: ((code: string) => void) | null = null;

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (this.capture) {
        e.preventDefault();
        const c = this.capture;
        this.capture = null;
        c(e.code);
        return;
      }
      if (e.code === 'Tab' || e.code === 'F2' || (this.locked && (e.code === 'Space' || e.code.startsWith('Arrow')))) e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
    });
    window.addEventListener('blur', () => {
      this.down.clear();
      this.lmb = this.rmb = false;
    });
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.lmb = true;
        this.lmbPressed = true;
      }
      if (e.button === 2) this.rmb = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.lmb = false;
      if (e.button === 2) this.rmb = false;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // some browsers report one bogus jump (about the cursor's offset) around pointer-lock
      // changes and clicks; no real hand movement covers this much in a single event
      if (Math.abs(e.movementX) > MAX_MOUSE_STEP || Math.abs(e.movementY) > MAX_MOUSE_STEP) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener(
      'wheel',
      (e) => {
        if (this.locked) this.wheel += Math.sign(e.deltaY);
      },
      { passive: true },
    );
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
    });
  }

  lock() {
    if (document.pointerLockElement !== this.el) {
      try {
        const p = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {
        /* pointer lock may be unavailable (tests / iframes) */
      }
    }
  }

  unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** a physical key by its code, independent of bindings */
  raw(code: string) {
    return this.enabled && this.down.has(code);
  }

  held(a: Action) {
    return this.enabled && this.down.has(this.bindings[a]);
  }

  /** true once per key press */
  hit(a: Action) {
    return this.pressed.has(this.bindings[a]);
  }

  /** inject a synthetic press (used by automated tests) */
  press(code: string, hold = false) {
    this.pressed.add(code);
    if (hold) this.down.add(code);
  }
  release(code: string) {
    this.down.delete(code);
  }

  endFrame() {
    this.pressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.lmbPressed = false;
    this.wheel = 0;
  }

  keyName(a: Action) {
    const c = this.bindings[a];
    return c.replace('Key', '').replace('Digit', '').replace('Left', '').replace('Right', '');
  }
}
