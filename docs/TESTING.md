# Testing, performance and known limitations

Everything below was produced by actually running the commands named; numbers
are copied from their output. Where something was **not** measured it says so.

## Test environment

* Linux container, 4 vCPU Intel Xeon @ 2.1 GHz, 15 GB RAM, **no GPU**
* Node.js 22.22, TypeScript 5.9.3 (strict), Vite 7.3.7, Vitest 4.1.12
* Browser tests: Chromium 141 (playwright-core 1.56.1) headless, WebGL through
  **SwiftShader** (software rasterisation), viewport 1280×720

## Static checks

`npm run typecheck` (`tsc --noEmit`, strict mode, `src/` and `tests/`): no errors.
`npm run build`: succeeds; the bundle is one 955 kB JavaScript file (278 kB
gzipped) plus CSS – there are no asset files because everything is generated.

## Unit and simulation tests (`npm test`)

37 tests in 6 files, all passing (last full run: 20 s wall time).

| File | What it checks |
| --- | --- |
| `tests/worldgen.test.ts` (9) | Same seed → identical town, different seed → different town; required buildings for all three sizes; doors and windows sit in wall openings on the correct sides; every building entrance, room, door side and furniture use point is reachable from the player's house; every home has a telephone and the player's house a table; connected roads/sidewalks; street lights, porch lights and dark alleys (8 seeds). |
| `tests/sim.test.ts` (14) | Population is reproducible and well formed (one killer, police, a chief, a lair); the simulation is deterministic (two runs of 1 500 steps are bit-identical); residents are at work by day and >80 % asleep at 3 am, couples side by side in their double bed; visibility drops in darkness, rises with a flashlight, is zero behind the observer and through walls; *saw / heard / told* memories are kept apart and hearsay loses confidence; repeated observations merge; melee hits in range, respects cooldowns, never hits through a wall, kills, opens an incident and spills blood; a killing witnessed by a neighbour who knows you raises your wanted level and opens a police case; police turn consistent witness descriptions into the right suspect and conflicting ones into none, never suspect an officer for using force, make a prowler a person of interest but arrest for violence, and hand a prisoner to another officer when the escort is called away; **save → JSON → load into a freshly generated world → 1 200 more steps** is identical to never having saved, and an open-ended activity is still open-ended after the JSON round trip. |
| `tests/story.test.ts` (9) | Game start (bus stop, key, letter); weak or contradicting accusations are rejected; a well-supported accusation gets the killer arrested by the simulated police and produces the winning ending; death and running out of nights produce the losing endings; journal and story state survive serialisation; save validation rejects outdated format, other generator, older simulation, incomplete and corrupt data; empty and corrupt slots are reported without throwing; stored settings from other sites or with out-of-range values and invalid key bindings are cleaned up. |
| `tests/player.test.ts` (2) | Removing an inventory slot (storing, dropping, selling) keeps the equipped weapon on the right slot and switches the flashlight off when the last one is gone. |
| `tests/audio.test.ts` (2) | Every sample name the audio engine plays exists in the synthesized bank (57 sounds, 88 s of audio, built in about 0.45 s); every buffer is finite, audible and does not clip. |
| `tests/emergent.test.ts` (1) | Three towns run headless for three full days and nights with nobody scripting anything. Requires murders, discovered bodies, police cases and reports, no resident stuck on path failures, finite positions. |

Output of the last emergent run (3 days, medium town, default director):

| seed | murders | burglaries | discovered | cases | reports | arrests | ms/step |
| --- | --- | --- | --- | --- | --- | --- | --- |
| emerge-1 | 1 | 0 | 1 | 4 | 42 | 0 | 0.048 |
| emerge-2 | 1 | 1 | 1 | 4 | 38 | 0 | 0.066 |
| emerge-3 | 2 | 0 | 2 | 4 | 28 | 0 | 0.053 |

`scripts/story-soak.ts` runs the real game director for five nights with a
passive player who stays locked in at home. Over nine seeds the killer
claimed 0–4 victims per game (19 in total), the police arrested nobody
(in some games they named a person of interest from sightings), and every
game ended with
*The Night Neighbour got away* – a player who does not investigate loses,
which is the intended design. (Before the fixes below, two seeds ended on the
first afternoon with an arrest for a mere trespass, and in another an officer
was arrested for using force while her prisoner was left handcuffed in the
street forever.)

## Browser smoke test (`npm run test:e2e`)

