# UFC Strike — collection roadmap (refreshed 2026-10-17, PT)
> Dated snapshot; every number is a dated sample — re-derive before quoting. Canonical plan: [roadmap-2026-10-17.md](../roadmap-2026-10-17.md). Defects: [known-issues.md](../../reference/known-issues.md) (item text wins over this file).

## Where it stands
**A closed-market archive, published on purpose.** The Flow market is closed: the native studio feed ended 2025-08-07, and the last Flow sale of any kind was **2026-05-13 10:06 AM PT** ([lib/market-closed.ts](../../../lib/market-closed.ts); `v_collection_marketplace_status` = `shutdown`, buy CTAs off). UFC itself moved to Aptos.

Live reads, ~6:00 PM PT 10-17:
- **846,344** UFC sales. **0** in the last 30 days and **0** in the last 90.
- **518** editions. FMV is **517 STALE + 1 NO_DATA**, so HIGH/MED is **0.0%**. **That number is the honest label, not a regression.** The roadmap says "the only correct product answer is a label" ([roadmap-2026-08-03](../roadmap-2026-08-03.md) §141, §132).
- Holdings cache: 4,525 rows across 120 wallets, **0** with a null `edition_key`.
- Tabs: overview, collection, sets and analytics. **There is no sniper tab** (Trevor, 09-06; `pages` in [lib/collections.ts](../../../lib/collections.ts)).
- `MarketplaceStatusBanner` and the closed-market chrome label every surface.

## Shipped recently (since mid-September)
- **10-04:** 13,016 chain-verified Flowty/Dapper sales named from the chain's set metadata and promoted (`ufc_chain_set_editions`). UFC now holds **32,410** sales from the `flowty_chain_*` / `dapper_chain_tx_v1` sources, dated 2023-11 → 2026-04. Also: `get_edition_recent_sales` dropped from 7.1 s to 63 ms on the UFC editions that had timed out, and the market-cap rank line stopped saying "of 0 players".
- **10-10:** #186 closed as **not a defect**. The chain confirms our UFC holdings, and Dapper's `searchUFCNft` owner index is stale in both directions. UFC lock UI was removed after an on-chain check found no locking.
- **10-14:** the `/ufc/overview` About card no longer promises a sniper. The closed-market guard gained a trading-claim arm. The `ufc-listing-cache` route got an E5 heartbeat.
- **10-17:** UFC Series 0 (0 editions) is now `noindex` with honest copy (`3bcf40138`), and it is out of the sitemap (`f5a4aa06e`, verified live 4:10 PM PT).

