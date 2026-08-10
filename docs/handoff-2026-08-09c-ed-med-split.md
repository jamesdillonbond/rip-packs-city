# Handoff — 2026-08-09c (Cowork cloud, ~13:00 PT)

⚠ **Scope: this blocker is THIS CLOUD SESSION only.** Your box carries the PAT in
`remote.origin.pushurl` and pushes normally. **Commit these as usual.**

---

## ✅ SHIPPED TO PROD — the `ed_med` split (2 migrations, verified)

The last structural lever on the platform's largest scheduled consumer. **Applied and verified
live; the public board is up.**

| | |
|---|---|
| `20260809200134` | `audit_20260809_perfect_mint_board_v2_ed_med_restricted_build` |
| `20260809200600` | `audit_20260809_perfect_mint_board_swap_to_ed_med_restricted` |

### 💡 Reconstruct the repo files from prod — do NOT retype them

`supabase_migrations.schema_migrations` has a **`statements`** column holding the exact applied SQL.
So the repo record can be rebuilt byte-exactly with zero transcription risk:

```sql
select version, name, statements
  from supabase_migrations.schema_migrations
 where version in ('20260809200134','20260809200600');
```

→ write each to `supabase/migrations/<version>_<name>.sql`. **This generalises: every
Cowork-applied migration's body is recoverable this way**, which is a cleaner fix for the
prod/repo drift class than relaying SQL through a handoff document (and it is how `migration-parity`
findings should be repaired going forward — pull from prod, don't reconstruct by hand).

### What changed

`mv_topshot_perfect_mint_premiums_board`'s `ed_med` CTE computed a 180-day median over **every** Top
Shot edition with ≥15 sales, then the final query INNER JOINed it to `perfect` and discarded almost
all of it. `ed_med` is now restricted to the edition set `perfect` already produces (CTEs reordered
so `ed_med` can reference it):

```sql
AND s.edition_id IN (SELECT perfect.edition_id FROM perfect)   -- the only change
```

### Equivalence — by construction, then corroborated

Restricting a `GROUP BY`'s input to a set of **group keys** removes whole groups and cannot alter a
surviving group's membership, so every survivor's `percentile_cont` median and `count(*)` — and
therefore `HAVING count(*) >= 15` — are unchanged; and `perfect JOIN ed_med` is INNER, so every
removed group was already discarded.

Corroborated against the **unrestricted** aggregate for all 164 editions v2 produced:
**164 rows / 164 matched / 0 median mismatches / 1 count mismatch / 0 below the HAVING cut.**

⚠ That 1 mismatch was chased, not waved off: edition `dc1cb92a-…`, delta **+7**, and **exactly 7**
qualifying rows were ingested after the `20:03:03Z` refresh stamp — refresh-time drift, not a
definitional difference. The ideal same-instant `EXCEPT` diff could not be run: computing the OLD
definition inline **exceeds the 55s client cap**, which is itself corroboration of the cost gap.

### Measured

Planner-only `EXPLAIN` (safe under IO throttling — planning does no IO):

| leg | current | restricted |
|---|---|---|
| `ed_med` GroupAggregate | cost 78,886 over **396,644 rows** | cost 2,246 over **6,202 rows** |
| `perfect` CTE | 97,947 | 97,946 (unchanged) |
| **total** | **176,993** | **100,355 (−43%)** |

And the v2 MV **refreshed in 9 seconds** (pg_cron jobid 260, 20:03:03→20:03:12Z) vs 300–460s for the
old definition, which has repeatedly blown its 600s ceiling.

⚠ **Two caveats on the 9s, because it is not apples-to-apples:** it was a **plain `REFRESH`** while
production uses `REFRESH … CONCURRENTLY` (which also builds and applies a diff), and two EXPLAINs on
the same shape had just run so index pages may have been warm. **The figure I stand behind is the
row-scan reduction, 396,644 → 6,202 (−98.4%)** — the meaningful one on a disk-IO-budget-bound
instance. Cost is not time; this repo has been bitten by that exact inference.

### 👉 Post-ship watch (the real number)

jobid 236 `rpc-refresh-perfect-mint-premiums`, now `17 */2 * * *`. Next ticks will give the true
production figure:

```sql
select d.status, d.start_time, d.end_time - d.start_time as dur
from cron.job_run_details d join cron.job j using (jobid)
where j.jobname='rpc-refresh-perfect-mint-premiums' order by d.start_time desc limit 4;
```

Verified post-swap: board **164 rows**, top premium **153.0×**, `{security_invoker=on}`, anon SELECT
on the **view** true / on the **MV** false, unique index present (CONCURRENTLY needs it), cron command
still matches the watchdog's `command ILIKE '%' || matview_name || '%'`,
`board_mv_refresh_stale_hours` **1.97/8**, `check_public_security_invariants()` **0**. The one-off
refresh job was unscheduled.

⚠ **Where the cost now lives:** `perfect` is **97.6%** of the remaining plan. It hash-joins a
110k-row index scan against a **seq scan of `editions`** on
`s.edition_id = e2.id AND s.serial_number = e2.circulation_count` — a cross-column correlation that
cannot be indexed directly. Treat `perfect` as a separate, genuinely hard problem; do not read this
as having addressed it.

⚠ **Rejected alternative, deliberately:** joining the existing `mv_topshot_edition_median_180d`,
whose definition is **byte-equivalent** to this `ed_med` CTE. It would remove the computation
entirely, but that MV refreshes on its own 6-hourly cron, so the median leg would carry up to ~6h of
staleness. The restriction keeps the median computed fresh at refresh time and is provably identical.

---

## 🟡 panini-squeeze — 95% already fixed; one precise branch left

`lib/insights/panini-board.ts` is **already correct** and its header already documents the defect —
`fetchRows` returns `ok:false, partial:true` on a page-N error and `fetchPaniniSqueezeDefault` gates
on `ok && !partial`, so **a truncated ranking is never cached**. Credit where due; I only found the
residual.

**The hole is the last rung of `readBoardOrLive` in `lib/insights/board-cache.ts`:**

```ts
// Nothing cached at all — hand back whatever live produced (typically empty)
return { payload: (res?.payload ?? ({} as T)), source: "live-degraded" }
```

For panini-squeeze `res.payload.initialRows` is **the truncated ~1,800-row ranking**, so on that
branch it renders. The degraded banner does travel — but a banner saying "could not be loaded" above
a plausible-looking complete leaderboard is the weaker half of the fix: for a **ranking**, no-data is
honest and partial-data is a lie.

Reached only when **no snapshot exists at all** for the key (never-yet-warmed, or after a snapshot
purge) **and** live fails — rare, but exactly the state during a long saturation spell following a
cache reset.

**Suggested fix, one branch:** suppress the rows when the ranking is partial — either have the
panini builder return `initialRows: []` when `partial`, or special-case `live-degraded` so a
partial *ranking* payload is emptied while its `degraded` notice is kept. Cheap, and it makes the
strict warm gate you already built true end-to-end.

---

## 🟡 Extending the `pre` precompute pattern — resolved as a DESIGN item, not affordable as-is

The `/api/sentinel` 504s justify moving the 25 live trust arms into the precompute, **but jobid 222
already runs at ~544–600s of its 600s ceiling**, so adding legs breaks the thing it fixes. Your
cold/warm measurement (19,002 ms cold vs 80 ms warm for 10 arms) also killed the chunking idea.

**Recommendation: split `rpc_trust_health_precompute_refresh` into per-leg functions with their own
cron entries.** It fixes three things at once:

1. Each leg gets its **own 600s budget** — headroom to absorb the live arms.
2. It fixes the **all-or-nothing rollback**: today one statement_timeout in Leg 7 (no handler) rolls
   back **all 18 metrics** — that is what happened at 12:58Z and left the table 8h stale.
3. Per-leg `computed_at` makes staleness attributable per metric, which the new
   `trust_precompute_max_age_hours` arm (breach 13) then reports precisely instead of in aggregate.

Not shipped from here deliberately: it is a refactor of a 13KB load-bearing plpgsql function plus ~7
new cron entries, on a contended instance, with no way to run the whole thing and measure from
Cowork.

---

## Not re-opened

`/api/market` — your disposition stands (already index-optimal; the lever is precompute, not
tuning). Same lever as the `deals` board's materialized latest-FMV-per-edition. The 2020–2025
`idx_sales_YYYY_serial1` builds remain operator-only (CONCURRENTLY, quiet window, SQL editor).