`e2e/run-e2e.mjs` builds the game, serves the production bundle with
`vite preview`, and drives it in headless Chromium through `e2e/smoke.mjs` with
real key presses and mouse clicks. The page's game object is only used to
read state, to teleport between distant places (walking across town at
software-rendered frame rates would take minutes) and to aim the camera at a
target. Checks:

* every main-menu button opens its screen and *Back* returns; a settings
  slider changes a setting and it is saved
* *New Game → Begin* generates a town; HUD and objectives appear; the audio
  engine is running with the synthesized sound bank and the day music
* W moves the player, arrow keys turn the camera
* the uncle's front door starts locked, is targeted, and **E** unlocks and
  opens it with the key; the player can walk in
* the letter is on a table, is targeted, **E** opens it, closing it returns to
  play and advances the objectives
* **Tab** opens the inventory, **J** the journal, all journal tabs open, the
  map tab draws
* a neighbour can be targeted and talked to; introducing yourself makes them
  known; the conversation closes
* **T** → wait 1 hour advances the clock by 60 game minutes
* at the hardware store counter **E** opens the shop; buying the flashlight
  takes $18 and puts it in the inventory, the objective completes, **F**
  switches it on and off (if the clerk has not reached work yet, the test
  places them behind the counter)
* **E** on the home telephone dials the police, who answer about the
  investigation
* the police chief can be talked to and asked about the case
* with a crowbar, a neighbour's locked front door offers *Pry the door open*;
  holding **E** opens it and marks it as forced
* **Esc** pauses, *Save Game → Slot 1* writes the save, *Resume* returns
* a baseball bat swing (left mouse) hurts a neighbour, who flees
* *Load Game → Slot 1* restores position and clock
* **E** on the bed offers sleep and sleeping advances to the morning
* **F2** opens observer mode, residents are listed, clicking one shows needs,
  activity and memories, the *16x* time button can be pressed, *Exit*
  returns to play
* death shows the ending screen with restart options; *Main menu* returns and
  now offers *Continue*
* no uncaught page errors and no errors in the game loop

Last run: **73 of 73 checks passed** (most of the time is the software
renderer drawing frames). The run log is printed to the console and saved as
`e2e/out/e2e-results.json`.

### Phones and tablets (`e2e/mobile.mjs`)

The same runner then plays the game on an **emulated landscape phone**
(Chromium with a touch screen and a mobile viewport, 844×390, no mouse or
keyboard), with finger taps for the menus and real multi-touch events (sent
through the Chrome DevTools Protocol, `e2e/touch.mjs`) for the on-screen
controls. It checks that:

* the touch controls switch on by themselves, the phone starts on the *low*
  preset at pixel ratio 1, and no pointer lock is taken
* the main menu, settings (touch option shown, key rebinding hidden), help,
  load and new-game screens fit the screen without zooming or sideways
  scrolling
* the left stick walks, past its rim sprints, and a thumb resting at the
  screen edge does not move the player; dragging on the right turns the view
* prompts read *[Use]*; USE unlocks the door and opens the letter, whose
  *Fold* button stays reachable on the short screen
* CROUCH, BLOCK (held), LIGHT, WEAPON and HIT work; HIT with a second finger
  while the thumb rests on the stick swings the bat; a second finger also
  closes a dialog while the thumb stays down
* BAG, JOURNAL, MAP, WAIT and ❚❚ open their screens, which fit
* turning the phone upright pauses with a notice whose *Menu* button reaches
  the pause menu; turning it back resumes and the view is resized
* observer mode shows its own controls (not hidden by the inspector panel)
  and the stick flies the camera
* at 640×360, 667×375, 740×360, 915×412 and 1024×768 every control is on
  screen, not covered, clear of the HUD text, and the pause menu fits
* no page errors and no errors in the game loop

Last run: **64 of 64 checks passed** in 132 s. Both suites together (what
CI runs): **132 of 132** at the time (59 mobile checks then) in 669 s.

Screenshots of each step are written to `e2e/out/`; a selection is in
`docs/screenshots/`.

Both smoke tests run in GitHub Actions after every deployment to GitHub
Pages, against the live site (`.github/workflows/pages.yml`, job *Browser
smoke test on the live site*), once the site serves the build that was just
published; it can be pointed at any deployment with `NN_URL=<url> npm run
test:e2e`. Branches and pull requests run type-check, unit tests and a build
(`.github/workflows/ci.yml`).

The browser is launched without any autoplay override, so the audio check
proves that sound starts from the player's click as it would for a real
player, and any failed request for the game's own files (HTTP 4xx/5xx) is
reported as an error. Before the first deployment the production bundle was
also served from the same sub-path GitHub Pages uses
(`/Nigth-Neighbourood-Claude/`) by a plain static server: all 73 checks passed
there and every request for the game's files returned 200.

