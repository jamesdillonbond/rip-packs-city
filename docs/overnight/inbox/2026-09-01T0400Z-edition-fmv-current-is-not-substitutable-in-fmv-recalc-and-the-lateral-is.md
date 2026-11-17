# ⛔ The queued `edition_fmv_current` swap in fmv-recalc would have corrupted 4 editions — the LATERAL is the fix, and it is proven equivalent

**Filed 2026-08-31 ~20:55 PT (2026-09-01 ~03:55Z) by Claude Code from Trevor's Windows box**, while
draining the 09-01 cloud handoffs. Zone read with `Get-Date -Format "yyyy-MM-dd HH:mm zzz"` →
`2026-08-31 20:48 -07:00`, so this is a PT-dated 08-31 action.

## What was queued, and why I did not ship it as written

The 0219Z and 0300Z cloud handoffs both queued, for Claude Code:

> `fmv-recalc` route Steps 5c/5d/5e — replace the `latest` CTE with a read of
> `public.edition_fmv_current` (~33 min of DB time a day in a path returning zero rows).

The **cost** half of that finding is real and I acted on it. The **remedy** half is not safe, and the
measurement that says so took one query.

### The measurement

Steps 5c/5d/5e each built `WITH latest AS (SELECT DISTINCT ON (edition_id) edition_id, confidence
FROM fmv_snapshots ORDER BY edition_id, computed_at DESC)` and used it for exactly one thing: the
predicate `(l.edition_id IS NULL OR l.confidence = 'NO_DATA')` (5e: `IN ('STALE','NO_DATA')`). So the
whole question is whether `edition_fmv_current.confidence` equals the true latest snapshot's
confidence, per edition.

**Membership agrees perfectly, which is exactly what makes this trap convincing:**

| check | result |
|---|---:|
| `edition_fmv_current` rows | 27,170 |
| distinct `edition_id` in `fmv_snapshots` | 27,170 |
| in `edition_fmv_current`, no snapshot | **0** |
| has a snapshot, absent from `edition_fmv_current` | **0** |

**`confidence` does not:**

| direction | count | consequence |
|---|---:|---|
| true = `NO_DATA`, efc ≠ `NO_DATA` | 0 | (would only under-include — benign) |
| **true ≠ `NO_DATA`, efc = `NO_DATA`** | **4** | ⛔ **admitted to the backfill and OVERWRITTEN with ASK_ONLY × 0.90** |
| any disagreement | 41 | — |

Four editions carrying a real snapshot would have been repriced off a troll-tolerant ask haircut, in a
step whose entire stated contract is *"an edition with ANY sale heals to a sales-based label via Step
5b (strictly better), so we must not steal it here."* The lag is small, the blast radius is not: this
writes `fmv_snapshots`.

⭐ **This is the THIRD independent time `edition_fmv_current` has been measured non-substitutable** —
see `2026-08-24T0455Z-the-fmv-haircut-topshot-leg-…-the-obvious-fix-loses-71pct-of-it.md` and
`2026-08-26T1500Z-…-edition-fmv-current-is-NOT-a-drop-in.md`. It is a *lagging materialisation*, and
CLAUDE.md's own rule covers it: **a lagging materialisation is not safe as a predicate filter.** The
pattern to notice is that it keeps passing the cheap check (row counts match) and failing the real one
(per-row values).

## What I shipped instead — a per-edition LATERAL

Same source table, same ordering, one index descent per candidate instead of a walk of the whole
history. This is the shape already ratified twice in this repo (`get_fmv_for_editions`,
`20260831151141_…thin_sales_guard_lateral…`).

**Cost, warm-vs-warm, `EXPLAIN (ANALYZE, BUFFERS)` on Step 5c:**

| form | buffers | exec |
|---|---:|---:|
| `DISTINCT ON` CTE (old) | 98,172 | 452 ms |
| **LATERAL + `LIMIT 1` (shipped)** | **75,975** | **159 ms** |
| `COALESCE((SELECT … LIMIT 1),'NO_DATA') = 'NO_DATA'` (**falsified**) | 120,508 | 343 ms |

⚠ **The COALESCE variant is recorded because it looks better than it is.** The idea was to let the
selective `NOT EXISTS (sales)` anti-join filter *before* the snapshot probe. The planner instead keeps
it as a per-row `SubPlan` inside the `editions` index-scan filter, loses the hash join, and costs
**more than the thing being replaced**. Measured, not assumed — do not re-try it.

### Equivalence — proven, and NOT vacuously

⚠ **The obvious test would have proven nothing.** Running old-vs-new for Step 5c and diffing with
`EXCEPT` gives `0 rows = 0 rows, 0/0` — because this path legitimately returns zero rows, which is the
very fact that made it worth optimising. `P(pass | the rewrite is broken)` there is ~1.

So the substitution was tested against the full population it operates on, in **one MVCC snapshot**:

| scope | rows compared | predicate class | `old EXCEPT new` | `new EXCEPT old` |
|---|---:|---:|---:|---:|
| all editions (5c/5d shape) | **27,170** | 4,508 `NO_DATA` | **0** | **0** |
| Top Shot–scoped (5e shape) | **19,762** | 5,032 `STALE`/`NO_DATA` | **0** | **0** |

`fmv_snapshots.confidence` is `NOT NULL`, so `l.edition_id IS NULL` ⟺ no snapshot row either way; the
LATERAL still selects `edition_id` so the predicate is preserved term-for-term rather than relying on
that.

## Two things I did NOT do, stated rather than dropped

1. **Step 6's `latest` CTE (the `forceStale` re-stamp) is untouched and should stay that way.** It
   *drives* the query — it selects every edition whose newest snapshot is >24 h old — so a per-edition
   LATERAL would do ~26k descents to replace one ordered merge walk. Different shape, different
   answer. Converting it is not a mechanical repeat of this change.

2. **The remaining cost is not in the join form any more, and the next lever is a VACUUM, not SQL.**
   In the shipped plan, `fmv_snapshots_2026` shows **`Heap Fetches: 10,880`** out of 12,148 probes —
   the covering index `…_ed_ct_conf_idx` (built by the 0219Z pass precisely to avoid heap fetches) is
   being defeated by a stale visibility map. And **24,296 buffers — 32% of the query — are spent
   probing `fmv_snapshots_2027`, a partition with ZERO rows**, because the partition key is
   `computed_at` and this predicate is on `edition_id`, so it cannot be pruned. Both are worth a look;
   neither is a reason to hold this change.

## Verification

`npx tsc --noEmit` clean; full `npm test` run before commit. The three rewritten statements are
string-built SQL inside `app/api/fmv-recalc/route.ts` and are not covered by any pinned SQL fixture,
so the equivalence table above **is** the test — which is why it was run against a real population
rather than against this path's empty result.
