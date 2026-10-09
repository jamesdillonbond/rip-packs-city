# Handoff — 2026-10-09 afternoon (Claude Code cloud) → pick up from any thread

Trevor is traveling 10-09 → 10-10 and asked: *"work on anything you can from here, then update any relevant documentation so that you have this saved and can pick this back up later when home from another thread."* This file is the pick-up point. Everything listed as shipped is on `main` with a ledger entry. Times are PT.

**To resume:** read §3 (watch list, in date order) and §2 (the one held fix). Then run the §4 alert read again before trusting any number here, because each figure is a dated sample.

## 1. Shipped today by this thread (all on `main`, all in the ledger)

| when | what | revert |
|---|---|---|
| ~8 AM–12:41 PM | Panini bridge case-variants (`20261009150720`), Atlas supply page retries (`20261009150802`), chain-arrival pack-pull per-probe check + stamped rebuild queue (`20261009162222`), wallet-rips rebuild `force_custom_plan` (`20261009165544`), sellback walk retries id-less pages (`20261009162520`), jobid 15 `rpc-backfill-pack-supply` deactivated | each migration header |
| ~1:39 PM | **#173 fixed** (`20261009203911`): checkpoint trigger on `topshot_moment_subeditions` + 1,373 sales / 848 moments / 156 wmc re-keyed | migration header |
| ~1:51 PM | **Pinnacle young renders** (`20261009205054`): < 7 d → last-5 median; < 3 d at most LOW, 3–6 d at most MEDIUM. **Verified live 3:50 PM** (0 violations after the 3:37 PM recalc) | migration header |
| ~2:13 PM | **#173 follow-up** (`20261009211308`): 62 moments / 71 sales / 32 wmc re-keyed where the checkpoint verifies base AND subedition | migration header |

## 2. HELD — one prod data fix, ready to run on Trevor's go-ahead (known-issues #175)

The auto-mode classifier blocked an unattended production write while Trevor is away, so this was **not run**. All three NFTs involved are chain-verified, so the fix is correct whatever the open #175 question resolves to. It moves 3 sales (Wembanyama 2023-24 Honors (Diced) `152:5370`, $2,000 / $2,888 / $3,999) off `149:5370::8` and corrects 2 `topshot_moment_subeditions` rows. Run it through Supabase `execute_sql`; it raises unless exactly 3 sales and 2 rows change.

```sql
DO $fix$
DECLARE
  c_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_to uuid; v_from uuid; v_s int; v_t int;
BEGIN
  SELECT id INTO v_to   FROM public.editions WHERE collection_id = c_ts AND external_id = '152:5370';
  SELECT id INTO v_from FROM public.editions WHERE collection_id = c_ts AND external_id = '149:5370::8';
  IF v_to IS NULL OR v_from IS NULL THEN RAISE EXCEPTION 'edition missing'; END IF;
  INSERT INTO flowty_archive.audit_20261009_173b_rekeys (tbl, key, nft_id, old_value, new_value, new_ed, applied_at)
  SELECT 'sales', s.id::text, s.nft_id, s.edition_id::text, v_to::text, v_to, clock_timestamp()
    FROM public.sales s
   WHERE s.collection_id = c_ts AND s.nft_id IN ('47085186', '47085192') AND s.edition_id = v_from;
  UPDATE public.sales s SET edition_id = v_to
   WHERE s.collection_id = c_ts AND s.nft_id IN ('47085186', '47085192') AND s.edition_id = v_from;
  GET DIAGNOSTICS v_s = ROW_COUNT;
  INSERT INTO flowty_archive.audit_20261009_173b_rekeys (tbl, key, nft_id, old_value, new_value, applied_at)
  SELECT 'subeditions', t.nft_id, t.nft_id, t.base_external_id || '|' || coalesce(t.subedition_id::text, ''),
         '152:5370|0', clock_timestamp()
    FROM public.topshot_moment_subeditions t WHERE t.nft_id IN ('47085186', '47085192');
  UPDATE public.topshot_moment_subeditions SET base_external_id = '152:5370', subedition_id = 0
   WHERE nft_id IN ('47085186', '47085192');
  GET DIAGNOSTICS v_t = ROW_COUNT;
  IF v_s <> 3 OR v_t <> 2 THEN RAISE EXCEPTION 'unexpected counts sales=% subeditions=%', v_s, v_t; END IF;
END
$fix$;
```

