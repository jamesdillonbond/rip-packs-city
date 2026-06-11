# Night-pass coordination — NEW pipeline `topshot-sales-history-backfill` is EXPECTED (shipped 2026-06-11 evening, Claude Code)

This is a heads-up so tonight's 08:02Z autonomous pass treats the new pipeline as expected, watches its counters, and does NOT auto-revert it on first-tick noise.

## What shipped
Phase 2 of the ASK_ONLY sales-ingest-gap fix (green-lit by Trevor — handoff `docs/handoff-2026-06-11-askonly-phase2-greenlight.md`, plan `docs/proposals/ts-sales-ingest-gap-backfill-2026-06-11.md`).

- **New route:** `app/api/cron/topshot-sales-history-backfill/route.ts` — synchronous (no `after()`), Bearer `INGEST_SECRET_TOKEN`. Each tick drains ≤15 ASK_ONLY-with-zero-sales TS editions: walks `searchMarketplaceTransactions` per edition (same proxied `topshotGraphql` transport the live ingest route uses), inserts the missing historical sales tagged `source='ts_history_backfill_v1'`.
- **New GHA workflow:** `.github/workflows/topshot-sales-history-backfill.yml` — schedule `7,22,37,52 * * * *` (off the :00/:20/:40 anchors, :45 wave, :15 TFP/badge slots), `curl --max-time 600`.
- **New DB objects:** table `topshot_sales_history_backfill_progress` (drain cursor) + SECDEF fn `seed_topshot_sales_history_targets()` (service_role-only). Migration `topshot_sales_history_backfill_progress`.
- **Target set:** 784 int-keyed ASK_ONLY TS editions with 0 sales, prioritized LT-matched (89) → tracked-held (775) → rest.

## Why a new `pipeline_runs` name appears
`topshot-sales-history-backfill` will log a run every ~15 min. Healthy runs show `ok=true` with extras `{editions_drained, editions_empty, sales_inserted, dupes_skipped, gql_errors, budget_hit, pending_remaining}`. `pending_remaining` should trend **down** over the night from ~784 toward 0. It is **NOT watchlisted** (per handoff — wait 24h stable), so `detect_stalled_pipelines()` will not flag it.

## Safety rails already built in (do not duplicate / fight)
- **Self-throttle:** the route counts `pipeline_runs` fails in the last 30 min (excluding itself); if >15 it logs `skipped: saturation` and exits. It will stand down on its own during a bad window.
- **Idempotent:** dedup by `transaction_hash` against existing `sales` + a 23505 row-by-row fallback. Re-runs are safe.
- **Creates ZERO editions** (keys only off existing canonical int-keyed editions; verifies each tx's int-key before attributing). So it cannot leak UUID-keyed edition rows.

## Revert (only if a sales-integrity metric genuinely breaks)
Per the handoff, the ONLY auto-revert triggers are: sentinel **TS-UUID-48h** leak, **fmv_sanity_flags** > 0, or sustained DB saturation **attributable to this backfill**. First-tick noise (a few `gql_errors`, an `editions_error`, a `budget_hit`) is NOT a revert trigger.

If one of those real triggers fires, the documented revert is:
1. **Disable the GHA workflow** (`topshot-sales-history-backfill.yml`) — stops all further ticks. (Or set Vercel env `TS_SALES_HISTORY_BACKFILL_DISABLED=1`.)
2. If sales must be pulled back: `DELETE FROM public.sales WHERE source='ts_history_backfill_v1';` (fully reversible — distinct tag).
3. fmv-recalc self-heals the affected editions on its next sweep.

Full teardown (only if abandoning): also `DROP TABLE public.topshot_sales_history_backfill_progress;` + `DROP FUNCTION public.seed_topshot_sales_history_targets();`.

## Expected FMV side-effect (intended, not a regression)
Inserted sales flow into fmv-recalc's normal sweep → ASK_ONLY editions flip to sales-derived labels (LOW/SALES_ONLY/STALE, recency-appropriate) overnight. TS ASK_ONLY count should drop. Do **not** force-stale or hand-trigger recalcs.

## Morning acceptance gate (Claude Code will run it — for awareness)
- LiveToken comparison on the matched ASK_ONLY cohort: median |ratio−1| must IMPROVE vs the 0.363 baseline and severe-highs must not grow.
- Spot-check 5 promoted editions vs dapper.market history.
- `fmv_sanity_flags` stays 0; sentinel TS-UUID-48h stays 0.
