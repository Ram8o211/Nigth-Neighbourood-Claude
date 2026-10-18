// Multi-touch for the mobile smoke test, sent through the Chrome DevTools Protocol
// (Playwright's own touchscreen only taps). Fingers are numbered; a finger stays down
// until end(). Chromium turns these into pointer events with pointerType 'touch'.

/** a landscape phone (Pixel-class size) at device scale 1, which keeps software rendering fast */
export const PHONE_LANDSCAPE = {
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
};

export class Touch {
  static async create(page) {
    return new Touch(page, await page.context().newCDPSession(page));
  }
  constructor(page, cdp) {
    this.page = page;
    this.cdp = cdp;
    this.down = new Map();
  }
  #pt(id, x, y) {
    return { id, x: Math.round(x), y: Math.round(y), radiusX: 4, radiusY: 4, force: 1 };
  }
  async start(id, x, y) {
    this.down.set(id, { x, y });
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [this.#pt(id, x, y)] });
  }
  /** moves: { [finger]: [x, y] } */
  async move(moves) {
    const pts = [];
    for (const [k, [x, y]] of Object.entries(moves)) {
      const id = Number(k);
      if (!this.down.has(id)) throw new Error(`finger ${id} is not down`);
      this.down.set(id, { x, y });
      pts.push(this.#pt(id, x, y));
    }
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts });
  }
  async end(id) {
    const p = this.down.get(id);
    if (!p) return;
    this.down.delete(id);
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [this.#pt(id, p.x, p.y)] });
  }
  async endAll() {
    this.down.clear();
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  /** drag a finger from (x, y) by (dx, dy) in a few steps, calling between() after each step */
  async drag(id, x, y, dx, dy, steps = 5, between = async () => {}) {
    await this.start(id, x, y);
    for (let i = 1; i <= steps; i++) {
      await this.move({ [id]: [x + (dx * i) / steps, y + (dy * i) / steps] });
      await between(i);
    }
  }
}

/** centre of the first element matching a selector, in CSS pixels (null if hidden) */
export async function centerOf(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(el).display === 'none') return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
}
