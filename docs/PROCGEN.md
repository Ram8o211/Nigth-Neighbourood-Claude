# Procedural generation

Every town is generated from a text seed (`GenParams`: seed, size
small/medium/large, population density, number of nights). The same seed always
produces the same town, population and killer; this is covered by tests.

## Pipeline (`src/world/gen`)

1. **Layout** (`layout.ts`) – a grid of streets with irregular spacing, one
   *Main Street*, named residential streets, alleys through some blocks and
   footpaths. Blocks are subdivided into lots facing a street; lots get
   addresses.
2. **Lot kinds** – Main Street lots become the police station, general store,
   hardware store, diner, bar, clinic, garage and church (each required kind is
   guaranteed); other lots become houses, a few abandoned houses and parks.
   Corner lots and lot sizes bias the choice.
3. **Floor plans** (`plans.ts`) – each building kind has a plan template
   (e.g. a house: hall → living room, kitchen, bathroom, one to three bedrooms;
   the police station: lobby, offices, cells; the diner: dining room, kitchen,
   toilets). Rooms are produced by recursive splitting of the footprint with
   minimum sizes, then connected with interior doors so every room is
   reachable.
4. **Buildings** (`buildings.ts`, `frame.ts`) – the plan is placed into the lot
   through a local frame (so a building can face any direction). Exterior walls
   get a front door facing the street, sometimes a back door, and windows
   sized by room type; garages and sheds get their own doors. Walls, doors and
   windows are stored as data the renderer, colliders and navigation share, so
   **the inside always matches the outside**: a window seen from the street is
   a real opening into the room behind it. Some houses get a shed in the back
   yard.
5. **Furniture** (`furnish.ts`) – rooms are furnished by type against walls,
   respecting door clearances and window zones (tall furniture never blocks a
   window). Furniture has a *use point* where NPCs stand to use it, an optional
   container with loot appropriate to the room, and can be a hiding place
   (wardrobes). Every home gets a telephone; the player's inherited house always
   has a table for the uncle's letter.
6. **Props** (`props.ts`) – street lights, trees, hedges, picket fences, cars in
   driveways, mailboxes, bins, benches, a bus stop, a water tower and radio
   mast landmarks, park furniture. Exterior door approaches and roads are
   reserved so props never block an entrance.
7. **Repair pass** (`repair.ts`) – the generated world is validated against
   the navigation grid: unreachable entrances get blocking fences/hedges
   removed, furniture whose use point cannot be reached is moved or removed,
   narrow rooms are cleared. It runs up to eight passes until stable.

## Horror-aware placement

* Street lights are spaced irregularly and some are broken or flickering
  (alley lights break a quarter of the time), so streets have dark gaps;
  alleys, back yards and the churchyard are mostly unlit. The simulation builds
  a night-light map from street, porch, park and sign lights, and the killer's
  and burglar's pathfinding pays a cost for lit cells, so they prefer dark
  routes.
* Abandoned houses, sheds and the woods around the town provide lairs and
  hiding places; the killer's lair is chosen among them.
* Houses have back doors and ground-floor windows that can be cracked, broken
  and climbed through, giving intruders more than one way in.

## Population (`src/sim/population.ts`)

Households are assigned to houses (single people, couples, families, room
mates). Each person gets a name, age, appearance (height class, build, skin,
hair colour and style, beard, glasses, coat colour, shoe type), personality
traits (bravery, curiosity, sociability, aggression, vigilance, gossip), a job
tied to a workplace with shifts, a weekly schedule, money, keys to their home
and workplace, and relationships with neighbours, colleagues and housemates.
Police officers and the chief are assigned to the station with day and night
shifts. One resident is secretly the killer (with a lair), and usually another
is a burglar. Everything comes from the world seed.

## Validation

`tests/worldgen.test.ts` generates towns for eight seeds and all three sizes
and checks: reproducibility, required buildings, door/window alignment with
wall openings, that every building entrance and every exterior door is
reachable from the player's home, that furniture use points are reachable,
a connected road and sidewalk network, lighting with dark gaps, and that every
home has a telephone (and the player's house a table). `scripts/mapdump.ts` prints an ASCII map of a
generated town for manual inspection.
