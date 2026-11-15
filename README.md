# Wargames

Single-player, round-based tactical wargame (skirmish vs an AI opponent): **buy like Counter-Strike, plan like classic Rainbow Six, then manage it live.**

Each round:

1. **Plan (untimed; hit READY when you're set).** Spend money on units and defenses. Tap a unit, then tap the map to lay waypoints; each waypoint shows when the unit gets there. Tap a waypoint to tag it with a **go code**: ALPHA → BRAVO → CHARLIE → off. A tagged waypoint is a breakpoint, and the unit holds there.
2. **Execute (live).** Your plan and the AI's run at the same time. Call **A / B / C** to release everyone holding on that code at once. That's how you sync a tank push over the bridge with infantry wading the ford. Tap a single unit's card to release just that unit. A code called early stays open, so units arriving later walk straight through.
3. **Audible.** **⟲ RECALL** sends a unit back to its spawn. It stays home for the rest of the round and still defends.

## Objectives: why you move

Each map has **objectives that go live on a published schedule**. The strip along the top of the map shows the schedule. On Riverside:

| Objective | Live |
|---|---|
| North bridge | 0:15 – 0:45 |
| South bridge | 0:45 – 1:15 |
| Ford | 1:15 – 1:55 |

Every second a team holds a live objective **uncontested** (its units inside the ring, no enemy units) is a point. **When time runs out, most points wins the round.** Eliminating the enemy or destroying an unguarded base still wins outright. If nothing can move or shoot any more, the round ends early and every unfinished window goes to whoever is sitting on it.

A plan is therefore a timeline: take the first bridge, rotate on ALPHA when it closes, stage for the ford on BRAVO. Both sides know where the other has to be and when, and that's where ambushes come from. The two bridges mirror each other, and each side has a building overlooking one of them.

## Movement and overwatch: how you move

- **Moving is exposed.** A unit that moved in the last 0.6s gets no cover or building protection and shoots at 75% accuracy.
- **Overwatch.** A unit that has been still for 1s and quiet for 3s is on overwatch (white sight arc). When it opens fire, its first 1.5s are aimed fire: much more accurate, no range falloff, and +50% damage. Walking into a settled unit is how you lose a fight.
- **Covering fire.** Units prioritize any enemy that just shot at a teammate. So a unit set up on overwatch protects a moving one: the ambusher gives itself away by firing and eats the aimed burst.
- **Suppression** (gunner fire) knocks units off overwatch and cancels their aimed fire.

Measured in `tests/tactics.test.ts`:

| Scenario | Win rate |
|---|---|
| Settled rifleman vs one walking into it | 87% (60% without these rules) |
| Rifleman walking past a hidden ambusher, alone | 10% |
| Same, with a sniper covering from overwatch | 97% |
| One settled rifleman vs two walking in | under 60% (numbers still matter) |

**Economy.** Win/draw/loss income, a loss-streak bonus, kill rewards, and a base-kill bonus. Unspent money rolls over, and surviving units carry into the next round. First to 5 rounds wins.

## Rock, paper, scissors

Damage depends on **damage type vs. armor class** (`DAMAGE` in `src/sim/config.ts`):

| | vs infantry | vs armor | vs structures |
|---|---|---|---|
| Bullets (rifle, MG, turret) | 1.0 | 0.08 | 0.25 |
| Precision (sniper) | 1.0 | 0.15 | 0.2 |
| Rockets | 0.3 (and 0.6× accuracy) | 1.0 | 1.2 |
| HE (tank shell, splashes) | 0.8 (and 0.75× accuracy) | 0.45 | 1.5 |
| Demo (breacher) | 1.0 | 0.5 | 4.0 |

**Tank > infantry > rocketeer > tank.** Open-field results (`npm test` prints the full table):

| Matchup | Left side wins |
|---|---|
| Tank ($900) vs 4 Riflemen ($800) | 100% |
| 2 Rocketeers ($700) vs Tank ($900) | 40% |
| 3 Rocketeers ($1050) vs Tank ($900) | 90% |
| 3 Riflemen ($600) vs 2 Rocketeers ($700) | 100% |
| Tank + 2 Riflemen ($1300) vs 4 Rocketeers ($1400) | 95% |

So tanks are strong for their price and have a clear counter, and combined arms beats a one-trick counter.

| Unit | Cost | Role |
|---|---|---|
| Rifleman | $200 | Cheap line infantry. Kills rocketeers. |
| Gunner | $350 | MG. Hits **suppress** infantry (slower, worse aim). |
| Sniper | $400 | 11-tile range, wide vision. Spots for the whole team. |
| Rocketeer | $350 | Anti-tank. Bad against soldiers. |
| Breacher | $300 | Shotgun + charges. Clears rooms, wrecks defenses and bases. |
| Medic | $250 | Heals nearby soldiers. |
| Tank | $900 | 600 HP, splash shells. Roads and open ground only. Max 2. |
| Barricade | $75 | Blocks movement and sight. |
| Tank trap | $100 | Stops vehicles; infantry walk through. |
| Turret | $300 | Auto MG, base guard. Useless against armor. |
| Mine | $100 | Hidden. 1.5× damage to vehicles. |

## Terrain

- **Buildings.** Garrisoned soldiers take half damage from bullets and three-quarters from rockets. Tank shells and breachers hit them at full strength. **Windows** let you shoot out, but outsiders can't see deep inside. Vehicles can't enter.
- **Forest.** Slows infantry, blocks vehicles, and two tiles of trees block sight.
- **Concealment.** Units in forest or buildings are only spotted within 4 tiles, unless they fire.
- **Roads** speed vehicles up. **Fords** let infantry cross the river slowly; tanks need the bridges.
- **Sandbags and crates** give cover (40% less small-arms damage).
- **Shared spotting.** Anything one of your units sees, all of them can shoot. A tank's vision (6) is shorter than its gun's range (7), so it needs spotters.

**Maps:** *Riverside* (two bridges, a ford, two buildings per side) and *Crossroads* (compact, open, three lanes).

## Run it

```bash
npm install
npm run dev      # http://localhost:5173 (exposed on LAN so you can open it on your phone)
npm test         # simulation tests: maps, matchups, go codes, AI-vs-AI matches, balance table
npm run build
```

## Architecture

```
src/sim/   deterministic game logic, no DOM
  config.ts   unit/defense stats and economy rules (tuning lives here)
  map.ts      maps (authored as the west half, mirrored for fairness) + terrain rules
  path.ts     A* + plan expansion (waypoints -> tile path with breakpoints)
  los.ts      line of sight and cover
  sim.ts      fixed-tick (20 Hz) round simulation: input = two plans + live commands
  match.ts    score, money, loss streaks, carried-over units
  ai.ts       AI opponent: counter-buys, routes, garrisons, go-code timing, emergency recalls
src/ui/    canvas renderer + touch input (phone landscape, tablet, desktop)
```

The simulation is seeded and deterministic. A round is fully described by `(seed, both plans, timestamped GO / RECALL / go-code commands)`, which is exactly what lockstep online multiplayer needs: players exchange plans at the end of the planning phase, then only exchange commands.

## Mobile

Touch-first with no hover or right-click, landscape layout, safe-area aware. To ship to the stores, wrap the build with [Capacitor](https://capacitorjs.com/) (`npx cap add ios` / `android`). Nothing in the code is web-only.
