# Wargames

Round-based tactical wargame: **buy like Counter-Strike, plan like classic Rainbow Six, then manage it live.**

Each round:

1. **Plan (60s).** Spend money on units and defenses. Tap a unit, then tap the map to lay waypoints. Tap a waypoint again to make it a **breakpoint**: the unit stops there and waits for you.
2. **Execute (live).** Both plans run at the same time. When a unit reaches a breakpoint its card flashes. Tap it (or **GO ALL**) to send it on.
3. **Audible.** **⟲ RECALL** sends a unit back to its spawn. It stays home for the rest of the round and still defends. If everyone on both sides ends up home, the round is a draw.

**Win a round** by eliminating the enemy team, or by destroying their base. The base can only be damaged when no enemy unit or turret is inside its guard ring.

**Economy.** Win/draw/loss income, a loss-streak bonus, kill rewards, and a base-kill bonus. Unspent money rolls over, and surviving units carry into the next round. First to 5 rounds wins.

## Units & defenses

| | Cost | Role |
|---|---|---|
| Rifleman | $200 | Cheap all-rounder |
| Gunner | $350 | Slow, tanky, high DPS at mid range |
| Sniper | $400 | 10-tile range, fragile |
| Breacher | $300 | Fast, 4× damage vs barricades, turrets and bases |
| Barricade | $75 | Blocks movement and sight |
| Turret | $300 | Auto-fires; counts as a base guard |
| Mine | $100 | Hidden to the enemy; area blast |

Cover: units take 40% less damage when a wall/crate sits between them and the shooter. Fog of war: you only see enemies your units, turrets or base can see.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173 (exposed on LAN so you can open it on your phone)
npm test         # simulation tests, incl. 20 AI-vs-AI matches
npm run build
```

## Architecture

```
src/sim/   deterministic game logic, no DOM
  config.ts   unit/defense stats and economy rules (tuning lives here)
  map.ts      tile map (authored as the west half, mirrored for fairness)
  path.ts     A* + plan expansion (waypoints -> tile path with breakpoints)
  los.ts      line of sight and cover
  sim.ts      fixed-tick (20 Hz) round simulation: input = two plans + live commands
  match.ts    score, money, loss streaks, carried-over units
  ai.ts       AI opponent: purchasing, routes, breakpoint timing, emergency recalls
src/ui/    canvas renderer + touch input (phone landscape, tablet, desktop)
```

The simulation is seeded and deterministic. A round is fully described by `(seed, both plans, timestamped GO/RECALL commands)`, which is exactly what lockstep online multiplayer needs: players exchange plans at the end of the planning phase, then only exchange commands.

## Mobile

Touch-first with no hover or right-click, landscape layout, safe-area aware. To ship to the stores, wrap the build with [Capacitor](https://capacitorjs.com/) (`npx cap add ios` / `android`). Nothing in the code is web-only.
