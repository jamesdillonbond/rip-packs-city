# UFC dormancy: every DB-side instrument agrees, one apparent counter-signal is REFUTED, and the decisive test is still operator-only

**Filed 2026-08-18 14:00 PT (21:00Z) · Claude Code (interactive) · READ-ONLY, nothing shipped for this item.**

Follow-up to `2026-08-17T2210Z-ufc-strike-has-had-zero-sales-for-96-days-and-the-indexer-reports-ok.md`,
which named one decisive test it did not run: **does upstream show any UFC sale after 2026-05-13?**

## What I could settle, and what I could not

⛔ **I could NOT run the decisive test.** Flowty is reachable only through the `flowty-proxy` Supabase
edge function (Vercel IPs are blocked upstream), which is gate-key'd. That is operator territory and
the key must not pass through a transcript. **So the dormancy question is still formally open** — what
follows raises confidence, it does not close it.

## Re-derived, and one filed signal turns out to be a red herring

| instrument | UFC | control | control verdict |
|---|---|---|---|
| `sales.sold_at` | last **2026-05-13 17:06Z**, 0 in 90d | `nba_top_shot` last **2026-08-18 20:42Z** | indexer demonstrably live |
| `flowty_transactions.created_at` | last **2026-05-23**, 1 in 90d | `topshot` last **2026-05-24** | ⚠ see below |
| `cached_listings_v2` | **no rows at all** | `nba_top_shot` also **no rows** | ⚠ not an instrument for either |

⚠ **`flowty_transactions` reads UFC activity TEN DAYS LATER than the last recorded sale (05-23 vs
05-13), which looks exactly like the indexer missing trades. It is not.** The same table's Top Shot
column stops at **2026-05-24**, while Top Shot `sales` is current to the minute. **The whole
`flowty_transactions` feed died ~2026-05-24 across every collection.** Without that control the 05-23
row would have been read as "UFC traded after the indexer's last sale ⇒ the indexer is broken" — the
opposite of the truth, and the same shape of error this register keeps recording.

⚠ **`cached_listings_v2` holds NO UFC rows — and no Top Shot rows either** (Top Shot listings live in
`topshot_active_listings` / `ts_listings`). **Absence there is therefore NOT evidence of a dead UFC
order book**; it means UFC has no listing-ingestion instrument at all. Do not cite it as dormancy
evidence — I nearly did.

## Where that leaves the disposition

Everything measurable from the database is **consistent with genuine dormancy**, and the strongest
positive evidence remains the 08-17 filing's own: the indexer sees other collections' sales in the
very same scans (`v2_dapper_typeids_seen` carries TopShot/AllDay/Pinnacle/Golazos/PackNFT, no UFC type
id at all), so it is not blind, not wedged and not mis-filtering.

⚠ **What is NOT settled, and why I shipped no monitoring change for it.** The 08-17 filing notes that
no UFC pipeline sits on `pipeline_cadence_watchlist`. Adding some looked like the obvious independent
fix. **It is not independent:** if UFC is dormant and a candidate for de-listing, watchlist rows for
its pipelines would page on a collection nobody intends to keep, and the 08-18 `0450Z`/`0455Z`
measurements show a naive median-derived threshold produces chronic false-firers (and that a NULL
threshold is a **silent pass**, so six pipelines would be "watched" while monitoring nothing). **The
right watchlist membership depends on the disposition, so the disposition comes first.**

## The two things that need a person

1. **One upstream query** (Flowty / the UFC Strike marketplace) for any sale after 2026-05-13. Upstream
   shows sales ⇒ the indexer is silently broken and the platform has been serving a 5-collection claim
   on 4. Upstream shows nothing ⇒ dormancy confirmed.
2. **The product call**: whether a collection with no trades in 97 days is still presented as one of
   the five live collections — and, downstream of that, whether `ufc_fmv_stale_hours` should be
   suppressed (it is currently an arm that no ingest fix can ever clear).
