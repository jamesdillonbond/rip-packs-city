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
- ✅ **TIER and SERIES were wrong across the catalogue — corrected from the chain 2026-10-18 (~9:30 AM PT).** Every UFC tier was FABRICATED by `inferTier()` from edition size: <=999 "CHALLENGER", <=25,000 "CONTENDER". Neither exists on chain. The chain's TIER trait (`UFC_NFT.getSetMetadata`, stored in `public.ufc_chain_set_metadata`, 628 sets, migration `20261018160339`) is Common / Uncommon / Rare / Epic / Champion / Ultimate / Fandom. Over the 517 chain-mapped editions, 503 carried a fabricated tier, and the chain said Common 185, Rare 139, Uncommon 72, Fandom 64, Epic 33, Champion 9. Series disagreed on 405 (the old "371 NULL" line, plus 25 stored 1 where the chain says 0 and 17 stored 1 where it says 2). `tier_type` gained EPIC (`20261018160852`); the data fix is `20261018163000`. `enrich-ufc-wallet` now copies tier and series from editions instead of inventing them. The 14 catchphrase moments carry no TIER on chain, so they read NULL (unknown).
  - **Still open from this:** (a) ✅ ~~EPIC sorted below Common~~ — fixed 10-18 11:27 AM PT in `get_set_editions`, the only one of the seven tier-CASE functions that orders by the rank (series / player sort by FMV; team functions serve hubs UFC lacks). (b) `seed-ufc-editions` (edge, no caller) still carries an `inferTier`; fix it if it is ever revived.
