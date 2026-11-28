# Fast Break (NBA Top Shot) — feature doc

Trevor, 2026-11-27: "How can we continue to build what we've started with Fastbreak for Top Shot?" → "Yes" (in-season QA) → "Yes do it all" / "Go. Connect to the repo".

## The rules, as Top Shot runs them in 2026-27 (researched 2026-11-28 from the help center's 4 Fast Break articles, the 10-19 announcement and the live nbatopshot.com/fastbreak page)

**Modes**
- **Classic** — any Moment in your collection counts.
- **Pro** — each run is themed to upcoming drops; nights are built around the next drop's sets, flagship Rare/Legendary sets (MGLE, Holo Icon incl. Top Shot 50, Cosmic, Holo MMXX), Top Shot Debut Moments and reward-badge Moments (Challenges, Leaderboards, Crafting). Pro targets run lower (11-28: 10 3PM + 20 3PA vs Classic's 32 assists). Pro run prizes (Nov 16–29): 1st an NBA Origins Case, 2–10 a Box each, 11–50 two Collector Packs each.
- **Historic** — free; simulated games between legends (career averages scaled to 36 min, all teams play nightly, games lock from 7 PM ET every 15 min to 10:45 PM ET). Highest FastBreak Points total wins the night. Five legends under a **350 Roster Points** budget; owning a legend's Moment cuts his rating 5 % (Common/Fandom), 10 % (Rare), 15 % (Legendary), 20 % (Ultimate); any Moment of the player counts. Top-100 daily prizes, top-240 run prizes, a pack for 5+ wins.

**A night (Classic / Pro)**
- Pick five players; each night names stat targets ("Combine for 32 Assists", "… 18 3PM + 40 3PA") the lineup's combined line must beat to WIN the night.
- One **Captain**, score × 1.5; changeable until lineup lock.
- One **bench** player subs in after the last game if a starter sits; a "Ruled Out" player can be swapped after his tip-off if he did not play. Injury tags appear only on game day.
- A player is locked once his game starts.

**Runs, leaderboards, prizes**
- A run is 11–13 game nights. **Run leaderboard = total nights won**; tiebreak = average daily-leaderboard finish across the run. **Daily leaderboard = total accumulated score for that night's stat(s)**; ties split the combined prizes for the places covered (serial tiebreakers are NOT used for prizes).
- Classic run prizes (Nov 16–29): 1st $500 … 51–100th $10 credit; daily 1st $100 … 11–25th $5; milestones 7 wins $5, 12 wins $50 credit. **Top 50 of any Classic or Pro run → Fast Break Finals** (invite-only, Mar 30 – Apr 11, 2027); Classic Final top 10 win an NBA Finals suite seat; the Pro Final plays for cash. An open Classic run continues alongside the Finals.
- The Rewards article still describes a lowest-serial-sum tiebreaker for the Daily Leader reward and milestone packs; the main article (newer) says serial tiebreakers are not used for prizes.

