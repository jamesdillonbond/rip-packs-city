# RPC autonomous pass — 2026-09-23 (fired ~12:06 PM PT)

**Mode: OFF-HOURS + NO-PUSH → monitor-mode.** The run fired at 19:06Z (verified against DB `now()` and a 23-second-old `max(sales.ingested_at)` — no clock skew), which is ~12:06 PM PT, outside the 00:00–06:00 PT overnight window. Push is unavailable in this sandbox (`git push --dry-run` → "could not read Username"; the harvested remote is the public `url`, no credential). So: **queued everything, shipped nothing** (correct under both gates anyway). These output docs are written to the mounted tree and are **UNPUSHED** — a push-capable session (Trevor's laptop or a credentialed pass) should commit them.

Lock: took over the RELEASED 09-21 lock; run-id `np-20260923-sbx-26015`; marked RELEASED at end.

## Verdict: GREEN / no regression. One live user-facing FMV defect queued (highest-value open item).

## Reviewed
- Fast baseline `rpc_ops_snapshot()`; `check_pgcron_recent_failures()`; `pipeline_runs` drill on the one HIGH alert; `net._http_response` (gate-key falsifier); Vercel deploys + runtime errors (24h); Sentry (new + escalating, 24h); the 11 Cowork artifacts; ledger top + focus + the two newest inbox candidates.
- Post-ship watch on everything shipped in the last ~24–48h (All Day ghost-floor fix job 596, All Day ASK_ONLY retirement, the 13-lane Vault gate-key rotation, the compute-allday-pack-ev v10 prune fix).

## Health-drift findings (Section 2)

**All clean:**
- Security 4/4 arms `[]` (invariants, anon_write_holes, rls_off_base_tables, secdef_anon_violations).
- `trust_health`: 0 breaches, all 39 arms `status:ok`.
- `stalled_pipelines` `[]`; `check_pgcron_recent_failures()` `[]`.
- All structural-drift arms `[]` (backward_cursor_rewinds, function_search_path_drift, procedure_txn_control_pins, cross_collection_mat_staleness, procedure_search_path_unpinned, suppression_parked_claim_drift).
- **Sentry 0 new / 0 escalating (24h), PAIRED with Vercel 0 new-first-seen error classes** — all 18 runtime-error groups are chronic June–Aug classes (url.parse DEP0169 warning, whale-wallet Cadence `computation limit exceeded` on oversized collections, sniper/Atlas upstream 403 challenges, pack-detail 5000ms saturation reads). None traces to a recent ship.
- Vercel production **READY at commit `108520ee`** (the last non-docs commit); the three docs-only commits after it (`77b7cd72`, `25d732d1`, `35296291`) correctly show CANCELED — `ignoreCommand` suppressed the rebuild as designed.

**One HIGH-severity alert — investigated, BENIGN (R124 pooled-across-fix):**
- `compute-allday-pack-ev` reads `failure_rate` HIGH: 75/133 (56.4%) over 3 calendar days, "pool prune 5349: Bad Request". Split by day: **09-20 0/10 · 09-21 38/48 · 09-22 37/48 · 09-23 0/39, last OK 19:07Z (one minute before the read)**. The prune-400 stopped 09-22 18:07Z (the v10 fix, ledger 09-21T1813Z monitor filing marked resolved). The alarm pools across the fix point exactly as CLAUDE.md's R124 note warns; live state is clean. No action.

## Post-ship watch — no regression
- **All Day ghost-floor fix (job 596) + ASK_ONLY→NO_DATA retirement:** All Day FMV trust arms clean (`allday_fmv_stale_hours` 0.2, `allday_fmv_pct_stale_30d` 0). All Day HIGH+MED continues its honest, by-design downward drift (1,779 on 09-22 → 1,747 now) as ghost-corroborated MED demotes — expected, already flagged to Trevor, not a regression.
- **Vault gate-key rotation (13 lanes):** falsifier = any 401 in `net._http_response`. Over 12h: 3607×200, 128×403 (Atlas/Cloudflare upstream challenge, documented self-healing), 83×null (pre-existing DNS-hang class). **Zero 401s.** Healthy.
- **compute-allday-pack-ev v10:** recovered (see above).

## Overnight deltas (vs metrics-latest 2026-09-22 ~5:45 PM PT)
- DB size 21 GB → **23.4 GB** (+~2.4 GB; on LARGE tier, within budget — worth a glance next pass if it keeps climbing).
- Top Shot HIGH+MED 7,749 → **7,750** (HIGH 1,344 / MED 6,406) — stable.
- All Day HIGH+MED 1,779 → **1,747** (HIGH 69 / MED 1,678) — honest continued drift.
- Pinnacle HIGH+MED **701** (HIGH 183 / MED 518); Candy MLB MED **26** (~stable vs 27); Golazos MED 4.
- Editions: TS 14,016 · All Day 6,190 · UFC 518 · Golazos 575 · Candy 125.
- `unmapped_resolution_backlog_max` 2 (ok). `sentinel_ts_uuid_editions_48h` 0.

## QUEUED — needs Trevor's decision

### Q0 (NEW, HIGH, live + user-facing) — the fourth ASK_ONLY writer publishes Flowty valuations above live floors
`public.fmv_from_cached_listings(p_collection_id, p_algo_version='ask_only_v2')`, called by `app/api/allday-listing-cache` / `golazos-listing-cache` / `ufc-listing-cache` every 20 min, republishes Flowty's blended valuation (`AVG(cached_listings.fmv)`) as RPC's own `ASK_ONLY` FMV, writes `floor_price_usd = MIN(ask_price)` with **no troll ceiling**, and its DELETE is **not scoped to its own algo_version** (it deletes every `ASK_ONLY` and `LOW` snapshot for matched editions, so a sales-derived LOW can be overwritten by a third-party valuation). Filed READ-ONLY 09-22 evening: `docs/overnight/inbox/2026-09-23T0510Z-a-fourth-ask-only-writer-republishes-third-party-valuations-over-troll-floors.md`.

**Verified LIVE this pass, and it reaches the surface (`edition_fmv_current`), newest tick 18:54Z today:**

| edition | surface FMV | surface floor | live ghost-filtered floor | FMV ÷ live floor |
|---|---|---|---|---|
| Jer'Zhan Newton, Regal Rookies (`81715e78`) | $60.39 | $1,000,000 | $3 | **20.1×** |
| Isaac Bruce, Career Chronicles '94 (`8ee5d7db`) | $50.14 | $1,000,000 | $4 | **12.5×** |
| Xavier Worthy, SB LIX Icon (`f63a7307`) | $202.76 | $1,000,000 | $46 | **4.4×** |
| Jordan Addison, Dynamic (`847f0d5f`) | $433.23 | $1,000,000 | $325 | 1.33× |

`ask_only_v2` wrote 67 Golazos + 9 All Day rows in the last 24h (8 All Day still carry the $1M troll floor, leaking into `surface_floor`). This is the confident-wrong shape the ask-ceiling exists to stop, bypassing it. **Not shippable autonomously — FMV/pricing route logic (DB function + 3 routes) is off-limits.**

Ready-to-run remediation (Trevor's call between the two shapes in the filing):
- **(a) Retire** the RPC call from the three listing-cache routes, OR **(b) scope** it to editions with no other pricing and apply the ask ceiling + troll cap. Either needs: bound the DELETE to `algo_version = p_algo_version`; run `SELECT public.refresh_edition_fmv_current(false)` afterward (snapshot ≠ surface).
- **Falsifier:** after the change, no new `ask_only_v2` rows in 24h and no current All Day row has FMV above `allday_edition_floor_ask.floor_ask`.

### Carried forward (still queued)
- **Q1** institutional-wallet snapshot silent (needs cron-job.org console / gate key — operator-only). N nights.
- **Q2** the two disabled 2-hourly Routines (#55) — Trevor to delete or re-enable.
- **Q3** All Day HIGH+MED headline KPI drifting down honestly from the ghost-floor fix — acknowledge/accept.
- **Q4** Candy MLB HIGH+MED fell 78→27 via the dispersion gate while sales rose — check edition-population mixing.
- **Q5** Consolidate/migrate the 11 legacy desktop dashboard artifacts (none flagged broken this pass).
- **Q6** Top Shot pack-sales ingest ~8h late (walker sweeps full history before returning to head) — head-first paging.

### Resolved since last metrics
- All 13 pg_cron literal gate keys de-literalised into Vault (09-22 evening) — closes the prior "Jobs 22/25/27/29 literal gate keys" queue item; falsifier (401s) clean this pass.

## Shipped / reverted
None (monitor + no-push). No auto-reverts needed — no regression found.

## Artifacts
Enumerated 11; none flagged broken by the daytime monitor and none touched (no-push + none drifted).
