// Tunable simulation constants.

export const CFG = {
  /** game seconds per real second during the day / at night */
  timeScaleDay: 60,
  timeScaleNight: 36,
  /** real seconds per simulation step (max) */
  maxStep: 1 / 20,
  walkSpeed: 1.4,
  briskSpeed: 1.75,
  runSpeed: 4.2,
  sneakSpeed: 0.95,
  playerWalk: 2.7,
  playerSprint: 5.2,
  playerCrouch: 1.35,
  dawn: 6.6,
  dusk: 19.4,
  /** hearing: sounds are given as an audible radius in metres for an awake listener */
  sleepHearing: 0.38,
  perceiveInterval: 0.3,
  thinkInterval: 0.9,
  pathBudgetPerStep: 3,
  startHour: 9,
};

/** what a basket of groceries costs at the store */
export const SHOP_COST = 18;

export function isDark(hour: number) {
  return hour >= 18.6 || hour < 7.2;
}

export function isNight(hour: number) {
  return hour >= 21 || hour < 5.5;
}
