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
