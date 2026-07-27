# Addendum — 2026-07-27, post-deploy: the ordering is wrong, and my 48% was an over-read

Follow-on to `docs/handoff-2026-07-27-alert-triage.md`. The rotation shipped and works. This corrects
two numbers in the original handoff and proposes one further one-line change.

## 1. The `res=0` reading is not yet evidence about the backlog

Verified at 17:20Z against `unmapped_sales`:

```
stamped_and_in_old_head   300
stamped_beyond_old_head     0      ← every probe so far
old_head_still_unstamped   85
```

**Every row the rotation has probed is inside the same 385-row head that was proven dead before the
fix (0/25 on-chain).** It has not yet touched a single never-probed row. `res=0` across both ticks is
therefore the *expected* result of re-probing the known-dead slate one final time — it carries no
information about the 28,640 rows behind it. Roughly 85 rows (~1.5 ticks) remain before it crosses over.

This is the same shape as the error the original handoff caught in the ledger, one level down: a yield
statistic being read as a verdict on a population the instrument had not sampled yet. Worth holding the
`onchain_unproductive` flag as *un-interpreted* until `stamped_beyond_old_head > 0`.

## 2. My ~13,000 projection was too high — revised to ~9,500, wide

The original 48% came from a single n=25 sample. A fresh stratified probe (same code path, rows the
rotation has not touched):

| stratum | probed | resolved |
|---|---|---|
| February 2026 | 20 | **4 (20%)** |
| March–April 2026 | 20 | **0 (0%)** |

Pooling February across both samples: **16/45 ≈ 36%** (95% CI roughly 22–51%). Applied to the 26,608
open February nft_ids: **≈9,500 recoverable, range ~5,900–13,600.** Down from 13,000, same order of
magnitude, and now stratified rather than pooled. The original figure should be treated as superseded.

Three of the original successes re-verified live at 17:18Z by direct buyer-borrow — `4728736→1416`,
`8801763→3540`, `4490944→1374` — so the resolvable class is real, not a probe artifact.

## 3. The proposed change: order the never-probed pass oldest-first

Open backlog by month (`sold_at`, open + `price_usd > 0`):

| month | open nfts | share | measured on-chain yield |
|---|---|---|---|
| **Feb 2026** | **26,608** | **92.7%** | **~36%** |
| Mar 2026 | 1,443 | 5.0% | 0/20 |
| Apr 2026 | 596 | 2.1% | 0/20 |
| Jun–Jul 2026 | 65 | 0.2% | 0/25 (the old head) |

The current `sold_at DESC` ordering walks these **worst-first**. After the head clears, the pass has to
grind through ~1,800 remaining March/April/July rows — every one in a stratum measuring 0/40 combined —
at 60/tick, ~3 ticks/hour: **roughly 10 hours of guaranteed zero yield** before it reaches February,
where all of the recoverable value is.

**Change:** for the never-probed pass (`last_onchain_attempt_at IS NULL`), order `sold_at ASC`.
Keep `DESC` for the re-probe pass if you want recency to win there — the two have opposite goals.

### Why older resolves better (mechanism, so nobody reverts this)

A recent sale's moment is often still in a Flowty storefront escrow `Listing` resource or mid-settlement
— no borrowable public `AllDay.Collection` holder exists, so the borrow correctly returns nil. Months
later it has settled into an end-user wallet that publishes the capability, and the borrow succeeds.
Resolvability *increases* with age, up to the point the moment is re-sold and resolved for free by
job 215.

⚠ Note this **inverts** the deliberate `sold_at DESC` chosen in the 07-26 rework. That choice was right
for its stated reason (don't let bulk-re-ingested backlog starve genuinely recent rows) and is right for
*business recency*. It is wrong for *on-chain resolvability*, which is a different axis. Both can hold:
recency for which rows matter, age for which rows are answerable.

## Revert path

One-line ordering change in `app/api/cron/allday-resolve-unmapped/route.ts`. Revert = flip the direction
back. No schema change — `last_onchain_attempt_at` and its index already shipped.

## Verification

After the head clears (`stamped_beyond_old_head > 0`), expect `onchain_resolved > 0` within a few ticks
and `onchain_unproductive` to clear on its own. The honest check:

```sql
SELECT count(*) FILTER (WHERE last_onchain_attempt_at IS NOT NULL) AS probed,
       count(*) FILTER (WHERE last_onchain_attempt_at IS NOT NULL AND resolved_at IS NOT NULL) AS hit
FROM (SELECT DISTINCT ON (nft_id) nft_id, last_onchain_attempt_at, resolved_at
      FROM unmapped_sales
      WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070' AND price_usd>0
        AND sold_at < '2026-03-01') feb;
```

Pass = `hit/probed` lands somewhere in 20–50% once a few hundred February rows are probed. If it comes
back near 0 over 500+ February probes, **my 36% is wrong and the recoverable pool should be written off**
— that is the number that settles it, and it is now observable either way.

**Claude Code's direct file inspection wins over this doc on any disagreement.**
