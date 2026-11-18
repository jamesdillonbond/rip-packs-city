# Overnight autonomous pass — 2026-11-18 (~1:05 AM PT)

**Verdict: quiet, honest night. Shipped 0 production changes. Queued 3 precisely-diagnosed fixes (ready-to-run). One trust breach, explained and self-limiting.**

Pass: genuine OVERNIGHT. Clock verified vs DB (shell/VM 09:03Z, DB now() 09:02Z, newest sale ingest 08:54Z, newest FMV 08:53Z — no skew). Not frozen. Lock was RELEASED (prior 818bde681335, 11-17 09:20Z), taken over as 2a45e7a99d5c. Push AVAILABLE (VM shallow? no — full `--filter=blob:none` clone; `/sessions` disk cleared to 13% as Trevor reported, so the 11-17 no-checkout workaround was not needed). Run-start origin/main = `7d2c725bf`; unchanged all run (no concurrent push).

## What was reviewed
- CLAUDE.md in full; focus.md (steers through 11-17 ~8:55 PM PT); metrics-latest.json; ledger head + Declined; latest handoff (11-17 overnight).
- Inbox drained (dispositions below): 4 new daytime-monitor filings (11-17 1911Z, 11-18 0110Z/0408Z/0705Z) + 2 Claude-Code acquisition-date filings (#261, blocked on Dune to 12-14). **Inbox left untouched (append-only).**
- Health baseline `rpc_ops_snapshot()` (09:05Z) + drill-downs; Vercel prod deploy state + runtime errors; focus-steer dated reads.

## Health-drift findings + deltas
- **Security: all clean** — invariants [], anon_write_holes [], rls_off_base_tables [], secdef_anon_violations [].
- **Trust: 1 BREACH** — `candy_sales_stale_hours` 31.4h (breach_at 0). This is the **candy-sales-indexer-down signal**, not a Candy market event (metric is indexer-health-aware; 3 consecutive failed walks flip breach_at to 0). Blast radius LOW (Candy = recorded-closure trickle; candy_revival_sales 3/ok, candy_fmv_stale 0.9h/ok, candy_fmv_pct_stale_30d 0). All other 42 trust arms ok. → QUEUE item B.
- **Post-ship regression watch (11-17 evening Claude Code pass, ~8 ships): CLEAN.** Prod serves `3705da73c` READY (tip of the evening ships: AnonSaveCollectionCta, weekly-digest-to-all + "New on RPC", email UTM, demand-read crawler rule, Panini "Binder" heading, GHA schedule fallback/relay, DAY1_ONBOARDING_ENABLED). Newest commit `7d2c725b` is inbox-docs-only → correctly CANCELED. No ERROR deploys. No runtime error traces to any evening ship; the `read exceeded`/`statement timeout` groups are chronic/bounded and degrade honestly; the pack-listings/pack-sniper **HTTP 530** group is the documented Dapper Studio outage (below), degrading honestly ("Pack listings are unavailable right now").
- **Dapper Studio GraphQL 530 outage** (since ~4:23 PM PT 11-17) — drives the whole `running_but_not_succeeding` pack cluster (allday/golazos/pinnacle/topshot pack-sales + opens, AD/Golazos pack-EV, snapshot-pack-asks, wallet-pack-pulls; all upstream-attributed in pipeline_fails_24h). By design these WARN; NOT ours to fix. (Could not re-probe Studio or `gh api` from the VM shell — the auto-mode egress classifier denied external curl/gh this run — but the snapshot cluster is entirely consistent with the monitors' attribution.)
- **GHA schedules:** resumed 11-17 ~7:03 PM PT (ledger); snapshot shows no "dark" flag. **Cleanup owed but NOT before 11-18 evening** per focus steer — left alone tonight.
- **Focus-steer dated reads:** main-tree-watch (pg_cron 893) running 09:02Z; pack-reality staleness (892) fresh 08:38Z; #258 Luis Garcia = 0 rows; panini-team-walk retry watch (3:35 AM PT) not yet due.
- **Deltas vs 11-17:** db 54,477 → 54,778 MB (+301). edition_integrity_flags **8 → 103** (under breach_at 250; not flagged by any of 4 monitor passes; likely new-edition churn from Panini +285 / Candy alias work — **watch next pass**). FMV HIGH+MED: nba 7,111→6,862, panini 20,507→20,623, nfl 1,796→1,729, pinnacle 1,003→1,003, candy 4→6, golazos 1, ufc 0. editions: candy 21,741→21,490 (alias retirement), nba 14,975→15,069, panini 48,123→48,408, nfl/golazos/ufc flat.

## Shipped
None. Every live candidate is OFF-LIMITS ingest/pack route-logic or collision-gated (details below). Nothing else was safe and not-already-done.

## Queued — needs your decision / an eyes-on apply

### B (HIGH) — candy-sales-indexer: isolate the later-set walk so one slow set can't abort the run
- **Symptom:** `candy-sales-indexer` last 3 runs (11-18 00:20/03:20/06:20Z) ok=false, rows_written=0, `later-set walk failed: asg26 … | quest26 … | ball24: The operation was aborted due to timeout`. Last row-writing run 11-17 09:20Z. → `candy_sales_stale_hours` BREACH. Three-in-a-row on the same named sets = it will NOT self-clear (the monitor's own falsifier).
- **Cause:** one slow later-set upstream (Magic Eden / Candy) timeout aborts the WHOLE run, so even healthy sets don't land.
- **Fix (code; route `app/api/**/candy-sales-indexer`, pinned by `__tests__/api-candy-sales-indexer-later-sets.test.ts`):** wrap each later-set walk in its own try/commit (land the sets that succeed; record the failed set), and/or shrink the page or lengthen the per-set budget for asg26/quest26/ball24. A healthy set then lands and the stale clock clears.
- **Why not auto-shipped:** ingest route-logic change in code (CLAUDE.md OFF-LIMITS, invisible-failure history). No data loss (failed run writes nothing; rows re-walked next tick). Needs preflight + deploy + eyes-on.

### A (HIGH) — pack-nft-identity: de-dup the proposed rows before `INSERT … ON CONFLICT`
- **Symptom:** `rpc-pack-nft-identity-lane` (pg_cron 509, `SELECT public.run_pack_nft_identity_lane()`), `ON CONFLICT DO UPDATE command cannot affect row a second time`; 77/288 runs in-window, failing ~every 5-min tick; last ok 11-18 00:58Z (~8h stalled).
- **Cause:** `collect_pack_nft_identity()` has TWO `INSERT INTO pack_nft_identity_queue … ON CONFLICT (collection_id, pack_nft_id) DO UPDATE SET attempts = …+1` blocks (the expired/`no_response` branch and the http-failure branch), each fed by a `UNION ALL` of `pack_purchases` (GROUP BY 1,2) and `pack_rips` (ungrouped) that can emit the same (collection_id, pack_nft_id) twice. Sibling `dispatch_pack_nft_identity()` already dedups with `GROUP BY c.collection_id, c.pack_nft_id` before its `ON CONFLICT DO NOTHING`.
- **Fix (migration only — these functions are NOT drift-guard-pinned; re-read live prosrc immediately before CREATE OR REPLACE):** in both branches, group the UNION-ALL subquery by key before the ON CONFLICT, e.g. replace
  `SELECT k.collection_id, k.pack_nft_id, k.at, 1 FROM (<union all>) k WHERE NOT EXISTS(…)`
  with
  `SELECT k.collection_id, k.pack_nft_id, max(k.at) AS at, 1 FROM (<union all>) k WHERE NOT EXISTS(…) GROUP BY k.collection_id, k.pack_nft_id`
  (mirrors dispatch's existing dedup; picks newest last_seen_at; DO UPDATE increments attempts once per distinct key).
- **Why not auto-shipped:** ingest-identity route-logic (OFF-LIMITS). No data loss (aborted statement writes nothing; rows re-offered next tick). Worth a human confirming WHY a key appears twice (the dedup is correct either way).
- **Revert (once applied):** CREATE OR REPLACE back to the current body (captured in this session).

### C (MEDIUM) — sync_allday_pack_dist_totals: skip NULL opened_count (do NOT write a fabricated 0)
- **Symptom:** `rpc-sync-allday-pack-dist-totals` (pg_cron, :24 hourly) `null value in column "total_opened" of relation "pack_distributions" violates not-null constraint`; clean transition — ok through 01:24Z, failing 02:24Z onward.
- **Cause:** the function sets `total_opened = i.opened_count` with no NULL guard. `expire_allday_dist_opened_drifted()` deliberately NULLs `allday_pack_supply.opened_count` to re-queue drifted dists for the hydrator; while the **Studio 530 outage** blocks the hydrator, opened_count stays NULL, and the write of NULL into NOT-NULL `pack_distributions.total_opened` aborts the whole UPDATE (so EVERY AllDay dist's totals go unrefreshed that hour, not just the NULLed one). Migration `20260913055000` documented this as a "bounded side effect" assuming the NULL would be copied and restored — but the column is NOT NULL, so it aborts.
- **Fix (honesty-canon compliant — NOT `COALESCE(i.opened_count,0)`, which would publish a false "0 opened"):** add one predicate `AND i.opened_count IS NOT NULL` after `AND coalesce(i.packnft_total,0) > 0`. Real 0-opens still writes (0 IS NOT NULL — preserves the function's documented D-UNOPENED case); the transient NULL-for-refetch case is skipped (prior total_opened kept); the abort is gone. This EXTENDS the function's own documented "refreshes on evidence not emptiness" philosophy to opened_count's NULL case.
- **Three-file change (drift-guard pinned):** (1) new migration `CREATE OR REPLACE FUNCTION public.sync_allday_pack_dist_totals()` = current body + the predicate; (2) re-point the `sync_allday_pack_dist_totals` PIN's `migration` in `__tests__/db-invariants-drift-guard.test.ts` to the new file + fix its comment; (3) update the verbatim block in `supabase/tests/sync_allday_pack_dist_totals.sql` to match (byte-identical after whitespace-normalize) and add a `D-NULLOPEN` case (packnft_total 1000, opened_count NULL, existing 500/10 → kept, count stays 3).
- **Why not auto-shipped:** (1) **collision gate** — `__tests__/db-invariants-drift-guard.test.ts` has 5 real commits in the last 48h (11-17 FMV pin work) and `supabase/tests/sync_allday_pack_dist_totals.sql` was committed 11-17 ("Restore main"); CLAUDE.md forbids editing a file with a real commit in the last 24–48h. (2) pack-dist write path. (3) **self-limiting** — the expire lane restores pre-images after 60 min and the whole thing clears when Studio 530 lifts, so there is no urgency. Durable fix regardless; apply when the hot file is cold.
- **Revert (once applied):** revert the commit; re-point the PIN back to `20260816080000`.

### Still queued (carried, not re-worked)
- **#261 acquisition dates** for ~11.4k pulls + ~18k held moments — blocked on Dune credits to **2026-12-14** (inbox 11-17 0358Z/0440Z). No action.

## Failed / blocked / reverted
- None. No production change attempted, so no revert. Two read-only probes (a `usage_events` column introspection and external `curl`/`gh api` from the VM shell) were denied by the auto-mode egress classifier; neither was load-bearing (client_error beacon was 0/24h per the 1911Z monitor; Studio/GHA status covered by the snapshot + monitors).

## Inbox dispositions (append-only — not moved/edited)
- `2026-11-17T1911Z-daytime-monitor` — GHA dark (now resolved 7:03 PM PT); panini-team-walk LOW (retry fix shipped, watch not due). No new action.
- `2026-11-18T0110Z-daytime-monitor` — pack-nft-identity ON CONFLICT (→ QUEUE A); TS pack-sales 530 blip (Studio outage, self-clears).
- `2026-11-18T0408Z-daytime-monitor` — allday-dist null total_opened (→ QUEUE C).
- `2026-11-18T0705Z-daytime-monitor` — candy-sales-indexer later-set timeouts → breach (→ QUEUE B); pack-nft-identity escalated to HIGH (→ QUEUE A).
- `2026-11-17T0358Z` / `0440Z-claude-code` — #261 acquisition dates, blocked on Dune 12-14. No action.

## Update 2026-11-18 ~7:15 AM PT (Claude Code cloud) — B and C cleared on their own; A is with another session

- **B: no code change needed, and the diagnosis above is wrong about the code.** The later-set walks in `app/api/candy-sales-indexer/route.ts` already run each set in its own `try/catch` (lines ~702–755). Each set's rows are inserted inside its own loop, so one set's timeout never discards another set's writes. A failed set only makes the run `ok=false`, named in the error, which is the honest report of a partial read. The 4:20 AM PT run was `ok=true`, and `candy_sales_stale_hours` reads **ok** (37.4 h, breach_at 674.7, the recorded-closure clock). The two earlier un-prefixed timeouts (4:20 PM and 7:20 PM PT 11-17) came from the Base walk, during the same upstream slowness.
- **C: cleared, and the guard shipped ~7:10 AM PT.** `rpc-sync-allday-pack-dist-totals` had succeeded every hour since 3:24 AM PT. Migration `20261118150441` adds `AND i.opened_count IS NOT NULL`, with the DB test case D-NULLOPEN and the re-pointed pin; see the ledger entry.
- **A:** committed by another session at 6:35 AM PT (`912641c`, file only). The apply is handed to Cowork: `docs/handoff-2026-11-18-pack-identity-apply-cowork.md`.
