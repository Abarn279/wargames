export type Team = 0 | 1; // 0 = blue (player, west), 1 = red (opponent, east)
export const other = (t: Team): Team => (t === 0 ? 1 : 0);

export type UnitType = 'rifleman' | 'gunner' | 'sniper' | 'rocketeer' | 'breacher' | 'medic' | 'tank';
export type DefenseType = 'barricade' | 'tanktrap' | 'turret' | 'mine';

/** Go codes: breakpoints are tagged with one; calling it releases every unit holding on it. */
export type GoCode = 'A' | 'B' | 'C';
export const GO_CODES: GoCode[] = ['A', 'B', 'C'];
export const CODE_NAMES: Record<GoCode, string> = { A: 'ALPHA', B: 'BRAVO', C: 'CHARLIE' };

/** How a unit moves: foot soldiers go anywhere walkable; vehicles need open ground (no buildings, forest, fords). */
export type MoveClass = 'foot' | 'vehicle';

export type ArmorClass = 'infantry' | 'armor' | 'structure';
export type DamageType = 'bullet' | 'precision' | 'rocket' | 'he' | 'demo' | 'blast';

/**
 * The rock-paper-scissors core. Rows are damage types, columns are what they hit.
 * Tanks (he) crush infantry; rockets kill tanks but are poor against soldiers;
 * small arms (bullet/precision) kill rocketeers but barely scratch armor.
 */
export const DAMAGE: Record<DamageType, Record<ArmorClass, number>> = {
  bullet: { infantry: 1, armor: 0.08, structure: 0.25 },
  precision: { infantry: 1, armor: 0.15, structure: 0.2 },
  rocket: { infantry: 0.3, armor: 1, structure: 1.2 },
  he: { infantry: 0.8, armor: 0.45, structure: 1.5 },
  demo: { infantry: 1, armor: 0.5, structure: 4 },
  blast: { infantry: 1, armor: 1.5, structure: 0 },
};

/** Damage taken by infantry inside a building (garrisoned), by incoming damage type. */
export const GARRISON: Record<DamageType, number> = {
  bullet: 0.5, precision: 0.5, rocket: 0.75, he: 1, demo: 1, blast: 1,
};

export interface UnitStats {
  name: string;
  short: string;
  cost: number;
  hp: number;
  speed: number; // tiles / second
  range: number; // tiles
  damage: number; // per hit, before the DAMAGE multiplier
  cooldown: number; // seconds between shots
  accuracy: number; // base hit chance at point blank
  /** Accuracy multiplier by target class (big guns struggle to hit a lone soldier). */
  accVs?: Partial<Record<ArmorClass, number>>;
  vision: number; // tiles
  dtype: DamageType;
  armor: ArmorClass;
  move: MoveClass;
  /** HE splash radius in tiles; enemies inside take half damage. */
  splash?: number;
  /** Seconds of suppression applied to infantry on hit (slows and spoils their aim). */
  suppress?: number;
  /** HP/second healed to the most-wounded friendly soldier in range. */
  heal?: number;
  maxPerTeam?: number;
  role: string;
  strong: string;
  weak: string;
}

