# Overnight pass — 2026-10-25 (~1:03–1:30 AM PT)

> ⚠ **Oldest routed item (30 nights): #58 OPENSEA_API_KEY — Trevor-only secret, no sandbox lever.** See `## Queued for Trevor / Claude Code`.

> ⚠ **Scope of the push route:** this pass pushed normally via the laptop-VM clone + the mount `.rpc-git-cred` store (cloud had no `add_repo`/attached repo). This is a fact about *this cloud session*, not the artifacts. Trevor's machine and Claude Code push normally via Git Credential Manager — **commit these files as usual.**

**Posture:** GREEN · 0 production shipped · 0 reverted · queue-only. Push GREEN (laptop-VM route). Real time established from the DB (`now()` 08:03Z agreed with shell to the second — no clock skew), = ~1:03 AM PT, inside the overnight window.

## TL;DR
A quiet, healthy night. Health is GREEN across security, structure, pipelines and the accuracy gate. The one carried post-ship watch — **panini-1.4.0** — is now fully verified and CLOSED: its FMV distribution was already confirmed real by the 10-25 03:05Z monitor, and this pass confirmed the **price accuracy** too (published HIGH FMV sits on the real 30-day sales median, ratio 1.008). One **new** signal surfaced — a single-minute 06:32Z timeout burst on `get_panini_franchise_panel` across ~30 NBA franchise hubs — but it is bounded/degraded (not a crash or false-empty), not recurring, and is route/RPC perf work on a hot Panini surface → queued, not shipped. The whole app/api + concierge + Panini surface is hot (concierge commits landed 00:04–01:00 AM PT tonight; Panini franchise/Holders work within 24–48h), so nothing clean-safe + non-hot + independently verifiable was open to ship.

## Gates & context
- **Clones:** cloud `$HOME/rpcwork` (reads/build) + laptop-VM `$HOME/rpcwork` (push). Both at `898964114` at clone time.
- **Lock:** prior `.lock` was `RELEASED 2026-10-24T17:48Z` (context-hygiene normal exit) → taken over, now `HELD 2026-10-25T08:03:52Z run=nightly-28101`. Released at end of run.
- **FREEZE:** none.
- **Time / quiet-hours:** DB `now()` 08:03:06Z vs shell `date -u` 08:03:04Z → **no skew**; max sale ingest 07:54Z / max FMV compute 07:56Z corroborate. Real local = ~1:03 AM PT → genuine overnight → normal shipping permitted.
- **Push capability:** `git push --dry-run` via `.rpc-git-cred` → `Everything up-to-date` (auth GREEN). No `add_repo` tool this run; cloud repo not attached.
- **Concurrency:** a concierge pass pushed `f4b75050…898964114` between 00:04 and 01:00 AM PT (ledger tip 2026-10-25). origin/main did **not** advance during this run (held at `898964114` across two fetches). Those files are route-logic (concierge) = off-limits + hot regardless.