## Open issues
No numbered register item is open for UFC. Recorded but not changed:
- **371 of 518 editions have a NULL `series`.** They were ingested after the close, so they appear on no series page.
- **Two malformed rows:** `KHABIB-TIME-901` and `YOU-SUCK-2-0-750` (the mint number was parsed into the name). The literal UPDATE is held ([afternoon handoff 10-17](../../handoff-2026-10-17-cowork-afternoon-pass.md)).
- **Sales the catalogue cannot name:** 47 on-chain sets map to editions RPC's catalogue lacks. That leaves 361 + 615 + 50 sales unpromoted, and they are never guessed (ledger 10-04).
- **Zero-yield lanes are still scheduled** (see Now).
- **Stale text.** These statements contradict live state:
  - The [lib/collections.ts](../../../lib/collections.ts) header says "UFC Strike — unpublished". It is `published: true`.
  - The UFC `pitch` says "147 editions tracked, 29 with FMV… backfill in progress". Live: 518 editions, all STALE, no backfill running.
  - The `v_collection_marketplace_status.notes` row still says "sales-indexer kept loose… studio history backfill + wallet walks continue" and "813k". Those lanes were retired 08-27 (#44), and the total is now 846k.
  - [roadmap-2026-08-02](../roadmap-2026-08-02.md) calls Flowty's UFC history "essentially absent… likely unrecoverable". That is now true only before the 2023-11 floor.

## Next — prioritized
**Now**
1. ✅ **DONE 2026-10-18 ~7:15 AM PT (Cowork cloud, Trevor: "Yes do it") — both cron-job.org entries DISABLED, not deleted (7804392, 7585607), confirmed Inactive on the jobs list; their `pipeline_cadence_watchlist` arms deactivated with notes.** Caller census: no pg_cron, `vercel.json`, GHA or in-repo caller. Re-measured over 30 d from `pipeline_runs_daily`: drain 1,417 runs, 0 written; resolver 1,415 runs, 0 found. The falsifier is already watched: `check_wmc_null_edition_key()` is collection-agnostic, and UFC had 0 null-key rows at retirement. `wallet-backfill-ufc` was NOT slowed: it has no console entry of its own (fired per wallet by `wallet-backfill-multicollection`, plus an in-route 12 h gate), so slowing it is a code change, not a console edit. ~~Retire `ufc-enrichment-drain` and `ufc-stub-thumbnail-resolver`.~~
   - *Why:* over 30 days, each ran 48 times a day. The drain wrote **0** rows, and since 10-16 it has found nothing ("no null-edition_key UFC rows"). The resolver found and wrote **0**, every day since 09-18. #44's rule: retire by measured yield.
   - *Gate:* neither job is in pg_cron, `vercel.json` or GHA, so the trigger is probably cron-job.org, which a sandbox cannot see. Enumerate every caller first, and add a ledger revert path.
   - *Falsifier:* a new null-key row appears. The wallet walk can create one, so leave a cheap weekly check or the watchlist row.
2. **Correct the stale text listed above.**
   - The registry header, `pitch` and status-view notes are pure honesty fixes.
   - *Gate:* `grep -rl` `__tests__` for the pitch string before editing (registry-value rule). The view notes change through a migration.

**Next**
3. **Right-size `wallet-backfill-ufc`. Do not retire it.**
   - *Why:* about 340 runs a day re-read about 5,674 rows and usually write 0. It still catches real changes, though: 198 on 09-23, 74 on 09-27 and 14 on 10-15. Holdings change even without a market (transfers, migration burns).
   - *Falsifier:* if a 30-day total writes 0, drop it to daily.
4. ~~Repair the two malformed edition rows~~ — **decided 10-17: only from source metadata, never a guessed UPDATE** (see Needs Trevor).

**Later**
5. **Delete the dead UFC route code:** `ufc-listing-cache`, `ufc-listings-indexer`, `ufc-pipeline`, `ufc-sales-indexer` and the two history backfills. *Gate:* their callers are confirmed gone (#44 removed the last trigger), and the guards that read them are re-pinned.
6. **Optional: back-fill `series` for the 371 NULL editions** from on-chain set metadata. It is archive polish with no accuracy payoff, so do it only if it is cheap.
7. **Aptos:** watch, don't build. Revisit only if UFC on Aptos develops a real, indexable market.

## Decisions on record (do not re-litigate)
- **No sniper tab** while the market is closed (Trevor, 09-06). Restoring it is a one-word `pages` change if the market reopens.
- **Retire UFC search pipelines once history is ingested** (Trevor, 08-27, #44). Retire by per-pipeline yield, never by collection name.
- **HIGH/MED 0.0% stays.** No model manufactures a price for a dead market. Treat UFC volume and FMV as a floor, not a census.
- **No Offers in JSON-LD** for UFC (deliberate honesty, roadmap 08-03 §83). No lock UI (no on-chain locking). There is no on-chain burn counter either, so market cap stays "Unknown" (ledger 10-03).
- **Aptos is watch-only** ([roadmap-2026-07-10](../roadmap-2026-07-10.md)).
- **Never read UFC holdings from `searchUFCNft`** (#186; [packs.md](../../reference/packs.md)).

## Needs Trevor

- ✅ **Zero-yield lanes: DECIDED 10-17 — retire them** at the next cron-job.org console session; slow `wallet-backfill-ufc` there too ([roadmap-status.md](../../reference/roadmap-status.md), "Decisions taken — the docs-refresh open list"). Not a Trevor decision any more, just console access.
- ✅ **Two malformed rows: DECIDED 10-17 — leave them as they are.** Re-read live ~8 PM PT: `KHABIB-TIME-901` ("Khabib Time 901", set "901") and `YOU-SUCK-2-0-750` ("You Suck 2 0 750", set "2 0"). Their true names cannot be verified on a closed market with no source metadata, and a guessed UPDATE would fabricate a label. Repair them only from source metadata.

## Where the detail lives
- [lib/market-closed.ts](../../../lib/market-closed.ts) · [lib/collections.ts](../../../lib/collections.ts)
- [known-issues.md](../../reference/known-issues.md): #44, #105/#106 (OG art), #186
- [ledger.md](../../overnight/ledger.md): 10-04, 10-10, 10-14 and 10-17 entries
- [roadmap-2026-08-03.md](../roadmap-2026-08-03.md) · [roadmap-2026-08-02.md](../roadmap-2026-08-02.md)
- [cron-and-schedulers.md](../../reference/cron-and-schedulers.md) · [sessions/2026-10.md](../../sessions/2026-10.md)
- [handoff-ufc-enrichment-decoupled-cron.md](../../handoff-ufc-enrichment-decoupled-cron.md) (why the drain exists)
