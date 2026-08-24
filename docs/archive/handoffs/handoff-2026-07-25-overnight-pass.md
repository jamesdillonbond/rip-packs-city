# Overnight autonomous pass — 2026-07-25

**Run:** rpc-nightly-autonomous-pass · genuine overnight (~01:02 PDT / 08:02Z, no clock skew) · shipped **1** (DB-only) · reverted 0 · repaired 0 · closed 1 · drained 4 inbox files.

Time sanity: shell `08:02:19Z` ≈ DB `now() 08:02:22Z` ≈ newest sale `07:56Z` ≈ newest FMV `07:54Z`. Lock taken over (stale RELEASED from 07-24T18:05Z). No FREEZE. Push available.

**Concurrency note:** `origin/main` advanced `ee63eab8`→`dd1127a5` mid-run — a concurrent Claude Code session pushed the pack-EV edge-drift + `atob` mojibake-writer + wallet-backfill chunk-loss batch. That is a **different surface** (edge functions, wallet-backfill) with **no overlap** with tonight's target (`get_team_activity`). It was stable 20s later (a completed batch, not an actively-hammering human), so I proceeded with the isolated DB migration and rebased my docs commit on top.

---

## Shipped

### `audit_20260725_get_team_activity_soldat_ordered_rewrite` — team-activity 28s -> ~60ms (DB-only, no deploy)

**Source:** daytime monitor inbox `2026-07-25T0308Z.md`, candidate 1 — Sentry **JAVASCRIPT-NEXTJS-1Y** "team detail unavailable: Timed out acquiring connection from connection pool" on `GET /[collection]/team/[slug]`. Monitor flagged it "NOT auto-shippable blind — needs the EXPLAIN diagnosis first." That diagnosis is now done.

**Diagnosis.** The team-detail page fires 7 RPCs concurrently; timing them isolated `get_team_activity` at **28,168 ms** while every sibling was <1.2s. Its query `JOIN sales->editions` filtered by team then `ORDER BY sold_at DESC LIMIT 30` **gathered every sale for all ~636 team editions (~60k-120k rows) and top-N sorted**, holding a `service_role` pool connection to the 30s ceiling -> pool exhaustion. The function's own `SET statement_timeout='8s'` is **inert on the direct-call path** (the documented statement_timeout re-arm finding — the timer arms at outer-statement start from the caller's session default before the fn's SET fires), so nothing capped it.

**Fix.** Materialize the team's `edition_ids`, then scan `sales` via the **existing** per-partition `(collection_id, sold_at DESC)` indexes with an `edition_id = ANY(...)` membership filter, so a MergeAppend walks newest-first and **stops at the LIMIT**. EXPLAIN confirms only `sales_2027` + `sales_2026` execute; `sales_2025...2020` show "never executed". **No new index** — the indexes already existed on every partition.

**Correctness — byte-identical row selection PROVEN.** The only added predicate is `s.collection_id = p_collection_id`; verified live there are **0** sales rows where `s.collection_id IS DISTINCT FROM edition.collection_id`, so it excludes nothing the JOIN included. Multiset diff old<->new = **0/0** across lakers 30/0, lakers 100/0, warriors 50/0, celtics 30/10, with identical boundary `sold_at`. (The initial md5 diff on 2 of 5 cases was pure tie-order among equal-`sold_at` rows — already nondeterministic in the original heapsort, which had no tiebreak.) Output column order/keys/`ORDER BY sold_at DESC` and attributes preserved (STABLE, SECURITY DEFINER, `search_path=public`, `statement_timeout=8s`, ACL `postgres`+`service_role` only, anon/authenticated NOT granted).

**Measured:** `get_team_activity` Lakers 28,168 ms -> **76 ms**; Knicks 129 ms; Celtics (100 rows) 521 ms.

**Independent subagent verification: PASS** — correctness multiset diffs 0/0 on 3 arg sets, timing 58-87 ms (Lakers), attributes/ACL as stated (`has_function_privilege` anon=false/authenticated=false/service_role=true/postgres=true), edge cases (nonexistent slug -> `[]`, real team -> 11-key array).

**Target metric to re-check tomorrow:** `get_team_activity` runtime stays <2s; Sentry JAVASCRIPT-NEXTJS-1Y (team-detail pool timeout) stops recurring. NEXTJS-20 (player-detail pool timeout) is **collateral** pool-exhaustion (get_player_detail 128 ms / get_player_editions 315 ms are already fast) and should ease as team-activity stops holding connections — watch, no separate fix.

**Revert:** restore the prior function body —
```sql
CREATE OR REPLACE FUNCTION public.get_team_activity(p_collection_id uuid, p_team_slug text, p_limit integer DEFAULT 30, p_offset integer DEFAULT 0)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public' SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_variants    text[];
  v_safe_limit  int := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_safe_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  result        jsonb;
BEGIN
  SELECT array_agg(DISTINCT team_name) INTO v_variants
  FROM editions
  WHERE collection_id = p_collection_id AND team_name IS NOT NULL
    AND regexp_replace(lower(trim(team_name)), '[^a-z0-9]+', '-', 'g') = p_team_slug;
  IF v_variants IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(t.*)), '[]'::jsonb) INTO result FROM (
    SELECT COALESCE(e.external_id, e.id::text) AS route_slug, e.player_name, e.set_name,
      e.team_name, e.play_type, e.tier::text AS tier, e.thumbnail_url,
      s.serial_number, s.price_usd, s.sold_at, s.marketplace
    FROM sales s JOIN editions e ON e.id = s.edition_id
    WHERE e.collection_id = p_collection_id AND e.team_name = ANY(v_variants)
    ORDER BY s.sold_at DESC LIMIT v_safe_limit OFFSET v_safe_offset
  ) t;
  RETURN result;
END;
$function$;
```