- ⚠ **The chain's own SET taxonomy is not RPC's.** On chain, `SET` is a separate trait: Base 479, Maple Rush 37, Lights Out II 33, Collector's Choice 15, Dojo / Lights Out / Tapped 10 each, PRIDE FC 9, Icons and The 209 4 each, Starter Pack 1, plus 15 catchphrase / promo sets with no SET. RPC's UFC "sets" are EVENT + FIGHT TYPE groups ("UFC 260 KO TKO", 394 of them), an RPC convention since the May ingest. The 10-18 morning fixes repaired names inside that convention. They did not move moments into the chain's sets, and the ledger's "real on-chain set" wording overstates them. **Decided 10-18:** keep the event groups as the set label (see Needs Trevor).
- ✅ **FIXED 2026-10-18 ~8:22 AM PT from the chain:** `KHABIB-TIME-901` → Khabib Nurmagomedov / set "KHABIB TIME", `YOU-SUCK-2-0-750` → Matt Frevola / set "YOU SUCK 2.0" (on-chain Display + Editions, chain set ids 234 and 328). ~~**Two malformed rows:** `KHABIB-TIME-901` and `YOU-SUCK-2-0-750` (the mint number was parsed into the name). The literal UPDATE is held ([afternoon handoff 10-17](../../handoff-2026-10-17-cowork-afternoon-pass.md)).
- ✅ **Name-parsing bug FIXED across the catalogue 2026-10-18 8:32 AM PT from the chain** (migration `20261018153214`, backup table `audit_20261018_ufc_names_backup`): 19 sets with a leaked surname fragment, 10 Pride FC / Noche fighters carrying the set string, and 10 catchphrase moments whose fighter was the phrase. Each catchphrase fighter comes from the NFT's on-chain Display description. ✅ **Follow-up done the same morning (8:51–8:56 AM PT, Trevor "Do it all")**: the 147 tier-word-set editions moved to their chain sets (102 sets created), the 72 editions with no set link were linked (43 created), and six fighters got their chain spelling back (Sean O'Malley, Georges St-Pierre, Benoit Saint-Denis, Marc-Andre Barriault, Da'Mon Blackshear, Terrance McKinney). Script: `docs/audits/2026-10-18-ufc-tier-word-sets-and-fighter-punctuation.sql`. **Residue:** the three now-EMPTY `sets` rows "Contender" / "Challenger" / "Fandom" are not deleted (the MCP holds a DELETE). They are harmless (nothing lists an empty set), and removing them is the one-line DELETE in that script's comment.
- ✅ **Sales the catalogue could not name — FIXED 10-18 (10:52–11:07 AM PT).** The 100 real chain sets with no RPC edition now have one: 99 created from `getSetMetadata` (54 Champions, 13 Ultimates, 35 Origin 1/1s, …) and 1 linked. 671 historical sales ($83,036) were promoted onto 56 of them, and all 617 real chain sets are mapped. UFC now has 617 editions (was 518). Not created: 10 retired contract sets and the EMERALD KEY pack insert. Sets 621 and 623's gigantik videos were moved to ipfs at 11:25 AM; no UFC media references gigantik.
- ✅ ~~**Zero-yield lanes are still scheduled**~~ — disabled 10-18 ~7:15 AM PT (see Now 1).
- ✅ **Stale text — FIXED 2026-10-18 ~8:10 AM PT** (the registry header and `pitch` had already been corrected by another session; this pass fixed the rest: the `/analytics` methodology line, the UFC banner and moment-page copy ("is migrating" → "moved to Aptos; Flow trading closed in May 2026"), and the `collection_config` marketplace notes). Original list kept below:
  - The [lib/collections.ts](../../../lib/collections.ts) header says "UFC Strike — unpublished". It is `published: true`.
  - The UFC `pitch` says "147 editions tracked, 29 with FMV… backfill in progress". Live: 518 editions, all STALE, no backfill running.
  - The `v_collection_marketplace_status.notes` row still says "sales-indexer kept loose… studio history backfill + wallet walks continue" and "813k". Those lanes were retired 08-27 (#44), and the total is now 846k.
  - [roadmap-2026-08-02](../roadmap-2026-08-02.md) calls Flowty's UFC history "essentially absent… likely unrecoverable". That is now true only before the 2023-11 floor.

## Next — prioritized
**Now**
1. ✅ **DONE 2026-10-18 ~7:15 AM PT (Cowork cloud, Trevor: "Yes do it") — both cron-job.org entries DISABLED, not deleted (7804392, 7585607), confirmed Inactive on the jobs list; their `pipeline_cadence_watchlist` arms deactivated with notes.** Caller census: no pg_cron, `vercel.json`, GHA or in-repo caller. Re-measured over 30 d from `pipeline_runs_daily`: drain 1,417 runs, 0 written; resolver 1,415 runs, 0 found. The falsifier is already watched: `check_wmc_null_edition_key()` is collection-agnostic, and UFC had 0 null-key rows at retirement. `wallet-backfill-ufc` was NOT slowed: it has no console entry of its own (fired per wallet by `wallet-backfill-multicollection`, plus an in-route 12 h gate), so slowing it is a code change, not a console edit. ⓘ **Measured 10-18 ~7:45 AM PT and NOT changed:** 48 h = 720 runs at ~0.5 s each (~6 min of compute a day), in waves at 4–7 PM and 5–6 AM PT, still catching real holdings changes (391 rows in 30 d). A code change to slow it would cost more than it saves; re-open only if a run gets expensive. ~~Retire `ufc-enrichment-drain` and `ufc-stub-thumbnail-resolver`.~~
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
6. ✅ ~~Back-fill `series` for the 371 NULL editions~~ — done from chain metadata 10-18 with the tier correction (it was an accuracy defect after all: 42 stored series were wrong, not just missing).
7. **Aptos:** watch, don't build. Revisit only if UFC on Aptos develops a real, indexable market.

## Decisions on record (do not re-litigate)
- **No sniper tab** while the market is closed (Trevor, 09-06). Restoring it is a one-word `pages` change if the market reopens.
- **Retire UFC search pipelines once history is ingested** (Trevor, 08-27, #44). Retire by per-pipeline yield, never by collection name.
- **HIGH/MED 0.0% stays.** No model manufactures a price for a dead market. Treat UFC volume and FMV as a floor, not a census.
- **No Offers in JSON-LD** for UFC (deliberate honesty, roadmap 08-03 §83). No lock UI (no on-chain locking). There is no on-chain burn counter either, so market cap stays "Unknown" (ledger 10-03).
- **Aptos is watch-only** ([roadmap-2026-07-10](../roadmap-2026-07-10.md)).
- **Never read UFC holdings from `searchUFCNft`** (#186; [packs.md](../../reference/packs.md)).

## Needs Trevor

- ✅ **UFC set pages: DECIDED 10-18 (Trevor delegated: "Do what you think is best") — keep the event + fight-type groups as the catalogue's set label; do not move editions into the chain SET trait.** Why: `set_name` is where the event and fight type live for UFC. `editions.name` is filled on only 219 of 518, and every surface renders "fighter — set name" (edition title, holdings, trophies, search). Moving to the chain sets would turn "Sean O'Malley — UFC 260 KO TKO" into "Sean O'Malley — Base Series 2", and a fighter's several Base moments would be told apart only by tier. The chain SET trait stays available in `ufc_chain_set_metadata.set_trait` (Base by series, Maple Rush, Lights Out II, Collector's Choice, Dojo, Lights Out, Tapped, PRIDE FC, Icons, The 209, Starter Pack). If a chain-set completion view is ever wanted, build it as an ADDITIONAL grouping over that table, not a re-parent of editions.

- ✅ **Zero-yield lanes: DECIDED 10-17 — retire them** at the next cron-job.org console session; slow `wallet-backfill-ufc` there too ([roadmap-status.md](../../reference/roadmap-status.md), "Decisions taken — the docs-refresh open list"). Not a Trevor decision any more, just console access.
- ✅ **Two malformed rows: DECIDED 10-17 — leave them as they are.** Re-read live ~8 PM PT: `KHABIB-TIME-901` ("Khabib Time 901", set "901") and `YOU-SUCK-2-0-750` ("You Suck 2 0 750", set "2 0"). Their true names cannot be verified on a closed market with no source metadata, and a guessed UPDATE would fabricate a label. Repair them only from source metadata.

## Where the detail lives
- [lib/market-closed.ts](../../../lib/market-closed.ts) · [lib/collections.ts](../../../lib/collections.ts)
- [known-issues.md](../../reference/known-issues.md): #44, #105/#106 (OG art), #186
- [ledger.md](../../overnight/ledger.md): 10-04, 10-10, 10-14 and 10-17 entries
- [roadmap-2026-08-03.md](../roadmap-2026-08-03.md) · [roadmap-2026-08-02.md](../roadmap-2026-08-02.md)
- [cron-and-schedulers.md](../../reference/cron-and-schedulers.md) · [sessions/2026-10.md](../../sessions/2026-10.md)
- [handoff-ufc-enrichment-decoupled-cron.md](../../handoff-ufc-enrichment-decoupled-cron.md) (why the drain exists)
