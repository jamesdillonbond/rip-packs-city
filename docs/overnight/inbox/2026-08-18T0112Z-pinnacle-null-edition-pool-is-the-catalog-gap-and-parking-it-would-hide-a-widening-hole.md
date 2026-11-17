# The Pinnacle null-edition pool IS the catalog-coverage gap — and parking those rows would hide a hole that is still widening

Claude Code, interactive, 2026-08-17 18:12 PT (2026-08-18 01:12Z). **Read-only. Nothing mutated.**
Closes sentinel-queue item 5 (`pinnacle-nft-resolver` — "~900 rows with a null upstream edition"), and
**rejects the disposition the queue proposed for it.**

## The short version

Item 5 asked: *"why do ~900 Pinnacle NFTs carry a null edition, and can that source supply it?"*

It is not a new question. It is the **same defect** already measured on 2026-08-15 in
`2026-08-15T1530Z-R4-is-a-catalog-coverage-gap-not-an-indexer-regression.md`, and that doc answers both
halves. The queue filed it as a fresh upstream mystery because nothing connected the two.

- **Why null:** `pinnacle_sales.edition_id` is a **text edition_key** with an FK to `pinnacle_editions`
  (**551** rows). The editions behind these sales exist only in `pinnacle_catalog` (**2,561** rows). A sale
  of a catalog-only edition is **structurally unresolvable** — the FK has nowhere to point.
- **Can the source supply it:** **yes, completely.** Re-running the 08-15 doc's own prescribed re-measure
  today returns `distinct_editions = 161 · in_editions = 0 · in_catalog = 161`. Every single one is
  already sitting in the catalog.

## Measurements (2026-08-18 01:12Z)

| quantity | 08-15 | now | note |
|---|---:|---:|---|
| `pinnacle_editions` rows | 547 | **551** | the FK target; barely moves |
| `pinnacle_catalog` rows | 2,561 | **2,561** | where the missing editions actually live |
| distinct unresolvable editions (48 h window) | 114 | **161** | ⚠ **+41 % in three days** |
| of those, present in `pinnacle_editions` | 0 | **0** | |
| of those, present in `pinnacle_catalog` | 114 | **161** | source has all of them |

Whole-pool counts: **954** `pinnacle_sales` rows with `edition_id IS NULL`, of which **946** have
`resolution_attempts = 0` and **949** sold in the last 7 days.

## ⚠ Two corrections to the queue's framing

**1. "Not a resolver bug; it declines correctly (`failed: 0`)" is right about the resolver and wrong
about the mechanism.** The resolver is not declining these rows — **946 of 954 have
`resolution_attempts = 0`, so it never reaches them at all.** `failed: 0` is not evidence of graceful
declining; it is evidence of *absence*. Those two states look identical in the success metric and mean
opposite things about where to look. (Same shape as the platform's `rows_written = 0` null-instrument
rule.)

**2. ⛔ Do NOT park the unresolvable rows.** The queue's fallback was *"if you instead park the
unresolvable rows, stamp on consideration, not on success."* The stamping advice is sound in general, but
the premise does not hold here: **these rows are not permanently unresolvable.** They become resolvable
the moment the catalog→editions promotion ships. Parking them converts a *widening, fixable coverage
gap* (114 → 161 editions in three days) into a quiet backlog that no metric reports — which is the
[[green-pipeline-blind-to-its-own-work]] failure, deliberately installed. Whatever else happens, the
count of catalog-only traded editions must stay visible.

## The actual fix, still gated — unchanged from 08-15

Promote the traded catalog editions into `pinnacle_editions`, then let the existing resolution path work.

**Still deliberately not taken autonomously.** `pinnacle_editions` is the render-keyed FMV table; adding
rows changes what the FMV recompute, the scarcity board and the serial-multiplier model consider to
exist. That is an ingest/pricing project with a review — the exact lane CLAUDE.md keeps off the
autonomous path — not a fill-only heal.

⚠ **Do not "fix" this by relaxing the foreign key**, and do not fill `pinnacle_sales.edition_id` from
`pinnacle_mint_events.edition_id`: that column is a **numeric** Pinnacle edition id (`2490`) while
`pinnacle_sales.edition_id` is the **text** edition_key (`STAR-OEV1-MAND:Silver Sparkle:1`). One column
name, two vocabularies — the same class as the long-form/short-form collection footgun. The FK caught
exactly this wrong hypothesis on 08-15 and refused the write.

## What changed since 08-15, and what it implies

Nothing about the mechanism. Only the **size**: +47 distinct editions in three days, and the sales pool
is now ~954 rows with essentially all of it (949) inside the last 7 days. The gap is not a fossil
draining — it is accruing at roughly the rate Pinnacle's trading mix rotates into new sets.

That raises the priority of the promotion project relative to 08-15, when it read as a one-off of 114.
It does not change who owns the call.

## Cheap re-measure (unchanged — use this, do not re-derive)

```sql
WITH tgt AS (
  SELECT DISTINCT me.edition_id AS num_ed
  FROM pinnacle_sales ps JOIN pinnacle_mint_events me ON me.nft_id::text = ps.nft_id::text
  WHERE ps.edition_id IS NULL AND ps.sold_at > now() - interval '48 hours' AND me.edition_id IS NOT NULL)
SELECT (SELECT count(*) FROM tgt) AS distinct_editions,
       (SELECT count(*) FROM tgt WHERE EXISTS (SELECT 1 FROM pinnacle_editions e WHERE e.external_id = tgt.num_ed::text)) AS in_editions,
       (SELECT count(*) FROM tgt WHERE EXISTS (SELECT 1 FROM pinnacle_catalog c WHERE c.edition_id::text = tgt.num_ed::text)) AS in_catalog;
```

While `in_editions` is 0 and `in_catalog` is the full count, **the resolver is working as designed and is
the wrong place to look.**
