# The institutional wallet walk is unstable, and everything derived from its diff is fiction

**Filed 2026-08-16 19:30Z (Claude Code, interactive). Contained downstream, root cause NOT fixed.**

## What is wrong

`snapshot-institutional-wallets` writes a daily `wallet_holdings_snapshot` row per
(wallet, collection) holding a `moment_ids` array, and
`compute_institutional_wallet_diff()` compares consecutive days to emit
"arrivals" into `topshot_insider_buybacks` as `acquisition_method='direct_transfer'`.

**The walk does not return a stable set, so the diff manufactures arrivals out of
the wallet's own existing stock.**

Measured live on `0x4d2c9216f1dca098` (NBATopShotCommunity):

| measurement | result |
|---|---|
| distinct moments recorded as "acquired" | 41,307 |
| **of those, ALREADY HELD on the first snapshot (2026-05-19)** | **41,301 (99.99%)** |
| genuinely new across the whole history | **6** |
| rows vs distinct moments | 161,366 / 41,307 = **3.91×** |
| daily "arrivals" present in the wallet TWO DAYS EARLIER | **62–86%** across 9 consecutive day-triples |
| sampled direct_transfer moments appearing in `sales` at any time | **0 of 200** |
| positive control — marketplace rows on the same join key | **208 of 208, all priced** |

Corroborating: holdings are flat at ~52,120 (daily deltas 0, ±1, ±4) while the
table claimed ~6,500 acquisitions/day. And the snapshot array itself is **13.6%
duplicates** — 52,123 entries, 45,059 distinct — so `moment_count` (and
`seeded_wallets.cached_moment_count`) **overstate the real holding**. Duplicate
emission plus skipping is the classic signature of paginated iteration with
unstable page boundaries.

⚠ **The 62–86% flip-flop figure is a LOWER bound** — it only catches moments
absent for exactly two days. A moment absent for three or more days and then
returning is equally impossible as an acquisition and is not counted there.

## What was contained (shipped 2026-08-16)

- `rpc_topshot_buyback_analytics` now aggregates **only** `acquisition_method='marketplace'`
  and reports `coverage.excluded_snapshot_rows` + `excluded_reason`, so the board
  explains its own size instead of implying the buyback programme is inactive.
  Migration `20260816192708_audit_20260816_buyback_analytics_exclude_snapshot_diff_artifacts.sql`.
- `/api/analytics/insider/signals` now filters to `marketplace`. ⚠ **That panel is
  on the live `/analytics` page and had been rendering fabricated events as
  "insider buyback detected"** — the artifact rows outnumber real ones ~375:1 and
  carry today's date, so they occupied every slot. Pinned by a guard that asserts
  the `.eq()` is issued (mutation-verified).

## What was NOT fixed, and what to check before touching it

The walk itself. Two candidate causes, not yet separated:

1. **Pagination instability in the Cadence/GraphQL wallet walk** — overlapping or
   skipping page boundaries would produce duplicates AND omissions simultaneously,
   which is exactly what is observed.
2. **A partial-success write** — the snapshot is written even when the walk did not
   complete, so a short read is recorded as the day's truth.

⚠ **Do not "fix" this by de-duplicating `moment_ids` on write.** That removes the
13.6% duplicate symptom and leaves the omissions, which are the half that
generates the false arrivals — the board would look repaired while the diff kept
fabricating. The duplicates are evidence, not the defect.

⚠ **Do not raise a threshold or add a floor to the diff.** The arrivals are not
noisy-but-real; they are 99.99% impossible.

⚠ **Check `compute_institutional_wallet_diff`'s DEPARTURE arm too.** This
investigation only measured arrivals; departures (5,432 on 2026-08-16) are
produced by the same comparison and are presumably equally unreliable. Nothing
downstream consumes them today, which is the only reason they are not also a
live defect.

## Blast radius verified at filing time

- `topshot_insider_alerts`: **0** rows of type `cluster_buyback` / `low_serial_buyback`
  / `set_concentration`, so the buyback detector has never emitted an alert. The
  alerting path is clean.
- `/analytics` InsiderSignals panel: **was** affected, now filtered.
- `/analytics/buyback`: **was** affected, now filtered.
- The 161,366 rows are left in `topshot_insider_buybacks` deliberately — they are
  the evidence, and no consumer reads them any more.

## The generalizable lesson

A diff between two observations is only as trustworthy as the *stability* of the
observation. Nothing in the pipeline compared a snapshot against anything except
its immediate predecessor, so a walk that returned a different subset each day
produced a large, plausible, self-consistent stream of events — ~6,500 a day for
three months — that no cadence monitor, row-count check or freshness arm could
distinguish from real activity. **The cheapest available falsifier was one query:
were these moments already in the wallet before?**