## Performance

### Measured: simulation (headless, `scripts/bench.ts`, 24 game hours)

| size | buildings | rooms | furniture | NPCs | generate | populate | ms / step | worst step |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| small | 27–30 | 101–127 | 373–451 | 18–21 | 65–123 ms | 54–70 ms | 0.044–0.051 | 28–57 ms |
| medium | 44–67 | 176–254 | 634–911 | 26–28 | 63–123 ms | 38–47 ms | 0.048–0.072 | 7–19 ms |
| large | 79–90 | 302–362 | 1064–1267 | 37–44 | 67–113 ms | 39–59 ms | 0.095–0.142 | 10–17 ms |

At normal speed the game runs one step per frame, so the simulation costs
well under 1 ms of a 16.7 ms frame on average. Occasional long steps come
from long A* searches: over 48 game hours a medium town had 4 steps above 8 ms
and 1 above 16 ms (worst single path search 24 ms); a large town had 17 above
8 ms and 3 above 16 ms. These can show up as rare single-frame hitches.
Sleeping fast-forwards at up to 60 steps per frame within a 14 ms budget.

### Measured: in the browser under SwiftShader (1280×720, medium town)

| setting | draw calls | triangles | sim ms/frame | JS ms/frame | frame interval |
| --- | --- | --- | --- | --- | --- |
| medium quality | 858 | 620 k | 1.8 | 112 | ~670 ms |
| low quality | 558 | 383 k | 1.0 | 42 | ~470 ms |
| low, no post-processing | – | – | 0.7 | 17 | ~360 ms |

Draw calls and triangles include the shadow passes. A CPU profile of 15
frames showed the main thread idle about 96 % of the time, i.e. waiting on the
software rasteriser in the GPU process; JavaScript (three.js scene traversal,
uniform uploads, HUD, simulation) accounts for the rest. **These frame rates
(1.5–3 FPS) say nothing about real hardware**: they are what a CPU emulating a
GPU achieves.

### Not measured: real GPUs

No GPU was available, so the 60 FPS target could **not be verified**. As an
estimate only: about 560–860 draw calls and 0.4–0.6 M triangles per frame, a
fixed pool of 4/8/12 shadowless point lights, a 1–2 k sun shadow map and a
small flashlight shadow map are a
moderate load that current discrete GPUs and recent integrated GPUs normally
handle at 60 FPS at 1080p on *medium*; *low* (75 % resolution, no shadows, 4
lights) is the fallback for weak integrated graphics. Expect the CPU side
(three.js submitting ~900 draw calls plus ~1 ms of simulation) to cost a few
milliseconds per frame. Please treat this as unverified until someone runs
the game on real hardware (the FPS counter is in *Settings → Graphics*).

## Bugs found by testing and fixed

* Movement and interaction were blocked whenever pointer lock was not granted;
  keyboard play now works without it, mouse look requires it, losing the lock
  pauses the game.
* The game started facing the back wall of the bus shelter.
* The uncle's letter could be placed on a bathroom cabinet because some houses
  had no table; houses had no telephone in some seeds. Every home now gets a
  phone, the player's house a table, and items win over the furniture they lie
  on when aiming.
* The observer panel was not clickable (CSS) and was rebuilt every few frames,
  which swallowed clicks; it is now built once and updated in place, and
  entering observer mode releases the mouse.
* Residents woken by noise or a hit were left standing inside their bed and
  got pushed into sealed pockets between furniture, after which every path
  failed (found by the emergent test). They now get up onto the bed's free
  side, and an unstick safety net moves a trapped NPC to the room's door when
  nobody is looking.
* Furniture was single-occupancy: in every couple only one partner could
  sleep, the other re-planned every few minutes all night; meals failed when
  someone sat on the sofa. Beds, sofas and benches now have capacity and seat
  slots.
* Residents without a job had no income and re-planned a shopping trip every
  hour; the burglar abandoned every attempt when anybody within 25 m glimpsed
  them.
* Police cases never progressed without a named culprit; detectives now
  re-read their files hourly and use descriptions.
* Witnesses reported officers making an arrest as assailants, and colleagues
  arrested them; a prisoner whose escort was taken away stayed handcuffed in
  the street for the rest of the game, so the arrest never counted. Found with
  `scripts/story-soak.ts`.
* A trespass or prowler sighting could get the killer arrested on the first
  morning, ending the game before the player had done anything; such cases
  now produce a person of interest and arrests follow violent crimes.