## Reviewed
- CLAUDE.md in full; ledger top matter; `metrics-latest.json`; focus.md (steers current through 10-24); inbox via newest filings + INDEX; last overnight handoff (2026-10-24).
- `npm run ops:ready-queue`: 3 items from the 10-24 handoff, 1 still open (#58). The other two are ✓-closed (scratch functions dropped 10-24; demand-read + zero-yield closed by the 10-23 CC session) — confirmed against ledger lines before dropping.
- **Stranded-output sweep:** CLEAN. `docs/overnight/ledger.md` and `docs/overnight/flow-ecosystem-watch.md` mount hashes == origin blob hashes exactly; both newest mount inbox files (10-24T1807Z, 10-25T0305Z) are in origin; no `docs/health/` or `docs/handoff-*` file on the mount newer than origin. Nothing to carry over.

## Health-drift triage (Section 2) — GREEN
- **Security:** invariants [], anon_write_holes [], rls_off_base_tables [], secdef_anon_violations [] (via `rpc_ops_snapshot.security`).
- **Structure:** stalled_pipelines [], backward_cursor_rewinds [], wmc_null_edition_key [], function/procedure search_path drift [], cross_collection_mat_staleness [], suppression_*_drift [].
- **Trust health:** 1 breach = `candy_sales_stale_hours` 316.7h (breach 168) = known **#58** (Trevor-only frozen Candy book; 311.8→316.7h since the 03:05Z monitor = still frozen, 0 new sales). NOT re-raised. `trust_precompute_max_age_hours` 5.29 (breach 13) → the trust reads are fresh/reliable. `edition_integrity_flags` 22 (breach 250), `unmapped_resolution_backlog_max` 18 (breach 100), `fmv_stale_touch_hours` 0.3, `fmv_sweep_wedge_hours` 0.16 — all ok.
- **Pipeline alerts:** 1 critical + 4 info, all known/benign. Critical `pg_net_http_403` = the unattributable-endpoint Cloudflare-challenge arm (2 calls/2h; "usually settles / self-inflicted"). Atlas editions/market/pack-supply 403s + flow-rest 400 = attributed Cloudflare challenges / designed "moment moved" outcomes; all fresh (last 200/drain 08:03–08:05Z, newest events 08:01Z), none escalated (0 sets overdue, no freshness gap).
- **pipeline_fails_24h:** topshot-pack-supply-atlas 170 (designed 403 re-ask, lane fresh), atlas-market-feed 10, member-wallet-usernames-atlas 1, golazos-listing-cache 1 — all upstream:0, none stalled.
- **Sentry:** dark (SDK removed #34) — not used as a health signal.
- **Client-error beacon:** `usage_events` feature_name='client_error' = 0 in 6h, 0 in 24h (newest 2026-10-23 05:04Z).
- **Vercel 24h:** 33 error groups. All chronic/bounded EXCEPT one new cluster (below). Known: ipfs-media "another gateway answered first" (gateway race, design), insights market-pulse/market-cap 8000ms (known slow boards, bounded degrade), player-top-sales statement timeout → degrades to empty, pack_contents 5000ms, panini market-cap-tile edition 8000ms. No new error CLASS beyond the franchise-panel burst. Prod serves `dpl_DB2N67RafA8zjUk2jtw5RLfRXBN9`.
- **Accuracy gate (once-a-pass):**
  - NBA `fmv_sales_backtest('nba_top_shot',7)`: published ALL ratio **0.960**, median_abs_err 16.7%, within_25 64.9%; HIGH ratio 0.974, err 11.1%, within_25 80.5%.
  - AllDay `('nfl_all_day',7)`: published ALL ratio **1.111** but median_abs_err_usd $0.05 (93% of AllDay sales are sub-$1, so the pct is noise); HIGH ratio 1.000, err 6.7%, within_25 83.6%.
  - Panini (manual spot-check; `fmv_sales_backtest` not wired for panini, returns []): HIGH fmv_snapshots vs each edition's 30-day `panini_sales` median → **ratio 1.008**, median_abs_err 25.2% (median sale $2.00, so same sub-dollar noise as AllDay), within_25 50.0%, n matched 33,586 raw HIGH rows. Published HIGH FMV is centered on the real market, not an outlier/stale tail.

## Overnight deltas (vs metrics-latest.json, prev compute 10-24 05:35Z → this 10-25 05:35Z)
- DB size: 41,839 → **41,400 MB (−439)** — autovacuum/WAL reclaim, not runaway.
- FMV HIGH+MED: panini 17,274 → **17,567 (+293)**; nba 6,519 → 6,568 (+49); nfl 1,697 → 1,718 (+21); pinnacle 935 → 938 (+3); candy 72 → 71 (−1); golazos 1 flat; ufc 0 flat.
- Editions: panini 38,985 → **39,170 (+185)**; nba/nfl/golazos/ufc/candy flat.
- Trust breaches 1 → 1 (candy_sales_stale 292.8 → 316.7h).

## Post-ship watch — the 10-23/10-24 state (all GREEN)
1. **panini-1.4.0** (shipped 10-24 15:22Z, commit `5427f2c7`, migration `20261024152200`; FMV input = the sales feed via `panini_recent_sales_fmv_v2`): **VERIFIED, watch CLOSED.** Distribution confirmed real by the 03:05Z monitor (HIGH 16,644 ≈ editions_sold_90d 17,487). Price accuracy confirmed this pass (ratio 1.008 vs 30-day sales median). No gate loosened. Revert path if it ever regresses stays on record: `git revert 5427f2c7` + re-point FMV read to v1 per the migration header.
2. **nba-espn-projections** (the new Fast Break lane): hourly ok=true, rows_written 337–363, per_date populated, window current. Healthy.
3. **Pinnacle #193 / ownLookup / sniper-follows-wallet honesty fixes** (10-23/10-24): no new Vercel error class, beacon quiet. Healthy.
4. **Concierge replay fixes** (`67e36d1`, `898964114`, tonight 00:04–01:00 AM PT, another session): NOT this pass's ships; deploy serves `dpl_DB2N67RafA8zjUk2jtw5RLfRXBN9`; no new error class attributable to them in the 24h window. Left to the owning session.

## Shipped
None. Nothing was clean-safe + non-hot + independently verifiable within the run. A quiet night.

## Queued for Trevor / Claude Code
1. **[P2, Claude Code, 1 night] `get_panini_franchise_panel` perf — bounded timeouts under a concurrent sweep.** New signal: a single-minute **06:32Z** burst (first-seen today, not recurring since) where the RPC timed out across ~30 NBA franchise hubs (`/teams/[league]/[slug]`) plus a couple of insights market-cap segments, each `read exceeded 10000ms`. Production stats (`pg_stat_statements`): 709 calls, **mean 1,736ms, max 13,805ms, stddev 2,583ms** — normally ~1.7s but the long tail tips past the page's 10s bound when a crawler/ISR sweep hits all franchises at once. Degrades honestly (bounded, not a crash or false-empty), so no user saw bad data; this is latency, not correctness. Why not auto-shipped: it is route/RPC perf on a Panini franchise-hub surface shipped within 24–48h (hot), and the right fix (read the function's plan + a targeted index or a precompute/MV for the panel) needs a measured plan read, not a blind additive index. For an interactive/Claude Code session: `EXPLAIN (ANALYZE, BUFFERS)` the panel query for a slow franchise, then index the hot predicate or precompute the panel like the other franchise panels.
2. **[P2, Trevor, 30 nights] #58 OPENSEA_API_KEY** — the Candy secondary-venue key. Drives `candy_sales_stale_hours` (316.7h) and the Candy marketplace-status row. Trevor-only (secret); the three candy-opensea indexers are UNSCHEDULED (focus steer: they do not run, so they cannot fail — the only open part is Trevor setting the key if he wants the Candy book to resume). No sandbox lever exists.

## Failed / blocked / reverted
None. No production shipping was attempted, so no first-failure hard-stop was triggered.

## Continuity written this pass
- This handoff (pushed to `main`; mirrored to the claude.ai Project).
- Ledger: one green-night `### 2026-10-25` entry spliced above the first `^### ` heading.
- `docs/overnight/metrics-latest.json` overwritten with tonight's values.
- Session-log entry prepended to `docs/sessions/2026-10.md`.
- Inbox left untouched (append-only); the two panini-1.4.0 watch filings are resolved by this pass's verification — disposition recorded here, per the append-only rule.
- Lock released.
