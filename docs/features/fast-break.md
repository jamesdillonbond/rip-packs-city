# Fast Break (NBA Top Shot) — feature doc

Trevor, 2026-11-27: "How can we continue to build what we've started with Fastbreak for Top Shot?" → "Yes" (in-season QA) → "Yes do it all" / "Go. Connect to the repo".

## The game, as Top Shot runs it in 2026-27 (verified 11-27 on nbatopshot.com/fastbreak)

- **Classic and Pro runs** of 11–13 game nights; the collector who wins the most nights takes the run. Top 50 of any run qualifies for the invite-only Fast Break Finals (Mar 30 – Apr 11, 2027).
- **A night = combined stat targets** for five players, e.g. "Combine for 18 3-Pointers Made + 40 3-Pointers Attempted". The stat changes nightly (points, rebounds, assists, steals, blocks, 3PM/3PA, FGM/FGA). One bench player subs in if a starter sits. One optional **Captain counts 1.5×** (help center).
- **Uses per Moment per run** = the higher of its average-sale-price band and its tier:
  - price bands (help center, 2025-26 fatigue table): $0.01–10 → 1 · $10.01–50 → 2 · $50.01–300 → 3 · $300.01–1,000 → 4 · $1,000.01+ → unlimited
  - tier floors: Rare 2 and Ultimate every night are stated by Top Shot; **Legendary 4 is the prior tier rule, assumed** until Top Shot states it; Common/Fandom 1.
  - RPC uses `wallet_moments_cache.fmv_usd` as the average-sale-price proxy and a player's **best single Moment** (we do not assume uses add across Moments of one player).
- Last spring's playoff format ("score the most points", 2–3 players + Captain) is the `max_points` objective and keeps `/api/fast-break/optimize` + `FastBreakClient`.

## Data (all live 2026-11-27)

| object | what |
|---|---|
| `fast_break_runs` | one row per run. `objective = 'thresholds'` for regular-season runs. **No writer — runs are added by hand.** |
| `fast_break_nights` | each night's targets for a run (`targets` jsonb, keys = `nba_player_game_stats` columns). **Recorded by hand** from the Fast Break page; Atlas `GameEngineService/GetContest` needs a user JWT. Contest id pattern: `contest-run-nba-classic-YYYY-MM-DD-YYYY-MM-DD`. |
| `nba_player_game_stats` | ESPN box scores, one row per player per final game; `fp_dk` generated. Written by the `nba-espn-projections` lane (kind `boxscore`, last 3 days, ≤ 12 games a tick). Season backfilled 11-27 (288 games; 3 May playoff games 404 at ESPN). |
| `nba_player_projections` | now also `proj_three_attempts`, `proj_fgm/fga/ftm/fta`. Every stat = (3 × ESPN season number + n × season-to-date actual) / (3 + n); method gets `+form-k3`. Players ESPN does not project fall back to their actual season averages (`espn-season-actual-v1`). |
| `get_fb_eligible_players_v2(wallet, run)` | per player: best Moment, uses (NULL = unlimited), times used, remaining. |

## Why the blend (walk-forward backtest, 11-01..11-26, 3,221 player-games, each game predicted only from games before it)

ESPN's "season projection" never moved (all 277 players checked were identical every night of a week). DK-FP MAE: ESPN 8.78 · season-to-date average 7.72 · blend k=3 7.72. Stars (ESPN ≥ 30 FP): 9.44 → 8.68. Nightly top-10 overlap with the actual top 10: 5.12 → 5.48.

## Optimizer — `lib/fast-break/threshold-optimizer.ts`

Maximises P(every target cleared). Each stat total ~ Normal(Σ projected, k_stat × Σ projected × 1.3), k from this season's box scores (pts 3.02, reb 1.39, ast 1.22, stl 1.09, blk 1.08, 3PM 1.15, 3PA 1.06, FGM 1.20, FGA 1.33); the Captain's contribution counts 1.5×; targets multiplied as independent. Pool = top 20 by coverage, all 5-combinations × each Captain. Within 1 point of the best odds it prefers the lineup that spends the fewest scarce plays (unlimited Moments are free).

Backtest on the 10 completed nights of the Nov 16–29 run, whole slate, no ownership limit: **9 of 10 nights won**, stated odds averaged 0.89 vs 0.90 realised (calibrated). The real constraint is the collector's own Moments and uses.

## Surfaces

- `/nba-top-shot/fast-break` (un-parked 11-27) → `ThresholdLineupClient` when the active run's objective is `thresholds`.
- `POST /api/fast-break/tonight` → targets, lineup + Captain + bench, odds per target, the whole-slate best and who the wallet lacks.
- `POST /api/fast-break/lineup` → saving counts plays against `get_fb_eligible_players_v2` uses on a `thresholds` run (unlimited stored as 99).

## Owed / next

1. **Each new run and its nights must be recorded by hand** until a writer exists (contest id is in the page URL). Next run starts ~11-30.
2. Legendary tier floor (4) is an assumption — confirm from Top Shot.
3. Captain-variance and correlated targets (3PM with 3PA) are modelled simply; revisit with a season of saved lineups.
4. Hardcourt.io support and an X "tonight's targets" post are open ideas (areas/hardcourt-io-support).
