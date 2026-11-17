# Both open attribution questions are CLOSED — and neither needed the instrumentation we thought

Cowork **cloud** session, 2026-08-13 ~12:30 PT (19:30Z). Read-only measurement. **No DB change.**

> ⚠ **NO-PUSH is specific to THIS cloud session** (git-proxy repo-set 403, upstream #76248).
> Trevor's machine and Claude Code push normally via the PAT in `remote.origin.pushurl` —
> **commit these files as usual.**

Two things were filed as blocked on missing instruments. Both turned out to be answerable from
data already on disk, using a different query shape. Recording the *method* as much as the answer.

---

## 1. ✅ CLOSED — jobid 22 is doing the AllDay resolutions. It is not waste.

**The open question** (08-13 closeout): the ~90/day `allday_pack_pull.edition_id` resolutions could
be coming from jobid 22 (`rpc-allday-resolve-pull-editions`) or from jobid 215's self-heal
(`rpc-allday-nem-from-sales-backfill`), which writes no `pipeline_runs` row. If 215 were doing the
work, 22 would be pure waste — so the ambiguity gated any decision about 22.

**No instrumentation was needed. Two independent checks agree.**

**(a) Cron minutes are a natural experiment.** `allday_pack_pull.updated_at` already exists, and the
two jobs run on disjoint minutes — jobid 22 at `9,39`, jobid 215 at `*/30` (:00, :30). Bucketing the
last 3 days of touched rows by minute-of-hour:

| minute | rows touched | of which **resolved** |
|---:|---:|---:|
| **:39** | 1,105 | **117** |
| **:09** | 1,057 | **102** |
| :27 | 3,974 | 0 |
| :58 | 2,153 | 0 |
| :07 | 1,945 | 0 |
| :37 | 1,747 | 0 |
| …11 other minutes | — | **0** |

**Every single resolution in three days landed on :09 or :39.** Zero at :00 or :30. The large
zero-resolution buckets are jobid 55's pack-opens writes (`6,16,26,…`, spilling into the next
minute) — rows touched, none resolved.

**(b) Mechanism check — the stronger one.** Jobid 215's two statements are
`backfill_nft_edition_map_from_sales()` and `promote_unmapped_sales()`. Neither function's `prosrc`
contains the string `allday_pack_pull` at all. **215 cannot resolve a pull row; it writes
`nft_edition_map`.** So the timing evidence isn't a coincidence to explain away — there was never a
mechanism for the alternative hypothesis.

**Disposition:** jobid 22 stays. ⚠ And the earlier proposal to drop its `ORDER BY block_height DESC`
stays dead — Trevor's `updated_at` finding already killed it, and this confirms 22 is the thing
actually doing the work, so a change there has real downside.

⚠ **Durable method note.** "Two jobs are indistinguishable because one writes no telemetry" was
false. **When two writers run on disjoint cron minutes, the target table's own `updated_at` is a
free discriminator** — no new instrument, no deploy. Check for one before filing an instrumentation
prerequisite. And check the *mechanism* (does the candidate even touch the table?) before checking
timing at all; it is cheaper and it is decisive.

---

## 2. ✅ CLOSED — 100% of the pg_net 403s are jobid 16. And retention was never the blocker.

**The recorded blocker:** *"attribution is still blocked by `net._http_response`'s ~1.6 h
retention."* **Both halves are wrong.**

**Retention is ~6 hours, not ~1.6.** Measured: 693 rows spanning `13:24Z → 19:23Z` = **05:59:00**,
ids 4222–4914. There was never a window problem.

**What actually blocked attribution was the query shape.** `net._http_response` has no URL column
(`id, status_code, content_type, headers, content, timed_out, error_msg, created`) and
`net.http_request_queue` drains to 0 rows, so the natural move is to join 403 timestamps to
`cron.job_run_details`. **That join cannot discriminate** — every candidate job's window overlaps
every 403. A ±90 s join attributed all 70 403s to jobid 16 *and* 63 to jobid 84 *and* 44 to jobid 25
(254 attributions for 70 events). Tightening to ±3 s still double-counted (106 for 70).

**The shape that works is set membership over cron minutes, not interval overlap:**

```sql
with j16 as (select date_trunc('minute', start_time) m from cron.job_run_details
             where jobid = 16 and start_time between <window>),
     f403 as (select date_trunc('minute', created) m from net._http_response
              where status_code = 403)
select (select count(*) from f403 where m in     (select m from j16)) as on_a_j16_minute,
       (select count(*) from f403 where m not in (select m from j16)) as not_on_a_j16_minute;
```

