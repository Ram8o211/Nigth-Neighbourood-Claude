# Night Neighbour

*Somebody on your street is not who they seem.*

Night Neighbour is a first-person horror simulation set in a procedurally
generated small town. You inherit your late uncle's house and his suspicion
that one of the neighbours kills at night. Every resident lives a real
routine – work shifts, meals, shopping, the bar, gossip, sleep – sees and hears
what happens around them, remembers it, and acts on it. One of them goes out
after midnight in a hooded coat. The police investigate whatever gets reported.
You have a handful of nights to survive and find out who it is.

This is a **beta**: a complete, playable game loop with a beginning, middle
and end, built from scratch in TypeScript and three.js with no external art,
audio or engine. See [the honest status](#status-and-known-limitations) at the
bottom.

![Arriving in town](docs/screenshots/street_day.png)

## Play

Requirements: Node.js 20+ and a browser with WebGL 2 (current Chrome, Edge,
Firefox or Safari). A dedicated or recent integrated GPU is recommended.

```bash
npm install
npm run dev          # http://localhost:5173
# or a production build
npm run build && npm run preview   # http://localhost:4173
```

Click *New Game*, keep or change the seed (the same seed always gives the same
town, residents and killer), pick a town size and the number of nights, and
press *Begin*. Click the view to capture the mouse.

| Key | Action |
| --- | --- |
| W A S D / mouse | Move / look (arrow keys also look) |
| Shift, C, Space | Sprint, crouch, dodge |
| E (hold E) | Interact (alternative: lock doors, pick locks, board windows, drag bodies) |
| Left / right mouse | Attack / block |
| F | Flashlight |
| 1–6, wheel, H | Weapons |
| Tab, J, M | Inventory, journal, map |
| T | Wait |
| Esc | Pause (save, load, settings) |
| F2 | Observer mode |

All bindings can be changed in *Settings*. The full rules are in
[docs/GAMEPLAY.md](docs/GAMEPLAY.md).

## What is in the beta

* **Procedural town** from a seed: streets, alleys, Main Street with police
  station, store, hardware store, diner, bar, clinic, garage and church, houses
  with yards, sheds, abandoned houses, a park and churchyard, street lights with
  dark gaps. Every building has a real, furnished interior matching its outside
  (doors, windows, rooms, furniture with containers and hiding places).
  [docs/PROCGEN.md](docs/PROCGEN.md)
* **Autonomous residents** (18–45 depending on town size) with identities,
  households, jobs and shifts, schedules, needs, personalities, relationships,
  keys and money; utility-based routines; sight (field of view, line of sight,
  light, stance) and hearing (walls muffle, sleepers wake); memories that keep
  *saw / heard / was told* apart; gossip; reactions (investigate, flee, hide,
  lock up, fight back, call or report to the police).
* **Emergent crime**: a killer with a nightly hunt (stalking, physical entry
  through doors, picked locks or broken windows, attack, dragging the body,
  cleaning up, leaving traces, a lair) and a burglar; missing-person reports;
  persistent consequences (bodies, blood, broken glass, police tape, fear).
* **Police**: calls and in-person reports open cases, officers travel,
  examine scenes, search homes, interview witnesses, match descriptions and
  arrest suspects into the station's cells – including you.
* **Player**: first-person movement, sprint, crouch, dodge, health, stamina,
  bleeding, hunger and energy, inventory, money, shops (buy and sell),
  flashlight with battery, sleeping and waiting, hiding, lock-picking, boarding
  windows, dragging bodies, stealth feedback.
* **Melee combat**: fists, knife, bat, crowbar, baton; wind-up, cooldown,
  blocking and dodging, knock-down, bleeding and death for everyone; no hits
  through walls; noise brings witnesses, witnesses bring the police.
* **Investigation and story**: the uncle's letter, objectives, a journal with
  physical evidence, testimony and your own sightings, resident profiles and a
  suspects comparison, accusing the culprit to the chief, a night-by-night
  director, seven endings (three wins).
* **Presentation**: day/night cycle with sky, sun, moon and stars, fog, tone
  mapping, shadows, flickering lights, a pooled real-time light system,
  procedural textures and characters, blood and glass effects, post effects
  for damage and fear; synthesized sound effects with spatial audio and wall
  occlusion, footsteps per surface, ambience, and generative music with
  menu/day/night/tension/danger states.
* **Menus and UI**: main menu, new game options, three save slots and
  autosave (with invalid/outdated save detection), pause menu, settings
  (graphics, audio, controls with key rebinding), how-to-play, HUD, dialogue,
  trade, containers, sleep/wait, phone, journal with map, death and ending
  screens.
* **Observer mode** on the live simulation: free/follow camera, time controls
  up to 60×, path / view-cone / navigation overlays, and an inspector for every
  resident's needs, activity, tasks, traits and memories, plus incidents and
  police cases.

![Observer mode](docs/screenshots/observer.png)

## Project layout and architecture

```
src/core     RNG, maths, names           src/sim      simulation (headless)
src/world    town generation, nav grid   src/render   three.js presentation
src/game     loop, player, story, saves  src/audio    synthesized audio + music
src/ui       HTML/CSS interface          tests/ e2e/ scripts/
```

The simulation never imports three.js or the DOM, so it runs headless in tests
and during sleep fast-forward. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Tests

```bash
npm run typecheck    # TypeScript, strict
npm test             # Vitest: world generation, simulation, story, saves, multi-night runs
npm run test:e2e     # builds, serves and drives the real game in headless Chromium
```

Developer tools: `node scripts/run.mjs scripts/soak.ts <seed> <hours>` prints
a timeline of a headless run; `node scripts/run.mjs scripts/bench.ts` measures
generation and simulation cost; `?viewer&seed=…&hour=…&look=street|home|inside&lineup=8`
renders a fixed view; `node e2e/drive.mjs e2e/screens.mjs docs/screenshots`
regenerates the screenshots. Results of the last runs are in
[docs/TESTING.md](docs/TESTING.md).

## Status and known limitations

See [docs/TESTING.md](docs/TESTING.md#known-limitations) for the full list.
In short: it was developed and tested in a container without a GPU, so all
browser testing used software rendering (SwiftShader) at 1–3 frames per
second; real-GPU frame rates were **not measured** and are only estimated from
draw-call and triangle counts. Characters are stylised low-poly figures
without skeletal animation assets. There is no voice acting and dialogue is
menu-based.

## Originality

All code, procedural content, textures, sounds and music in this repository
were written for this project. No code, assets or data from any earlier Night
Neighbour implementation were used or consulted.
