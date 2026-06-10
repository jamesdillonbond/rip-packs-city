# Daytime monitor — 2026-06-10T03:05Z

Run context: lock present but stale (2026-06-09 08:42, ~18h — treated as released). 20/20 prod deploys READY (head `add59faf`, pack-sniper null-safe fix). Security 0/0. `detect_stalled_pipelines()` = []. Trust health 6/6 ok (pinnacle_ask_stale_hours **0.2h** — the 56ad4ff/re-enable fix HOLDING). Sentinel ts_uuid_dupes_24h 0. Artifacts spot-checked healthy (v_tracked_wallet_fmv_confidence 20 rows, squeeze 500+, pack_reality_top_ev 6, v_rewards_economy ok).

## Focus item 1 — wave-watch data point (00Z wave on f41caf4, pre-06Z)

The 06:00Z wave is still ahead of this run; here is the 00Z–01Z reading for the night pass:

- **wallet-backfill family: 0 fails across all 6 variants** (wallet-backfill 100 ok, -allday 330, -pinnacle 267, -multicollection dispatch 262 / complete 147, -golazos 48, -ufc 23; last runs ~02:50Z). No 5xx storm signature.
- **upsert_wmc_batch in pg_stat_statements: 23 calls, mean 186ms, max 2.0s** — under the <500ms target.
- **Cross-pipeline saturation DID still occur 00:08–01:06Z** (~30 fails / 15 pipelines, all statement-timeout/pool class: wmc-fmv-populate 7, topshot-buyer-backfill 5, pinnacle-nft-resolver 4, hydrator 3, pack-ev 3, reconcile 2, singletons elsewhere), then **fully quiet 01:06→03:05Z**. Milder + shorter than the prior two nights' 05–08:30Z windows; no trust-health breach this time (reconcile recovered, 11 ok/8h). Verdict so far: improvement, not elimination — the 06Z wave is the decisive data point (DBSAT re-baseline is already carried; this is supporting data, not a new item).
- 202-wrap (c55d394) logging confirmed: analytics-smoke 15 ok/8h, lock-check-batch 15 ok/8h, reconcile logging normally.

## New candidates

### 1. NEXTJS-1K — `/share/:wallet` "TypeError: Load failed" (NEW, recent-ship correlation) — MED-HIGH
- Source: Sentry JAVASCRIPT-NEXTJS-1K, first seen ~02:10Z 2026-06-10, 2 events / 2 users, culprit `/share/:wallet`.
- Correlates with today's funnel ship `c576172` (ShareEmptyState queue + "Analyzing your wallet…" poll of collection-snapshot + reload). "Load failed" is the WebKit/Safari fetch-abort TypeError — most likely the new client-side poll fetch failing (network blip, abort-on-navigate, or the poll hitting an authed/CORS-failing endpoint anonymously).
- Risk read: low blast radius today (2 events) but this is THE public funnel surface; if the poll throws unhandled on iOS Safari the empty-state breaks for exactly the new-user cohort it was built for.
- Suggested action (night pass / CC): read the NEXTJS-1K event JSON (browser, URL, stack), and if it's the ShareEmptyState poll, wrap the poll fetch in try/catch with fallback to the retry box (and ignore AbortError). Do not revert — feature otherwise verified.

### 2. SMOKE-EDITION-TIMEOUT escalation note (NEXTJS-1H/1J) — update to EXISTING queued item, not a new item
- NEXTJS-1H "edition page has Recent Sales" now 4 events/21h; NEXTJS-1J "pack dist page has Sales History" 6 events/21h; both last seen ~02:47Z. No longer the single-cold-start shape — intermittent-recurring, clustering in the saturation windows. Still looks like the timeout class (events align with the 00–01Z wave + earlier waves), but if the night pass has a clean window, one manual anon fetch of an edition page + pack dist page would distinguish "section truly missing" from "smoke fetch timing out".

## Carried, observed, NOT re-raised
- PINFMV-DRIFT-14 (NEXTJS-14) still firing (16 events/22h, last 02:55Z) — carried, CC/Trevor-owned, off-limits.
- DB size 6,842 MB (+155 MB since 08:30Z baseline 6,687) — existing creep watch.
- TS FMV latest-per-edition: HIGH+MED **2,857** (554 H / 2,303 M) vs last-known 2,917 — small dip, within churn; NO_DATA **4,761** (improving from 5,029). unmapped_sales open 183 (flat). TS editions 15,542 (flat).
- NEXTJS-15 listing_resolution_failures (PIN1 class) 3 events/10h — known.
- Smoke singleton cluster (NEXTJS-A/-4/-E/-1E/-W) all quiet 2h+ — saturation-window echoes.
