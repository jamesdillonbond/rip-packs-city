> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# `/api/collection-moments` fails **10 of 18 requests** and the cause is heap fetches on two hot tables, not the query shape

**Filed 2026-08-29 18:12 PT (2026-08-30 01:12Z) · Cowork cloud autonomous pass · READ-ONLY, nothing shipped**

> ⚠ **The no-push blocker below is specific to THIS cloud session.** Trevor's machine and Claude Code
> push normally via the PAT in `remote.origin.pushurl` — **commit these files as usual.**

Derived against a fresh clone of `origin/main` at **`47955055d`**, read 2026-08-30 00:58Z.
All DB reads are live against `bxcqstmqfzmuolpuynti`, stamped in-line.

---

## The number, with its denominator

Per the standing rule that a failures-only query reads as 100% failing, this is the whole route:

| route | 200 | 500 | 504 | fail % |
|---|---:|---:|---:|---:|
| **`/api/collection-moments`** | **8** | **10** | 0 | **56 %** |
| `/api/market` | 330 | 2 | 38 | 10.8 % |
| `/api/sniper-feed` | 347 | 0 | 16 | 4.4 % |

Vercel production runtime logs, 24 h window ending 2026-08-30 01:10Z,
`prj_YBJ6Utl32GfyBOIzbsp3kbshJh96`. `/api/collection-moments` is a **user-facing wallet
collection page** and it is the worst-performing route on the board by more than 5×.

⚠ **Low traffic is not low harm here.** 18 requests is a handful of collectors looking at their
own portfolios; more than half of them got an error page.

## The 10 split into two unrelated causes, and only one is new

**Four are the dead legacy endpoint** — `Top Shot GraphQL failed with 530`,
Cloudflare **error 1033** (Argo Tunnel not connected) against `public-api.nbatopshot.com`,
at 19:58:53–19:59:00Z. Already recorded: see
`inbox/2026-08-29T1630Z-CORRECTION-it-is-not-a-topshot-outage-…`. Nothing new.

🚨 **Six are `57014 canceling statement due to statement timeout`** inside
`get_wallet_moments_with_fmv`, at 19:30:16Z and 19:32:25Z, for wallet `0xbd94cade097e50ac`,
collection `nba_top_shot`. **One of the two failing calls passed `p_limit: 1`.**

⭐ **`p_limit: 1` timing out is the whole finding.** It says the cost is not in producing the page
of results — it is paid in full before the LIMIT can help.

## Measured, from outside, at 01:0xZ

| what | buffers | time |
|---|---:|---:|
| `get_wallet_moments_with_fmv(…, p_limit **1**, …)` — whole call | **139,771** (126,809 hit / 12,962 read) + **722 temp blocks** | **24.2 s** |
| its `base` + `total` leg alone (wmc ⋈ editions ⋈ LATERAL fmv) | 74,272 | 0.39 s |

`EXPLAIN (ANALYZE, BUFFERS)` on the function call, 2026-08-30 01:0xZ.
**The function carries `SET statement_timeout TO '30s'`** — so 24.2 s is not a healthy read that
happened to lose a race, it is a read sitting at 81 % of its own ceiling. That wallet holds
**15,181** `wallet_moments_cache` rows in `nba_top_shot`.

## ⛔ The obvious shape-defect hypothesis is REFUTED — do not re-file it

I expected `base = base_other UNION ALL base_pinnacle` to scan `wallet_moments_cache` **twice**,
because the collection discriminator (`p_collection_id = pin_uuid`) sits in each arm's `WHERE`
rather than gating the branch — which would have explained the 74k → 140k doubling exactly.

**It does not.** Forced generic plan, parameters not folded:

```
Append
  ->  Result   One-Time Filter: ($2 <> '7dd9dd11-…'::uuid)      actual rows=15181
  ->  Result   One-Time Filter: ($2 =  '7dd9dd11-…'::uuid)      actual rows=0
        ->  Index Scan … on wallet_moments_cache wmc_1          (never executed)
```

Postgres emits a **One-Time Filter** and the Pinnacle arm is `never executed`, generic plan or not.
The UNION ALL is free. **Filing this so the next pass does not spend the same hour on it.**

## ⭐ What it actually is: stale visibility maps on the two hottest tables

Both legs degenerate the same way, and it is the class the 08-29 leaderboard fix named.

**1. `fmv_snapshots_2026` — the per-row FMV LATERAL.**

```
Index Only Scan using fmv_snapshots_2026_edition_id_computed_at_idx
  Heap Fetches: 14386          (of 15,181 loops)
  Buffers: shared hit=59613 read=182
```

**59,613 of the 74,272 buffers in the base leg** are that one LATERAL, and 14,386 of 15,181
index-only probes had to visit the heap anyway. `last_vacuum` is **NULL** — it has never had a
manual vacuum; last autovacuum 2026-08-29 20:19Z, `n_mod_since_analyze` 30,478 on 1,330,382 live
tuples.

**2. `wallet_moments_cache` — the wallet scan itself.**

```
Index Only Scan using idx_wmc_lock_wallet_coll
  Heap Fetches: 6519           (43 % of 15,181)
  Buffers: shared hit=1865 read=4172 dirtied=524
  Execution Time: 5933 ms      ← for a bare count(*) of 15,181 index entries
```