| measure | value |
|---|---:|
| jobid 16 runs in window | 72 |
| total 403s in window | **70** |
| 403s on a jobid-16 minute | **70** |
| 403s **not** on a jobid-16 minute | **0** |
| jobid-16 minutes with no 403 | 2 |

**Zero 403s belong to any other job.** The "different subset of gate-keyed jobs" framing is wrong —
it is one job, the same one the 08-12 and 08-13 filings already named. The rate corroborates it
independently: 70 403s / 6 h ≈ 11.7/h, and jobid 16 is the only candidate running 12×/h. Every other
candidate (jobid 84 at 30×/h, 25 and 29 at 20×/h) would have produced far more 403s than exist.

### Root cause, dated

`rpc-backfill-pack-pool` (jobid 16, `3,8,13,…,58 * * * *`) → `backfill-topshot-pack-supply`, which
returns exactly `{"error":"forbidden"}` on a failed `gateKeyOk` — matching the observed body,
`content_type: application/json`, `x-served-by: supabase-edge-runtime`.

⚠ **`backfill-topshot-pack-supply` is one of the three functions the gate-key memory records as
ALREADY ROTATED, with "cron 15+16 repointed" and "nothing half-broken". That is false.** Both cron
15 and cron 16 carry the **same** key (md5 `0f1af121cc4670a7a92568792d163493` — md5 only, the value
was never read) and the deployed function accepts neither it nor its `_OLD` fallback.

**Break dated from the data, not from a log:** `pack_drop_pool` rows with
`pool_source = 'gql_historical'` — the only rows this job writes — stop at
**2026-08-12 03:33:08Z**, ~40 h ago. That corroborates the 08-12 filing independently.

### ⚠ Blast radius is LOW, and the honest reason is unflattering to the job

`pack_drop_pool` looks perfectly healthy — newest write 18 seconds old. That is
`pool_source = 'gql'`, written by **`compute-topshot-pack-ev`**, a different job. Per source:

| `pool_source` | rows | newest | stale for |
|---|---:|---|---|
| `gql` | 26,322 | 19:25Z | **1 min** |
| `gql_historical` ← jobid 16 | 9,316 | 2026-08-12 03:33Z | **~40 h** |
| `atlas` | 25,594 | 2026-07-17 14:18Z | **27 days** |

And the job was nearly idle even when healthy: over **5 days**, `gql_historical` has exactly **one**
hour with any write at all (08-12 03:00Z, 63 rows, 1 dist). It processes `limit=3` dists per tick and
almost always finds nothing.

So: **~288 wasted edge invocations/day, and approximately one dist's worth of missed pool data.** Not
CRITICAL. ⚠ But note what that implies even after the key is fixed — 288 calls/day for ~1 unit of
work every 4 days is exactly the "worker-seconds spent on runs that wrote nothing" pattern.
**Fixing the key restores a job that should probably run hourly or daily, not every 5 minutes.**

### 🔍 The monitor gap this exposes — the most reusable part

**A whole-table freshness check on `pack_drop_pool` reads 1 minute old and is correct.** The dead
source is invisible because a *different* writer keeps a *different* `pool_source` fresh in the same
table. Any multi-writer table needs freshness **per writer/source**, not per table. `atlas` at
27 days is sitting in the same blind spot right now and nobody has said whether that is intended.

This is the [[absence-of-a-metric-read-as-zero]] family inverted: not a missing metric read as zero,
but **a present metric averaging a dead component away.**

---

## Operator actions (both one-step, neither needs me to see a secret)

1. **Unbreak jobid 15 + 16.** Either set `TOPSHOT_PACK_SUPPLY_GATE_KEY_OLD` to the key currently in
   the cron command (zero-downtime, no cron edit, no redeploy — the deployed function already
   accepts `_OLD`), **or** repoint cron 15+16 to the current secret. To check which of your stored
   keys the cron is using without printing it:
   `select md5(substring(command from 'key=([^&'']+)')) from cron.job where jobid=16;`
   → must equal `0f1af121cc4670a7a92568792d163493`.
2. **Decide `atlas`.** 27 days stale, 25,594 rows, no writer observed. Either it is a frozen
   historical snapshot by design — in which case say so somewhere durable — or it is a second silent
   outage nobody has attributed.

## Still with you from earlier

- `PINNACLE_PACK_EV_GATE_KEY` + deploy (`--no-verify-jwt` mandatory).
- 30 undrained inbox files, Aug 9–13, deliberately not archived.
