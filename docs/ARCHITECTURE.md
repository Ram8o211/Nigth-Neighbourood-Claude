# Architecture

Night Neighbour is a browser game written from scratch in TypeScript on top of
three.js and Vite. There is no game engine and no external art or audio: every
mesh, texture, sound and piece of music is generated in code at startup.

```
src/
  core/      seeded RNG, maths helpers, name tables
  world/     procedural neighbourhood (pure data) + navigation grid, colliders, pathfinding
    gen/     layout → lots → floor plans → buildings → furniture → props → repair pass
  sim/       the living simulation (pure TypeScript, no DOM, no three.js)
  render/    three.js presentation of world + simulation state
  audio/     offline-synthesized sample bank, spatial playback, generative music
  game/      game loop, player controller, story director, journal, saves, settings, observer
  ui/        HTML/CSS user interface (menus, HUD, dialogs, journal, observer panel)
  main.ts    boots Game + UI (or the developer viewer with ?viewer)
tests/       Vitest suites (headless: world generation, simulation, story, saves)
e2e/         Playwright-driven browser smoke test and screenshot tools
scripts/     headless dev tools (soak test, map dump) run through esbuild
```

## Layering

The most important design rule is that the **simulation does not know it is
being rendered**. `src/world` and `src/sim` import nothing from three.js or the
DOM. They can be stepped headless at thousands of steps per second, which is
what the unit tests, the soak script and the sleep/wait fast-forward use.

```
            ┌──────────────┐  reads state each frame  ┌──────────────┐
  input ──▶ │ game/        │ ───────────────────────▶ │ render/      │──▶ WebGL
            │ Game loop    │                          │ audio/       │──▶ WebAudio
            │ Player, Story│ ◀── events (SimEvent) ── │ ui/          │──▶ DOM
            └──────┬───────┘                          └──────────────┘
                   │ step(dt)
            ┌──────▼───────┐
            │ sim/         │  actors, perception, memory, tasks, crime, police
            │ Simulation   │
            └──────┬───────┘
                   │ queries
            ┌──────▼───────┐
            │ world/       │  WorldData, WorldGrid (nav/sight/sound), Colliders, Pathfinder
            └──────────────┘
```

Communication from the simulation outwards is a per-step list of `SimEvent`s
(sounds, deaths, swings, discoveries, arrests…). The game layer turns them into
audio, effects, journal entries and UI messages, and then clears the list.

## World data (`src/world`)

`generateWorld(params)` returns a plain, serialisable `WorldData`: roads,
blocks, lots, buildings, rooms, doors, windows, furniture, props, lights,
points of interest and landmarks. Everything is in metres on the XZ plane.
Doors and windows store both their static geometry and their dynamic state
(open, locked, broken, cracked, boarded), so the renderer, colliders and
navigation all read the same objects.

* **WorldGrid** – a 0.5 m occupancy grid with layered flags (blocked, door,
  window, indoor, wall, road, dark-preference), room / building ids, surface
  type (for footsteps) and floor height. It answers line-of-sight (DDA) and
  sound-occlusion queries.
* **Colliders** – axis-aligned boxes in a spatial hash; doors and windows are
  dynamic colliders whose activity depends on their state. Movement uses
  circle-vs-box resolution; melee hits test segment-vs-box so nothing is hit
  through walls.
* **Pathfinder** – weighted A* over the grid with per-agent costs (an
  `NavAgent` decides which doors it may use, unlock, knock or break, whether
  windows are passable and how much it dislikes light) and portal-aware path
  smoothing.

## Simulation (`src/sim`)

`Simulation.step(dt)` advances everything by `dt` real seconds (one real
second is 60 game seconds by day and 36 at night, so nights last longer):

1. door animation, light switching (every game minute), daily checks
2. combat timers, bleeding, getting up (`combat.ts`)
3. per NPC: perception every 0.3 s (`perception.ts`), thinking every 0.9 s
   (`brain.ts` + role controllers), then the current task queue (`tasks.ts`)
4. dragged bodies, police custody, incidents and investigations

**NPCs** are data (`NpcState`) with identity, appearance, traits, a household,
a job, a weekly schedule, needs (hunger, energy, social, fear), relationships,
keys, money, memories and an awareness map. Behaviour is layered:

* *Routine* – utility-scored activities (sleep, work, eat, relax, shop, visit,
  bar, church, walk, smoke…) expanded into serialisable task queues
  (`goto`, `use` furniture, `door`, `wait`, `talk`, …).
* *Reaction* – alarm from what was seen or heard can override the routine:
  investigate, flee, hide, lock down the house, confront, fight back, call the
  police (from a phone), or go and report in person.
* *Role controllers* – the killer's hunt state machine (`killer.ts`:
  prep → travel → stalk → entry → inside → attack → drag/cleanup → return), the
  burglar (`burglar.ts`), and police officers handling cases (`police.ts`).

**Perception** combines field of view, line of sight on the grid, the light
level at the target (daylight + street, porch and room lights + flashlights),
distance, stance and motion into a visibility value; awareness accumulates
over time. **Hearing** uses an audible radius per sound attenuated by walls;
sleeping NPCs hear less (and wake up).