`last_vacuum` **NULL**; autovacuum ran **00:43:26Z, seventeen minutes before this reading**, and the
map was still 43 % un-set. `n_dead_tup` 44,645 / `n_mod_since_analyze` 44,700 on 2,503,990 rows.

⭐ **The generalisation this adds to the leaderboard finding:** on `wallet_moments_cache` a *recent
autovacuum is not evidence of a fresh visibility map*. The delete-then-insert / high-churn write
pattern re-dirties pages faster than the trigger fires, so "autovacuumed 17 minutes ago" and
"43 % heap fetches" are both true at once. **Check `Heap Fetches`, never `last_autovacuum`.**

ⓘ The ledger has recorded this same staleness on `fmv_snapshots_2026` twice before —
`Heap Fetches: 14782` at ledger:19038 (*"Left to autovacuum — a manual VACUUM on the hottest
partition is an operator call"*) and ledger:24885 (*"a cost estimate is not a measurement, and on
`fmv_snapshots` it is systematically optimistic about index-only scans"*). **This is the third
sighting and the first one with a user-visible 500 attached to it.**

## ⛔ Why nothing shipped, stated rather than implied

Three candidate levers, all declined **for cause**, not for fatigue:

1. **Manual `VACUUM public.fmv_snapshots_2026`** — the ledger has already ruled this "an operator
   call" (19038). I am not overriding a recorded operator decision unattended.
2. **A scheduled `maint-vacuum-fmv-snapshots-hot-partition`, copying jobid 383's shape** — this is
   the tempting one and it is premature. **jobid 383's own first tick has not run yet** (`53 10,20`,
   first at 10:53Z; `cron.job_run_details` holds zero rows for it as of 01:0xZ). Extending an
   unproven pattern to the platform's most write-heavy table, unattended, is how a pass ships a
   plausible mechanism instead of a measurement.
3. **Autovacuum storage parameters on `wallet_moments_cache`** — blocked on the exact measurement
   `inbox/2026-08-29T0241Z-…` demands: `insert_scale_factor` is proportional to table SIZE while map
   staleness is driven by write RATE, and that note proves copying `2000 / 0.01` unexamined produces
   a trigger that fires *after* the map has already rotted. I have not measured wmc's write rate.

⛔ **And the function itself is not a cloud pass's to rewrite.** `get_wallet_moments_with_fmv` is
pinned by `supabase/tests/get_wallet_moments_with_fmv.sql` (envelope, sort ladder, `total_count`
semantics, `price_band_30d` gate, `serial_fmv` passthrough), is reached by an anon-executable
invoker path that keeps `serial_fmv_estimate`'s grant load-bearing, and is THE wallet-display read.

## 👉 For Trevor — the decision, and what would settle it

**The measurement that decides lever 2 arrives on its own at 10:53Z**: jobid 383's first
`maint-vacuum-sales-hot-partition` tick. If it exits `succeeded` under 600 s and `sales_2026`'s
`last_vacuum` advances, the pattern is proven and extending it to `fmv_snapshots_2026` becomes a
routine copy. If it 57014s again, neither table should get a scheduled vacuum until the budget
question is answered.

**Falsifier for this whole finding:** re-measure `get_wallet_moments_with_fmv` for
`0xbd94cade097e50ac` after any vacuum of the two tables. If buffers do not fall well below 139,771,
the heap fetches were not the cost and the sort/CTE-materialisation leg is the real lever — note the
**722 temp blocks**, which say the 15,181-row `filtered` materialisation already spills to disk.

## ⚠ A correction to my own working hypothesis, recorded because it nearly shipped as a finding

`rpc_ops_snapshot()` **timed out twice** in this pass (MCP 60 s, then an explicit 50 s
`statement_timeout`), and the 08-29 17:32Z pass had just fixed it. I was one step from filing
"`rpc_ops_snapshot` has regressed."

**It has not.** Arm-by-arm, the same session, minutes apart:

| arm | seconds |
|---|---:|
| security (4 invariants) | 0.69 |
| `detect_stalled_pipelines` + `get_pipeline_alerts` | 4.34 |
| `v_rpc_trust_health` + `pipeline_fails_24h` **together** | **33.31** |
| `v_rpc_trust_health` **alone**, moments later | **5.43** |
| `pipeline_fails_24h` alone | 0.04 |
| `editions_by_collection` + ts_uuid arm | 0.08 |
| `fmv_by_collection` (5 × `sentinel_fmv_confidence_rows`) | 1.65 |
| **whole `rpc_ops_snapshot()`, third attempt** | **9.35 s — returned all keys** |

Sum of parts ≈ 12 s; the function timed out at 50 s twice and returned in 9.35 s once. **That is
contention, not structure** — the same lesson the leaderboard work recorded as *"two identical runs
read IDENTICAL buffers at 4,970 and 9,530 ms, so buffers are the durable figure and timings are
contention-confounded."* ⛔ **Do not re-diagnose `rpc_ops_snapshot`.** If it must be made robust, the
lever is splitting the read, not fixing an arm.
