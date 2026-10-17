// Item catalogue shared by world generation, simulation and UI.

export type ItemCategory = 'food' | 'medical' | 'tool' | 'weapon' | 'valuable' | 'key' | 'evidence' | 'misc';

export interface ItemDef {
  id: string;
  name: string;
  cat: ItemCategory;
  price: number;
  stack: number;
  desc: string;
  // food
  hunger?: number;
  energy?: number;
  stamina?: number;
  // medical
  heal?: number;
  stopsBleeding?: boolean;
  // weapons
  weapon?: WeaponDef;
}

export interface WeaponDef {
  damage: number;
  range: number;
  /** seconds between strikes */
  cooldown: number;
  /** delay between input and hit frame */
  windup: number;
  stamina: number;
  arc: number; // half-angle radians
  bleed: number; // bleed chance
  knockdown: number;
  noise: number;
  breaks: number; // damage dealt to windows/doors
  blood: number;
}

export const FISTS: WeaponDef = {
  damage: 7,
  range: 1.35,
  cooldown: 0.55,
  windup: 0.12,
  stamina: 7,
  arc: 0.6,
  bleed: 0.02,
  knockdown: 0.05,
  noise: 12,
  breaks: 4,
  blood: 0.2,
};

export const ITEMS: Record<string, ItemDef> = {
  sandwich: { id: 'sandwich', name: 'Sandwich', cat: 'food', price: 6, stack: 4, desc: 'Ham and cheese. Fills you up.', hunger: 38 },
  canned_beans: { id: 'canned_beans', name: 'Canned beans', cat: 'food', price: 4, stack: 4, desc: 'Cold, but filling.', hunger: 32 },
  apple: { id: 'apple', name: 'Apple', cat: 'food', price: 2, stack: 6, desc: 'Crisp and a little sour.', hunger: 14 },
  coffee: { id: 'coffee', name: 'Thermos of coffee', cat: 'food', price: 4, stack: 3, desc: 'Keeps you awake through the night.', hunger: 4, energy: 30 },
  chocolate: { id: 'chocolate', name: 'Chocolate bar', cat: 'food', price: 3, stack: 6, desc: 'Quick energy.', hunger: 9, stamina: 40 },
  bandage: { id: 'bandage', name: 'Bandage', cat: 'medical', price: 8, stack: 5, desc: 'Stops bleeding and patches small wounds.', heal: 12, stopsBleeding: true },
  painkillers: { id: 'painkillers', name: 'Painkillers', cat: 'medical', price: 14, stack: 4, desc: 'Restores health over a short time.', heal: 35 },
  flashlight: { id: 'flashlight', name: 'Flashlight', cat: 'tool', price: 18, stack: 1, desc: 'Lights the way. Also makes you easy to spot. [F] to toggle.' },
  battery: { id: 'battery', name: 'Battery', cat: 'tool', price: 5, stack: 6, desc: 'Fresh battery for the flashlight.' },
  planks: { id: 'planks', name: 'Wooden planks', cat: 'tool', price: 9, stack: 6, desc: 'Board up a window from the inside.' },
  lockpick: { id: 'lockpick', name: 'Lockpick set', cat: 'tool', price: 30, stack: 1, desc: 'Quietly opens locked doors. Takes time.' },
  kitchen_knife: {
    id: 'kitchen_knife',
    name: 'Kitchen knife',
    cat: 'weapon',
    price: 12,
    stack: 1,
    desc: 'Fast and vicious. Causes bleeding.',
    weapon: { damage: 20, range: 1.5, cooldown: 0.5, windup: 0.1, stamina: 9, arc: 0.5, bleed: 0.55, knockdown: 0.05, noise: 10, breaks: 3, blood: 1 },
  },
  baseball_bat: {
    id: 'baseball_bat',
    name: 'Baseball bat',
    cat: 'weapon',
    price: 22,
    stack: 1,
    desc: 'Slow, heavy swings that can knock people down and smash glass.',
    weapon: { damage: 29, range: 2.0, cooldown: 1.0, windup: 0.32, stamina: 18, arc: 0.75, bleed: 0.12, knockdown: 0.45, noise: 18, breaks: 18, blood: 0.6 },
  },
  crowbar: {
    id: 'crowbar',
    name: 'Crowbar',
    cat: 'weapon',
    price: 20,
    stack: 1,
    desc: 'A decent weapon. Pries open locked doors and windows.',
    weapon: { damage: 23, range: 1.75, cooldown: 0.8, windup: 0.22, stamina: 13, arc: 0.6, bleed: 0.25, knockdown: 0.25, noise: 14, breaks: 12, blood: 0.7 },
  },
  baton: {
    id: 'baton',
    name: 'Police baton',
    cat: 'weapon',
    price: 0,
    stack: 1,
    desc: 'Standard issue.',
    weapon: { damage: 13, range: 1.7, cooldown: 0.75, windup: 0.18, stamina: 10, arc: 0.6, bleed: 0.02, knockdown: 0.45, noise: 14, breaks: 10, blood: 0.15 },
  },
  cigarette_butt: { id: 'cigarette_butt', name: 'Cigarette butt', cat: 'misc', price: 0, stack: 9, desc: 'Somebody smokes around here.' },
  watch: { id: 'watch', name: 'Pocket watch', cat: 'valuable', price: 25, stack: 3, desc: 'Somebody’s heirloom. Worth something at the store.' },
  jewelry: { id: 'jewelry', name: 'Jewellery', cat: 'valuable', price: 35, stack: 3, desc: 'A tangle of necklaces and rings.' },
  silverware: { id: 'silverware', name: 'Silverware', cat: 'valuable', price: 15, stack: 3, desc: 'Polished forks and spoons.' },
  cash: { id: 'cash', name: 'Cash', cat: 'valuable', price: 1, stack: 999, desc: 'Money.' },
  cigarettes: { id: 'cigarettes', name: 'Cigarettes', cat: 'misc', price: 5, stack: 3, desc: 'A pack of Red Crow cigarettes. Smokers talk more freely over one.' },
  key: { id: 'key', name: 'Key', cat: 'key', price: 0, stack: 1, desc: 'Opens a door somewhere.' },
  evidence: { id: 'evidence', name: 'Evidence', cat: 'evidence', price: 0, stack: 1, desc: 'Something important.' },
  note: { id: 'note', name: 'Note', cat: 'misc', price: 0, stack: 1, desc: 'A handwritten note.' },
};

export function itemName(id: string): string {
  return ITEMS[id]?.name ?? id;
}
