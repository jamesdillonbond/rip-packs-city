# The pack-sales "head-check" the 2026-08-26 entry called unavailable IS implementable — from our own cursor table

**Filed 2026-09-19 10:30 AM PT (Cowork cloud). NOT SHIPPED, deliberately.** This is a design
candidate with a falsifier, filed 30 minutes after the unlatch fix landed, precisely because the
2026-08-26 entry is a cautionary tale about shipping a cadence change on this exact lane from
reasoning rather than measurement.

## What 2026-08-26 concluded

> "**The actual defect is that the walker re-reads ~300k rows to discover ~120 new ones**
> (19,194 and 16,590 disk blocks *per* `LIMIT/OFFSET` call). The fix is a cheap head-check that
> stops at the first already-seen row, run often, with the deep re-walk run rarely — **not a
> cadence number.** Filed rather than shipped: both writers are edge functions with no committed
> source (deep-audit R21), so their behaviour cannot be changed under review."

That entry also measured the cost — **70.9 GB/day at `*/3`, ~9% of the instance's ~780 GB/day** —
and established the mechanism that made a cadence cut the WRONG lever: the walker is a single full
DESC re-walk from head to oldest, and **it picks up new sales only when it finishes and laps back
to page 0**, so head freshness = LAP TIME and cadence is a multiplier on it.

## What changed today

The 09-19 outage forced a close read of `topshot_pack_sales_cursor` / `allday_pack_sales_cursor`,
and the finding is that **the walker's entire position is state in OUR database**. Setting
`after_cursor = NULL, done = false` puts it back at the head — verified today: Top Shot went from
09-13 to 09-19 and recovered 1,187 sales within two minutes of that single UPDATE.

⭐ **So the premise of "cannot be changed under review" is wrong, and it was wrong for a specific
reason worth naming: the behaviour we want to change lives in the STATE, not in the code.** The
edge function's logic is fixed, but what it does is a function of a cursor we own.

## The candidate

Reset `after_cursor = NULL, done = false` **unconditionally** every N minutes (not only when
latched, which is all `unlatch_pack_sales_cursors` does today), and then cut the cadence.

This **decouples freshness from lap time**, which is the thing the 08-26 cut could not do:

| | today (`*/3`, lap-gated) | candidate (head-reset every 15 min) |
|---|---|---|
| head freshness | ~5 h (one lap) | **~15 min** |
| rows read/day | ~1.9 M, sweeping the whole 168 MB table | ~4,000 newest rows per run |
| cache behaviour | constant misses — the sweep evicts itself | the same hot pages, so **hits, not disk reads** |
| cadence cut | ⛔ costs 5× freshness | ✅ **free** — freshness no longer depends on it |

⚠ The IO argument is the *interesting* one and also the *weakest*: it claims the reads become
`shared_blks_hit` rather than `shared_blks_read`. The 08-26 entry is emphatic that hits and reads
must be reported separately and that conflating them is "the mistake this box's whole IO story is
vulnerable to". **That conversion is a HYPOTHESIS, not a measurement.**

## ⛔ Why it is not shipped

1. **The tail's completeness is not established.** A head-only walker never re-walks history. The
   cursor read `done = true, total_seen = 21` — 21 is far too small for a ~300k-row lap, so
   `total_seen` is probably per-RUN, not per-lap, which means **`done` does not prove the tail is
   complete**. Do not build on that assumption; establish it first.
2. **Upstream corrections to old rows would be silently missed.** Needs a rare deep lap (e.g.
   skip the reset once a week) and a way to tell that lap is finishing.
3. **This lane has already taught the repo one expensive lesson about confident cadence changes.**
   Shipping a second behavioural change on it the same hour as the first, with no post-fix
   baseline, would repeat the 08-26 pattern exactly.

## Falsifier, to register BEFORE any of this is attempted

Same shape as 08-26's, which worked: over 24 h after a change, **`n_tup_ins` on
`topshot_pack_sales_history` must hold at its prior daily rate (~100–165/day) while disk reads
fall.** If inserts fall too, the walk was covering ground and the change is wrong — revert.
⚠ And take a WARM-vs-WARM `pg_stat_statements` baseline over ≥ 24 h first; the 08-26 entry
recorded a 39-minute, n=4 window that would have been "a snapshot posing as a rate", and the
lane's cost must be split on the change point, never pooled across it.

## Order of work

1. Establish whether the tail is complete (compare our row count against upstream's `totalCount`,
   or walk once with instrumentation) — **this gates everything else**.
2. Take the 24 h warm baseline.
3. Only then: head-reset + cadence cut, with the falsifier registered and read at 24 h, not at 7.
