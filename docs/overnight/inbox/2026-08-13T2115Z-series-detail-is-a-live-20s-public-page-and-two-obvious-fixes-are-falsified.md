# `get_series_detail` is a live, tens-of-seconds PUBLIC page query (Sentry NEXTJS-27), and the two obvious fixes are both WORSE

Claude Code, interactive, 2026-08-13 ~14:15 PT (21:15Z). **Read-only measurement. No code, DB or prod
change.** Found by sweeping Sentry for new production issues rather than from the disk-read ranking.

---

## The symptom is real and user-facing

**Sentry `JAVASCRIPT-NEXTJS-27`** — *"Error: series detail unavailable: canceling statement due to
statement timeout"*, culprit `GET /[collection]/series/[slug]`. 2 events, 1 user, first seen 2 days ago.
The only new unresolved issue in the trailing 3 days.

⚠ **The page's error handling is already correct — do not "fix" that.** `fetchDetail` deliberately
`throw`s rather than returning null, because returning null fed `if (!detail) notFound()` and **soft-404'd
a real series holding thousands of editions** (deep-audit D10), which also defeated the layout gate that
fails open precisely so "a transient pool blip must never emit a 404 and invite Google to drop a real
page". The throw is the fix from 2026-07-14. What is broken is the query underneath it.

## Measured

`EXPLAIN (ANALYZE)` on the live instance:

| what | result |
|---|---|
| `get_series_detail('<topshot>', 'series-4')` | **20,172 ms** |
| plan **cost** for the same aggregate | **8,022** — i.e. the cost model badly understates it |

That gap is the 1730Z file's own lesson arriving again: **under IO throttling, plan cost ranks nothing.**
A cost of 8k looks trivial and takes 20 seconds.

**Why:** the non-Pinnacle branch runs a correlated LATERAL —
`(SELECT fmv_usd, floor_price_usd FROM fmv_snapshots WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1)`
— **once per edition**. Measured per-probe cost is **~10.7 ms**, and the series in question has 3,597
editions. It is index-backed; it is simply ~3.6 k random probes on a throttled disk.

## Blast radius — 12 public SEO pages, and the one that errored is not the worst

Series with >300 editions:

| collection | series | editions |
|---|---:|---:|
| nba_top_shot | **8** | **4,863** |
| nba_top_shot | 5 | 3,597 |
| nba_top_shot | 7 | 2,849 |
| nba_top_shot | 6 | 2,458 |
| nfl_all_day | 9 | 1,889 |
| nba_top_shot | 2 | 1,772 |
| nba_top_shot | 4 | 1,463 |
| nba_top_shot | 1 | 1,306 |
| nfl_all_day | 7 / 5 / 1 | 1,031 / 957 / 941 |
| laliga_golazos | 1 | 575 |

**Top Shot series 8 is 35% larger than the one measured at 20 s.** These are `revalidate = 600` ISR
pages, so every 10 minutes each one attempts this again.

## ⚠ Two obvious fixes, both FALSIFIED — do not spend the afternoon on either

1. **Set-based `DISTINCT ON` over the series' editions** (`WHERE fs.edition_id IN (SELECT id FROM eds)`):
   **timed out at >60 s.** The `IN (subquery)` loses the per-edition index descent and the planner picks
   something worse.
2. **Add `collection_id` to the LATERAL** so it can use `(collection_id, edition_id, computed_at DESC)`
   — including the 2026 partition's covering index with `INCLUDE (fmv_usd)`: **38,553 ms.** It *does*
   reach an Index-Only Scan and prunes the 2025 partition to `never executed`, but still pays
   `Heap Fetches: 1592` (because `floor_price_usd` is not in the INCLUDE) and the per-loop cost does not
   move.

⚠ **Caveat on ranking these three numbers: the instance load varies between runs, minutes apart.** Do not
read 20 s → 38 s as "variant 2 made it 1.9× worse". The safe conclusion is the one that matters: **all
three are tens of seconds, and neither restructuring is a fix.** The work is inherently ~3.6 k random
reads.

## What the actual fix is — and it is one we have already half-identified

There is **no materialized latest-FMV source**. `fmv_current` is a plain view (`relkind = 'v'`, 0 bytes),
so joining it recomputes `DISTINCT ON` over the whole table and helps nothing.

**This is the same missing thing behind at least three separately-filed symptoms:**

- this page (tens of seconds, live Sentry error, 12 public pages),
- `rpc_fmv_confidence_share()` **exceeding a 60 s statement budget**, which is why the trust board needs
  the `rpc_thp_leg_fmv_coverage` precompute leg at all (measured today, 90.6 s for that leg),
- the public-board timeouts, whose 08-12 note already names "the shared materialize-latest-FMV item" as
  the lever rather than another index.

**Recommendation: promote "materialize latest FMV per edition" from a board-cache line-item to its own
piece of work**, because it now has a user-facing symptom and three consumers. Shape: a
`fmv_latest(edition_id PK, collection_id, fmv_usd, floor_price_usd, confidence, computed_at)` table
maintained by `fmv-recalc` on write (it already knows the latest value at the moment it writes it), or a
MATERIALIZED VIEW refreshed CONCURRENTLY on the recalc cadence. Either turns all three consumers from
per-edition probes into a single index scan.

⚠ **Sequencing note:** it must be written by whatever already computes FMV, not by a trigger on
`fmv_snapshots` — that table takes deliberate daily duplicate history ("daily duplicates are intentional
history, not a bug"), so a per-row trigger would fire on every historical write.

## Not filed as an emergency

2 events / 1 user. The page fails to a retryable error boundary, not a 404, and not to wrong data. This
is a **latency and cost** defect on public SEO surfaces, not a correctness one — but it is the first
*user-visible* consequence of the missing latest-FMV materialization, which is why it is worth promoting.
