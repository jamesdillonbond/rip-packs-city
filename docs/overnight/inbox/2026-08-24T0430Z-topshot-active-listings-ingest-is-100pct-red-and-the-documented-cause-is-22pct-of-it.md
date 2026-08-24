# `topshot-active-listings-ingest` is 100% red, and the documented cause is 22% of it

**Filed 2026-08-23 21:35 PT (2026-08-24 04:35Z), Claude Code on Trevor's Windows box.** Read-only: 40 GitHub Actions logs, one `pg_stat_statements` read, two repo greps. **No code change, no DB change, no schedule change.**

**Why this exists:** a single red run was noticed after tonight's R46 push. Checking whether it was mine turned up a streak, and reading the streak refuted the register's account of it.

---

## The measurement

**40 of the last 40 runs failed** — unbroken from **2026-08-19 07:11Z to 2026-08-24 04:11Z**, zero successes in the window. The workflow fires `29 */3 * * *` (8×/day) from GitHub Actions.

⚠ **I read every one of the 40 logs rather than sampling.** That is the whole point of this filing — the register's figure came from a 7-run sample.

| cause | count | share | where it dies |
|---|---:|---:|---|
| `GET targets failed: 500 {"error":"canceling statement due to statement timeout"}` | **29** | **72.5%** | RPC's own DB, at `?phase=targets` |
| Atlas WAF block → runner's egress probe trips, exit 1 | **9** | **22.5%** | Cloudflare, mid-sweep |
| `GET targets failed: 504 An error occurred with your deployment` | 2 | 5.0% | Vercel gateway, same endpoint |

⚠ **The 9 WAF runs do not print `FATAL`, so a `grep FATAL` classifies them as "unknown" and a careless pass lumps them with the other 31.** They log `egress probe: 5 consecutive failures with 0 successes after 106s — treating as WAF block, stopping early`, then `DONE {…"rows_upserted":0}`, then exit 1. **A `##[error]Process completed with exit code 1` with no FATAL above it is the tell for this class.**

---

## 🚨 What this refutes

CLAUDE.md and known-issues **#20** both said: *"~60% of `topshot-active-listings-ingest` sweeps meanwhile fail `egress_blocked`"*, sourced to the 2026-08-22 pipeline alert at **5/7 runs**.

- **The rate is 22.5%, not ~60%.** The 5/7 sample was real and unrepresentative.
- **More consequential than the number: `atlas-proxy`'s `wrangler deploy` (#20) cannot un-red this workflow.** It addresses 9 of 40 failures. The other 31 never reach Atlas.
- ⚠ **The register named the smaller of two failure modes and gave the pipeline one badge.** This is the recorded shape — *a permanently-red instrument is indistinguishable from a broken one at a glance* — with the twist that the diagnosis attached to the badge was for the minority cause.

**Do not credit #20 with fixing this pipeline.** It is still worth shipping on its own merits; it is not the blocker here.

---

## The dominant failure, named exactly

`scripts/ingest-topshot-active-listings.mjs:89` throws on a non-OK response from:

```
GET /api/cron/topshot-active-listings-ingest?phase=targets&floor=100
```

That route's entire GET body ([route.ts:52](../../../app/api/cron/topshot-active-listings-ingest/route.ts#L52)) is:

```ts
const { data, error } = await supabaseAdmin.rpc("topshot_serial_board_targets", { p_min_no1_estimate: floor });
```

`supabaseAdmin` is `service_role`, whose `rolconfig` `statement_timeout` is **30 s**.

### 🚨 The RPC is marginal at rest, not only in a spell

`pg_stat_statements` over the **complete** population — reset 2026-08-12 01:34Z with `dealloc = 0`, so nothing was evicted and these are all of them:

| | |
|---|---:|
| calls | 57 |
| mean_exec_time | **13,163 ms** |
| max_exec_time | **29,949 ms** |
| ceiling (`service_role`) | **30,000 ms** |
| shared_blks_read | 620,272 |
| shared_blks_hit | 46,184,123 |
| buffer touches **per call** | **~6.2 GB** |

**The mean sits at 44% of the timeout and the max at 99.8% of it.** A query shaped like that does not need a saturation spell to fail — ordinary contention is enough, which is exactly what a 72.5% failure rate across all hours of the day looks like.

⚠ **`max_exec_time` = 29,949 ms is the timeout, observed.** Cancelled statements are still recorded, so the 57 calls mix successes and kills; I am **not** claiming a success/failure split from this row.

---

## ⚠ This is an R46 symptom, not an R46 cause

Stated explicitly because the temptation runs the other way:

- **Not a cause.** ~5 GB of disk reads over 12 days is **~0.06%** of R46's measured 8,227 GB. Fixing this query does not move the saturation.
- **Very much a victim.** ~6.2 GB of buffer touches per call is roughly the whole 6.5 GB hot set, on an instance with 512 MB of `shared_buffers`. It cannot stay resident, so every call re-reads it.
- 🚨 **And R46 was decided as "no capacity change, permanently" on 2026-08-23.** So the usual escape — *it will get better when the box gets bigger* — is closed by decision. **This pipeline stays red until the query is cut down.** That is the direct, foreseeable consequence of option E landing on a real pipeline, and it arrived the same night.

---

## ⚠ What I have NOT established

1. **What the outage costs.** I did not trace the consumers of `topshot_active_listings`. `ts_listings` is separately recorded as DEAD, and the two must not be conflated. **Until a consumer is named, this is a broken pipeline, not a user-facing defect** — and it must not be written up as one.
2. **Why the query costs 6.2 GB per call.** No `EXPLAIN` was run: any plan taken tonight would be taken inside a spell, and this repo's own rule is that a benchmark in a spell cannot verify or characterise a fix. **Re-measure in a 20:00–00:00Z quiet window.**
3. **Whether it ever succeeded.** 40/40 is the limit of what `gh run list` returned in one page; the streak may be longer. I did not page further.
4. **Whether the 9 WAF runs and the 29 DB runs correlate with anything** (time of day, target count). Not looked at.

