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

---

## ⛔ CORRECTION 2026-08-23 23:05 PT — **MY OWN HEADLINE IS WRONG. The pipeline has a SECOND caller, it works, and I measured one arm.**

I went looking for the consumers of `topshot_active_listings` to decide whether this outage is user-facing. It is — and on the way the table refuted the filing above.

### The measurement that broke it

`topshot_active_listings`: **624 rows, 224 active, newest `last_seen_at` = 7.1 hours ago.** Not five days. **Something is writing this table.**

`pipeline_runs` names it: **two `ok: true` runs, `rows_written` 224 (2026-08-23 22:13Z) and 257 (2026-08-21 22:13Z), with 1,274 and 1,408 `atlas_calls` and 0 skips.** Atlas was not blocking those runs at all. And **22:13Z is not on the workflow's `29 */3` schedule.**

### 🚨 The second caller is an EIGHTH source, and nothing in this repo can see it

**`RPC Deal Board Ingest` — a Windows Scheduled Task on Trevor's own box**, `PT3H` from `00:13 -07:00`, running `scripts/run-active-listings-ingest.ps1`. It is invisible to all six sources CLAUDE.md requires, *and* to cron-job.org (the documented seventh), *and* to GitHub Actions, `vercel.json`, and `cron.job`.

**It is not alone. Four production ingests run from this box:**

| task | cadence | last run (PT) | rc |
|---|---|---|---|
| `RPC Deal Board Ingest` | every 3 h from 00:13 | 08-23 22:20 | **1 — FAILED** |
| `RPC Pinnacle Render Cache Fill` | **every 15 min** | 08-23 22:41 | 0 |
| `RPC Panini Ingest` | every 4 h | 08-23 22:00 | still running |
| `RPC AllDay Badge Ingest` | daily 05:37 | 08-23 05:37 | 0 |

💡 **This is where "residential Atlas ingest" physically happens** — a phrase carried in the notes for months without a location. Atlas WAF-blocks GitHub runners and Vercel egress; it does **not** block Trevor's home IP. **So the local task is the arm that actually feeds the public board, and the GHA workflow is the arm that cannot.**

### The corrected severity — worse-founded, and pointing the same way

**❌ Wrong:** *"100% red for 5+ days"* — that is the GHA arm only, and GHA was never the working arm.

**✅ Right:** the residential arm succeeded **1 of 8 runs on 2026-08-23** (15:13 PT only; 00:13, 03:13, 06:13, 09:13, 12:13, 18:13 and 22:20 all logged `start` and then died). **And it dies at the same `GET targets` DB timeout.**

➡ **So the DB timeout is not merely breaking a WAF-blocked arm that was already useless. It is breaking the ONLY arm that works**, cutting the board's refresh from 8×/day to about once a day. That is a smaller headline and a stronger argument: the R46 symptom is the binding constraint on a working production path, and #20's `wrangler deploy` is even less of a remedy than the section above said.

### ⚠ Three failure-rate numbers, three populations, and none of them is "the pipeline's rate"

This is why the register, the monitor and I all disagreed — and **no one was lying**:

| figure | source | population it actually measures |
|---|---:|---|
| "~60% `egress_blocked`" | known-issues #20 | a 5-of-7 sample of `pipeline_runs` |
| "80.0% `egress_blocked`" | `metrics-latest.json` | all of `pipeline_runs` |
| "22.5% `egress_blocked`" | this filing | GitHub Actions run conclusions |

🚨 **`pipeline_runs` cannot see the dominant failure at all, by construction: the route writes its `log_pipeline_run` row in the POST phase, and the DB timeout kills the run in the GET phase.** So every instrument reading `pipeline_runs` sees a population *filtered to runs that got past the timeout* — and inside that population, `egress_blocked` really is ~80%. **The pipeline's own telemetry is structurally blind to the thing that stops it**, which is the recorded "green pipeline blind to its own work" shape in a new place. ⓘ Corroboration: ~48 runs should exist across the 73 h retention window (two callers × 8/day); `pipeline_runs` holds **7**.

### ⚠ And the local task's failure leaves no trace in its own log

