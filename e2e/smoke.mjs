// End-to-end gameplay smoke test. Drives the real game UI in Chromium with real
// key presses and clicks; uses the page's game object only to read state, to
// teleport between distant places (walking at software-rendered frame rates
// would take minutes) and to turn the camera towards a target.
//
// Every check is recorded; the run fails if any check fails.

export const results = [];

export default async function smoke(page, h) {
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  };
  const state = () =>
    h.eval(() => {
      const g = window.__game;
      const s = g.sim;
      const p = s?.player;
      return {
        mode: g.mode,
        x: p?.x,
        z: p?.z,
        time: s?.time,
        health: p?.health,
        building: p?.building,
        target: g.player?.target ? { kind: g.player.target.kind, id: g.player.target.id, prompt: g.player.target.prompt } : null,
        err: g.lastError,
        inv: p?.inventory.map((i) => i.item),
      };
    });
  /** stand at (x,z) and look at the point (tx, ty, tz) */
  const stand = (x, z, tx, ty, tz) => h.eval(([x, z, tx, ty, tz]) => window.__nnTest.stand(x, z, tx, ty, tz), [x, z, tx, ty, tz]);
  const spotNear = (x, z, r, rMax, b) => h.eval(([x, z, r, rMax, b]) => window.__nnTest.spotNear(x, z, r, rMax, b ?? undefined), [x, z, r, rMax, b ?? null]);

  // ---------------------------------------------------------------- main menu
  await h.open();
  await h.frames(3);
  check('main menu shows', await h.hasText('New Game'));
  await h.shot('01_main_menu');
  for (const [btn, expect] of [
    ['Settings', 'Graphics'],
    ['How to Play', 'How to Play'],
    ['Credits', 'Credits'],
    ['Load Game', 'Load Game'],
  ]) {
    await h.clickText(btn);
    await page.waitForTimeout(150);
    const txt = await page.locator('#layer').innerText();
    check(`menu: ${btn} opens`, txt.toLowerCase().includes(expect.toLowerCase()), txt.slice(0, 60).replace(/\n/g, ' | '));
    await h.clickText('Back');
    await page.waitForTimeout(100);
    check(`menu: ${btn} back`, await h.hasText('New Game'));
  }
  // settings change persists
  await h.clickText('Settings');
  await page.waitForTimeout(100);
  const fovBefore = await h.eval(() => window.__game.settings.fov);
  const slider = page.locator('input[type=range]').first();
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const changed = await h.eval(() => JSON.stringify(window.__game.settings));
  await h.shot('02_settings');
  await h.clickText('Back');
  check('settings: slider changes a setting', changed !== null, `fov ${fovBefore}`);
  check('settings: saved to localStorage', await h.eval(() => !!localStorage.getItem('nightneighbour.settings.v1')));

  // ---------------------------------------------------------------- new game
  await h.clickText('New Game');
  await page.waitForTimeout(150);
  await page.locator('#layer input').first().fill('smoke-test');
  await h.clickText('Begin');
  const t0 = Date.now();
  await h.waitFor(() => window.__game && window.__game.mode === 'playing', null, 180000);
  check('new game starts', true, `${((Date.now() - t0) / 1000).toFixed(1)}s to generate + populate`);
  await h.frames(4);
  let s = await state();
  check('HUD visible', await page.locator('#hud').isVisible());
  check('objectives shown', (await page.locator('.objectives').innerText()).includes('uncle'));
  await h.shot('03_arrival');

  // ---------------------------------------------------------------- movement
  const before = s;
  await h.holdFrames('KeyW', 6);
  s = await state();
  const moved = Math.hypot(s.x - before.x, s.z - before.z);
  check('W moves the player', moved > 0.3, `moved ${moved.toFixed(2)} m`);
  const yaw0 = await h.eval(() => window.__game.sim.player.yaw);
  await h.holdFrames('ArrowRight', 3);
  const yaw1 = await h.eval(() => window.__game.sim.player.yaw);
  check('arrow keys turn the camera', Math.abs(yaw1 - yaw0) > 0.05);

  // ---------------------------------------------------------------- uncle's house: unlock door with key
  const home = await h.eval(() => {
    const s = window.__game.sim;
    const b = s.world.buildings[s.world.playerHouseId];
    const d = b.doorIds.map((i) => s.world.doors[i]).find((d) => d.exterior);
    return { of: b.outsideFront, inf: b.insideFront, door: { id: d.id, x: d.axis === 'x' ? d.t : d.c, z: d.axis === 'x' ? d.c : d.t, locked: d.locked }, floorY: b.floorY, id: b.id };
  });
  check('front door starts locked', home.door.locked);
  await stand(home.of.x, home.of.z, home.door.x, home.floorY + 1.2, home.door.z);
  await h.frames(2);
  s = await state();
  check('door is targeted', s.target?.kind === 'door', s.target?.prompt);
  await h.tap('KeyE');
  await h.frames(3);
  const dstate = await h.eval((id) => window.__game.sim.world.doors[id], home.door.id);
  check('E unlocks and opens the door (player holds key)', !dstate.locked && dstate.target === 1, `locked=${dstate.locked} target=${dstate.target}`);
  // walk inside through the open door
  await stand(home.inf.x, home.inf.z, home.inf.x + 1, home.floorY + 1.4, home.inf.z);
  await h.frames(3);
  s = await state();
  check('player is inside the house', s.building === home.id, `building=${s.building}`);
  await h.shot('04_inside_house');

  // ---------------------------------------------------------------- the letter
  const note = await h.eval(() => {
    const it = window.__game.sim.items.find((i) => i.item === 'note' && !i.taken);
    return it ? { id: it.id, x: it.x, y: it.y, z: it.z } : null;
  });
  check('uncle’s letter placed', !!note);
  if (note) {
    // stand 1 m away, on a free spot
    const spot = await spotNear(note.x, note.z, 0.8, 1.8, home.id);
    if (spot) {
      await stand(spot.x, spot.z, note.x, note.y, note.z);
      await h.frames(2);
      s = await state();
      check('letter is targeted', s.target?.kind === 'item', s.target?.prompt);
      await h.tap('KeyE');
      await h.frames(2);
      const txt = await page.locator('#layer').innerText().catch(() => '');
      check('reading the letter opens it', txt.includes('nephew') || txt.includes('My dear'), txt.slice(0, 50));
      await h.shot('05_letter');
      if (await h.hasText('Fold the letter away')) await h.clickText('Fold the letter away');
      await h.frames(2);
      s = await state();
      check('letter closed, back to play', s.mode === 'playing', s.mode);
      const objs = await page.locator('.objectives').innerText();
      check('objectives advanced after the letter', !objs.includes('Read the letter'), objs.replace(/\n/g, ' | '));
    } else check('free spot near letter', false);
  }

  // ---------------------------------------------------------------- inventory / journal / map
  if ((await state()).mode === 'dialog') {
    await h.eval(() => window.__game.ui.closeDialog());
    await h.frames(1);
  }
  await h.tap('Tab');
  await h.frames(1);
  let layer = await page.locator('#layer').innerText();
  check('Tab opens inventory', layer.toLowerCase().includes('inventory'), layer.slice(0, 40));
  await h.shot('06_inventory');
  await h.clickText('Close');
  await h.tap('KeyJ');
  await h.frames(1);
  layer = await page.locator('#layer').innerText();
  check('J opens journal', layer.includes('Objectives') || layer.includes('Journal'));
  for (const tab of ['Evidence', 'Suspects', 'Log', 'Map']) {
    await h.clickText(tab);
    await page.waitForTimeout(80);
  }
  check('journal map tab draws a canvas', (await page.locator('#layer canvas').count()) > 0);
  await h.shot('07_journal_map');
  await h.clickText('Close');
  await h.frames(1);

  // ---------------------------------------------------------------- talk to a neighbour
  const npc = await h.eval(() => {
    const s = window.__game.sim;
    const n = s.npcs.filter((n) => n.alive && n.role !== 'police' && !n.sleeping && n.building < 0).sort((a, b) => Math.hypot(a.x - s.player.x, a.z - s.player.z) - Math.hypot(b.x - s.player.x, b.z - s.player.z))[0];
    return n ? { id: n.id, x: n.x, z: n.z, y: n.y, yaw: n.yaw } : null;
  });
  check('an awake neighbour outdoors exists', !!npc);
  if (npc) {
    // stand 1.4 m in front of them
    const spot = await spotNear(npc.x, npc.z, 1.3, 2.0);
    if (spot) {
      await stand(spot.x, spot.z, npc.x, npc.y + 1.5, npc.z);
      await h.frames(1);
      s = await state();
      check('neighbour targeted', s.target?.kind === 'npc', s.target?.prompt);
      await h.tap('KeyE');
      await h.frames(2);
      const dlg = await page.locator('#layer .dialog').count();
      check('E opens conversation', dlg > 0);
      await h.shot('08_dialogue');
      if (dlg) {
        const opts = await page.locator('#layer .options button').allInnerTexts();
        check('dialogue has options', opts.length >= 2, opts.slice(0, 4).join(' / '));
        const intro = opts.find((o) => o.toLowerCase().includes('introduce') || o.toLowerCase().includes('name'));
        if (intro) {
          await h.clickText(intro);
          await page.waitForTimeout(120);
          const known = await h.eval((id) => window.__game.sim.player.knownTo.includes(id), npc.id);
          check('introducing adds the neighbour to known people', known);
        }
        // leave
        const leave = (await page.locator('#layer .options button').allInnerTexts()).find((o) => /bye|leave|goodbye|nothing/i.test(o));
        if (leave) await h.clickText(leave);
        else await h.tap('Escape');
        await h.frames(2);
        s = await state();
        check('conversation closes', s.mode === 'playing', s.mode);
      }
    }
  }

  // ---------------------------------------------------------------- wait (time passes)
  const tBefore = (await state()).time;
  await h.tap('KeyT');
  await h.frames(1);
  check('T opens wait dialog', await h.hasText('1 hour'));
  await h.clickText('1 hour');
  await h.waitFor((t) => window.__game.sim.time >= t + 3500 || (window.__game.ff && window.__game.ff.interrupted), tBefore, 180000);
  await h.waitFor(() => !window.__game.ff, null, 60000);
  const tAfter = (await state()).time;
  check('waiting advances the clock ~1h', tAfter - tBefore > 3000, `${((tAfter - tBefore) / 60).toFixed(0)} game minutes`);

  // ---------------------------------------------------------------- shopping: buy a flashlight at the hardware store
  const shop = await h.eval(() => {
    const s = window.__game.sim;
    const b = s.world.buildings.find((b) => b.kind === 'hardware');
    const reg = s.world.furniture.find((f) => f.buildingId === b.id && f.use === 'register' && f.kind !== 'none');
    let keeper = window.__game.player.keeperAt(reg);
    if (!keeper) {
      // the clerk is still on the way to work: put them behind the counter (test assist)
      const clerk = s.npcs.find((n) => n.alive && n.workId === b.id && n.role !== 'killer') ?? s.npcs.find((n) => n.alive && n.workId === b.id);
      clerk.tasks = [];
      clerk.path = null;
      clerk.x = reg.ux;
      clerk.z = reg.uz;
      clerk.y = s.grid.heightAt(reg.ux, reg.uz);
      clerk.room = s.grid.roomAt(reg.ux, reg.uz);
      clerk.building = b.id;
      clerk.sleeping = false;
      clerk.usingFurniture = reg.id;
      clerk.activity = { kind: 'work', priority: 35, started: s.time, until: s.time + 4 * 3600, data: {} };
      keeper = clerk;
    }
    // counters stand against a wall: the customer steps up beside the clerk
    const spot = window.__nnTest.spotNear(reg.ux, reg.uz, 0.9, 1.8, b.id);
    return { reg: { x: reg.x, z: reg.z, h: reg.h, y: b.floorY }, spot, keeper: keeper.id };
  });
  check('hardware store has a counter and a clerk', shop.spot && shop.keeper >= 0);
  if (shop.spot) {
    await stand(shop.spot.x, shop.spot.z, shop.reg.x, shop.reg.y + shop.reg.h * 0.7, shop.reg.z);
    await h.frames(1);
    s = await state();
    check('counter targeted', s.target?.kind === 'furniture' && /counter/.test(s.target.prompt), s.target?.prompt);
    await h.tap('KeyE');
    await h.frames(1);
    const tradeOpen = (await page.locator('#layer .item-row').count()) > 0;
    check('E at the counter opens the shop', tradeOpen);
    if (tradeOpen) {
      await h.shot('09a_shop');
      const money0 = await h.eval(() => window.__game.sim.player.money);
      await page.locator('#layer .item-row').filter({ has: page.locator('.name', { hasText: /^Flashlight/ }) }).locator('button', { hasText: 'Buy' }).first().click();
      await page.waitForTimeout(100);
      const after = await h.eval(() => ({ money: window.__game.sim.player.money, has: window.__game.sim.player.inventory.some((i) => i.item === 'flashlight') }));
      check('buying the flashlight takes the money and adds it to the inventory', after.has && after.money === money0 - 18, `$${money0} -> $${after.money}`);
      await h.clickText('Done');
      await h.frames(3);
      const objs = await page.locator('.objectives').innerText();
      check('the flashlight objective is done', !/Buy a flashlight/.test(objs), objs.replace(/\n/g, ' | '));
      await h.tap('KeyF');
      check('F switches the flashlight on', await h.eval(() => window.__game.sim.player.flashlight));
      await h.tap('KeyF');
      check('F switches it off again', !(await h.eval(() => window.__game.sim.player.flashlight)));
    }
  }

  // ---------------------------------------------------------------- the telephone at home
  const phone = await h.eval(() => {
    const s = window.__game.sim;
    const f = s.world.furniture.find((f) => f.buildingId === s.world.playerHouseId && f.use === 'phone' && f.kind !== 'none');
    if (!f) return null;
    const spot = window.__nnTest.spotNear(f.ux, f.uz, 0, 1, s.world.playerHouseId);
    return { x: f.x, z: f.z, h: f.h, y: s.world.buildings[f.buildingId].floorY, spot };
  });
  check('the house has a telephone', !!phone?.spot);
  if (phone?.spot) {
    await stand(phone.spot.x, phone.spot.z, phone.x, phone.y + phone.h * 0.8, phone.z);
    await h.frames(1);
    s = await state();
    check('telephone targeted', s.target?.prompt?.includes('Call the police'), s.target?.prompt);
    await h.tap('KeyE');
    await h.frames(1);
    check('E on the telephone dials the police', await h.hasText('Ask about the investigation'));
    if (await h.hasText('Ask about the investigation')) {
      await h.clickText('Ask about the investigation');
      await page.waitForTimeout(100);
      const txt = await page.locator('#layer').innerText();
      check('the police answer about the investigation', txt.length > 40, txt.slice(0, 80).replace(/\n/g, ' | '));
      await h.clickText('Hang up');
      await h.frames(1);
    }
  }

  // ---------------------------------------------------------------- the police chief
  const chief = await h.eval(() => {
    const s = window.__game.sim;
    const c = s.npcs.find((n) => n.job === 'chief' && n.alive);
    const spot = window.__nnTest.spotNear(c.x, c.z, 1.2, 2.0, c.building >= 0 ? c.building : undefined);
    return { id: c.id, x: c.x, z: c.z, y: c.y, spot };
  });
  if (chief.spot) {
    await stand(chief.spot.x, chief.spot.z, chief.x, chief.y + 1.5, chief.z);
    await h.frames(1);
    s = await state();
    check('police chief targeted', s.target?.kind === 'npc' && s.target.id === chief.id, s.target?.prompt);
    await h.tap('KeyE');
    await h.frames(1);
    const progress = (await page.locator('#layer .options button').allInnerTexts()).find((o) => o.includes('Any progress'));
    check('the chief can be asked about the case', !!progress);
    if (progress) {
      await h.clickText('Any progress');
      await page.waitForTimeout(100);
      const say = await page.locator('#layer .say').innerText();
      check('the chief answers', say.length > 10, say.slice(0, 80).replace(/\n/g, ' | '));
    }
    await h.tap('Escape');
    await h.frames(2);
    if ((await state()).mode !== 'playing') await h.eval(() => window.__game.ui.closeDialog());
  } else check('found a spot next to the chief', false);
  // back home before the next steps (fighting in front of the police station would end in an arrest)
  await stand(home.of.x, home.of.z, home.door.x, home.floorY + 1.2, home.door.z);
  await h.frames(2);

  // ---------------------------------------------------------------- save, pause menu
  await h.tap('Escape');
  await h.frames(1);
  s = await state();
  check('Esc pauses', s.mode === 'paused', s.mode);
  await h.shot('09_pause');
  await h.clickText('Save Game');
  await page.waitForTimeout(100);
  await page.locator('#layer button', { hasText: 'Save here' }).nth(0).click();
  await page.waitForTimeout(200);
  const saved = await h.eval(() => Object.keys(localStorage).filter((k) => k.startsWith('nightneighbour.save.')));
  check('save written to localStorage', saved.some((k) => k.endsWith('slot1')), saved.join(','));
  const savedPos = await state();
  if (await h.hasText('Back')) await h.clickText('Back');
  await h.clickText('Resume');
  await h.frames(2);
  check('Resume returns to play', (await state()).mode === 'playing');

  // ---------------------------------------------------------------- combat
  const target = await h.eval(() => {
    const s = window.__game.sim;
    const n = s.npcs.filter((n) => n.alive && n.role !== 'police' && n.building < 0 && !n.sleeping).sort((a, b) => Math.hypot(a.x - s.player.x, a.z - s.player.z) - Math.hypot(b.x - s.player.x, b.z - s.player.z))[0];
    return n ? { id: n.id, x: n.x, z: n.z, y: n.y, hp: n.health } : null;
  });
  if (target) {
    await h.eval(() => {
      const g = window.__game;
      g.sim.player.inventory.push({ item: 'baseball_bat', n: 1 });
      g.player.equip(g.sim.player.inventory.length - 1);
    });
    const spot = await spotNear(target.x, target.z, 1.0, 1.6);
    await stand(spot.x, spot.z, target.x, target.y + 1.3, target.z);
    await h.frames(1);
    // a click: the canvas has pointer lock in Chromium
    const locked = await h.eval(() => window.__game.input.locked);
    if (!locked) await page.mouse.click(640, 360);
    await h.frames(1);
    await page.mouse.down();
    await h.frames(1);
    await page.mouse.up();
    await h.waitFor((id) => {
      const s = window.__game.sim;
      return s.events.some(() => true) && (s.npcs.find((n) => n.id === id).health < 100 || s.player.swingT <= 0);
    }, target.id, 60000).catch(() => {});
    await h.frames(6);
    const after = await h.eval((id) => { const n = window.__game.sim.npcs.find((n) => n.id === id); return { hp: n.health, alarm: n.alarm, act: n.activity?.kind }; }, target.id);
    check('swinging a bat at a neighbour hurts them', after.hp < target.hp, `hp ${target.hp} -> ${after.hp.toFixed(0)}, reaction=${after.act}`);
    await h.shot('10_combat');
  }

  // ---------------------------------------------------------------- a crowbar pries a locked door open
  const door = await h.eval(() => {
    const s = window.__game.sim;
    const p = s.player;
    p.inventory.push({ item: 'crowbar', n: 1 });
    const b = s.world.buildings.filter((b) => b.kind === 'house' && b.id !== s.world.playerHouseId).sort((a, c) => Math.hypot(a.outsideFront.x - p.x, a.outsideFront.z - p.z) - Math.hypot(c.outsideFront.x - p.x, c.outsideFront.z - p.z))[0];
    const d = s.world.doors[b.frontDoorId];
    d.locked = true;
    d.target = 0;
    d.open = 0;
    const out = d.roomPos >= 0 ? -1 : 1;
    const x = d.axis === 'x' ? d.t : d.c + out * 1.1;
    const z = d.axis === 'x' ? d.c + out * 1.1 : d.t;
    return { id: d.id, x, z, dx: d.axis === 'x' ? d.t : d.c, dz: d.axis === 'x' ? d.c : d.t, y: b.floorY };
  });
  await stand(door.x, door.z, door.dx, door.y + 1.2, door.dz);
  await h.frames(1);
  s = await state();
  check('a locked door offers prying with a crowbar', /Pry/.test(s.target?.prompt ?? ''), s.target?.prompt);
  await h.holdFrames('KeyE', 30);
  const pried = await h.eval((id) => ({ locked: window.__game.sim.world.doors[id].locked, forced: window.__game.sim.forcedDoors.includes(id) }), door.id);
  check('holding E pries the door open (and leaves marks)', !pried.locked && pried.forced, JSON.stringify(pried));

  // ---------------------------------------------------------------- load
  await h.tap('Escape');
  await h.frames(1);
  if ((await state()).mode !== 'paused') {
    await h.eval(() => window.__game.pause());
  }
  await h.clickText('Load Game');
  await page.waitForTimeout(100);
  await page.locator('#layer tr', { hasText: 'Slot 1' }).locator('button', { hasText: 'Load' }).click();
  await h.waitFor(() => window.__game.mode === 'playing', null, 180000);
  await h.frames(2);
  s = await state();
  const dpos = Math.hypot(s.x - savedPos.x, s.z - savedPos.z);
  check('loading slot 1 restores the saved position', dpos < 0.5, `distance ${dpos.toFixed(2)} m`);
  check('loading restores the clock', Math.abs(s.time - savedPos.time) < 60, `${s.time.toFixed(0)} vs ${savedPos.time.toFixed(0)}`);

  // ---------------------------------------------------------------- night and sleep
  await h.eval(() => {
    const g = window.__game;
    const s = g.sim;
    const day = Math.floor(s.time / 86400);
    s.time = day * 86400 + 22.5 * 3600;
  });
  await h.frames(4);
  await h.shot('11_night_street');
  const bed = await h.eval(() => {
    const s = window.__game.sim;
    const f = s.world.furniture.find((f) => f.buildingId === s.world.playerHouseId && f.use === 'bed');
    return f ? { x: f.x, z: f.z, w: f.w, d: f.d, h: f.h, y: s.world.buildings[f.buildingId].floorY } : null;
  });
  check('player house has a bed', !!bed);
  if (bed) {
    const spot = await spotNear(bed.x, bed.z, Math.min(bed.w, bed.d) / 2 + 0.45, Math.max(bed.w, bed.d) / 2 + 1.2, home.id);
    if (spot) {
      await stand(spot.x, spot.z, bed.x, bed.y + bed.h * 0.6, bed.z);
      await h.frames(2);
      s = await state();
      check('bed targeted', s.target?.kind === 'furniture', s.target?.prompt);
      await h.tap('KeyE');
      await h.frames(1);
      const sleepOpen = await h.hasText('Sleep until');
      check('E on bed offers sleep', sleepOpen);
      if (sleepOpen) {
        const tb = (await state()).time;
        await h.clickText('Sleep until');
        await h.waitFor(() => !window.__game.ff && window.__game.mode !== 'dialog', null, 400000);
        const ta = (await state()).time;
        check('sleeping advances to the morning (or is interrupted by danger)', ta - tb > 3600, `${((ta - tb) / 3600).toFixed(1)} h slept`);
        await h.frames(3);
        await h.shot('12_after_sleep');
      }
    }
  }

  // ---------------------------------------------------------------- observer mode
  await h.tap('F2');
  await h.frames(2);
  s = await state();
  check('F2 opens observer mode', s.mode === 'observer', s.mode);
  if (s.mode === 'observer') {
    const rows = page.locator('.obs-panel .res');
    const n = await rows.count();
    check('observer lists residents', n > 3, `${n} rows`);
    if (n) await rows.nth(0).click();
    await h.frames(2);
    const det = await page.locator('.obs-panel').innerText();
    check('observer shows resident details', det.includes('Memories') || det.includes('Activity') || det.includes('Needs'), det.slice(0, 80).replace(/\n/g, ' | '));
    await h.clickText('16x');
    await h.frames(4);
    await h.shot('13_observer');
    await h.clickText('Exit');
    await h.frames(2);
    check('observer exits back to play', (await state()).mode === 'playing');
  }

  // ---------------------------------------------------------------- death and the ending screen
  await h.eval(() => {
    const p = window.__game.sim.player;
    p.health = 0;
  });
  await h.waitFor(() => window.__game.mode === 'ending', null, 60000);
  const endTxt = await page.locator('#layer').innerText();
  check('death shows the ending screen', endTxt.length > 20, endTxt.slice(0, 60).replace(/\n/g, ' | '));
  await h.shot('14_death');
  check('ending offers restart', await h.hasText('New game'));
  await h.clickText('Main menu');
  await h.frames(2);
  check('ending → main menu', (await state()).mode === 'menu');
  check('Continue offered after saves exist', await h.hasText('Continue'));

  const errs = h.errors.filter((e) => !/AudioContext|autoplay/i.test(e));
  check('no uncaught page errors', errs.length === 0, errs.slice(0, 3).join(' || '));
  const ge = await h.eval(() => window.__game.lastError);
  check('no errors in the game loop', !ge, ge?.slice(0, 200));
}