**Uses per run ("fatigue") — VERIFIED 116/116 against one wallet's live "N of M plays left" cards, 11-28**
- Per Moment: max(price band of Top Shot's **own average sale price** — none/$0 → unlimited "Hall of Fame", $0.01–10 → 1 "Draft Pick", $10.01–50 → 2 "Starter", $50.01–300 → 3 "All-Star", $300.01–1,000 → 4 "MVP", $1,000.01+ → unlimited; tier floor — Common/Fandom 1, Rare 2, **Legendary 4**, Ultimate unlimited).
- Per player: the Moment with the most uses ("Fast Break will prioritize the Moment that has the most usages").
- RPC reads the ASP from `badge_editions.avg_sale_price` (`get_fb_eligible_players_v3`). Models that did NOT match: RPC FMV 106/115, ASP without tier floors 60/116, Legendary unlimited 91/116.
- Last spring's playoff format ("score the most points", 2–3 players + Captain) is the `max_points` objective and keeps `/api/fast-break/optimize` + `FastBreakClient`.

## Data (all live 2026-11-27)

| object | what |
|---|---|
| `fast_break_runs` | one row per run. `objective = 'thresholds'` for regular-season runs. **No writer — runs are added by hand.** |
| `fast_break_nights` | each night's targets for a run (`targets` jsonb, keys = `nba_player_game_stats` columns). **Recorded by hand** from the Fast Break page; Atlas `GameEngineService/GetContest` needs a user JWT. Contest id pattern: `contest-run-nba-classic-YYYY-MM-DD-YYYY-MM-DD`. |
| `nba_player_game_stats` | ESPN box scores, one row per player per final game; `fp_dk` generated. Written by the `nba-espn-projections` lane (kind `boxscore`, last 3 days, ≤ 12 games a tick). Season backfilled 11-27 (288 games; 3 May playoff games 404 at ESPN). |
| `nba_player_projections` | now also `proj_three_attempts`, `proj_fgm/fga/ftm/fta`. Every stat = (3 × ESPN season number + n × season-to-date actual) / (3 + n); method gets `+form-k3`. Players ESPN does not project fall back to their actual season averages (`espn-season-actual-v1`). |
| `get_fb_eligible_players_v3(wallet, run, user)` | per player: best Moment, Top Shot ASP, uses (NULL = unlimited), THIS user's times used, remaining. v2 (FMV-priced, run-wide uses) is superseded. |

## Why the blend (walk-forward backtest, 11-01..11-26, 3,221 player-games, each game predicted only from games before it)

ESPN's "season projection" never moved (all 277 players checked were identical every night of a week). DK-FP MAE: ESPN 8.78 · season-to-date average 7.72 · blend k=3 7.72. Stars (ESPN ≥ 30 FP): 9.44 → 8.68. Nightly top-10 overlap with the actual top 10: 5.12 → 5.48.

## Optimizer — `lib/fast-break/threshold-optimizer.ts`

Maximises P(every target cleared). Each stat total ~ Normal(Σ projected, k_stat × Σ projected × 1.3), k from this season's box scores (pts 3.02, reb 1.39, ast 1.22, stl 1.09, blk 1.08, 3PM 1.15, 3PA 1.06, FGM 1.20, FGA 1.33); the Captain's contribution counts 1.5×; targets multiplied as independent. Pool = top 20 by coverage, all 5-combinations × each Captain. Within 1 point of the best odds it prefers the lineup that spends the fewest scarce plays (unlimited Moments are free).

Backtest on the 10 completed nights of the Nov 16–29 run, whole slate, no ownership limit: **9 of 10 nights won**, stated odds averaged 0.89 vs 0.90 realised (calibrated). The real constraint is the collector's own Moments and uses.

## Surfaces

- `/nba-top-shot/fast-break` (un-parked 11-27) → `ThresholdLineupClient` when the active run's objective is `thresholds`. **Classic / Pro tabs** (`?mode=pro`, 11-28) — each mode has its own active run (`fast_break_runs.mode`, `fetchActiveRun(db, mode)`).
- `POST /api/fast-break/tonight` → targets, lineup + Captain + bench, odds per target, the whole-slate best and who the wallet lacks. When synced Top Shot cards exist for (user, run, night) their plays left override RPC's count. **Pro night:** picks only from the synced card list (Pro restricts Moments; RPC cannot derive which); no synced list → `pro_eligibility_unknown`, never "no eligible players"; the whole-slate comparison is omitted (it would ignore the restriction).
- `POST /api/fast-break/lineup` → saving counts plays against `get_fb_eligible_players_v3` uses (this user only) on a `thresholds` run (unlimited stored as 99).

## Sync from Top Shot (11-28) — the run/night/plays-left writer

- **Reader:** `TOPSHOT_READER_SOURCE` in `lib/fast-break/topshot-sync.ts` (one copy; offered as a bookmarklet by `TopShotSyncCard`). Runs on the collector's own signed-in `nbatopshot.com/fastbreak?mode=classic|pro`: clicks each date chip to read its objective and contest id, reads every player card's `title` ("N of M plays left" / "Unlimited plays"), then sends the tab to `rippackscity.com/nba-top-shot/fast-break?mode=…#topshot-sync=<payload>`. The payload rides in the URL **fragment** — never sent to a server by the browser.
- **Receiver:** `TopShotSyncReceiver` (page) POSTs it to `POST /api/fast-break/topshot-sync` (session user + pinned wallet, never the body's) → `fast_break_ingest_topshot(jsonb)`: run keyed by the contest-id prefix (`contest-run-nba-<mode>-<runStart>`; the suffix is the NIGHT date), end = last night, one active run per mode, nights + `fast_break_parse_targets()` targets, `fast_break_topshot_cards`, and `fast_break_player_uses` synced to Top Shot's count.
- **Schedule:** a twice-daily scheduled task in Trevor's Chrome runs the reader on Classic then Pro (see the ledger entry of 11-28 for its name). Other collectors run the bookmarklet themselves.
- An unmapped objective clause parses to `{}` → the night reads `targets_unknown`, never a guessed target. Add the phrase to `fast_break_parse_targets`.

## Track record (11-28) — is the model right?

- `/api/cron/fast-break-predictions` (vercel.json, hourly at :41) writes `fast_break_predictions` for each active `thresholds` run: the best 5 + Captain + bench from the WHOLE slate (no ownership) and the chance it gave of clearing every target. Re-written each hour until the night's first tipoff, never after — the projection blend folds finished games into the season line, so a later write would know the answer. No known tipoff → written once.
- The same route scores past nights from `nba_player_game_stats` (`lib/fast-break/track-record.ts`): Captain 1.5×, the bench replaces the first starter who sat (at 1× — Top Shot does not say a sub inherits the Captain bonus), a pick with no row in a final, box-scored game did not play. `cleared` stays NULL until every pick's game is final **and** has box rows.
- Shown on the page as "This run, the best lineup RPC picked from the whole slate cleared X of Y nights; it had given those nights a Z% chance on average" — the gap between the two numbers is the calibration read. Telemetry: `pipeline_runs` 'fast-break-predictions' (`extra.scored / predicted / locked / still_pending`).

## Owed / next

1. Captain-variance and correlated targets (3PM with 3PA) are modelled simply; revisit with a season of saved lineups.
2. Historic mode (350 roster points, ownership discounts) is not modelled.
3. Hardcourt.io support and an X "tonight's targets" post are open ideas (areas/hardcourt-io-support).