The failing runs log the header and `[listings-ingest] start …` and then **nothing** — no error, no exit code, just the next run's header. ⚠ **The script does redirect every stream** (`node … *>&1 | Tee-Object -FilePath $log -Append`), so "stdout only" is not the explanation; my first guess was wrong. **Likely mechanism, corroborated by a recorded gotcha rather than measured here:** PowerShell 5.1 wraps a native executable's stderr in `NativeCommandError` records, which is exactly how a real error becomes invisible in a `Tee-Object` pipeline. **Unverified — do not repeat it as fact.** What IS measured: **a reader of this log cannot tell a failed run from a run that never started.**

### What still stands from the sections above

The plan finding is untouched and is now *more* important, not less: the `DISTINCT ON` scanning 857,293 rows to return 13,230 is what kills the residential arm 7 times in 8. R52's second consumer is real. `serial_fmv_estimate` is still unattributed and `pg_stat_statements.track = 'top'` still cannot split it.

---

## ✅ RESOLVED 2026-08-24 00:05 PT — **both consumers are HONEST. Not escalating.** One residual, precisely bounded.

The correction above left one question open and explicitly refused to escalate it: *do the two consuming surfaces bound their liveness claim by `last_seen_at`?* Both were read. **They do.** Recording the negative result, because "I checked and it was fine" is the finding that never gets written down and therefore gets re-derived.

### The view gates on `active`, not on age — so the question was real

`topshot_underpriced_serials_board` filters `WHERE l.active AND …`. It **selects** `l.last_seen_at` and passes it through, but **never filters on it**. And `active` is only cleared by `deactivate_stale_topshot_active_listings`, which runs *only on a successful ingest* — so when the ingest fails, `active` is **frozen** and a sold or delisted moment stays on the board. The DB layer alone would publish a stale listing as live.

### ✅ The page bounds it

`UnderpricedSerialsBoardClient.tsx` computes `listingsAgeHours` from `max(last_seen_at)` across the rows and renders, at **≥4 h**:

> `Listings last refreshed {N}h ago`

At tonight's 7.1 h that caption is live on the page right now. ⓘ Its own comment already knew the shape I spent the evening rediscovering: *"the ingest runs ~every 3h from a residential runner and can skip overnight."* **The knowledge existed in a component comment and in no reference doc** — which is precisely why CLAUDE.md says a fact left in one file stops being read.

### ✅ The concierge bounds it, and unusually well

`app/api/support-chat/route.ts` reads `max(last_seen_at)` where `active`, computes `feedAgeHours`, **tells the model the age on every call**, and sets a deliberately conservative `feed_stale` at **36 h**. Its comment records why the obvious 24 h ceiling was rejected — measured gaps of min 3 h / median 6 h / **p90 22 h / max 26.7 h** — and names the cry-wolf precedent (`ufc_fmv_stale_hours`) it was avoiding. **This is the honesty canon applied correctly, including the part about not making the flag the primary output.**

### ⚠ The residual: the OG card asserts "live deals" with no age at all

`app/api/og/insights/underpriced-serials/route.tsx` handles a **failed** read (`boardEmptyCopy(fetched, "board")`) but has **no staleness path**. It renders `boardCountLabel(count, 'live deals')` and a footer `Live deals · buy on Dapper`. Grepped for any age signal: the only matches are substrings of *message*, *Image*, *page*. **There is none.**

- **This is the documented shape, not a new one:** *fix per PANEL, not per page.* The OG card is its own layer in the four-layer honesty table, with its own helper — and it was hardened for the failed-read case while the stale-read case went to the page only.
- **Severity: LOW–MEDIUM, and stated carefully.** The count is a real count of `active` rows, so this is **not** a fabricated number. The defect is an **unbounded liveness claim**: "live deals" on the surface with the widest reach (Twitter / iMessage / Slack previews) at a moment when the spine can be ~24 h old and `active` is frozen.
- **Not shipped.** The page's own ≥4 h threshold is the obvious precedent to copy, and `lib/og/board-count.ts` is shared by other boards — so this needs the blast radius checked before editing, per the rule about grepping the guards and callers of a shared helper first.

### ⚠ One stale COMMENT worth correcting when someone is next in that file

The concierge block attributes the failures to the Atlas WAF: *"fails `egress_blocked` most sweeps (the Atlas WAF blocks the GHA runner IP)"*. **Its behaviour is right and should not change** — report the age, every time. **Its diagnosis is superseded by tonight's measurement:** the dominant failure is the `GET targets` DB timeout, and the residential arm is the one that works. A future reader who trusts that comment will chase `atlas-proxy` again.
