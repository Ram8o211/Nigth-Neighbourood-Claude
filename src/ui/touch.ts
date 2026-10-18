// On-screen controls for phones and tablets: a floating move stick on the left,
// drag anywhere else to look, and buttons that stand in for keys and mouse buttons.
// Every control acts on pointerdown/pointerup (a second finger's tap never becomes a
// click) and captures its pointer so a finger sliding off still releases it.
import type { Game } from '../game/game';
import type { Action } from '../game/input';

/** stick radius in CSS pixels; dragging past it (by STICK_SPRINT) sprints */
const STICK_R = 56;
const STICK_SPRINT = 1.2;
const DEAD = 0.14;
/** touch look: CSS pixels to mouse-equivalent pixels */
const LOOK_SCALE = 2.4;

type Btn = { el: HTMLButtonElement; down?: () => void; up?: () => void; modes: string };

export class TouchControls {
  readonly el: HTMLElement;
  private moveZone: HTMLElement;
  private stickBase: HTMLElement;
  private stickKnob: HTMLElement;
  private rotate: HTMLElement;
  /** the stick: neutral where the thumb landed (ox, oy); its ring is drawn at (bx, by), kept on screen */
  private stick: { id: number; ox: number; oy: number; bx: number; by: number } | null = null;
  private look: { id: number; x: number; y: number } | null = null;
  /** pointerId -> pressed button */
  private held = new Map<number, Btn>();
  private buttons: Record<string, Btn> = {};
  private visibleMode = '';
  /** the game paused itself because the phone was turned upright */
  private pausedByRotation = false;
  /** the player chose the pause menu over the rotate notice (rotation lock, split screen) */
  private rotateDismissed = false;
  private wakeLock: { release(): Promise<void> } | null = null;
  private wakePending = false;

