# RPC overnight pass — 2026-07-10 (RUN 2, GENUINE OVERNIGHT ~01:02 PDT)

**Result: shipped 0 (correct). Health GREEN. Post-ship watch of the heavy 07-10 daytime + CC wave ALL PASS, 0 reverts. Impossible-parallel breach cleared to 0. No SHIP-eligible candidate — every actionable item was already shipped by today's interactive/CC sessions; the remainder is operator / off-limits / future-retry.**

This is the real scheduled overnight run, ~5h after the earlier OFF-HOURS monitor-mode run (`docs/handoff-2026-07-10-overnight-pass.md`, ~20:41 PDT Jul 9).

## Setup / gates
- **No clock skew.** shell `08:02Z` ~= DB `now()` `08:02:10Z` ~= newest sale `07:53Z` ~= newest fmv `07:58Z`. Real local time ~= **01:02 PDT -> genuine overnight window** (00:00-06:00). Normal shipping allowed.
- **Lock:** mount `.lock` was RELEASED (03:58Z context-hygiene). Took `night-20260710T080233Z-21502`. Released at end.
- **FREEZE:** none. **Push:** available (`git push --dry-run` -> "Everything up-to-date").
- **Git:** fresh sandbox clone `$HOME/rpcwork` at `origin/main = 211abc09`, stable start->end (not advancing).
- **Connectors:** Supabase + Vercel + Sentry all live. `rpc_ops_snapshot()` returned the full vector, no timeout.

## Post-ship regression watch — ALL PASS, 0 reverts
Re-measured the last ~24-36h of shipped changes (07-10 daytime interactive wave + CC round-2):

- **`4969aef` + 4 DB migrations (07-10 interactive full audit).**
  - `audit_20260710_circ_floor_raise_impossible_parallel_stragglers` -> **VERIFIED HELD:** `topshot_impossible_parallel_serials` = **0** (was 4/3 breach at ship; the inbox candidate 2 is now moot). trust_health **16/16 ok, breaches []**.
  - `audit_20260710_allday_pack_dist_totals_sync` (new pg_cron `rpc-sync-allday-pack-dist-totals` @ 12,42) — not in `check_pgcron_recent_failures()`; new cron expected.
  - `pack_dist_title_mojibake_fix` + `pack_table_rows_depletion_coalesce` — additive/data fixes, no regression signal.
- **`5039463` (CC round-2 ops fixes), deploy `dpl_3HuSv921` READY:**
  - **allday-listing-cache marketplace-GQL 403 fallback -> WORKING.** Every `*/20` tick since deploy `ok=true`, ~100-105 rows/tick, zero errors, no gaps (07-09 02:14Z -> 07-10 07:54Z). The Cloudflare-403 marketplace leg now flows through the topshot-proxy `/allday-consumer` worker route.
  - **drain-topshot-misattribution crash-logger** — no `pipeline_runs` row yet (daily 11:00Z cron; next tick ~3h out). Remains QUEUED CC item VERCEL-CRON-MISATTRIB-DRAIN-500. Behavior-preserving, no risk.
- **`211abc09` (CC, allday-badge-ingest hard 30s curl timeout), prod `dpl_B5d3ww...` READY:** the pipeline stuck since ~07-06 ran **06:37Z `ok=true`, 5,600 rows written**. Timeout fix confirmed unfreezing the 59-page walk.
- **Concierge wave (`8b0b322`,`74d4145`,`3ccb4da`,`187669ed`,`eeff0b1`)** — all prod-READY; Sentry 0 unresolved/24h; no new runtime-error class. Carried PASS.

No shipped change correlates with a regression -> **0 auto-reverts**.