---

## Closed

**0605Z inbox candidate — `audit_20260725_allday_nem_from_sales` RLS-off / anon-readable: ALREADY RESOLVED before this run.** Live check: `relrowsecurity=true`, `has_table_privilege('anon',...,SELECT)=false`, `authenticated=false`; `rpc_ops_snapshot().security.rls_off_base_tables` is now `[]`. Hardened after the 0605Z tick (likely the CC session). **No action** — do NOT drop it; it is the same-day revert artifact for the 2,619-sale AllDay free-lane recovery.

---

## Post-ship watch — the 07-25 mega-wave (ALL PASS, 0 reverts)

Today was an exceptionally heavy interactive day (14 DB migrations in the verified-findings remediation + AllDay free-lane recovery + Phase 2/3 crons + a multi-round test-coverage program + a late pack-EV edge/atob/wallet-backfill batch).

- **P1 legacy-wmc-unique-index DROP** (the highest-risk item): healthy. `wallet-backfill` 480 / `wallet-backfill-allday` 575 / `wallet-backfill-pinnacle` 561 ok, **0 fails/24h** — the upsert chunks the old cross-collection unique index silently discarded now land.
- **4 pg_cron `cron_heavy` moves (jobids 216-219):** all last-status `succeeded` (217 atlas-pack-ev 53.3s, under the 600s ceiling, would have died at 120s).
- **jobid 215 `rpc-allday-nem-from-sales-backfill`:** succeeded 5.48s @08:00Z.
- **New Vercel crons:** `allday-price-recover` 14 ok / 0 fail (last 08:01Z); `allday-unmapped-resolver-tail` 1 ok / 0 fail (sparse, low-yield by design).
- **Security invariants `[]`x4** after the whole wave; `check_pgcron_recent_failures()` `[]`.

No regression attributable to any recent ship -> **no auto-revert warranted.**

---

## Health drift (baseline `rpc_ops_snapshot()` @08:04Z)

- security: invariants `[]`, anon_write_holes `[]`, rls_off_base_tables `[]`, secdef_anon_violations `[]`.
- trust_health: **20 metrics, 0 breaches** (topshot_fmv_stale 0.3h, allday 0.2h, pinnacle 9.5h, ufc 8.9h, golazos 0.3h; unmapped_resolution_backlog_max 31; edition_integrity_flags 5; fmv_sanity_flags 0; topshot_impossible_parallel_serials 0).
- stalled_pipelines `[]`; pipeline_alerts 2 **info-only** (golazos_sales + ufc_sales resolving_editions — standing).
- sentinel_ts_uuid_editions_48h 0. DB **10,779 MB** (vs monitor 10,957 @0605Z — normal vacuum fluctuation).
- pipeline_fails_24h: carried classes only — Dune pair (DUNE-DATAPOINT-CAP-402, cursors parked), sales-counterparty-backfill 14 (contention `*/5`), snapshot-institutional-wallets 4 (STALE pre-fix daily runs, last 07-24 10:07Z; next tick ~10:07Z 07-25 confirms the 07-24 index fix), plus self-recovering contention flaps.
- Sentry: **0 unresolved production issues / 24h**.
- Vercel: prod serving `9d4ce49e` READY; the 3 docs-only tip commits correctly CANCELED by `ignoreCommand`. 0 ERROR-state.

### Deltas vs metrics-latest (07-24 14:10Z)
- FMV TS HIGH+MED 3,051 -> **2,957** (820+2137; documented oscillation band).
- editions TS 19,506 -> 19,513. DB 10,804 -> 10,779 MB. All normal.

---

## Artifacts

17 listed / 15 active (rpc-growth-funnel + rtr-pack-finder are retired tombstones). None flagged broken/stale in the inbox; tonight's change is a function-body optimization with identical output shape (cannot break any artifact); the monitor already re-validated rpc-live-health clean today. **No repair needed.**

---

## Queued / carried (unchanged unless noted)

- **NEXTJS-20 player-detail pool timeout** — collateral pool exhaustion, not a slow RPC; watch after the team-activity fix, no separate action.
- **CANDY-VIEW-SECURITY-INVARIANT-DRIFT** — security invariants are now `[]` (may have self-cleared via the day's `security_invoker` normalization); verify at owner allowlisting.
- REFRESH-SEEDED-WALLET-STATS-HOLDINGS-SUMMARY-COST, CORRELATED-PIPELINE-DROPOUT-DETECTOR, PIPELINE-WATCHLIST-COVERAGE-AUDIT, DUNE-DATAPOINT-CAP-402, TOPSHOT-BADGE-CATALOG-429, WMC-PRUNE-120S-CEILING, NON-WAVE-WALLET-BACKFILL-DRIVER, WMC-LOCK-FRESHNESS, MARKET-EDITION-LINK, CLAUDE-MD-GOLAZOS-LOW-ASK-STALE, Panini go-live (Trevor editorial), chain-two/Candy (gated) — all carried.