* Setting the player's health to zero did not end the game (regeneration ran
  first) and starvation skipped the normal death handling.
* Blood decals (and feet) were drawn under paths, driveways and roads, which
  the renderer lifts 1–3 cm above the terrain; renderer and simulation now share
  one ground-height table (found while taking the crime-scene screenshot).
* Main Street labels on the journal map overlapped into an unreadable jumble
  and the map did not fit a 720 px screen; public buildings are now numbered
  with a legend.
* Save results were shown on the hidden HUD while the pause menu was open,
  and failed autosaves were silent.
* Preparing the GitHub Actions smoke test showed that Playwright's stripped
  "headless shell" browser reports one large bogus mouse movement after a
  click while the pointer is locked; the game turned the player with it, so a
  bat swing missed its target. CI now drives full Chromium like the local
  runs (no bogus jumps there). The game ignores only the first mouse movement
  after the pointer is captured, which some browsers report with the cursor's
  old offset; at most that one event (a frame's worth) is lost, and fast
  mouse-look is no longer thrown away.
* An automated review of the merge pull request found three bugs, all fixed:
  saves turned an open-ended resident activity deadline (`Infinity`) into
  `null`, so after loading, residents dropped what they were doing (now
  restored; covered by a test); the ending screen's *New game* and *Load*
  buttons left the "ending shown" flag set, so a later game could never show
  its ending; storing an inventory item that came before the equipped weapon
  left the equipped index pointing at the wrong slot. A second review of those
  fixes found two older relatives: storing, dropping or selling a lit
  flashlight left its beam on with no way to switch it off, and an ending
  that arrived while the arrest dialog was open blocked every later arrest
  until the page was reloaded. Both are fixed (the first covered by
  `tests/player.test.ts`).
* Two smoke-test checks read the HUD's objective list two or three frames
  after closing a dialog, but the HUD redraws it only every six frames, so
  they passed or failed by chance (one failed once). They now wait for the
  HUD to refresh.
* Making the game playable on phones, the mobile smoke test and a review
  found: observer UP/DOWN buttons hidden under the inspector panel; menu
  buttons ignoring taps while the thumb rested on the stick (browsers make no
  click from a second finger's tap); a thumb landing near the screen edge
  walking the player; the "turn your phone sideways" notice trapping players
  with rotation lock on; saves taken when the page was hidden overwriting the
  morning checkpoint (and, during a night in the cells, locking the player in
  for good); input-mode switches swallowing a click; HUD text under the
  controls on 640–740 px wide phones. All fixed and covered by the tests above.
* The crowbar's description promised prying doors and windows open, which was
  not implemented; cigarettes were sold but had no use (now: offer one to a
  smoker for rumours).

## Known limitations

* **Performance on real GPUs is unmeasured** (see above).
* **Phones and tablets were tested only in emulation** (Chromium's mobile
  mode with emulated touch), never on a real iPhone, iPad or Android device.
  Things emulation cannot show: frame rate on phone GPUs, iOS Safari's own
  behaviour (it has no full-screen API on iPhone; *Add to Home Screen* gives
  a full-screen app whose saves are separate from Safari's), orientation
  lock, and audio: on an iPhone the silent switch mutes the game. Phones are
  played sideways; upright, the game pauses.
* Visual style is deliberately simple: characters are rounded-box figures with
  procedural animation (no skinned meshes or motion capture), buildings are
  single-storey, there are no vehicles moving.
* The town is flat apart from small floor-height differences; there are no
  stairs or upper floors.
* Dialogue is menu-based and generated from memories; there is no free text or
  voice.
* NPC pathfinding is grid A* with a per-step budget; very rarely an NPC takes
  an odd route or pauses while waiting for a path, and long searches can cause
  an occasional frame hitch.
* Police only arrest when witnesses name someone, descriptions fit exactly one
  person, or the chief accepts the player's accusation; they do not analyse
  physical evidence on their own.
* Audio is synthesised; it is atmospheric but obviously not recorded foley.
* Saves live in the browser's `localStorage` (about 5 MB per site). A save is
  about 320 kB at the start and 375 kB after five days in a medium town, so the
  autosave and three slots fit, but other sites' data on the same origin could
  crowd them out (the game reports a failed save instead of crashing).
* Tested only in Chromium. Firefox and Safari were not tested. The mouse is
  captured (pointer lock) after the town has been generated, outside the click
  that started it; Chromium allows that, Firefox may not, in which case the
  game shows *Click to look around* and one click on the view captures it.
