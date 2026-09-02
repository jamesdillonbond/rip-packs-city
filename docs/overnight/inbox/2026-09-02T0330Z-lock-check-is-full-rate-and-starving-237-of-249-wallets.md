# `lock-check-batch` is at full rate, fully green, and starving 237 of 249 wallets

**Filed 2026-09-02 03:30Z (2026-09-01 20:30 PT) · cloud autonomous pass**
**Nothing shipped. The one change worth making is Trevor's call, not an optimisation.**

## The number

Over 24 h on `nba_top_shot`, `lock-check-batch` ran **48/48 ok**, found 19,200 rows and wrote 19,184 —
exactly its designed throughput, no errors, no alerts. Those checks reached:

- **12 distinct wallets**
- **69.2 %** of them to a single wallet (6,641 checks)
- **99.9 %** to the top five

There are **249 hot wallets with qualifying work**. 237 of them received nothing.

Every instrument says this pipeline is healthy, and by its own definition it is: it is doing full-rate
work. **Nothing watches the distribution**, so a pipeline can be simultaneously green and useless to
95 % of the users it exists for. That is the reusable lesson — a throughput arm cannot see a fairness
failure, and this estate now has several arms of exactly that shape.

## Why it happens

`1,474,231` of `1,904,215` TopShot rows have `lock_checked_at IS NULL`. The ordering is
`ORDER BY lock_checked_at ASC NULLS FIRST`, so **all 1.47 M NULLs are tied**. When everything ties,
the tie-break decides everything — and the tie-break is effectively the scan's input order, so the
first wallets encountered take the entire batch, every run, forever.

Two consequences fall out of the same fact:

1. **The `p_max_age_days` staleness predicate is inert.** With 1.47 M NULLs permanently sorting ahead
   of any timestamped row, nothing already checked is ever re-checked. Freshness is not "7 days"; it
   is "checked once, then not again this year".
2. **The target is arithmetically unreachable regardless of policy.** Keeping 1.9 M rows fresh within
   7 days needs ~271,000 checks/day. Actual is **9,590/day — 3.5 %**. The never-checked backlog alone
   is 154 days. (The route header already says `MAX_AGE_DAYS` is a background target, not a promise —
   that was right; this is the size of the gap.)

## What I tried, and why nothing shipped

**Three optimisations, all refuted on buffers, same arguments, same session:**

| shape | buffers | rows materialised |
|---|---|---|
| **live: per-wallet LATERAL, inner `LIMIT 200`** | **21,725** | 46,255 |
| `wallet_address IN (SELECT … FROM hot)` | 631,906 | 1,862,848 |
| `wallet_address = ANY(array(…))` | 565,784 | 1,665,575 |

Both rewrites destroy the per-wallet bound and materialise the entire qualifying set before a top-N
sort. I predicted an early-terminating ordered scan and got neither. **The live shape is the best of
the three and should be left alone** — early termination would need a scan ordered globally by
`lock_checked_at`, but `wallet_address` is not in that index, so membership costs a heap visit per
candidate and the planner will not choose it.

**And the covering index I built last night cannot help, for a reason I had wrong.** Its plan is a
genuine `Index Only Scan` — and reports `Heap Fetches: 16866`. An index-only scan still visits the
heap for tuples on pages the visibility map does not mark all-visible; INCLUDE columns have no bearing
on that. The writer dirtying those pages is *this same pipeline*: ~19,200 scattered non-HOT UPDATEs a
day across 120,286 heap pages. Each batch un-marks the pages the next batch wants to read.

Autovacuum is not the lever either — I checked before proposing it. The table already runs
`autovacuum_vacuum_scale_factor=0.02` (default 0.2), has 693 autovacuums, last ran 20 minutes before
measurement, and sits at 1.18 % dead tuples.

> **Diagnostic rule worth keeping: when a plan says `Index Only Scan`, read the `Heap Fetches:` line
> before believing the index works.**