---

## Suggested next step, not taken

The obvious shape is to bound the target selection the way `/api/ready`'s count was bounded — but **`topshot_serial_board_targets` returns a working set, not a scalar**, so the `/api/ready` trick does not transfer, and a `LIMIT` bounds output rather than cost (the recorded `drain_fmv_cold_tail` lesson). **This needs the `EXPLAIN` from a quiet window before anyone proposes a fix**, which is precisely what I declined to do tonight.

⚠ And per the R46 decision: any remedy that adds a cron, an index build or a materialisation must state **its steady-state IO cost and what it displaces**. The budget is at 100% by choice now.

---

## FOLLOW-UP 2026-08-23 22:35 PT — the plan is read, and it wants the object R52 was parked on

**Method note:** everything below is either a catalogue read or a **plain `EXPLAIN`** — no `ANALYZE`, nothing executed. That is deliberate: a plan *shape* is structural and valid in a spell, whereas a *timing* is not. The filing's open item #2 asked for a quiet window; this is the part that did not need one.

### The function chain

`topshot_serial_board_targets` is a thin `jsonb_agg` wrapper. The cost is one level down in **`topshot_serial_board_candidates`**, whose leading CTE is:

```sql
WITH latest_fmv AS (
  SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.fmv_usd, fs.confidence::text
  FROM fmv_snapshots fs
  WHERE fs.collection_id = '95f28a17-…'   -- all of Top Shot
  ORDER BY fs.edition_id, fs.computed_at DESC
)
```

### 🚨 The measured plan: **857,293 rows scanned to return 13,230** — a ~65:1 read amplification

```
Unique  (cost=0.70..69396.13 rows=13230)
  ->  Merge Append  (cost=0.70..67252.89 rows=857295)
        ->  Index Scan using fmv_snapshots_2026_collection_id_edition_id_computed_at_idx
              on fmv_snapshots_2026  (rows=857293)
```

- **`Index Scan`, not `Index Only Scan`.** Every one of those ~857k index entries takes a **heap fetch**, because the CTE also selects `confidence`, which no index covers.
- ⚠ **There IS a covering index and it is the wrong cover:** `fmv_snapshots_2026_coll_ed_ct_fmv_idx` is `(collection_id, edition_id, computed_at DESC) INCLUDE (fmv_usd)` — **118 MB** — and the planner **declined it** in favour of the smaller 91 MB index, because `INCLUDE (fmv_usd)` buys nothing while `confidence` still forces the heap. **A 118 MB index is being maintained for this query shape and cannot serve it.**
- **`DISTINCT ON` cannot skip.** Postgres has no index-skip-scan, so it walks every historical snapshot of every Top Shot edition to keep one row each. This is the documented `drain_fmv_cold_tail` shape — *a `LIMIT` bounds output, not cost* — in a second place.

That accounts for the ~6.2 GB of buffer touches per call, and for why the mean sits at 44% of a 30 s ceiling.

### ⚠ The obvious fix is the one this repo has already measured as WORSE

Three prior fixes in this codebase replaced raw `fmv_snapshots` with the **`fmv_current`** view (watchlist ×2, concierge FMV distribution). **Do not reach for it here.** The recorded measurement: `fmv_current` pushdown is **shape-dependent** — a literal `IN` list is ~335 buffers, but a **`JOIN` or `IN (subquery)` is ~1.05M buffers**. This call site is a `JOIN`. **The idiomatic fix is the pessimal one at this shape.**

### ➡ What it actually wants is R52's object, and that changes R52's arithmetic

`topshot_serial_board_candidates` needs *latest-FMV-per-edition, precomputed*. **That is exactly the missing object R52 identified** — and R52 was parked on the R46 capacity decision, which has now been answered "no capacity change."

🚨 **So R52 has a second consumer, and this one is not a latency complaint — it is a pipeline that has been 100% red for five days.** R52's own note says the rollup cuts buffers ~10× and *"cannot fix ~74 ms per disk read"*; that reasoning was written against ISR pages that still serve 200. **It does not transfer to a caller that fails outright at a 30 s ceiling**, where a 10× buffer cut is the difference between finishing and not. R52 should be re-litigated with this consumer counted — which is the re-litigation I flagged as owed when the gate opened, now with a concrete reason.

### ⚠ What is STILL not attributed, and the instrument that cannot do it

`serial_fmv_estimate` is called **twice per surviving row** — and it is **plpgsql, 6,776 chars, and reads tables**. It is the other candidate for the bulk of the cost.

⛔ **`pg_stat_statements.track = 'top'` on this instance, so nested statements inside plpgsql are NOT tracked.** The 6.2 GB/call figure therefore *includes* everything `serial_fmv_estimate` does but **cannot be split from it**. There is no way to attribute between the `DISTINCT ON` and the 2×-per-row function from `pg_stat_statements` at all.

➡ **Sharpened next step:** `EXPLAIN (ANALYZE, BUFFERS)` in a **13:00–17:00 PT** window is the *only* instrument that can separate these two. Not "run EXPLAIN to see the plan" — the plan is now read — but specifically to get **per-node actual buffers**. Until then, "the `DISTINCT ON` is the cost" is a **well-supported hypothesis, not a measurement**, and the 65:1 amplification is its evidence rather than its proof.

⚠ And per the R46 decision: if the remedy is a rollup, it must state its steady-state IO cost and what it displaces. **The honest version of that argument here is that it would DISPLACE the 118 MB index the planner already refuses to use.**
