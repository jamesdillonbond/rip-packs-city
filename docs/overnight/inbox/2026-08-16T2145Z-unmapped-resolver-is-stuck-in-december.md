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
| window span | **2025-12-29 14:42:59Z → 2025-12-30 01:39:29Z = 10.94 hours** |
| rows with `price_usd = 0` | **1,738 (86.9%)** |
| **frozen** (`open_n > 1 AND price_usd = 0`) | **1,534 (76.7%)** |

⚠ **Corrected 2026-08-16 16:49 PT / 23:49Z — an earlier revision of this filing published
7.50 h / 89.0% and claimed the originating pass's figures "did not reproduce". That was MY error and
it is now retracted; see the reconciliation below.**

⛔ **The resolver's entire candidate window is under eleven hours of late December 2025**
(2025-12-29 into 2025-12-30), overwhelmingly price-zero rows that the promotion path deliberately excludes
(`promote_unmapped_sales` skips `price_usd <= 0`). A fixed ascending order over a set far larger
than the window means **the tail is never reached** — it re-scans the same December slice every
30 minutes.

**So this is not a cost story. It is why the backlog does not drain.** Corroborated by the Sentinel's
own trend: oldest open sale pinned at 2025-12-29 across the 10:55 / 12:15 / 13:35 alerts while
actionable rows grew 47,557 → 47,560 → 47,564, with outflow 212–223/24 h against inflow 231–240/24 h.

⚠ **This is the same structural defect as the board-liveness sweep fixed the same day** (ledger
2026-08-16): a fixed ordering over a population larger than the per-tick budget starves a constant
tail. The remedy there — rotation — is the cheap remedy here too.

### ✅ RECONCILED — the originating figures were right; my "did not reproduce" note was wrong

Re-measured live 2026-08-16 23:49Z against the catalog and the table. **The originating pass's
10.94 h / 76.7% frozen reproduce EXACTLY**, and my divergent 7.50 h / 89.0% came from measuring a
different population. Retracted in full:

- ⛔ **"`open_n` is computed inside `get_unmapped_resolver_targets`" is FALSE.**
  `position('open_n' in pg_get_functiondef(...))` = **0** for that function — it references neither
  `open_n` nor `transaction_hash`. `open_n` is computed inside **`refresh_unmapped_backlog_growth`**
  (position 309), the function that raises the Sentinel alert itself, as
  `count(*) … GROUP BY u.collection_id, u.transaction_hash` over `resolved_at IS NULL` rows. Both
  inputs are real columns, **so the predicate is fully replayable** — and it is the alert's own
  vocabulary, which is why the originating pass used it.
- ⛔ **"the window drains slightly between passes" is FALSE.** The divergence was a **missing clause**:
  dropping the `NOT EXISTS (… nft_edition_map …)` predicate from the candidate CTE reproduces
  **89.0% / 7.50 h / 2025-12-29 22:13:05Z exactly**. That clause is what makes the window the
  resolver's *actual* candidate set; without it the population includes NFTs that are **already
  mapped** and which the resolver therefore never looks at.
- ⚠ **The two percentages are not interchangeable: unpriced (86.9%) is a SUPERSET of frozen (76.7%)**
  — frozen additionally requires `open_n > 1`. Substituting one for the other is not a tightening of
  the same number.

**Quote 10.94 h / 86.9% unpriced / 76.7% frozen.** The structural conclusion was never in dispute.

---

## ⛔ Why the approved lever was NOT shipped

The agreed fix on record is "record a permanent-failure reason and exclude by REASON", which the
existing `NOT EXISTS … retry_count >= 5` predicate would deliver with no function change — just a
backfill of `unmapped_sales_resolution_failures`. But:

> `get_unmapped_resolver_targets` maps **nft_id → edition**. It is *not* the price-promotion path
> (`promote_unmapped_sales` is). Excluding a frozen row also stops its NFT ever being mapped.

⛔ **RE-MEASURED 2026-08-16 23:49Z, AND THE HEADLINE FIGURE WAS OVERSTATED BY 65%.** The originating
pass reported **50,213** distinct All Day NFTs appearing ONLY in frozen rows. Live:

| | |
|---|---|
| frozen NFTs | 53,048 |
| actionable NFTs | 43,978 |
| frozen **and** also actionable (exclusion free) | 2,840 |
| frozen-only | **50,208** ✅ reproduces (1 row of live drift) |
| ⛔ frozen-only **AND still absent from `nft_edition_map`** | **30,331** |

**19,877 of the 50,208 frozen-only NFTs already have an `nft_edition_map` entry.** They were mapped
through some other path, and the candidate CTE's `NOT EXISTS … nft_edition_map` clause means the
resolver already skips them — so excluding their rows forfeits **nothing**. ⚠ **The real cost of the
exclusion lever is ~30,331 NFTs, not ~50,213.** The originating pass counted a population without
checking it against the table that makes the count moot.

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
2. **Exclude frozen rows by reason** — biggest throughput win, costs ~**30,331** mappings (NOT the
   ~50,213 originally filed; re-measured above). Cheaper than believed, but still a data-coverage
   judgment with a ~30k-row blast radius.
3. **Both.**

⛔ **Do NOT raise `breach_at` on `unmapped_resolution_backlog_max`** — that only defers the crossing,
per the standing note in CLAUDE.md.
