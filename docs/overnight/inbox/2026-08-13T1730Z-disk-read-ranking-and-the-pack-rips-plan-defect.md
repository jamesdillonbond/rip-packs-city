# Rank the DB by disk reads and cache-hit ratio, not by time — and the one "obvious" index that turned out to be a regression

Cowork **cloud** session, 2026-08-13 ~10:35 PT (17:35Z). Measurement. **Net DB change: zero** — an
index was built, measured, and reverted in-session. `pack_rips` is back to its 9 original indexes.

> ⚠ **NO-PUSH is specific to THIS cloud session.** `git push --dry-run` returns
> `access denied by the git proxy: jamesdillonbond/rip-packs-city is not in this session's
> authorized repository set` (403). Trevor's machine and Claude Code push normally via the PAT in
> `remote.origin.pushurl`. **Commit these files as usual.**
> Also this session: `device_list_dir` works, `device_bash` fails — they fail independently, as the
> pass contract says.

---

## Part 1 — the framing: rank by disk reads AND hit ratio

Every prior cost triage on this instance ranked `pg_stat_statements` by `total_exec_time`. Under
disk-IO throttling that ranking is misleading: the top time-consumers are mostly **warm** queries
(93–99% buffer hit) that are slow because the instance is starved, not because they are starving it.
Ranking by `shared_blks_read` **and** buffer hit ratio separates the two — the low-hit-ratio big
readers are the ones evicting everyone else's working set.

Window: `pg_stat_statements` reset **2026-08-12 01:34Z** ⇒ **39.7 h**. (Read `stats_reset` first,
always — the counters are cumulative and the window is usually much shorter than it feels.)
Total across all statements ≈ **1.44 TB of `shared_blks_read`** ⇒ ~**870 GB/day** on a Small-tier
instance. That aggregate, not any single query, is the saturation everything else rolls up to.

### The low-hit-ratio big readers (>2 GB read, hit ratio <70%)

| GB read | calls | hit % | MB/call | statement |
|---:|---:|---:|---:|---|
| 58.0 | 265 | 23.0 | 224 | `fmv_recalc_edition_page(p_window_start, p_pinnacle_collection_id, …)` |
| 55.7 | 299 | 42.6 | 191 | `refresh_wmc_fmv_drift_active(p_deviation_pct, p_limit)` |
| 45.4 | 38 | **6.5** | 1223 | `raise_impossible_parallel_circ()` |
| 44.7 | 402 | 65.8 | 114 | `count_insider_detector_candidates(p_slug, p_detector)` |
| 41.3 | 43 | **0.5** | 984 | `get_allday_unresolved_pulls(p_limit)` |
| 28.3 | 13 | 11.7 | **2229** | `SELECT sales.* FROM sales WHERE ingested_at >= $1` (PostgREST paged read) |
| 17.3 | 351 | 46.6 | 51 | `topshot_pack_ev_targets` |
| 16.0 | 121 | 47.5 | 135 | `get_lock_check_batch(p_collection_slug, p_limit, p_max_age_days)` |
| 15.4 | 432 | 24.8 | 36 | `pinnacle_get_unresolved_batch_v2(p_limit)` |

For contrast, the boards that dominate the *time* ranking are **warm**: `panini_squeeze_board`
95.4% hit, `candy_scarcity_board` 98.7%, `topshot_first_mint_trophy_stats` 93.7%. They are victims
of the throttle, not causes of it. **This is the measured basis under the 08-12 conclusion that the
board timeouts are a ~15× throttling multiplier rather than a plan defect — that conclusion holds,
and now it has a cause list.**

```sql
select round((shared_blks_read*8192/1024.0^3)::numeric,1) gb_read, calls,
       round((shared_blks_hit*100.0/nullif(shared_blks_hit+shared_blks_read,0))::numeric,1) hit_pct,
       round((shared_blks_read*8192/1024.0/1024/nullif(calls,0))::numeric,0) mb_per_call,
       left(regexp_replace(query,'\s+',' ','g'),300) q
from pg_stat_statements
where shared_blks_read > 2000000
  and (shared_blks_hit*100.0/nullif(shared_blks_hit+shared_blks_read,0)) < 70
order by shared_blks_read desc;
```

---

## Part 2 — ⚠ the index that looked obvious, was built, and had to be reverted

**This is the most useful thing in this file. Do not re-derive it.**

`get_allday_unresolved_pulls(int)` — the queue read behind pg_cron jobid 22
`rpc-allday-resolve-pull-editions` (`9,39 * * * *`) → ungitted edge fn `resolve-allday-pull-editions`
— planned as:

