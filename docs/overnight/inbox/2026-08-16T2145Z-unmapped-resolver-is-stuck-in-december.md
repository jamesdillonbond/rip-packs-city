# `unmapped-sales-nfl_all_day` — the resolver is stuck in December, and the approved lever is NOT lossless

Filed 2026-08-16 14:45 PT / 21:45Z (Claude Code, interactive). **QUEUED — nothing shipped. Trevor's call.**

Origin: a cloud Cowork triage pass proposed "halve the scanned population" as an approved lever.
Measuring it found something **more useful and a trade-off that makes the approved fix not
clearly-safe**, so it was deliberately not taken.

---

## The finding: the candidate window never leaves 2025-12-29

`get_unmapped_resolver_targets` selects `ORDER BY us.sold_at ASC LIMIT GREATEST(p_limit*10, 2000)`.
Replayed against the table for All Day (`dee28451-…`, `resolved_at IS NULL`), **measured live
2026-08-16 21:45Z**:

| | |
|---|---|
| window rows | **2,000** |
| window span | **2025-12-29 14:42:59Z → 2025-12-29 22:13:05Z = 7.50 hours** |
| rows with `price_usd = 0` | **1,780 (89.0%)** |

⛔ **The resolver's entire candidate window is seven and a half hours of a single day in December
2025**, overwhelmingly price-zero rows that the promotion path deliberately excludes
(`promote_unmapped_sales` skips `price_usd <= 0`). A fixed ascending order over a set far larger
than the window means **the tail is never reached** — it re-scans the same December slice every
30 minutes.

**So this is not a cost story. It is why the backlog does not drain.** Corroborated by the Sentinel's
own trend: oldest open sale pinned at 2025-12-29 across the 10:55 / 12:15 / 13:35 alerts while
actionable rows grew 47,557 → 47,560 → 47,564, with outflow 212–223/24 h against inflow 231–240/24 h.

⚠ **This is the same structural defect as the board-liveness sweep fixed the same day** (ledger
2026-08-16): a fixed ordering over a population larger than the per-tick budget starves a constant
tail. The remedy there — rotation — is the cheap remedy here too.

### ⚠ Numbers that did NOT reproduce, and why that matters

The originating pass reported an **11-hour** window (to 2025-12-30 01:39Z) and **76.7% frozen**
using the predicate `open_n > 1 AND price_usd = 0`. Neither reproduces exactly:

- ⚠ **`open_n` is not a column on `unmapped_sales`**, and `resolution_hint ? 'open_n'` matches
  **0 of 2,000** window rows. It is computed inside `get_unmapped_resolver_targets`, so that
  predicate cannot be replayed against the table and the 76.7% could not be re-derived here.
- The window span differs (7.50 h vs 11 h) because the window drains slightly between passes.

**The structural conclusion is unchanged and is what should be acted on** — but quote the measured
7.50 h / 89.0% above, not the originating figures.

---

## ⛔ Why the approved lever was NOT shipped

The agreed fix on record is "record a permanent-failure reason and exclude by REASON", which the
existing `NOT EXISTS … retry_count >= 5` predicate would deliver with no function change — just a
backfill of `unmapped_sales_resolution_failures`. But:

> `get_unmapped_resolver_targets` maps **nft_id → edition**. It is *not* the price-promotion path
> (`promote_unmapped_sales` is). Excluding a frozen row also stops its NFT ever being mapped.

The originating pass measured the loss as **50,213 distinct All Day NFTs appearing ONLY in frozen
rows** (vs 2,840 that also appear in an actionable row, where exclusion is free). ⚠ **That figure is
carried from the originating pass and was NOT independently re-measured here** — re-measure before
acting, as it is the number the whole trade-off turns on.

Exclusion is arguably still right: the loss is *deferred* rather than permanent (such an NFT becomes
actionable if it later trades in a priced single-NFT tx), and the resolver currently maps ~200/day
while never reaching the actionable pile at all. But that is a data-coverage judgment with a
~50k-row blast radius, taken during an active saturation wave — **not clearly-safe, so queued.**

---

## Options, in preference order

1. **Change the ORDERING, not the population — smallest fix, forfeits nothing.** Rotate the
   candidate window (least-recently-attempted first via `last_onchain_attempt_at`, or `sold_at DESC`)
   so the resolver stops re-scanning December. Directly mirrors the board-liveness rotation fix.
   `unmapped_sales` already carries `last_onchain_attempt_at` and `onchain_attempts`, so the
   rotation key exists — no schema change.
2. **Exclude frozen rows by reason** — biggest throughput win, costs the ~50,213 mappings above.
   Verify that count first.
3. **Both.**

⛔ **Do NOT raise `breach_at` on `unmapped_resolution_backlog_max`** — that only defers the crossing,
per the standing note in CLAUDE.md.
