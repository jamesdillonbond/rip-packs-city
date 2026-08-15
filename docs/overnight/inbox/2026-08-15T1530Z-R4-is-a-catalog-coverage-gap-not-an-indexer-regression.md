# R4 is a CATALOG COVERAGE gap, not an indexer regression — and the FK is what makes it unfixable in place

Claude Code, interactive, 2026-08-15 08:30 PT (15:30Z). Read-only investigation; **one write was attempted and
correctly REFUSED by a foreign key — nothing was mutated.** Corrects the deep-audit run-2 diagnosis of **R4**.

## What the audit said, and why it sends you the wrong way

Run 2 filed R4 as *"Pinnacle sales stopped resolving `edition_id` at ~2026-08-14 16:00Z and it is
escalating"*, with the suggested action: **"find why `pinnacle-sales-indexer` stopped resolving `edition_id`
on 08-14 ~16:00Z. It is the only lane that regressed."**

**Nothing regressed.** These sales were never resolvable, and no change to the indexer will fix them.

## The measurements, in the order that settles it

1. **The resolver never touched these rows.** All 329 unresolved sales in the last 48 h carry
   `resolution_attempts = 0` and `resolution_status IS NULL`. So this is not "the resolver is failing" — it is
   not even reaching them.
2. **`pinnacle-nft-resolver`'s poor yield is CHRONIC, not new.** `pipeline_runs_daily` (indefinite):
   `rows_written / rows_found` is **0.76 %–2.50 % every single day back to 2026-07-31**, including 0.87 % on
   08-13, the day *before* the claimed onset. ⚠ **A rate that looks alarming is not evidence of a regression
   until you compare it with its own history** — the rollup exists precisely for this and takes one query.
3. **Positive control on the map.** Of sales in the last 24 h: 727 resolved (262 of them present in
   `pinnacle_nft_map`) vs **329 unresolved, 0 of which are in the map** — while the map itself is healthy
   (63,025 rows, newest row minutes old). So the map writer is alive; these NFTs are simply not in it.
4. **The data to resolve them looked present, and that was a trap.** 307 of the 329 ARE in
   `pinnacle_mint_events`, all 307 with a non-null `edition_id` across 114 distinct editions. That reads like
   a one-line fill-only heal, and I wrote it.
5. ⚠ **The foreign key refused it, and the FK was right.** `pinnacle_mint_events.edition_id` is a **numeric**
   Pinnacle edition id (`2490`); `pinnacle_sales.edition_id` is the **text edition_key**
   (`STAR-OEV1-MAND:Silver Sparkle:1`) with an FK to `pinnacle_editions`. Two different vocabularies for one
   column name — the same class as the platform's documented long-form/short-form collection footgun. The
   whole statement aborted; **no rows were written.**
6. **The actual root cause.** Of the 114 numeric editions behind these sales:
   **0 exist in `pinnacle_editions` (547 rows) · 114 exist in `pinnacle_catalog` (2,561 rows).**
   `pinnacle_sales.edition_id` can only reference `pinnacle_editions`, so a sale of an edition that lives only
   in the catalog is **structurally unresolvable**. This is the documented editions-vs-catalog grain mismatch,
   now with a user-visible consequence.
7. **And the "clean onset" is a red herring.** Those 114 editions' `pinnacle_catalog` rows were created
   between **06-06 and 08-12** — they are not new. 08-14 16:00Z is simply when they started *trading* (13
   distinct sets). A pre-existing coverage gap became visible through a shift in the trading mix; nothing
   changed in our pipelines that hour.

## What is actually broken, and what it costs

`/disney-pinnacle/overview` renders RECENT TOP SALES as a blank panel because all five top sales carry a NULL
`edition_id` and the name join cannot match. **The page half of that is FIXED** (`8f59749b`, deep-audit R1/R4:
the empty-state guard now runs on the post-filter array, so it renders an honest empty state instead of a
blank box). What remains is that Pinnacle's most-traded new editions produce sales rows that **no
edition-keyed surface can see** — FMV, scarcity and per-edition boards silently exclude them.

## The fix, and why I did not take it

Populate `pinnacle_editions` from `pinnacle_catalog` for the editions that actually trade (114 today), then
let the existing resolution path work.

**Deliberately not done autonomously.** `pinnacle_editions` is the **render-keyed FMV table** — Pinnacle FMV
lives in `pinnacle_fmv_history` keyed on `render_id`, and CLAUDE.md's standing rule is that a Pinnacle FMV
join must use the `(character_name, set_name, variant_type)` triple, never `edition_key` alone. Inserting 114
rows there changes what the FMV recompute, the scarcity board and the serial-multiplier model consider to
exist. That is an ingest/pricing project with a review, not a fill-only heal, and it is exactly the lane
CLAUDE.md keeps off the autonomous path.

⚠ **Do not "fix" this by relaxing the foreign key.** The FK is the only thing that caught my wrong hypothesis
here; without it I would have written 307 numeric ids into a text edition_key column and corrupted the join
for every Pinnacle surface, silently.

## Cheap re-measure for the next pass

```sql
-- unresolved recent Pinnacle sales, and whether their editions exist anywhere
WITH tgt AS (
  SELECT DISTINCT me.edition_id AS num_ed
  FROM pinnacle_sales ps JOIN pinnacle_mint_events me ON me.nft_id::text = ps.nft_id::text
  WHERE ps.edition_id IS NULL AND ps.sold_at > now() - interval '48 hours' AND me.edition_id IS NOT NULL)
SELECT (SELECT count(*) FROM tgt) AS distinct_editions,
       (SELECT count(*) FROM tgt WHERE EXISTS (SELECT 1 FROM pinnacle_editions e WHERE e.external_id = tgt.num_ed::text)) AS in_editions,
       (SELECT count(*) FROM tgt WHERE EXISTS (SELECT 1 FROM pinnacle_catalog c WHERE c.edition_id::text = tgt.num_ed::text)) AS in_catalog;
```
Expect `in_editions` to rise toward `distinct_editions` once the catalog→editions promotion ships. While
`in_editions` is 0 and `in_catalog` is the full count, the resolver is working as designed and is the wrong
place to look.