```
Limit  (cost=237146.62..237181.12 rows=300)
  -> Gather Merge -> Sort (rows=496720)  Sort Key: r.block_height DESC
       -> Parallel Hash Join   Hash Cond: (r.pack_nft_id = p.pack_nft_id)
            -> Parallel Seq Scan on pack_rips r  (rows=1654206, cost 122714)
                 Filter: block_height IS NOT NULL AND collection_id = <AllDay>
            -> Parallel Hash -> Parallel Seq Scan on allday_pack_pull p (rows=644282)
                 Filter: edition_id IS NULL
```

Two full seq scans and a **497k-row sort to return `LIMIT 300`**. `pack_rips` carried no index on
`block_height` at all (`idx_pack_rips_collection_time` is `(collection_id, sealed_at DESC)`), so
nothing could serve the ordering and nothing could stop early. The 122,714-page scan ≈ **958 MB**,
matching the measured 984 MB/call exactly. Textbook missing index.

**Built it** — `(collection_id, block_height DESC) WHERE block_height IS NOT NULL`, ~123 MB, 3m41s
via the one-off pg_cron CIC recipe. The plan flipped to precisely the intended shape:

```
Limit  (cost=0.86..579.47 rows=300)
  -> Nested Loop  (cost=0.86..1628640.69 rows=844424)
       -> Index Scan using idx_pack_rips_collection_block_height on pack_rips r  (rows=2818356)
            Index Cond: (collection_id = <AllDay>)
       -> Index Scan using idx_allday_pack_pull_unresolved on allday_pack_pull p  (rows=3)
            Index Cond: (pack_nft_id = r.pack_nft_id)
```

**Limit cost 237,181 → 579. A 409× improvement — and it is wrong.**

`EXPLAIN (ANALYZE)` of the new plan **exceeded 60 s**, against the old plan's measured 11.2 s mean.
The reason, measured directly:

```sql
with newest as (select pack_nft_id from pack_rips
                where collection_id=<AllDay> and block_height is not null
                order by block_height desc limit 20000)
select count(*) scanned,
       count(*) filter (where exists (select 1 from allday_pack_pull p
                                      where p.pack_nft_id=n.pack_nft_id and p.edition_id is null))
from newest n;
-- scanned = 20000,  with_unresolved = 0
```

**Of the newest 20,000 AllDay rips, ZERO have an unresolved pull.** The drain has cleared the entire
recent frontier; every remaining unresolved pull is deep in history (consistent with the 08-01
ledger entry — local derivation is exhausted and the residue needs the un-deployed hydrator). So the
nested loop **cannot stop early**: it walks a very long prefix of already-resolved rips doing one
random index probe per row. A bounded probe over the newest 250,000 rips blew a 50 s
`statement_timeout`. The planner's own *full-execution* estimate agrees with the verdict —
**1,628,640 vs 294,269** — it only ever won on the startup estimate.

**Reverted**, `pack_rips` back to 9 indexes, verified.

### The three durable lessons

1. **A `LIMIT n ORDER BY <recent>` query is only cheap if the qualifying rows ARE recent.** Before
   adding an index to enable an early stop, *measure the density of qualifying rows at the head of
   the ordering.* One 3-line `EXISTS` count over the newest 20k rows would have refuted this design
   before a 3m41s build. **That check is now the first step for any "add an index so the LIMIT can
   stop early" proposal.**
2. **Planner cost is not time, and the startup cost is not the total cost.** `cost=0.86..579.47`
   read as a 409× win; `..1628640.69` on the same line said the opposite and I read past it. When a
   `LIMIT` plan's startup and total costs differ by 4 orders of magnitude, the plan is a *bet on
   early termination* — and the bet is exactly what needs measuring.
3. **On an IOPS-throttled instance, fewer bytes can be slower.** The index plan reads far less data
   and is worse, because ~10⁵ random probes cost more than one 958 MB sequential read when the
   disk is throttled. **Bytes-read is the right way to rank candidates and the wrong way to judge a
   fix.** The seq scan + sort is the *correct* plan for "the 300 newest rows of a set whose members
   are all old."

### What would actually fix it (queued, not shipped)

The lever is the **query shape**, not an index. In rough order of appeal:

- **Drop the ordering.** The function exists to hand a drain 300 rows of work. If the newest 20k
  rips are all resolved, "newest first" is sorting 497k rows to pick from a set where recency is
  meaningless. `ORDER BY` removal (or ordering by something the queue-side partial index already
  provides) makes this a cheap partial-index scan. ⚠ It changes what the edge fn receives — confirm
  `resolve-allday-pull-editions` does not depend on descending block height before touching it.
- **Bound it to the unresolved frontier** — carry a cursor/watermark the way the 07-26 resolver
  rework did for `unmapped_sales`, so each tick walks forward instead of re-deriving the same set.
