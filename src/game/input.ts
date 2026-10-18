// Keyboard / mouse input with pointer lock and rebindable actions, plus the state
// the on-screen touch controls feed (src/ui/touch.ts).

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

export type TouchSetting = 'auto' | 'on' | 'off';

/** a phone or tablet: the primary pointer is a finger */
export function touchPrimary() {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

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
  /** the first movement after the pointer is captured can carry the cursor's old offset */
  private skipMove = false;
  enabled = true;
  /** set while a text field / rebind capture wants raw keys */
  capture: ((code: string) => void) | null = null;
  /** on-screen touch controls are in use (no pointer lock; buttons stand in for keys and mouse) */
  touchMode = false;
  touchSetting: TouchSetting = 'auto';
  /** analog movement from the touch stick: x right, y back (forward is negative), length <= 1 */
  moveX = 0;
  moveY = 0;
  /** the touch stick is pushed past its rim */
  stickSprint = false;
  /** called when touchMode changes, and when held touch state must be dropped */
  onTouchMode: ((on: boolean) => void) | null = null;
  onReset: (() => void) | null = null;
  private lastPointer: '' | 'mouse' | 'touch' = '';
  private lastTouchAt = -1e9;

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      // typing in a text field (the world seed) is not a game key
      if (!this.capture && (isTextField(e.target) || e.isComposing)) return;
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
    window.addEventListener('blur', () => this.reset());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.reset();
    });
    // which kind of pointer the player is using decides whether the touch controls show
    window.addEventListener(
      'pointerdown',
      (e) => {
        // a pen can stand in for either (a desktop tablet or an iPad pencil): it does not switch
        if (e.pointerType === 'mouse') this.lastPointer = 'mouse';
        else if (e.pointerType === 'touch') {
          this.lastPointer = 'touch';
          this.lastTouchAt = performance.now();
        } else return;
        this.updateTouchMode();
      },
      true,
    );
    el.addEventListener('mousedown', (e) => {
      // browsers follow a tap with emulated mouse events; those are not clicks
      if (this.touchMode || performance.now() - this.lastTouchAt < 800) return;
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
      if (this.skipMove) {
        this.skipMove = false;
        return;
      }
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
      this.skipMove = this.locked;
    });
    this.updateTouchMode();
  }

  /** look and attack input is live: the pointer is captured, or the touch controls are up */
  get active() {
    return this.locked || this.touchMode;
  }

  setTouchSetting(t: TouchSetting) {
    this.touchSetting = t;
    this.updateTouchMode();
  }

  private updateTouchMode() {
    const t = this.touchSetting;
    const on = t === 'on' || (t === 'auto' && (this.lastPointer ? this.lastPointer === 'touch' : touchPrimary()));
    if (on === this.touchMode) return;
    this.touchMode = on;
    if (on) this.unlock();
    this.reset();
    this.onTouchMode?.(on);
  }

  /** drop every held key, button and stick (focus lost, page hidden, controls hidden) */
  reset() {
    this.down.clear();
    this.lmb = this.rmb = false;
    this.moveX = this.moveY = 0;
    this.stickSprint = false;
    this.onReset?.();
  }

  /** press an action as if its key went down (touch buttons); hold keeps it down until released */
  pressAction(a: Action, hold = false) {
    this.press(this.bindings[a], hold);
  }
  releaseAction(a: Action) {
    this.release(this.bindings[a]);
  }

  lock() {
    // phones have no pointer lock, and taking it would hide where the fingers are
    if (this.touchMode) return;
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

  /** inject a synthetic press (touch buttons and automated tests) */
  press(code: string, hold = false) {
    if (!this.down.has(code)) this.pressed.add(code);
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

/** an element that takes typed text (sliders, checkboxes and selects still let game keys like Esc through) */
function isTextField(t: EventTarget | null) {
  if (!(t instanceof HTMLElement)) return false;
  if (t.tagName === 'TEXTAREA' || t.isContentEditable) return true;
  return t instanceof HTMLInputElement && ['text', 'search', 'number', 'email', 'url', 'password', 'tel'].includes(t.type);
}
