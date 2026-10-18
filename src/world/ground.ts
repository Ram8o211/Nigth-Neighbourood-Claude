/**
 * Height (metres) of each kind of ground surface above the base terrain. The
 * renderer draws the ground at these heights and the navigation grid uses the
 * same values, so feet, bodies and blood decals sit on top of paths and roads.
 */
export const GROUND_Y: Record<string, number> = {
  forestfloor: -0.03,
  town: 0,
  overgrown: 0.006,
  vacant: 0.006,
  wild: 0.006,
  park: 0.004,
  parkpath: 0.012,
  path: 0.012,
  alley: 0.014,
  main: 0.018,
  street: 0.018,
  parking: 0.022,
  forecourt: 0.02,
  driveway: 0.026,
  walkway: 0.03,
};