- Either is a function-body change, i.e. an `apply_migration`, i.e. **shippable from Cowork** — but
  only after the caller's ordering assumption is checked. Not blind.

---

## Part 3 — method notes worth keeping

### `CREATE INDEX CONCURRENTLY` over the Supabase MCP: the recorded reason was wrong, and reality is worse

The record said the MCP cannot run CIC / the 60 s cap aborts it. Measured today:

- `execute_sql` **does not reject** it — no "cannot run inside a transaction block" error.
- The build **keeps running server-side past the 60 s client cap** — `pg_stat_activity` showed it
  `active` on `IO/DataFileRead` at **70 s**, long after the tool returned a timeout.
- It then **dies later**, leaving `indisready=true, indisvalid=false` — an index the planner never
  uses and every write to the table still maintains. **Pure write cost, invisible to every health
  check, and from the client it looks like nothing happened.**

So: keep using the pg_cron recipe, but for the right reason, and **always check `indisvalid` after
any CIC, including one you believe was killed.** The leftover here was dropped in
`audit_20260813_drop_invalid_pack_rips_block_height_index`.

**Honest-failure fallback:** a transactional `apply_migration` carrying a *plain* `CREATE INDEX`
fails **cleanly** — the 60 s cap rolls it back and leaves no debris. Tried here; it did exactly that.

### ⚠ A timed-out `apply_migration` can RECORD its version while its DDL rolls back

`20260813172005` sits in `supabase_migrations.schema_migrations` with its full body, and its index
did not exist. **`migration-parity` compares repo files against recorded versions — it would have
called that clean while prod's schema did not reflect the migration.** After any `apply_migration`
that timed out, verify the **object**, never the version row.

---

## Part 4 — not shipped, and why (each checked, not assumed)

1. **`compute-pinnacle-pack-ev` — the code fix is already in git and must NOT be deployed alone.**
   `bd53bb3` (today 08:20 PT) added `dedupeByConflictKey` to the `pack_distributions` upsert, which
   is exactly what today's daytime monitor filed as HIGH. Prod does not have it — the deployed
   function is **version 18, updated 2026-07-18** — so the pipeline is still failing 100% of ticks
   (`21000`, every tick back through 08-11 18:17Z). **Deploying from here would be strictly worse:**
   the ledger already records it at line 166 — jobid 42 is one of D2b's five un-rotated functions,
   the repo copy reads `PINNACLE_PACK_EV_GATE_KEY`, that secret is **not set**, and the gate fails
   closed. A deploy turns a deterministic SQL failure into a **403 every tick**. Operator step
   first: set `PINNACLE_PACK_EV_GATE_KEY` to the currently-deployed literal (or run the rotation
   window), **then** deploy. ⚠ The monitor's suggested action is therefore already done in code and
   blocked on a credential, not on engineering.
2. **`raise_impossible_parallel_circ()`** — 1.2 GB/call at 6.5% hit, second-worst reader. It is a
   **writer** on `editions.circulation_count` on the FMV-adjacent path. Not an autonomous ship.
   Lever: bound it to editions touched by recent sales instead of re-joining the whole Top Shot
   `editions ⨝ sales` set every run.
3. **`sales WHERE ingested_at >= $1`** — 2.2 GB/call, the worst per-call reader on the instance.
   `sales` is the hot partitioned shared table; the 08-02 ledger entry declined to touch its index
   set for the same reason. Identify the caller first (`LIMIT/OFFSET` ⇒ a route or admin sweep, not
   a function). ⚠ And apply Part 2's lesson before assuming an index helps.
4. **`fmv_recalc_edition_page` (58 GB) and `refresh_wmc_fmv_drift_active` (55.7 GB)** — the two
   largest readers overall, both FMV-path, both belonging to the `rwfd_state` thread already open in
   the 08-13 closeout. That closeout's warning stands: the self-tuning half **alone** runs slower.

## Health at 17:20Z

`detect_stalled_pipelines()` 4 rows, all known/carried (`candy-listings-indexer` info,
`allday-pack-opens-backfill` medium, `refresh-pack-grail-metrics-mv` info,
`topshot-moments-hydrator` info). `check_pgcron_recent_failures()` 3, all documented:
`rpc-refresh-mv-ts-set-play-catalog` **job startup timeout** (never ran — worker-slot exhaustion),
`rpc-refresh-misattrib-candidates` + `rpc-trust-health-precompute-refresh` the midday
saturation-window statement timeout that recovers next tick. No new trust breach, no new class.

⚠ **One parity item that is not mine:** `20260813150925
audit_20260813_reconcile_saved_wallet_stats_lower_soft_deadline` is applied in prod. Whoever applied
it should confirm a matching `supabase/migrations/` file exists, or `migration-parity` will report
it.
