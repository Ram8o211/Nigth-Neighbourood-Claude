import type { Rng } from './rng';

const TOWN_A = ['Hollow', 'Ash', 'Mill', 'Raven', 'Black', 'Wren', 'Cold', 'Elder', 'Thorn', 'Grey', 'Moss', 'Fallow', 'Briar', 'Stone', 'Larch'];
const TOWN_B = ['brook', 'field', 'creek', 'wood', 'haven', 'ford', 'dale', 'ridge', 'wick', 'mere', 'hurst', 'stead'];

export function townName(rng: Rng): string {
  return rng.pick(TOWN_A) + rng.pick(TOWN_B);
}

export const STREET_NAMES = [
  'Elm', 'Oak', 'Maple', 'Birch', 'Willow', 'Cedar', 'Pine', 'Hawthorn', 'Juniper', 'Linden', 'Alder', 'Chestnut',
  'Sycamore', 'Hazel', 'Rowan', 'Laurel', 'Magnolia', 'Poplar', 'Spruce', 'Holly', 'Aspen', 'Beech',
];
export const STREET_TYPES = ['Street', 'Avenue', 'Lane', 'Road', 'Drive', 'Way'];

export const FIRST_M = [
  'Arthur', 'Walter', 'Frank', 'Harold', 'George', 'Eugene', 'Leonard', 'Raymond', 'Victor', 'Douglas', 'Roy', 'Dale',
  'Curtis', 'Wesley', 'Gordon', 'Martin', 'Lloyd', 'Vernon', 'Dennis', 'Calvin', 'Howard', 'Elliot', 'Russell', 'Neil',
];
export const FIRST_F = [
  'Margaret', 'Dorothy', 'Helen', 'Ruth', 'Evelyn', 'Joan', 'Irene', 'Lorraine', 'Beverly', 'Judith', 'Carol', 'Nora',
  'Ada', 'June', 'Marion', 'Frances', 'Edith', 'Gloria', 'Agnes', 'Vivian', 'Lillian', 'Rosa', 'Hazel', 'Ivy',
];
export const SURNAMES = [
  'Miller', 'Hartley', 'Crane', 'Whitlock', 'Bramwell', 'Ashby', 'Kessler', 'Doyle', 'Pruitt', 'Lindqvist', 'Okafor',
  'Marsh', 'Delaney', 'Voss', 'Harrow', 'Tilden', 'Greaves', 'Fenwick', 'Osei', 'Castellano', 'Brandt', 'Holloway',
  'Mercer', 'Quill', 'Sorensen', 'Abernathy', 'Pike', 'Novak', 'Reyes', 'Underwood', 'Calloway', 'Strand',
];

export function personName(rng: Rng, female: boolean, surname?: string) {
  const first = rng.pick(female ? FIRST_F : FIRST_M);
  return { first, last: surname ?? rng.pick(SURNAMES) };
}
