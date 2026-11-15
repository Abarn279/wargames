export type Team = 0 | 1; // 0 = blue (player, west), 1 = red (opponent, east)
export const other = (t: Team): Team => (t === 0 ? 1 : 0);

export type UnitType = 'rifleman' | 'gunner' | 'sniper' | 'breacher';
export type DefenseType = 'barricade' | 'turret' | 'mine';

export interface UnitStats {
  name: string;
  short: string;
  cost: number;
  hp: number;
  speed: number; // tiles / second
  range: number; // tiles
  damage: number; // per hit
  cooldown: number; // seconds between shots
  accuracy: number; // base hit chance at point blank
  vision: number; // tiles
  structureMult: number; // damage multiplier vs defenses and base
  blurb: string;
}

export const UNITS: Record<UnitType, UnitStats> = {
  rifleman: {
    name: 'Rifleman', short: 'R', cost: 200, hp: 100, speed: 2.6, range: 5, damage: 12,
    cooldown: 0.5, accuracy: 0.85, vision: 7, structureMult: 1,
    blurb: 'Cheap all-rounder.',
  },
  gunner: {
    name: 'Gunner', short: 'G', cost: 350, hp: 150, speed: 1.8, range: 5.5, damage: 7,
    cooldown: 0.16, accuracy: 0.7, vision: 7, structureMult: 1,
    blurb: 'Slow, tanky, shreds at mid range.',
  },
  sniper: {
    name: 'Sniper', short: 'S', cost: 400, hp: 70, speed: 2.2, range: 10, damage: 48,
    cooldown: 1.7, accuracy: 0.9, vision: 10, structureMult: 0.5,
    blurb: 'Long sightlines. Fragile up close.',
  },
  breacher: {
    name: 'Breacher', short: 'B', cost: 300, hp: 120, speed: 2.9, range: 2.5, damage: 20,
    cooldown: 0.5, accuracy: 0.9, vision: 6, structureMult: 4,
    blurb: 'Fast. Wrecks barricades, turrets and bases.',
  },
};

export interface DefenseStats {
  name: string;
  cost: number;
  hp: number;
  blocksMove: boolean;
  blocksLos: boolean;
  range: number;
  damage: number;
  cooldown: number;
  accuracy: number;
  vision: number;
  blurb: string;
}

export const DEFENSES: Record<DefenseType, DefenseStats> = {
  barricade: {
    name: 'Barricade', cost: 75, hp: 300, blocksMove: true, blocksLos: true,
    range: 0, damage: 0, cooldown: 0, accuracy: 0, vision: 0,
    blurb: 'Blocks movement and sight.',
  },
  turret: {
    name: 'Turret', cost: 300, hp: 180, blocksMove: true, blocksLos: false,
    range: 6, damage: 10, cooldown: 0.35, accuracy: 0.75, vision: 6,
    blurb: 'Auto-fires. Counts as a base defender.',
  },
  mine: {
    name: 'Mine', cost: 100, hp: 1, blocksMove: false, blocksLos: false,
    range: 0.7, damage: 110, cooldown: 0, accuracy: 1, vision: 0,
    blurb: 'Hidden. Blasts enemies that step close.',
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
  startMoney: 1000,
  maxMoney: 9000,
  winReward: 1400,
  drawReward: 1100,
  lossReward: 900,
  lossStreakBonus: 300,
  lossStreakCap: 3,
  killReward: 150,
  baseKillReward: 300,
  baseHp: 600,
  /** Base can only be damaged when no enemy unit/turret is within this radius of it. */
  baseDefendRadius: 4.5,
  coverReduction: 0.4,
  mineBlastRadius: 1.6,
  /** Round ends in a draw if no unit can still advance and nothing has fired for this long. */
  stalemateSeconds: 6,
};
