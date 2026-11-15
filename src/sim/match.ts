import { RULES, UNITS, DEFENSES, type Team, type UnitType, type DefenseType } from './config';
import type { RoundResult, UnitPlan } from './sim';

export interface TeamEcon {
  money: number;
  score: number;
  lossStreak: number;
  /** Units that survived last round and carry into the next one (healed). */
  roster: UnitPlan[];
}

export interface RoundSummary {
  round: number;
  result: RoundResult;
  earned: [number, number];
}

/** Match-level state: score, money, loss streaks, carried-over units. Pure data, no rendering. */
export class Match {
  round = 1;
  teams: [TeamEcon, TeamEcon] = [Match.freshEcon(), Match.freshEcon()];
  static freshEcon(): TeamEcon {
    return { money: RULES.startMoney, score: 0, lossStreak: 0, roster: [] };
  }
  history: RoundSummary[] = [];
  /** undefined while in progress; Team for a winner; null for a drawn match. */
  winner: Team | null | undefined = undefined;
  private idCounter: [number, number] = [0, 0];

  newUnitId(team: Team) {
    return `${team}-u${++this.idCounter[team]}`;
  }

  static unitCost(t: UnitType) { return UNITS[t].cost; }
  static defenseCost(t: DefenseType) { return DEFENSES[t].cost; }

  finishRound(r: RoundResult): RoundSummary {
    const earned: [number, number] = [0, 0];
    for (const t of [0, 1] as Team[]) {
      const e = this.teams[t];
      let gain = r.kills[t] * RULES.killReward;
      if (r.winner === t) {
        gain += RULES.winReward;
        e.score++;
        e.lossStreak = 0;
      } else if (r.winner === null) {
        gain += RULES.drawReward;
      } else {
        gain += RULES.lossReward + RULES.lossStreakBonus * Math.min(e.lossStreak, RULES.lossStreakCap);
        e.lossStreak++;
      }
      if (r.baseDestroyed !== null && r.baseDestroyed !== t) gain += RULES.baseKillReward;
      e.money = Math.min(RULES.maxMoney, e.money + gain);
      e.roster = r.survivors[t];
      earned[t] = gain;
    }
    const summary = { round: this.round, result: r, earned };
    this.history.push(summary);
    const [s0, s1] = [this.teams[0].score, this.teams[1].score];
    if (s0 >= RULES.roundsToWin || s1 >= RULES.roundsToWin) this.winner = s0 > s1 ? 0 : 1;
    else if (this.round >= RULES.maxRounds) this.winner = s0 === s1 ? null : s0 > s1 ? 0 : 1;
    this.round++;
    return summary;
  }
}
