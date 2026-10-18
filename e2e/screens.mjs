// Documentation screenshots: NN_SHOT_EXT=jpg node e2e/drive.mjs e2e/screens.mjs docs/screenshots
// Starts a game, then stages a few situations with window.__nnTest and captures them.
export default async function screens(page, h) {
  const setHour = (hr) =>
    h.eval((hr) => {
      const s = window.__game.sim;
      // time only moves forward (decals and memories are time-stamped)
      let t = Math.floor(s.time / 86400) * 86400 + hr * 3600;
      if (t < s.time) t += 86400;
      s.time = t;
      s.lightTimer = 0; // street and porch lights switch on the next step
    }, hr);
  const stand = (x, z, tx, ty, tz) => h.eval(([x, z, tx, ty, tz]) => window.__nnTest.stand(x, z, tx, ty, tz), [x, z, tx, ty, tz]);
  const settle = () => h.frames(4);

  await h.open();
  await h.frames(6);
  await h.shot('menu');
  await h.clickText('New Game');
  await page.locator('#layer input').first().fill('lantern-4417');
  await h.clickText('Begin');
  await h.waitFor(() => window.__game && window.__game.mode === 'playing', null, 180000);
  await h.eval(() => {
    const g = window.__game;
    g.settings.showFps = false;
    g.applySettings();
  });
  await settle();
  await h.shot('arrival');

  // a street by day, looking along the road from the player's front yard
  const home = await h.eval(() => {
    const s = window.__game.sim;
    const b = s.world.buildings[s.world.playerHouseId];
    return { of: b.outsideFront, inf: b.insideFront, rect: b.rect, id: b.id, floorY: b.floorY };
  });
  await setHour(16.5);
  await stand(home.of.x, home.of.z, (home.rect.x0 + home.rect.x1) / 2, 2.5, (home.rect.z0 + home.rect.z1) / 2);
  await h.eval(() => {
    const p = window.__game.sim.player;
    p.yaw += Math.PI; // turn round to face the street
    p.pitch = -0.05;
  });
  await settle();
  await h.shot('street_day');

  // inside the house by day
  const room = await h.eval((id) => {
    const s = window.__game.sim;
    const rooms = s.world.rooms.filter((r) => r.buildingId === id && (r.kind === 'living' || r.kind === 'kitchen'));
    const r = rooms.sort((a, b) => (b.rect.x1 - b.rect.x0) * (b.rect.z1 - b.rect.z0) - (a.rect.x1 - a.rect.x0) * (a.rect.z1 - a.rect.z0))[0];
    return r ? r.rect : null;
  }, home.id);
  if (room) {
    const cx = (room.x0 + room.x1) / 2;
    const cz = (room.z0 + room.z1) / 2;
    const spot = await h.eval(([x, z, b]) => window.__nnTest.spotNear(x, z, 0.8, 3, b), [room.x0 + 0.8, room.z0 + 0.8, home.id]);
    if (spot) {
      await stand(spot.x, spot.z, cx, home.floorY + 0.9, cz);
      await settle();
      await h.shot('interior_day');
    }
  }

  // a resident on the pavement in front of the house, stopped for a chat
  const npc = await h.eval(([x, z]) => {
    const s = window.__game.sim;
    const n = s.npcs.find((n) => n.alive && n.role === 'resident' && n.homeId !== s.world.playerHouseId);
    const spot = window.__nnTest.spotNear(x, z, 3, 6);
    n.tasks = [];
    n.activity = null;
    n.path = null;
    n.sleeping = false;
    n.stance = 'stand';
    n.usingFurniture = -1;
    n.x = spot.x;
    n.z = spot.z;
    n.y = s.grid.heightAt(n.x, n.z);
    n.room = -1;
    n.building = -1;
    n.thinkT = 30;
    n.yaw = Math.atan2(x - n.x, -(z - n.z));
    return { id: n.id, x: n.x, z: n.z, y: n.y };
  }, [home.of.x, home.of.z]);
  if (npc) {
    const dx = npc.x - home.of.x;
    const dz = npc.z - home.of.z;
    const d = Math.hypot(dx, dz) || 1;
    await stand(npc.x - (dx / d) * 1.8, npc.z - (dz / d) * 1.8, npc.x, npc.y + 1.45, npc.z);
    await h.frames(2);
    await h.shot('resident');
  }

  // a crime scene found in the morning: the killer's victim on a front lawn, a smashed window behind
  await setHour(10.75);
  const scene = await h.eval(() => {
    const s = window.__game.sim;
    const victim = s.npcs.find((n) => n.alive && n.role === 'resident' && n.homeId !== s.world.playerHouseId && s.world.buildings[n.homeId].kind === 'house');
    const b = s.world.buildings[victim.homeId];
    const out = { x: b.outsideFront.x - b.insideFront.x, z: b.outsideFront.z - b.insideFront.z };
    const l = Math.hypot(out.x, out.z) || 1;
    out.x /= l;
    out.z /= l;
    const spot = window.__nnTest.spotNear(b.outsideFront.x + out.x * 2.2, b.outsideFront.z + out.z * 2.2, 0, 1.5);
    victim.tasks = [];
    victim.activity = null;
    victim.path = null;
    victim.x = spot.x;
    victim.z = spot.z;
    victim.y = s.grid.heightAt(victim.x, victim.z);
    victim.room = -1;
    victim.building = -1;
    victim.yaw = Math.atan2(out.x, -out.z);
    window.__nnTest.kill(victim.id, s.killerId);
    // the front window nearest the door is smashed
    const fx = b.outsideFront.x;
    const fz = b.outsideFront.z;
    const win = s.world.windows.filter((w) => w.buildingId === b.id).sort((a, c) => Math.hypot((a.axis === 'x' ? a.t : a.c) - fx, (a.axis === 'x' ? a.c : a.t) - fz) - Math.hypot((c.axis === 'x' ? c.t : c.c) - fx, (c.axis === 'x' ? c.c : c.t) - fz))[0];
    if (win) window.__nnTest.hitWindow(win.id, 99);
    return { x: victim.x, z: victim.z, y: victim.y, out, house: { x: (b.rect.x0 + b.rect.x1) / 2, z: (b.rect.z0 + b.rect.z1) / 2 } };
  });
  await setHour(11);
  const cam = await h.eval(([x, z]) => window.__nnTest.spotNear(x, z, 0, 1.5), [scene.x + scene.out.x * 3.2, scene.z + scene.out.z * 3.2]);
  if (cam) {
    await stand(cam.x, cam.z, scene.house.x, 1.0, scene.house.z);
    await h.eval(() => (window.__game.sim.player.pitch = -0.32));
    await settle();
    await h.shot('crime_scene');
  }

  // night: dark street, then a flashlight
  await setHour(23.5);
  await stand(home.of.x, home.of.z, (home.rect.x0 + home.rect.x1) / 2, 2.5, (home.rect.z0 + home.rect.z1) / 2);
  await h.eval(() => {
    const p = window.__game.sim.player;
    p.yaw += Math.PI;
    p.pitch = -0.05;
  });
  await settle();
  await h.shot('night_street');
  await h.eval(() => {
    const g = window.__game;
    g.sim.player.inventory.push({ item: 'flashlight', n: 1 });
    g.sim.player.flashlight = true;
    g.sim.player.battery = 100;
  });
  await stand(home.inf.x, home.inf.z, (home.rect.x0 + home.rect.x1) / 2, home.floorY + 1.0, (home.rect.z0 + home.rect.z1) / 2);
  await h.eval(() => {
    // lights out in the house
    const s = window.__game.sim;
    for (const l of s.world.lights) if (l.buildingId === s.world.playerHouseId) l.on = false;
  });
  await settle();
  await h.shot('flashlight_interior');

  // journal map and observer
  await setHour(10);
  await h.eval(() => window.__game.ui.showJournal('map'));
  await h.frames(2);
  await h.shot('journal_map');
  await h.eval(() => window.__game.ui.closeDialog());
  await h.frames(1);
  await h.eval(() => window.__game.startObserver());
  await h.frames(2);
  await h.eval(() => {
    const g = window.__game;
    const ob = g.observer;
    const k = g.sim.npcs.find((n) => n.alive && n.role === 'resident' && n.building < 0) ?? g.sim.npcs[0];
    ob.select(k.id);
    ob.follow = true;
    ob.showSight = true;
  });
  await h.frames(30);
  await h.shot('observer');

  // the good ending: the chief accepted an accusation and the killer is in a cell
  await h.eval(() => window.__game.exitObserver());
  await h.frames(2);
  await h.eval(() => {
    const g = window.__game;
    const k = g.sim.npc(g.sim.killerId);
    g.story.accusations.push({ id: k.id, time: g.sim.time, accepted: true });
    const cell = g.sim.world.rooms.find((r) => r.buildingId === g.sim.world.policeId && r.kind === 'cell');
    g.sim.jail(k, cell ? cell.id : -1);
  });
  await h.waitFor(() => window.__game.mode === 'ending', null, 60000);
  await h.frames(2);
  await h.shot('ending_win');
}