**Memory** – every observation becomes a `Memory` with a topic (murder,
attack, scream, glass, prowler, body, trespass…), a *source* (`saw`, `heard`,
`told`) plus the teller for hearsay, the identified actor or a partial
description (height, coat, hair, shoes, build, hood), a place, a time and a
confidence. Repeated observations merge. Gossip copies important memories
between NPCs as `told` with reduced confidence. Dialogue lines are generated
from memories (`memoryLine`) so a resident says *"I saw…"*, *"I heard…"* or
*"Martha told me…"*.

**Crime and consequences** – violence opens an `Incident`; deaths leave a body,
blood and decals; the killer leaves clues (fabric, footprints, hair,
cigarette butts…) and stashes evidence in a lair; burglaries break windows or
pick locks and stolen goods go missing. Missing residents are noticed by their
household or colleagues. Everything persists: broken windows stay broken,
bodies stay until found and collected, police tape stays up.

**Police** – reports create or extend a `PoliceCase`. On-duty officers drive
the case: travel to the scene, examine it, search the victim's building and
interview witnesses, whose memories become reports. Once an hour detectives
go over the open files. Reports that *name* someone are weighted by what was
seen (an attack counts far more than a glimpse of someone with a weapon, a
hooded armed figure at night in between) and are combined with other open
cases from the same two days. Unnamed descriptions (height, coat, hair, shoes,
build) are checked against everybody in town; when they fit exactly one
person – two witnesses agreeing on three traits, or one witness who saw four –
that person becomes the suspect. An officer is then sent to make the arrest.
The player's accusation, when the chief accepts it, opens a case with that
suspect. Arrested actors are held in cells at the station.

## Game layer (`src/game`)

* **Game** – owns the mode state machine (`menu`, `loading`, `playing`,
  `paused`, `dialog`, `ending`, `observer`), the frame loop, fixed sub-stepping
  of the simulation, fast-forward for sleeping/waiting (interrupted by nearby
  alarming sounds), conversation logic, trading, arrests of the player, saving
  and loading.
* **PlayerController** – first-person movement with collision, sprint/crouch/
  dodge, needs, flashlight battery, interaction targeting and hold actions
  (lock, pick locks, board windows, drag bodies), hotbar and combat input.
* **Story** – the director. It chooses each night's hunt plan (how early the
  killer goes out, how many victims, whether they come for the player),
  tracks objectives and the player's "threat" to the killer, evaluates
  accusations and decides endings.
* **Journal** – the player's knowledge: clues (physical evidence, testimony,
  own sightings) with reliability, resident profiles learned by observation,
  an event log and a fit score per resident used by the chief.
* **Observer** – a free/follow camera over the *live* simulation with time
  controls, overlays (paths, view cones, nav grid) and an inspector for every
  resident's needs, activity, tasks, traits and memories.

## Rendering (`src/render`)

* `worldMesh.ts` builds static geometry per 32 m chunk, merged by material
  (walls with openings cut for doors and windows, floors, roofs, props,
  furniture); vegetation, doors and windows are instanced or individually
  animated meshes.
* `textures.ts` paints every texture (brick, siding, plaster, wood, tiles,
  asphalt, grass, faces…) on canvases at startup.
* `lights.ts` keeps a fixed pool of point lights assigned each frame to the
  most relevant world lights near the camera, plus sprite glows and ground
  light pools for the rest.
* `sky.ts` – sky dome shader, sun/moon, stars and a keyframed atmosphere
  (sun colour, ambient, fog, exposure) over the 24 h cycle.
* `characters.ts` – procedural rigs built from rounded boxes, dressed from the
  NPC's appearance (coat, hood at night, hair, glasses, police uniform) and
  animated procedurally (walk/run/sneak cycles, sit, lie, fight, downed, dead).
* `effects.ts` – blood decals and pools, footprints, chalk outlines, glass
  shards and debris, impact particles, police tape.
* `renderer.ts` – scene, shadows (sun + flashlight), quality presets and an
  `EffectComposer` post pass (tone mapping, vignette, grain, damage/fear
  desaturation, brightness).

## Audio (`src/audio`)

`synth.ts` renders ~60 sounds offline into `AudioBuffer`s at startup
(footsteps on eight surfaces, doors, locks, knocks, glass cracks and
shatters, swings, hits, screams, heartbeat, breathing, ambience loops…).
`audio.ts` plays them positionally through `PannerNode`s with a low-pass
filter driven by grid sound occlusion. `music.ts` is a small generative score
with layered states (menu, day, night, tension, danger, discovery stinger)
cross-faded by the game.

## Saving

A save is JSON in `localStorage`: generation parameters (the world is
regenerated deterministically from the seed), the full `SimSnapshot` (all
actors with memories and task queues, cases, incidents, clues, items, decals,
dynamic state of every door/window/light/furniture/prop, RNG state), the
journal and story state. Saves carry three version numbers (save format,
world generator, simulation); mismatches are reported in the load menu
instead of loading a broken game.
