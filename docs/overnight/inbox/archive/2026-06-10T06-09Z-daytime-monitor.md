# Daytime monitor — 2026-06-10T06:09Z

Run context: lock present but stale (2026-06-09 08:42, ~21h — treated as released; commit proceeding). 20/20 prod deploys READY — very heavy ship day since the 03:05Z run: light-mode Phase 0 → Batch 2 + un-gate (`206818f`/`4dd98ba`/`2d58b72`), pack-sniper wave (`add59faf`/`b8233f0`/`ba83f96`/`4231e07`/`6FwCnET…`), pin-list row-cap fix (`e05030b`), onboarding leak fixes (`bf7cd33`), PINFMV-DRIFT-14 guard fix (`4138db6`), and head `7b03815` (SEO: stop advertising 6,404 TS fossil editions; deployed 06:01Z, minutes before this run). Security 0/0 (RLS-off [], anon-write base tables []). `detect_stalled_pipelines()` = []. Trust health 6/6 ok (pinnacle_ask_stale_hours **0.2h** — holding). ts_uuid_dupes_24h 0. Artifacts spot-checked healthy (fmv_confidence 20 rows, squeeze 500+, pack_reality 6, rewards 1, pinnacle_catalog priced 1,806).

## Focus item 1 — wave-watch datapoint (pre-06Z-wave reading)

- **wallet-backfill family: 0 fails / 7h across all 7 variants** (wallet-backfill 106 ok, -allday 336, -pinnacle 273, -mc dispatch 268 / complete 153, -golazos 54, -ufc 29; last runs ~04:33–04:35Z). No 5xx storm.
- **upsert_wmc_batch: 38 calls cumulative, mean 169ms, max 2.0s** — well under the <500ms target.
- **Saturation: confined to 00:08–01:06Z** (~35 fails / 15 pipelines, all timeout/pool class), then essentially quiet — only 3 stragglers (reconcile 03:09Z, hydrator 04:42Z, analytics-smoke 04:43Z) and **zero fails 04:43→06:05Z**. Clearly milder than the prior nights' 05–08:30Z windows; no trust-health breach. The 06:45–06:58Z wave lands after this run — next monitor/night pass gets the decisive reading.
- 202-wrap still logging (analytics-smoke 2 fails/6h were DB statement-timeouts inside the run, not the 30s cap; lock-check-batch 1 fail 00:08Z pool-timeout, recovered).

## Positive verifications (close-out datapoints, no action needed beyond ledger updates)

1. **b7211fb-VOLUME-WATCH — gate MET, closeable.** TS sales at the 06-09 peak: 14Z 216, 15Z 156, 16Z 130, 17Z 102, 18Z 204, 19Z 146, 20Z 132, 21Z 148, 22Z 107, 23Z 115/hr — squarely in the 100–250/hr target band. Recommend the night pass close the watch in the ledger.
2. **PINFMV-DRIFT-14 / NEXTJS-14 — quiet post-fix.** `4138db6` (drift-guard comparison-set fix) deployed ~05:46Z; NEXTJS-14 absent from the post-22Z unresolved list (was 16 events/22h through 02:55Z). After a further clean window, mark the Sentry issue resolved with regression arming.

## New/updated candidates

### 1. SMOKE-EDITION-TIMEOUT — ESCALATION datapoint (update to EXISTING queued item) — MED
- Source: Sentry NEXTJS-1H ("edition page has Recent Sales") **9 events/6h**, NEXTJS-1J ("pack dist page has Sales History") **8 events/6h**, both last ~05:32–05:41Z, both showing first-seen ~00:10Z (fresh issue-groups → prior resolves regressed or re-grouped).
- Key new fact: these fired **outside the DB-saturation window** (pipeline fails were zero 04:43→06:05Z, yet smoke failed at ~05:3x–05:4xZ). The "pure saturation echo" explanation is weakening; at ~12 smoke ticks/6h this is a majority-of-ticks failure rate for 1H.
- Monitor could not do the distinguishing anon page-fetch (sandbox web-fetch provenance restriction). Suggested action (night pass/CC): manually fetch one canonical TS edition page + one pack dist page anonymously and check the Recent Sales / Sales History sections actually render; if they do, the fix is in the smoke checkUrl budget/retry, not the pages.
- Related watch (NEW, post-`7b03815`): the fossil-edition 404 change deployed 06:01Z means any smoke/edition-check that selects a **hyphenated TS slug** now gets a by-design 404. All 1H/1J events predate the deploy, so it's not the cause of tonight's failures — but verify the smoke edition-URL picker only selects canonical int-pair slugs, otherwise 1H goes permanently red starting tonight.

### 2. NEXTJS-1K `/share/:wallet` "TypeError: Load failed" — carried, no escalation
- Still 2 events / 2 users, quiet ~3h. Already logged 03:05Z with the ShareEmptyState-poll diagnosis. No new events → keep queued, no urgency bump.

## Carried, observed, NOT re-raised
- DB size **6,865 MB** (+178 vs 06-09 08:30Z baseline 6,687; +23 since 03:05Z) — existing creep watch.
- TS FMV latest-per-edition: HIGH+MED **2,864** (565 H / 2,299 M), NO_DATA **4,721** (improving), ASK_ONLY 994, STALE 238 — flat-to-improving vs 03:05Z.
- TS editions 15,542 / unmapped_sales open 183 — both flat.
- NEXTJS-15 listing_resolution_failures (PIN1/Q4 class) 3 events, last 7h — known.
- Smoke saturation singletons (NEXTJS-A/-4/-E/-1E) low-count, consistent with the 00–01Z window.
