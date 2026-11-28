# nba-espn-projections: box-score fetch fails the whole run on a single ESPN gamesummary 404

**Source:** pipeline `nba-espn-projections`, run 2026-11-27 21:06:35 PT (`ok=false`, error `espn boxscore 404 (): {"code":404,"message":"Error invoking GET: http://site.api.internal.espn.com/apis/site/v2/sports/basketball/nba/gamesummary/<gameId>...`). Also surfaced as the `pg_net_http_404` HIGH arm of `rpc_ops_snapshot()` (3 pg_net 404s in 2h, ESPN nba summary/gamesummary endpoint). The ESPN box-score storage is new tonight (ledger 2026-11-27 ~9:45 PM PT — Fast Break launch; commit d409b1b1, migrations `20261128050200`+; `nba_player_game_stats`).

**Observed:** 1 of 24 `nba-espn-projections` runs in the last 14h failed; every run before and after is `ok=true`, and the lane self-recovered on its next tick. The failing run threw on a single ESPN `gamesummary/<gameId>` returning HTTP 404 and the entire run went `ok=false`. No stalled pipeline, no trust-health regression, no `fast_break`/projection writer breakage — nothing was lost.

**Risk read:** LOW. ESPN returns 404 for some gamesummary ids (a game not yet final, a placeholder/non-NBA id, or a transient). The concern is robustness of the brand-new box-score drain, not an outage: one 404'd game aborts the whole projection run rather than being skipped. If ESPN 404s recur during a nightly stat-target window, that night's projections could be skipped entirely instead of merely degraded. Read-only pass — the route/drain code was not inspected (off-limits here).

**Suggested action (night pass):** in the box-score fetch step of `nba-espn-projections`, catch a per-game ESPN gamesummary HTTP 404 (and likely other 4xx), record/skip that one game, and let the run finish `ok=true` over the games that did resolve — mirroring the per-item skip pattern used elsewhere (panini-collector-walk per-walk cap; the Atlas drains' per-page retry). Confirm the drain already distinguishes "game not found / not yet final" from a real upstream outage before relaxing the run's ok semantics.

---

**Disposition (Claude Code cloud, 11-28 ~8:05 AM PT): FIXED — `20261128154406`.** The three 404s were May playoff games (401871334, 401871337, 401873343) marked `final` with no scores — never-played "if necessary" games, so ESPN's 404 was correct. `nba_espn_drain()` now records a box-score 404 as `not_found` (`boxscore_not_found` stat) instead of a run error; every other failure still fails the run, and ≥ 3 box-score 404s with no box score landed still fails (`every_boxscore_404`). Ledger 2026-11-28 8:05 AM PT.