**Revert:** restore `sales.edition_id` from `flowty_archive.audit_20261009_173b_rekeys` rows with `tbl='sales'` and `nft_id IN ('47085186','47085192')`. Restore the two subeditions rows from `tbl='subeditions'`, where `old_value` is `base|sub`. **After running it:** add a ledger entry, and the `152:5370` FMV refreshes on the next recalc. The Supabase MCP may hold the UPDATE for human confirmation; that hold shows up as a 60 s timeout.

**Still open under #175 (needs an on-chain census, not code):** whether any NFT has set 149 with subedition 8. If none does, the 25 `149:<play>::8` editions are phantoms carrying 44 on-chain offers and their own FMV rows. Method and both outcomes are in known-issues #175.

## 3. Watch list (date order)

1. **10-10 4:41 AM — chain-arrival tick after the 4:13 AM seed.** `rpc-chain-arrival-pack-pulls` should be `succeeded` with no 120 s timeout (fixed 10-09; the 10:41 / 11:41 / 12:41 PM ticks were already ok). Falsifier: a `canceling statement due to statement timeout` row.
2. **10-10 after 1:30 PM — #173 slice re-measure** (the daily `/api/admin/drain-conflated-subeditions`). Falsifier: any `topshot_moment_subeditions` row whose base disagrees with `topshot_checkpoint_base(nft_id)`, which would mean a writer bypasses the trigger. Also re-run the #173 follow-up verification (0 verified mismatches expected); the query is in the `20261009211308` header.
3. **10-10 ~4 PM — #169** (owned by the daytime health pass; handoff `docs/handoff-2026-10-09-daytime-health-pass.md`). None of the 34 should still be MEDIUM on a pre-10-04 snapshot.
4. **By 10-12 ~5:18 AM — `atlas-edition-supply` `failure_rate` (high) clears by itself.** It pools 3 days across the 10-09 retry fix. All 4 runs since the fix (8:13 AM onward) are `ok`; the alarm needs the 10-06 → 10-09 5:18 AM failures to age out. **Do not re-fix.** Falsifier: any `ok=false` run after 10-09 8:13 AM.
5. **Pinnacle** — the 3-hourly recalc keeps young renders capped. Spot check: `pinnacle_catalog` renders < 3 d old read only LOW, and 3–6 d old never HIGH.

## 4. Alerts read at ~4:00 PM 10-09 (`get_pipeline_alerts()`) — all explained, none actionable

- `atlas-edition-supply` failure_rate **high**: pooled across the fix (see §3.4).
- `pg_net_http_400` **high** ("height range 5000 exceeds maximum allowed of 250"): 2 responses at 2:22 PM. That was the **concurrent daytime session's one-off Golazos on-chain check** (two event reads over 5,000 blocks, repeated at Flow's 250 limit). No lane sends this. Aged out of the 2 h window at ~4:22 PM.
- Info rows (Atlas 403 base rate, `flow-rest-moment-moved-400` by design, `ingest-pinnacle-mints-backfill` cron_silent because jobid 84 was deactivated on purpose 10-09, All Day unmapped backlog draining ~1.2 d): expected.

## 5. Measured and deliberately NOT acted on (do not re-chase)

- **~7.2 k sales / moments / wmc rows on Top Shot NFTs with no checkpoint record disagree with their `topshot_moment_subeditions` row.** Not verifiable from the DB: the sparse direct chain reads side both ways. Only 13 of those sales fall inside 30 d (48 inside 90 d). Re-open trigger and reasoning are in the #173 follow-up paragraph in known-issues.
- **13,428 `topshot_moment_subeditions` rows with NULL `subedition_id`** (8,580 of them have a chain read saying 0) are being drained by the daily drain (20,000 resolved in 24 h). No action needed.

## 6. Still Trevor's (unchanged)

- The 10-04 dedupe + scratch-table drop (`dedupe_tx_lane_20261004.sql`, `drop_scratch_20261004.sql`): destructive, needs his confirmation in Supabase.
- §2 above.
- #172 (giveaway "Deliver all" stalls with the desktop Flow Wallet extension): needs his desktop browser.
- #22 credential-purge residue.