## ⛔ CORRECTION, 03:50Z — this is a DEFECT, not the policy trade I filed 20 minutes ago

I filed the section below as "breadth vs depth, Trevor's call". Then I ran the query it recommended,
and the answer removes the trade entirely.

**Every one of the 12 wallets receiving checks is a SEEDED coverage wallet.** Not one is user-saved,
not one is linked. And on the other side:

| | user wallets (saved + linked) | seeded coverage wallets |
|---|---|---|
| wallets holding TopShot moments | 31 of 344 | — |
| TopShot rows held | **212,201** | — |
| rows qualifying for a lock check | **212,201 (100 %)** | — |
| checks received in 24 h | **0** | **9,590** |
| checks received in 30 d | **230** (0.1 %) | ~121,000 |

**The priority leg exists specifically to favour the wallets users care about, and it is delivering
100 % of its output to seeded coverage wallets and 0 % to user wallets.** Users' own moments have had
zero lock checks in 24 hours and 230 in a month. That is not a tuning preference; it is the feature
not doing the thing it was built to do.

**Why:** `hot` UNIONs seeded, saved and linked with **no preference among them**, so a seeded wallet
is indistinguishable from a user wallet in the ordering. Seeded wallets then win on sheer mass — 274
of them with work versus 31 user wallets, and the biggest holds 21,124 moments against a typical user
wallet's handful. With all 1.47 M NULLs tied, mass decides.

### The fix is smaller and safer than the cap I proposed below

Do **not** cap per-wallet contribution — that was aimed at the wrong problem and carries the real
breadth/depth trade. Instead **add a tier to the ordering**: user (saved/linked) wallets rank above
seeded-only wallets, i.e. carry a `is_user_wallet` flag through `cand`/`dedup` and order by it before
`lock_checked_at`. That:

- is a strict priority fix, not a fairness trade — nothing is starved that was previously served,
  because seeded wallets simply resume once user wallets are current;
- clears the entire 212,201-row user backlog in ~22 days at today's unchanged 9,590/day, then hands
  the capacity straight back to seeded coverage;
- leaves throughput, batch size, cadence and the `LIMIT` structure untouched;
- needs no new index — `is_user_wallet` is derived from the `hot` CTE that is already computed.

⚠ Still verify on **rows written per wallet class**, not on `ok` — this pipeline has been green and
wrong for its entire life, and a throughput arm cannot see the difference.

⚠ And it does not fix the arithmetic: 9,590/day against a 7-day target needing ~271,000/day stands
regardless. This makes the scarce capacity go to the right wallets; it does not create capacity.

**Not shipped tonight** — it is a live-pipeline function change and the measurements are 20 minutes
old. It is the first thing to ship next pass, with a per-class verification query.

---

## Superseded — the policy framing I filed before running the query

*(Kept deliberately: the reasoning below is wrong in its conclusion, and the reason it is wrong —
I proposed a trade-off without first checking who was actually being served — is the useful part.)*

## The decision for Trevor

Capping each wallet's contribution (a smaller inner `LIMIT`) would cut materialised rows 20–180× *and*
spread checks across ~200 distinct wallets per run instead of one. It is the same one-line change for
both wins.

But it is **not** exactness-preserving — one wallet can legitimately own all 200 rows of the correct
answer — so it is a real trade:

- **Today (depth):** one wallet fully converges in ~22 days; 237 wallets never start.
- **Under a cap (breadth):** every hot wallet advances; none completes quickly.

Given 69 % of a whole day's work going to one wallet, breadth looks clearly better for users. But it
changes what the product promises about lock freshness, so it belongs to Trevor rather than to a
3:30 AM optimisation pass.

**Cheapest thing that would settle it:** ask which wallets are actually *viewed*. If the busiest
wallet is an institutional/seeded address nobody opens, the current allocation is pure waste and the
cap is a clear win. `page_views` or the saved-wallet table would answer it in one query.