## Health-drift triage (Section 2)
Baseline `rpc_ops_snapshot()` @ 08:03Z:
- **Security 0/0/0/0** — invariants [], secdef_anon [], rls_off_base [], anon_write_holes [].
- **trust_health 16/16 ok, breaches [].** impossible_parallel **0** (cleared), edition_integrity 4/50, unmapped_backlog 34/100, fmv_sanity 0, all FMV freshness legs ok (topshot 0.2h, allday 0.1h, golazos 0.3h, ufc 0.1h, pinnacle_fmv 21.9h/30, pinnacle_ask 0.1h).
- **sentinel TS-UUID-48h 0.**
- **stalled_pipelines: 1 INFO** — `ultimate-fmv-recalc-v1` silent 1528 min (last 07-09 06:35Z, missed 07-10 06:35Z tick). RPC_ADMIN_TOKEN daily cron = operator; self-healed last time. Carried LOW.
- **pipeline_alerts: 2 INFO** — `ufc_sales` resolving_editions (benign) + the ultimate-fmv note.
- **pipeline_fails_24h:** `topshot-moments-hydrator` **53** (upstream GetMintedMoment GQL flakiness — last run 08:02Z ok=true, 17 ok/52 fail in 12h, NOT degraded to persistent-0, no corruption), fmv-recalc 14, compute-topshot-pack-ev 7, analytics-smoke 7, wallet-backfill-ufc 6, topshot-buyer-backfill 6 — all known families, latest runs ok.
- **pgcron failures: 1** — `rpc-fmv-clamp-disconnected-ask` failed 07-09 13:55Z (statement timeout). Next tick 07-10 13:55Z NOT yet fired. Inline clamp primary -> no gap. QUEUE/track.
- **Sentry:** 0 unresolved firstSeen -24h.
- **Vercel:** prod `dpl_B5d3ww...` (211abc09) READY; no ERROR-state deploy in last 20 (CANCELED = docs-only ignoreCommand skips).
- **Artifacts:** 15 enumerated, estate intact. HTML on OneDrive (outside sandbox mount) so payloads not re-run; data fresh-on-open and the 07-10 migrations were additive (COALESCE/sync-cron/data) with no column drop/rename -> no query breakage. No repair needed.

### Overnight deltas vs metrics-latest.json (07-10 03:42Z)
- FMV TS H+M **5,173 -> 5,193** (HIGH 1424->1430, MED 3749->3763) improving. AllDay H+M 809->804 (benign). UFC 15, Golazos 4 flat.
- editions flat: TS 19,088 / AllDay 6,190 / Golazos 575 / UFC 518.
- DB **8,869 -> 8,902 MB** (+33 benign).
- `topshot_impossible_parallel_serials` **4 -> 0**.
- unmapped 34, sentinel 0, Sentry 0 (flat).

## Shipped
None. Correct — the daytime interactive + CC sessions already shipped every actionable item today.

## Queued (carried / new)
- **FMV-CLAMP-DISCONNECTED-ASK-CONTENTION-TIMEOUT** (LOW, night-count 2). Single 07-09 13:55Z miss; retry 13:55Z today not yet fired. Inline clamp primary => no gap. If multiple consecutive daily misses: CC raises backstop fn statement_timeout or bounds the `latest` CTE (measure first). FMV-adjacent -> not auto-shipped.
- **ULTIMATE-FMV-RECALC-V1-MISSED-TICK** (LOW, carried). Missed 07-10 06:35Z. RPC_ADMIN_TOKEN daily cron = operator; self-healed before. Re-check next tick.
- **TOPSHOT-MOMENTS-HYDRATOR-GETMINTEDMOMENT-ERRORS** (LOW, night-count 2). 53 fails/24h upstream GQL; still resolving (last run ok=true). Off-limits ingest, self-limiting, no safe DB-only lever. CC de-prioritize only if persistent 0-resolution.
- **Carried standing:** cron-job.org dropout family, SALES-SERIAL-BACKFILL-WATCHLIST, CROSS-SOURCE-DEDUP, BADGE-CATALOG-STALE-429, DAYTIME-CONTENTION family, DAILY-PORTFOLIO-SNAPSHOT-GATEWAY-TIMEOUT, CLASSIFY-ACQ-ALLDAY, FMV-RECALC-EDITION-FETCH-TIMEOUT-CREEP, REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT, BUYERBF, ALLDAY-V1-UNMAPPED-DRIFT, WEEKLY-SURFACE-QA-PROSE, THIN-FMV-GUARD-CONTENTION, VERCEL cost family, + standing owned/operator/gated queue.
- **CC-owned from today's interactive session (docs/handoff-2026-07-10-full-audit-followups.md):** restart 2 dead home-machine Task Scheduler ingests (HIGH), ALLDAY_PROXY_URL Vercel env, misattrib-drain root-cause after crash-logger surfaces it, UFC->Aptos honest UI, soft-404 noindex / recharts SSR warning.

## Closed
- **TOPSHOT-IMPOSSIBLE-PARALLEL-SERIALS-BREACH** — cleared to **0** by 07-10 interactive `audit_20260710_circ_floor_raise_impossible_parallel_stragglers` (was 4/3). Inbox candidate 2 moot.

## Failed / blocked / reverted
None.
