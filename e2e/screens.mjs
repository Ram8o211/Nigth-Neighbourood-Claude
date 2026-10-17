// Documentation screenshots: node e2e/drive.mjs e2e/screens.mjs docs/screenshots
// Starts a game, then stages a few situations with window.__nnTest and captures them.
export default async function screens(page, h) {
  const setHour = (hr) =>
    h.eval((hr) => {
      const s = window.__game.sim;
      const day = Math.floor(s.time / 86400);
      s.time = day * 86400 + hr * 3600;
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

  // residents
  const npc = await h.eval(() => {
    const s = window.__game.sim;
    const p = s.player;
    const n = s.npcs.filter((n) => n.alive && n.building < 0 && !n.sleeping && n.role !== 'police').sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
    return n ? { id: n.id, x: n.x, z: n.z, y: n.y } : null;
  });
  if (npc) {
    const spot = await h.eval(([x, z]) => window.__nnTest.spotNear(x, z, 2.2, 3.5), [npc.x, npc.z]);
    if (spot) {
      await stand(spot.x, spot.z, npc.x, npc.y + 1.3, npc.z);
      await settle();
      await h.shot('resident');
    }
  }

  // a crime scene at dusk: the killer's victim in a front yard, a smashed window
  const scene = await h.eval(() => {
    const s = window.__game.sim;
    const victim = s.npcs.find((n) => n.alive && n.role === 'resident' && n.homeId !== s.world.playerHouseId && s.world.buildings[n.homeId].kind === 'house');
    const b = s.world.buildings[victim.homeId];
    const win = s.world.windows.find((w) => w.buildingId === b.id && w.exterior !== false);
    victim.tasks = [];
    victim.activity = null;
    victim.path = null;
    victim.x = b.outsideFront.x;
    victim.z = b.outsideFront.z;
    victim.y = s.grid.heightAt(victim.x, victim.z);
    victim.room = -1;
    victim.building = -1;
    window.__nnTest.kill(victim.id, s.killerId);
    if (win) window.__nnTest.hitWindow(win.id, 99);
    return { x: victim.x, z: victim.z, y: victim.y, win: win ? { x: win.axis === 'x' ? win.t : win.c, z: win.axis === 'x' ? win.c : win.t } : null };
  });
  await setHour(19.3);
  const sceneSpot = await h.eval(([x, z]) => window.__nnTest.spotNear(x, z, 2.6, 4.5), [scene.x, scene.z]);
  if (sceneSpot) {
    await stand(sceneSpot.x, sceneSpot.z, scene.x, scene.y + 0.2, scene.z);
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
}