  constructor(private game: Game, root: HTMLElement, before: Node) {
    const inp = game.input;
    this.stickBase = div('t-stick-base');
    this.stickKnob = div('t-stick-knob');
    this.stickBase.append(this.stickKnob);
    this.moveZone = div('t-move');
    this.el = div('');
    this.el.id = 'touch';
    const top = div('t-top');
    this.el.append(div('t-look'), this.moveZone, this.stickBase, top);
    const key = (a: Action, hold = false): Pick<Btn, 'down' | 'up'> => ({
      down: () => inp.pressAction(a, hold),
      up: hold ? () => inp.releaseAction(a) : undefined,
    });
    const add = (name: string, label: string, modes: string, b: Pick<Btn, 'down' | 'up'>, parent: HTMLElement = this.el) => {
      const el = document.createElement('button');
      el.className = `t-btn t-${name}`;
      el.textContent = label;
      el.dataset.t = name;
      this.buttons[name] = { el, modes, ...b };
      parent.append(el);
    };
    // play: actions
    add('use', 'USE', 'p', key('interact', true));
    add('attack', 'HIT', 'p', {
      down: () => {
        inp.lmb = true;
        inp.lmbPressed = true;
      },
      up: () => (inp.lmb = false),
    });
    add('block', 'BLOCK', 'p', { down: () => (inp.rmb = true), up: () => (inp.rmb = false) });
    add('dodge', 'DODGE', 'p', key('dodge'));
    add('crouch', 'CROUCH', 'p', key('crouch'));
    add('light', 'LIGHT', 'p', key('flashlight'));
    add('weapon', 'WEAPON', 'p', { down: () => (inp.wheel += 1) });
    // play: menus (top right)
    add('wait', 'WAIT', 'p', key('wait'), top);
    add('map', 'MAP', 'p', key('map'), top);
    add('journal', 'JOURNAL', 'p', key('journal'), top);
    add('bag', 'BAG', 'p', key('inventory'), top);
    add('pause', '❚❚', 'p', key('pause'), top);
    // observer: fly up and down
    add('up', 'UP', 'o', key('dodge', true));
    add('down', 'DOWN', 'o', key('crouch', true));
    this.rotate = div('t-rotate');
    this.rotate.innerHTML =
      '<div><div class="t-rotate-icon">⟳</div>Turn your phone sideways to play.<div class="muted">The game is paused. If the screen does not turn, switch off rotation lock.</div><div class="t-rotate-buttons"></div></div>';
    const rotateButtons = this.rotate.querySelector('.t-rotate-buttons')!;
    if (document.fullscreenEnabled) {
      // full screen can lock landscape again (Android), e.g. after Back left full screen
      const fs = document.createElement('button');
      fs.textContent = 'Full screen';
      fs.addEventListener('click', () => game.enterFullscreen());
      rotateButtons.append(fs);
    }
    const menu = document.createElement('button');
    menu.textContent = 'Menu';
    menu.addEventListener('click', () => {
      this.rotateDismissed = true;
      this.rotate.style.display = 'none';
    });
    rotateButtons.append(menu);
    this.rotate.style.display = 'none';
    this.el.style.display = 'none';
    // below the HUD's modal layers and the observer panel; the rotate notice covers everything
    root.insertBefore(this.el, before);
    root.append(this.rotate);

    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    this.el.addEventListener('pointermove', (e) => this.onMove(e));
    this.el.addEventListener('pointerup', (e) => this.onUp(e));
    this.el.addEventListener('pointercancel', (e) => this.onUp(e));
    this.el.addEventListener('lostpointercapture', (e) => this.onUp(e));
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    inp.onReset = () => this.release();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.wakePending = false;
    });
    this.clickSecondFingerTaps();
  }

  /**
   * Browsers never turn a tap into a click while another finger is on the screen, so with a thumb
   * resting on the stick, menu and dialog buttons would ignore taps. Such a tap clicks its button
   * when the finger lifts; a native click that may still follow is dropped.
   */
  private clickSecondFingerTaps() {
    const touches = new Set<number>();
    const presses = new Map<number, { btn: HTMLButtonElement; multi: boolean }>();
    let synthetic: { btn: HTMLButtonElement; until: number } | null = null;
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (e.pointerType !== 'touch') return;
        synthetic = null;
        touches.add(e.pointerId);
        if (touches.size > 1) for (const p of presses.values()) p.multi = true;
        const btn = (e.target as Element | null)?.closest?.('button');
        if (btn && !this.el.contains(btn)) presses.set(e.pointerId, { btn, multi: touches.size > 1 });
      },
      true,
    );
    const lift = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      touches.delete(e.pointerId);
      const p = presses.get(e.pointerId);
      presses.delete(e.pointerId);
      if (!p || !p.multi || e.type !== 'pointerup' || !p.btn.isConnected || p.btn.disabled) return;
      const under = document.elementFromPoint(e.clientX, e.clientY);
      if (!under || !p.btn.contains(under)) return;
      synthetic = { btn: p.btn, until: performance.now() + 600 };
      p.btn.click();
    };
    document.addEventListener('pointerup', lift, true);
    document.addEventListener('pointercancel', lift, true);
    document.addEventListener(
      'click',
      (e) => {
        if (!synthetic || !e.isTrusted || performance.now() > synthetic.until || !synthetic.btn.contains(e.target as Node)) return;
        e.preventDefault();
        e.stopPropagation();
        synthetic = null;
      },
      true,
    );
  }

  private onDown(e: PointerEvent) {
    e.preventDefault();
    const t = e.target as HTMLElement;
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer may already be gone */
    }
    const name = t.dataset?.t;
    if (name) {
      const b = this.buttons[name];
      if (!b) return;
      this.held.set(e.pointerId, b);
      b.el.classList.add('down');
      b.down?.();
      return;
    }
    if (t === this.moveZone && !this.stick) {
      // the stick is neutral where the thumb lands; its ring is drawn clear of the screen edges
      const bx = clamp(e.clientX, STICK_R + 8, innerWidth - STICK_R - 8);
      const by = clamp(e.clientY, STICK_R + 8, innerHeight - STICK_R - 8);
      this.stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, bx, by };
      this.el.classList.add('sticking');
      this.moveStick(e.clientX, e.clientY);
      return;
    }
    if (!this.look) this.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }

  private onMove(e: PointerEvent) {
    if (this.stick && e.pointerId === this.stick.id) this.moveStick(e.clientX, e.clientY);
    else if (this.look && e.pointerId === this.look.id) {
      const inp = this.game.input;
      // absolute positions: touch pointer events carry no movementX/Y, and moves may be coalesced
      inp.mouseDX += (e.clientX - this.look.x) * LOOK_SCALE;
      inp.mouseDY += (e.clientY - this.look.y) * LOOK_SCALE;
      this.look.x = e.clientX;
      this.look.y = e.clientY;
    }
  }

  private onUp(e: PointerEvent) {
    const b = this.held.get(e.pointerId);
    if (b) {
      this.held.delete(e.pointerId);
      b.el.classList.remove('down');
      b.up?.();
    }
    if (this.stick && e.pointerId === this.stick.id) this.endStick();
    if (this.look && e.pointerId === this.look.id) this.look = null;
  }

  private moveStick(x: number, y: number) {
    const s = this.stick!;
    let dx = (x - s.ox) / STICK_R;
    let dy = (y - s.oy) / STICK_R;
    const len = Math.hypot(dx, dy);
    const inp = this.game.input;
    inp.stickSprint = len > STICK_SPRINT;
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    // (dx, dy) now has length l; rescale it so the dead zone maps to 0 and the rim to 1
    const l = Math.min(1, len);
    const k = l < DEAD ? 0 : (l - DEAD) / (1 - DEAD) / Math.max(l, 1e-6);
    inp.moveX = dx * k;
    inp.moveY = dy * k;
    this.placeStick(s.bx, s.by, s.ox - s.bx + dx * STICK_R, s.oy - s.by + dy * STICK_R);
    this.stickBase.classList.toggle('sprint', inp.stickSprint);
  }

  private placeStick(ox: number, oy: number, kx: number, ky: number) {
    this.stickBase.style.left = `${ox}px`;
    this.stickBase.style.top = `${oy}px`;
    this.stickKnob.style.transform = `translate(${kx}px, ${ky}px)`;
  }

  private endStick() {
    this.stick = null;
    const inp = this.game.input;
    inp.moveX = inp.moveY = 0;
    inp.stickSprint = false;
    this.el.classList.remove('sticking');
    this.stickBase.classList.remove('sprint');
    this.stickBase.style.left = '';
    this.stickBase.style.top = '';
    this.stickKnob.style.transform = '';
  }

  /** let go of everything (controls hidden, focus lost, mode changed) */
  release() {
    for (const b of this.held.values()) {
      b.el.classList.remove('down');
      b.up?.();
    }
    this.held.clear();
    if (this.stick) this.endStick();
    this.look = null;
  }

  /** per frame: which controls show, button states, the upright-phone pause, screen wake lock */
  update() {
    const g = this.game;
    const inp = g.input;
    // phones play sideways; tablets (and split-screen windows on them) may play upright
    const phone = Math.min(screen.width, screen.height) < 600;
    const upright = inp.touchMode && phone && innerHeight > innerWidth;
    if (g.mode === 'playing') this.rotateDismissed = false;
    if (upright && g.mode === 'playing') {
      g.pause();
      this.pausedByRotation = true;
    } else if (!upright && this.pausedByRotation) {
      this.pausedByRotation = false;
      // back to where the game was, unless the player went into the pause menu meanwhile
      if (g.mode === 'paused' && !this.rotateDismissed) g.resume();
    }
    if (g.mode !== 'paused') this.pausedByRotation = false;
    const rotateShown = upright && !this.rotateDismissed && (g.mode === 'observer' || this.pausedByRotation);
    this.rotate.style.display = rotateShown ? '' : 'none';

    const mode = !inp.touchMode || rotateShown ? '' : g.mode === 'playing' ? 'p' : g.mode === 'observer' ? 'o' : '';
    if (mode !== this.visibleMode) {
      this.visibleMode = mode;
      this.release();
      this.el.style.display = mode ? '' : 'none';
      this.el.dataset.mode = mode;
      for (const b of Object.values(this.buttons)) b.el.style.display = b.modes.includes(mode) && mode ? '' : 'none';
    }
    if (mode === 'p' && g.player && g.sim) {
      const p = g.sim.player;
      this.buttons.crouch.el.classList.toggle('on', p.crouching);
      this.buttons.light.el.classList.toggle('on', p.flashlight);
      this.buttons.light.el.classList.toggle('off', !g.player.count('flashlight'));
      this.buttons.block.el.classList.toggle('on', p.blocking);
      const t = g.player.target;
      this.buttons.use.el.classList.toggle('ready', t.kind !== 'none' || p.stance === 'hidden' || p.carrying >= 0);
      this.buttons.weapon.el.classList.toggle('off', !g.player.weaponSlots().some(({ s }) => s.item !== 'flashlight'));
    }
    this.keepAwake(inp.touchMode && (g.mode === 'playing' || g.mode === 'dialog' || g.mode === 'observer') && !document.hidden);
  }

  /** phones dim and lock after a minute without a touch; keep the screen on while playing */
  private keepAwake(want: boolean) {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (!wl) return;
    if (want && !this.wakeLock && !this.wakePending) {
      this.wakePending = true;
      wl.request('screen')
        .then((l) => {
          this.wakeLock = l;
          (l as unknown as EventTarget).addEventListener?.('release', () => (this.wakeLock = null));
        })
        .catch(() => {
          /* refused (battery saver, not visible): try again after the next visibility change */
        });
    } else if (!want && this.wakeLock) {
      const l = this.wakeLock;
      this.wakeLock = null;
      this.wakePending = false;
      l.release().catch(() => {});
    }
  }
}

function div(cls: string) {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
