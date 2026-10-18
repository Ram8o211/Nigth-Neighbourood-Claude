// Mobile smoke test: the game on an emulated landscape phone (touch screen, mobile
// viewport, no mouse or keyboard). Menus are operated with finger taps and the game
// with the on-screen controls through real multi-touch events; the page's game object
// is used only to read state and to teleport, as in smoke.mjs.

import { Touch, centerOf } from './touch.mjs';

export const results = [];

export default async function mobile(page, h) {
  const check = (name, ok, detail = '') => {
    results.push({ name: `mobile: ${name}`, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  mobile: ${name}${detail ? '  — ' + detail : ''}`);
  };
  const player = () =>
    h.eval(() => {
      const g = window.__game;
      const p = g.sim?.player;
      return p ? { mode: g.mode, x: p.x, z: p.z, yaw: p.yaw, crouching: p.crouching, blocking: p.blocking, flashlight: p.flashlight, sprinting: p.sprinting, building: p.building, target: g.player.target.kind } : { mode: g.mode };
    });
  const stand = (x, z, tx, ty, tz) => h.eval(([x, z, tx, ty, tz]) => window.__nnTest.stand(x, z, tx, ty, tz), [x, z, tx, ty, tz]);
  const spotNear = (x, z, r, rMax, b) => h.eval(([x, z, r, rMax, b]) => window.__nnTest.spotNear(x, z, r, rMax, b ?? undefined), [x, z, r, rMax, b ?? null]);
  /** every visible button of the current screen lies inside the viewport (reachable without zooming) */
  const fits = (sel = '#layer button') =>
    h.eval((sel) => {
      const bad = [];
      for (const b of document.querySelectorAll(sel)) {
        const r = b.getBoundingClientRect();
        if (!r.width) continue;
        // a scrollable screen may put a button below the fold: scroll it into view first
        b.scrollIntoView({ block: 'nearest' });
        const q = b.getBoundingClientRect();
        if (q.left < -1 || q.right > innerWidth + 1 || q.top < -1 || q.bottom > innerHeight + 1) bad.push(`${b.textContent.trim().slice(0, 20)} @${Math.round(q.left)},${Math.round(q.top)}`);
      }
      return { bad, wide: document.documentElement.scrollWidth > innerWidth + 1 };
    }, sel);
  const t = await Touch.create(page);
  /** wait until an on-screen control is shown (the layer follows the game mode on the next frame) */
  const control = async (name) => {
    await h.waitFor((sel) => {
      const el = document.querySelector(sel);
      return !!el && el.getBoundingClientRect().width > 0;
    }, `#touch .t-${name}`, 20000).catch(() => {});
    const c = await centerOf(page, `#touch .t-${name}`);
    if (!c) throw new Error(`touch control ${name} is not shown`);
    return c;
  };
  /** the controls a finger would actually hit: shown, and not covered by another element */
  const reachable = () =>
    h.eval(() =>
      [...document.querySelectorAll('#touch .t-btn')]
        .filter((b) => getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 0)
        .filter((b) => {
          const r = b.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return hit === b || b.contains(hit);
        })
        .map((b) => b.dataset.t),
    );
  /** tap an on-screen game control (acts on touch-down, like a finger) */
  const tapControl = async (name, holdFrames = 1) => {
    const c = await control(name);
    await t.start(5, c.x, c.y);
    await h.frames(holdFrames);
    await t.end(5);
    await h.frames(1);
    return true;
  };

  // ---------------------------------------------------------------- menus on a phone
  await h.open();
  await h.frames(3);
  const env = await h.eval(() => ({
    touch: window.__game.input.touchMode,
    cls: document.body.classList.contains('touch'),
    quality: window.__game.renderer.quality,
    pr: window.__game.renderer.renderer.getPixelRatio(),
    w: innerWidth,
    h: innerHeight,
  }));
  check('touch mode switches on by itself on a touch screen', env.touch && env.cls, JSON.stringify(env));
  check('phones start on the low graphics preset', env.quality === 'low' && env.pr <= 1, `${env.quality}, pixel ratio ${env.pr}`);
  check('main menu shows', await h.hasText('New Game'));
  let f = await fits();
  check('main menu fits the landscape screen', !f.bad.length && !f.wide, f.bad.join('; '));
  await h.shot('m01_menu');
  for (const [btn, expect] of [
    ['Settings', 'Touch controls'],
    ['How to Play', 'Left side'],
    ['Load Game', 'Load Game'],
  ]) {
    await h.tapText(btn);
    await page.waitForTimeout(200);
    const txt = await page.locator('#layer').innerText();
    f = await fits();
    check(`menu: ${btn} opens and fits`, txt.includes(expect) && !f.bad.length && !f.wide, `${txt.slice(0, 50).replace(/\n/g, ' | ')} ${f.bad.join('; ')}`);
    if (btn === 'Settings') {
      check('settings: key rebinding is hidden on touch', !(await page.locator('#layer summary').count()));
      await h.shot('m02_settings');
    }
    await h.tapText('Back');
    await page.waitForTimeout(150);
  }
  check('menus return to the main menu', await h.hasText('New Game'));

  // ---------------------------------------------------------------- start a game with taps
  await h.tapText('New Game');
  await page.waitForTimeout(200);
  const seed = page.locator('#layer input').first();
  check('seed field is not auto-capitalised', (await seed.getAttribute('autocapitalize')) === 'off');
  await seed.fill('mobile-test');
  f = await fits();
  check('new game screen fits', !f.bad.length && !f.wide, f.bad.join('; '));
  await h.tapText('Begin');
  await h.waitFor(() => window.__game && window.__game.mode === 'playing', null, 180000);
  await h.frames(4);
  await control('use');
  const hud = await h.eval(() => ({
    lock: !!document.pointerLockElement,
    touchShown: getComputedStyle(document.querySelector('#touch')).display !== 'none',
    hint: getComputedStyle(document.querySelector('.click-hint')).display,
    msgs: document.querySelector('.messages').innerText,
  }));
  check('game starts without pointer lock', !hud.lock);
  hud.buttons = await reachable();
  check('touch controls are shown in play, none covered', hud.touchShown && ['use', 'attack', 'block', 'dodge', 'crouch', 'light', 'weapon', 'pause', 'bag', 'journal', 'map', 'wait'].every((b) => hud.buttons.includes(b)), hud.buttons.join(','));
  check('no "click to look" hint on touch', hud.hint === 'none');
  check('arrival message names the touch controls', /thumb/i.test(hud.msgs), hud.msgs.slice(0, 120));
  f = await fits('#touch .t-btn');
  check('every touch control is on screen', !f.bad.length, f.bad.join('; '));
  await h.shot('m03_play');

  // ---------------------------------------------------------------- move with the left stick
  let a = await player();
  let mid = null;
  await t.drag(0, 120, 300, 0, -50, 4, async () => {
    await h.frames(1);
  });
  await h.frames(8);
  mid = await h.eval(() => ({ mx: window.__game.input.moveX, my: window.__game.input.moveY }));
  await t.end(0);
  await h.frames(2);
  let b = await player();
  const walked = Math.hypot(b.x - a.x, b.z - a.z);
  check('left stick walks the player', walked > 0.3, `moved ${walked.toFixed(2)} m, stick ${mid.mx.toFixed(2)},${mid.my.toFixed(2)}`);
  check('releasing the stick stops', await h.eval(() => window.__game.input.moveX === 0 && window.__game.input.moveY === 0));
  // past the rim sprints
  await t.drag(0, 120, 300, 0, -90, 3, async () => {
    await h.frames(1);
  });
  await h.frames(3);
  b = await player();
  await t.end(0);
  check('stick past the rim sprints', b.sprinting);

  // ---------------------------------------------------------------- look by dragging on the right
  a = await player();
  await t.drag(1, 480, 170, 160, 0, 5, async () => {
    await h.frames(1);
  });
  await t.end(1);
  await h.frames(2);
  b = await player();
  check('dragging on the right turns the view', Math.abs(b.yaw - a.yaw) > 0.3, `yaw ${a.yaw.toFixed(2)} -> ${b.yaw.toFixed(2)}`);

  // ---------------------------------------------------------------- USE: the uncle's door and letter
  const home = await h.eval(() => {
    const s = window.__game.sim;
    const b = s.world.buildings[s.world.playerHouseId];
    const d = b.doorIds.map((i) => s.world.doors[i]).find((d) => d.exterior);
    return { of: b.outsideFront, inf: b.insideFront, door: { id: d.id, x: d.axis === 'x' ? d.t : d.c, z: d.axis === 'x' ? d.c : d.t }, floorY: b.floorY, id: b.id };
  });
  await stand(home.of.x, home.of.z, home.door.x, home.floorY + 1.2, home.door.z);
  await h.frames(2);
  const prompt = await page.locator('.prompt').innerText();
  check('prompts name the USE button', /\[Use\]/.test(prompt) && !/\[E\]/.test(prompt), prompt);
  check('USE lights up when something can be used', await h.eval(() => document.querySelector('#touch .t-use').classList.contains('ready')));
  await tapControl('use');
  await h.frames(3);
  const door = await h.eval((id) => window.__game.sim.world.doors[id], home.door.id);
  check('tapping USE unlocks and opens the door', !door.locked && door.target === 1, `locked=${door.locked} target=${door.target}`);
  const note = await h.eval(() => {
    const it = window.__game.sim.items.find((i) => i.item === 'note' && !i.taken);
    return it ? { x: it.x, y: it.y, z: it.z } : null;
  });
  const spot = note && (await spotNear(note.x, note.z, 0.8, 1.8, home.id));
  if (spot) {
    await stand(spot.x, spot.z, note.x, note.y, note.z);
    await h.frames(2);
    await tapControl('use');
    await h.waitFor(() => !!document.querySelector('#layer .letter'), null, 30000).catch(() => {});
    const letter = await h.eval(() => ({ mode: window.__game.mode, touch: getComputedStyle(document.querySelector('#touch')).display }));
    check('USE on the letter opens it, and the controls step aside', letter.mode === 'dialog' && letter.touch === 'none', JSON.stringify(letter));
    f = await fits();
    check("the letter's Fold button is reachable on a short screen", !f.bad.length, f.bad.join('; '));
    await h.shot('m04_letter');
    await h.tapText('Fold the letter away');
    await h.waitFor(() => window.__game.mode === 'playing', null, 30000).catch(() => {});
    check('letter folds away, back to play', (await player()).mode === 'playing');
  } else check('free spot near the letter', false);

  // ---------------------------------------------------------------- crouch, block, flashlight, weapon
  await tapControl('crouch');
  b = await player();
  check('CROUCH crouches', b.crouching);
  await tapControl('crouch');
  check('CROUCH again stands up', !(await player()).crouching);
  const bc = await control('block');
  await t.start(6, bc.x, bc.y);
  await h.frames(3);
  b = await player();
  await t.end(6);
  await h.frames(2);
  check('holding BLOCK blocks, letting go stops', b.blocking && !(await player()).blocking);
  await h.eval(() => {
    const g = window.__game;
    g.player.give('flashlight');
    g.sim.player.battery = 80;
  });
  await tapControl('light');
  check('LIGHT switches the flashlight on', (await player()).flashlight);
  await tapControl('light');
  check('LIGHT switches it off again', !(await player()).flashlight);
  await h.eval(() => window.__game.player.give('kitchen_knife'));
  await tapControl('weapon');
  check('WEAPON draws a weapon', (await h.eval(() => window.__game.sim.player.weapon)) === 'kitchen_knife');
  await tapControl('weapon');
  check('WEAPON again goes back to bare hands', (await h.eval(() => window.__game.sim.player.weapon)) === null);

  // ---------------------------------------------------------------- HIT while walking (two fingers)
  const target = await h.eval(() => {
    const s = window.__game.sim;
    const n = s.npcs.filter((n) => n.alive && n.role !== 'police' && n.building < 0 && !n.sleeping).sort((a, b) => Math.hypot(a.x - s.player.x, a.z - s.player.z) - Math.hypot(b.x - s.player.x, b.z - s.player.z))[0];
    return n ? { id: n.id, x: n.x, z: n.z, y: n.y, hp: n.health } : null;
  });
  if (target) {
    await h.eval(() => {
      const g = window.__game;
      g.player.give('baseball_bat');
      g.player.equip(g.sim.player.inventory.findIndex((i) => i.item === 'baseball_bat'));
    });
    const sp = await spotNear(target.x, target.z, 1.0, 1.6);
    await stand(sp.x, sp.z, target.x, target.y + 1.3, target.z);
    await h.frames(1);
    // thumb resting on the stick (no movement) while the other finger hits
    await t.start(0, 120, 300);
    const hc = await control('attack');
    await t.start(7, hc.x, hc.y);
    await h.frames(1);
    await t.end(7);
    await h.waitFor((id) => window.__game.sim.npcs.find((n) => n.id === id).health < 100 || window.__game.sim.player.swingT <= 0, target.id, 60000).catch(() => {});
    await h.frames(6);
    await t.end(0);
    const hp = await h.eval((id) => window.__game.sim.npcs.find((n) => n.id === id).health, target.id);
    check('HIT with a second finger swings the bat', hp < target.hp, `hp ${target.hp} -> ${hp.toFixed(0)}`);
  } else check('a neighbour outside to hit', false);

  // ---------------------------------------------------------------- a thumb resting at the screen edge
  await t.start(0, 14, 384);
  await h.frames(3);
  const edge = await h.eval(() => ({ mx: window.__game.input.moveX, my: window.__game.input.moveY }));
  await t.end(0);
  check('a thumb landing at the screen edge does not walk', edge.mx === 0 && edge.my === 0, `stick ${edge.mx.toFixed(2)},${edge.my.toFixed(2)}`);

  // ---------------------------------------------------------------- dialogs with the thumb still on the stick
  await t.start(0, 120, 300);
  await h.frames(1);
  const bag = await control('bag');
  await t.start(3, bag.x, bag.y);
  await t.end(3);
  await h.waitFor(() => window.__game.mode === 'dialog', null, 20000).catch(() => {});
  const closeBtn = await h.eval(() => {
    const b = [...document.querySelectorAll('#layer button')].find((b) => b.textContent.trim() === 'Close');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (closeBtn) {
    await page.waitForTimeout(200);
    await t.start(4, closeBtn.x, closeBtn.y);
    await t.end(4);
    await h.waitFor(() => window.__game.mode === 'playing', null, 20000).catch(() => {});
  }
  check('a second finger closes a dialog while the thumb rests on the stick', closeBtn && (await player()).mode === 'playing');
  await t.end(0);
  await h.frames(2);

  // ---------------------------------------------------------------- top-right menu buttons
  for (const [btn, sel, close] of [
    ['bag', '#layer .panel', 'Close'],
    ['journal', '#layer .tabs', 'Close'],
    ['map', '#layer canvas', 'Close'],
    ['wait', '#layer .panel', 'Cancel'],
  ]) {
    await tapControl(btn);
    await h.frames(2);
    const open = await h.eval((sel) => !!document.querySelector(sel) && window.__game.mode === 'dialog', sel);
    f = await fits();
    check(`${btn.toUpperCase()} opens its screen, which fits`, open && !f.bad.length && !f.wide, f.bad.join('; '));
    if (btn === 'bag') await h.shot('m05_inventory');
    await h.tapText(close);
    await h.waitFor(() => window.__game.mode === 'playing', null, 20000).catch(() => {});
  }
  await tapControl('pause');
  await h.frames(2);
  check('❚❚ pauses', (await player()).mode === 'paused');
  f = await fits();
  check('pause menu fits', !f.bad.length && !f.wide, f.bad.join('; '));
  await h.shot('m06_pause');
  await h.tapText('Resume');
  await h.waitFor(() => window.__game.mode === 'playing', null, 20000).catch(() => {});
  check('Resume returns to play', (await player()).mode === 'playing');

  // ---------------------------------------------------------------- turning the phone upright
  await page.setViewportSize({ width: 390, height: 844 });
  await h.waitFor(() => window.__game.mode === 'paused', null, 20000).catch(() => {});
  const upright = await h.eval(() => ({ mode: window.__game.mode, notice: getComputedStyle(document.querySelector('.t-rotate')).display !== 'none' }));
  check('turning the phone upright pauses and asks to turn it back', upright.mode === 'paused' && upright.notice, JSON.stringify(upright));
  await h.shot('m07_upright');
  await page.setViewportSize({ width: 844, height: 390 });
  await h.waitFor(() => window.__game.mode === 'playing', null, 20000).catch(() => {});
  check('turning it back resumes', (await player()).mode === 'playing');
  // rotation lock on: the notice still leads to the pause menu
  await page.setViewportSize({ width: 390, height: 844 });
  await h.waitFor(() => window.__game.mode === 'paused', null, 20000).catch(() => {});
  await page.waitForTimeout(300);
  await h.tapText('Menu', '.t-rotate button');
  await page.waitForTimeout(300);
  const menuShown = await h.eval(() => ({ notice: getComputedStyle(document.querySelector('.t-rotate')).display, resume: [...document.querySelectorAll('#layer button')].some((b) => b.textContent.includes('Resume')) }));
  check('the notice’s Menu button reveals the pause menu', menuShown.notice === 'none' && menuShown.resume, JSON.stringify(menuShown));
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(500);
  check('after choosing the menu, turning back stays paused', (await player()).mode === 'paused');
  await h.tapText('Resume');
  await h.waitFor(() => window.__game.mode === 'playing', null, 20000).catch(() => {});
  const canvas = await h.eval(() => ({ w: window.__game.renderer.renderer.domElement.width, h: window.__game.renderer.renderer.domElement.height, pr: window.__game.renderer.renderer.getPixelRatio() }));
  check('the view is resized for landscape again', Math.abs(canvas.w / canvas.h - 844 / 390) < 0.05, JSON.stringify(canvas));

  // ---------------------------------------------------------------- observer mode with touch
  await tapControl('pause');
  await h.frames(2);
  await h.tapText('Observer Mode');
  await h.waitFor(() => window.__game.mode === 'observer', null, 30000).catch(() => {});
  await control('up').catch(() => {});
  const obsButtons = await reachable();
  check('observer shows its own touch controls, none covered by the panel', obsButtons.includes('up') && obsButtons.includes('down') && !obsButtons.includes('use'), obsButtons.join(','));
  const o0 = await h.eval(() => window.__game.observer.pos.toArray());
  await t.drag(0, 120, 300, 0, -50, 3, async () => {
    await h.frames(1);
  });
  await h.frames(6);
  await t.end(0);
  const o1 = await h.eval(() => window.__game.observer.pos.toArray());
  check('the stick flies the observer camera', Math.hypot(o1[0] - o0[0], o1[2] - o0[2]) > 0.5, `${o0.map((v) => v.toFixed(1))} -> ${o1.map((v) => v.toFixed(1))}`);
  f = await fits('.obs-top button');
  check('observer buttons are on screen', !f.bad.length, f.bad.join('; '));
  await h.shot('m08_observer');
  await h.tapText('Exit');
  await h.waitFor(() => window.__game.mode === 'playing', null, 20000).catch(() => {});
  check('observer exits back to play', (await player()).mode === 'playing');

  // ---------------------------------------------------------------- other phone and tablet sizes
  for (const [w, hgt, name] of [
    [667, 375, 'iPhone SE landscape'],
    [740, 360, 'phone landscape with browser bars'],
    [915, 412, 'large Android landscape'],
    [1024, 768, 'tablet landscape'],
  ]) {
    await page.setViewportSize({ width: w, height: hgt });
    await h.waitFor(() => window.__game.mode === 'playing', null, 20000).catch(() => {});
    await h.frames(8);
    const lay = await h.eval(() => {
      const btns = [...document.querySelectorAll('#touch .t-btn')].filter((b) => getComputedStyle(b).display !== 'none');
      const off = [];
      const covered = [];
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) off.push(b.dataset.t);
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!(hit === b || b.contains(hit))) covered.push(b.dataset.t);
      }
      // HUD text that a control would sit on top of
      const overlaps = [];
      for (const sel of ['.objectives', '.compass', '.clock', '.equip', '.bars', '.stealth', '.messages']) {
        const el = document.querySelector(sel);
        if (!el || !el.textContent.trim()) continue;
        const a = el.getBoundingClientRect();
        for (const b of btns) {
          const r = b.getBoundingClientRect();
          const ix = Math.min(a.right, r.right) - Math.max(a.left, r.left);
          const iy = Math.min(a.bottom, r.bottom) - Math.max(a.top, r.top);
          if (ix > 4 && iy > 4) overlaps.push(`${sel}/${b.dataset.t}`);
        }
      }
      return { off, covered, overlaps };
    });
    check(`${name} (${w}x${hgt}): controls on screen, uncovered, clear of the HUD`, !lay.off.length && !lay.covered.length && !lay.overlaps.length, JSON.stringify(lay));
    await h.shot(`m09_${w}x${hgt}`);
  }
  await page.setViewportSize({ width: 844, height: 390 });
  await h.frames(4);

  // ---------------------------------------------------------------- health of the run
  const loopErr = await h.eval(() => window.__game.lastError);
  check('no uncaught page errors', h.errors.length === 0, h.errors.slice(0, 3).join(' | '));
  check('no errors in the game loop', !loopErr, loopErr.slice(0, 200));
}