export const UNITS: Record<UnitType, UnitStats> = {
  rifleman: {
    name: 'Rifleman', short: 'R', cost: 200, hp: 100, speed: 2.6, range: 5, damage: 12,
    cooldown: 0.5, accuracy: 0.85, vision: 7, dtype: 'bullet', armor: 'infantry', move: 'foot',
    role: 'Cheap line infantry.', strong: 'Rocketeers, snipers', weak: 'Tanks',
  },
  gunner: {
    name: 'Gunner', short: 'G', cost: 350, hp: 140, speed: 1.8, range: 6, damage: 7,
    cooldown: 0.15, accuracy: 0.65, vision: 7, dtype: 'bullet', armor: 'infantry', move: 'foot',
    suppress: 1.5,
    role: 'MG. Suppresses: pinned soldiers slow down and miss.', strong: 'Infantry pushes', weak: 'Tanks, snipers',
  },
  sniper: {
    name: 'Sniper', short: 'S', cost: 400, hp: 70, speed: 2.2, range: 11, damage: 55,
    cooldown: 1.8, accuracy: 0.9, vision: 11, dtype: 'precision', armor: 'infantry', move: 'foot',
    role: 'Long sightlines, spots for the team.', strong: 'Gunners, exposed infantry', weak: 'Close quarters, tanks',
  },
  rocketeer: {
    name: 'Rocketeer', short: 'A', cost: 350, hp: 90, speed: 2.3, range: 6.5, damage: 150,
    cooldown: 2.5, accuracy: 0.8, accVs: { infantry: 0.6 }, vision: 6, dtype: 'rocket', armor: 'infantry', move: 'foot',
    role: 'Anti-tank. Outranges a tank’s vision.', strong: 'Tanks, turrets', weak: 'Infantry',
  },
  breacher: {
    name: 'Breacher', short: 'B', cost: 300, hp: 120, speed: 2.9, range: 2.5, damage: 22,
    cooldown: 0.5, accuracy: 0.9, vision: 6, dtype: 'demo', armor: 'infantry', move: 'foot',
    role: 'Shotgun + charges. Clears rooms, wrecks defenses and bases.', strong: 'Buildings, defenses, bases', weak: 'Open ground',
  },
  medic: {
    name: 'Medic', short: '+', cost: 250, hp: 90, speed: 2.7, range: 4, damage: 8,
    cooldown: 0.6, accuracy: 0.75, vision: 7, dtype: 'bullet', armor: 'infantry', move: 'foot',
    heal: 9,
    role: 'Heals nearby soldiers.', strong: 'Long fights', weak: 'Everything, alone',
  },
  tank: {
    name: 'Tank', short: 'T', cost: 900, hp: 600, speed: 1.7, range: 7, damage: 60,
    cooldown: 1.8, accuracy: 0.8, accVs: { infantry: 0.75 }, vision: 6, dtype: 'he', armor: 'armor', move: 'vehicle',
    splash: 0.9, maxPerTeam: 2,
    role: 'Armor. Needs roads and open ground; can’t enter buildings or forest.', strong: 'Infantry, buildings, defenses', weak: 'Rocketeers, mines',
  },
};

export interface DefenseStats {
  name: string;
  cost: number;
  hp: number;
  blocksFoot: boolean;
  blocksVehicle: boolean;
  blocksLos: boolean;
  range: number;
  damage: number;
  cooldown: number;
  accuracy: number;
  vision: number;
  dtype: DamageType;
  blurb: string;
}

export const DEFENSES: Record<DefenseType, DefenseStats> = {
  barricade: {
    name: 'Barricade', cost: 75, hp: 300, blocksFoot: true, blocksVehicle: true, blocksLos: true,
    range: 0, damage: 0, cooldown: 0, accuracy: 0, vision: 0, dtype: 'bullet',
    blurb: 'Blocks movement and sight.',
  },
  tanktrap: {
    name: 'Tank trap', cost: 100, hp: 400, blocksFoot: false, blocksVehicle: true, blocksLos: false,
    range: 0, damage: 0, cooldown: 0, accuracy: 0, vision: 0, dtype: 'bullet',
    blurb: 'Stops vehicles. Infantry walk through.',
  },
  turret: {
    name: 'Turret', cost: 300, hp: 220, blocksFoot: true, blocksVehicle: true, blocksLos: false,
    range: 6, damage: 10, cooldown: 0.35, accuracy: 0.75, vision: 6, dtype: 'bullet',
    blurb: 'Auto MG. Guards the base. Useless vs armor.',
  },
  mine: {
    name: 'Mine', cost: 100, hp: 1, blocksFoot: false, blocksVehicle: false, blocksLos: false,
    range: 0.7, damage: 110, cooldown: 0, accuracy: 1, vision: 0, dtype: 'blast',
    blurb: 'Hidden. Extra damage to vehicles.',
  },
};

export const RULES = {
  tickRate: 20,
  planSeconds: 60,
  roundSeconds: 120,
  roundsToWin: 5,
  maxRounds: 12,
  maxUnits: 6,
  maxDefenses: 8,
  startMoney: 1200,
  maxMoney: 9000,
  winReward: 1400,
  drawReward: 1100,
  lossReward: 1000,
  lossStreakBonus: 300,
  lossStreakCap: 3,
  killReward: 150,
  baseKillReward: 300,
  baseHp: 600,
  /** Base can only be damaged when no enemy unit/turret is within this radius of it. */
  baseDefendRadius: 4.5,
  coverReduction: 0.4,
  suppressedAccuracy: 0.7,
  suppressedSpeed: 0.5,
  mineBlastRadius: 1.6,
  /** Units in forest or buildings are only spotted this close, unless they fire. */
  concealRange: 4,
  /** Round ends in a draw if no unit can still advance and nothing has fired for this long. */
  stalemateSeconds: 6,
};
