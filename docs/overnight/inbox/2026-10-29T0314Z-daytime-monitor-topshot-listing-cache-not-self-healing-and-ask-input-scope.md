# Daytime monitor — topshot-listing-cache did NOT self-heal (refutes the 00:15Z outage-tail call); + accurate ask-input freshness scope

**Status: 🟢 infra GREEN · WATCH / LOW · read-only · NOT a spell (io_wait 4 / active 6, nothing timed out; an active interactive build wave is live).** Follow-up to `2026-10-29T0015Z-daytime-monitor-topshot-listing-lanes-dark-after-dapper-notice-lifted.md`.

## 1. The 00:15Z self-heal prediction is REFUTED
The 00:15Z filing flagged `topshot-listing-cache` 0-success (~20h) as "almost certainly outage-tail that should self-heal now the atlas lanes answer 200s again," and set action #1: *a post-00:10Z tick that STILL returns page-0 HTTP 500 means the listing endpoint is not Dapper-tail but a distinct break worth inspecting independently.*

That trigger is now MET. At this tick (~03:14Z, ~3h and ~8 ticks later):
- `topshot-listing-cache` still **0 ok over 18 runs / 6h**; last ok **2026-10-28 04:15Z (~23h)**; every run `sweep incomplete: page 0 (offset 0) returned HTTP 500`.
- Meanwhile the atlas lanes are fully healthy and have been since ~00:10Z: atlas-market-feed last ok 03:07Z (52/60 2h), atlas-editions-refresh 03:07Z (59/60), topshot-pack-supply-atlas 03:08Z (103/114), pinnacle-sales-indexer 03:04Z (6/6).

So the listing-cache HTTP 500 is behaving as a **distinct listing-endpoint break, independent of the (recovered) atlas lanes** — exactly the condition 00:15Z said warrants independent inspection. (No causal claim on the 500 itself — verify, don't conclude.)

## 2. Scope correction — TS user-facing asks are FINE; the stale ask surface is AllDay/Golazos/Pinnacle
The 00:15Z worry was "TS ASK_ONLY FMV + 'Listed' asks drift stale behind a healthy banner." But TS live asks now come from **`ts_listings`, which is FRESH: newest ingest 03:05Z (0.1h), 19,864 rows** (per the 10-25 focus steer, TS moment pages read `ts_listings`). So `topshot-listing-cache`/`cached_listings` looks **redundant/legacy for TS** — user-facing TS ask impact is likely nil. `topshot_fmv_stale_hours` 0.2 (ok).
- Night pass: before weighing any "listing-feeder staleness guard," confirm whether fmv-recalc TS **ASK_ONLY** reads `cached_listings`/`badge_editions.low_ask` (stale) or `ts_listings` (fresh). If the live TS ask path is `ts_listings`, the right disposition may be to **retire the redundant topshot-listing-cache lane**, not repair it.

The genuinely-stale ask-input surface (which 00:15Z did not examine) is **`cached_listings_v2` — AllDay / Golazos / Pinnacle only (TS is not in this table)** — frozen since 10-27 ~16:17Z (~35h):
- nfl_all_day (direct_v2 678 + storefront_v2 82): newest ingest **10-27 16:17Z**
- disney_pinnacle (direct 886): newest **10-27 16:25Z**
- laliga_golazos (direct_v2 1): newest **10-27 13:07Z**

AllDay + Pinnacle are **known-still-in-Dapper-maintenance** (the active interactive sessions are holding the per-collection maintenance notice, 0 sales, each lifts on its own volume, backstop 2026-11-04 — commit `3f0a4836`), so their listing freeze is **expected, not a defect**. **Golazos is NOT named in the recovery commits** — verify whether its listing feeder is quiet-market or independently wedged.

⚠ `*_fmv_stale_hours` stays green for all three (it measures FMV recompute recency, not ask-input age), so this ask staleness is **invisible to the trust gate** — the silent-staleness class this monitor exists to surface.

## Suggested action (night pass — read-only confirm first; quiet-window)
1. Confirm `topshot-listing-cache` is a distinct listing-endpoint break (not atlas tail). Given `ts_listings` carries fresh live TS asks, weigh **retire the redundant lane** vs repair — check which path fmv-recalc ASK_ONLY actually reads first.
2. Re-measure `cached_listings_v2` ask-input age per collection in a quiet window. AllDay/Pinnacle should clear when Dapper fully reopens (managed); **isolate whether laliga_golazos is market-quiet or wedged.**

**Risk: LOW** — read-only watch, no shippable action proposed. Everything broken-looking traces to the known/managed Dapper upstream recovery; TS fully fresh; security 0/0/0/0, trust 0 breaches, pg_cron clean, 16/16 dashboard objects valid, last prod deploy READY.

## ↳ Context from Claude Code cloud (10-28 ~8:25 PM PT) — this is the FLOWTY shutdown, already tracked
`topshot-listing-cache`, `allday-listing-cache` and `golazos-listing-cache` are the three **Flowty API** lanes (via the `flowty-proxy` edge function), not Dapper or Atlas lanes. All three went DARK together at ~9:20 PM PT 10-27, about 12 h after the Dapper outage began and independent of it. They are tracked in `docs/operations/flowty-retirement-runbook.md` §0: DARK ×3, teardown pre-staged, and **held by Trevor** (10-28 ~7:45 AM PT) until Dapper is fully back (All Day trading again), then 24 h more. The runbook already establishes nothing priced depends on these lanes (Top Shot asks read `ts_listings`; All Day / Golazos read the on-chain `cached_listings_v2` book). So "retire, don't repair" is the plan of record; do not open a separate repair. The All Day / Golazos / Pinnacle `cached_listings_v2` freeze is the Dapper markets still being closed (0 storefront events for those NFT types since 10-27 ~9:30 AM PT).
