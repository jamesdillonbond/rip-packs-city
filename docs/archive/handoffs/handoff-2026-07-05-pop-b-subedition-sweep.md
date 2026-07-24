# Population B subedition sweep — base-resident parallel probe

**Date:** 2026-07-05 · **Status: IMPLEMENTED & DEPLOYED** (commit `128e2a7`; DB migrations live; ledger `dd740c0`).

This started as a Claude Code handoff and was then implemented directly. The shipped design refined the original draft in two ways, both forced by the live schema/rules:

1. **Cursor:** the draft proposed an integer `last_wmc_id` PK cursor. `wallet_moments_cache.id` is a **uuid** (its PK), which can't seed a `bigint` `event_cursor`, and the live candidate scan is ~88s/tick (full 1.5M-row wmc scan + anti-join). Shipped instead a **materialized queue table** (`topshot_base_parallel_probe_queue`, dense `bigint seq` PK) seeded once from that scan, drained by an indexed `seq` cursor (~80ms/tick).
2. **Trigger:** the draft proposed a cron-job.org entry. A new authed cron-job.org job needs its `Authorization: Bearer` header on the **Advanced tab** (Trevor's hard rule forbids opening it; CLAUDE.md: "secret-bearing config edits are operator-only") and `?token=` is banned (leaks into cron history). Shipped instead a **Vercel cron** hitting an internal route that injects the INGEST bearer server-side — the established autonomous, secret-safe equivalent (the `drain-topshot-misattribution` precedent).

The authoritative record of what shipped is [docs/overnight/ledger.md](overnight/ledger.md) (2026-07-05 Population B entry). This doc is the design/context.

---

## 1. Context — what Cowork already shipped (reference only)

Base-resident TopShot held moments (`wallet_moments_cache` rows on a `setID:playID` base) that should be on `::N` parallels — the "Jrue class": plays that were never a subedition-resolution target, so their moments never entered `topshot_moment_subeditions` and never got re-keyed.

Already live (DB-only):
- **`topshot_moment_subeditions`** — canonical map `nft_id → (base_external_id, subedition_id)`. PK `nft_id`; `base_external_id` is **NOT NULL**; `subedition_id smallint`.
- **`remap_topshot_realign_miskeyed_subeditions()`** / **`remap_topshot_split_resolved_subeditions()`** / **`catalog_topshot_subedition_editions_from_resolved()`** / **`seed_topshot_recent_base_subedition_targets()`** — steps 3/4/4b/1c of the daily `drain-conflated-subeditions` orchestrator.
- **Population A** — moments already in the map but not re-keyed — fixed via `audit_20260705_pop_a_subedition_remap` (commit `408f81f`).

Population B needs an on-chain `getMomentsSubedition` call per moment → an edge function.

---

## 2. DB objects (shipped)

Migrations (each applied via `apply_migration`):

- **`audit_20260705_ts_base_parallel_probe_queue_table`** — `public.topshot_base_parallel_probe_queue (seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, nft_id text NOT NULL UNIQUE, base_external_id text NOT NULL)`; RLS enabled; anon/authenticated revoked; service_role granted.
- **`audit_20260705_ts_base_parallel_probe_queue_seed`** — one-time seed (`SET LOCAL statement_timeout='600s'`): base-resident TS wmc rows whose base edition has a `::N` sibling, not in `topshot_moment_subeditions`, deduped by `moment_id`. Result: **134,071** rows (matches the audit's ~134k), dense `seq` 1–134071.
- **`audit_20260705_ts_base_parallel_probe_targets_from_queue`** — `get_topshot_base_parallel_probe_targets(p_after bigint, p_limit int) RETURNS jsonb` (SECDEF, service_role only). Returns `{seq,nft_id,base_external_id}` for `seq > p_after ORDER BY seq LIMIT p_limit`. **JSONB (scalar)** so a 20k batch is not clamped by PostgREST's 1000-row SETOF cap. ~80ms/batch (PK index scan).
- **`audit_20260705_suppress_ts_base_parallel_probe_cursor_stalled`** — permanent `pipeline_alert_suppression` row keyed on `event_cursor.id = backfill-topshot-base-parallel-probe` (the value `get_pipeline_alerts()` cursor_stalled matches). Terminal-backfill twin of `allday_pack_opens_backfill`.

**Revert:** `DROP TABLE public.topshot_base_parallel_probe_queue;` · `DROP FUNCTION public.get_topshot_base_parallel_probe_targets(bigint,int);` · `DELETE FROM public.event_cursor WHERE id='backfill-topshot-base-parallel-probe';` · `DELETE FROM public.pipeline_alert_suppression WHERE pipeline='backfill-topshot-base-parallel-probe';`

---

## 3. Edge function (shipped) — `supabase/functions/backfill-topshot-base-parallel-probe/index.ts`

Deployed to `bxcqstmqfzmuolpuynti` (ACTIVE v1, `verify_jwt=false`; INGEST bearer / `?token=`). Adapted from `backfill-topshot-subeditions` (same `runScript`/`decodeDict` Flow-REST pattern). Per tick:

1. Read cursor `event_cursor(id='backfill-topshot-base-parallel-probe').last_processed_block` (default 0).
2. `get_topshot_base_parallel_probe_targets(cursor, 20000)` → next queue batch by `seq`.
3. Resolve `TopShot.getMomentsSubedition(nftID)` on Flow mainnet in **chunks of 500** (concurrency 8, retry, 130s soft budget). One Cadence script loops an array → `{nftID: subeditionID}`.
4. Insert confirmed parallels (`subedition_id>0`) into `topshot_moment_subeditions` `ON CONFLICT (nft_id) DO NOTHING` (`base_external_id` from the queue satisfies NOT NULL). Standard (0) never written.
5. Advance cursor to the **max seq of the contiguous successfully-resolved chunk prefix** (a chunk error never skips a candidate — re-pulled next tick). Never advance on an upsert write failure.
6. `log_pipeline_run` (`pipeline=topshot-base-parallel-probe`, `extra={inserted,done,cursor,…}`).
7. `done=true` when the queue is exhausted (fewer than requested returned); the done branch stops writing the cursor.

Cadence script:
```cadence
import TopShot from 0x0b2a3299cc857e29
access(all) fun main(ids: [UInt64]): {UInt64: UInt32} {
  let out: {UInt64: UInt32} = {}
  for id in ids {
    let sub = TopShot.getMomentsSubedition(nftID: id)
    if sub != nil { out[id] = sub! }
  }
  return out
}
```

**Revert:** `git revert 128e2a7` (source) + delete the deployed function.

---

## 4. Downstream (no new re-key logic)

Once the probe populates `topshot_moment_subeditions`, the existing daily `drain-conflated-subeditions` orchestrator catalogs the `::N` editions (step 3) and splits/realigns the moments off base (steps 4/4b) on its next run. The conflation guard trends down. **No FMV/pricing logic touched** — affected editions self-heal on the canonical fmv-recalc sweep.

---

## 5. Trigger (shipped) — Vercel cron

`app/api/cron/drain-base-parallel-probe/route.ts` fires the edge fn with the server-side INGEST bearer (auth: `CRON_SECRET | INGEST_SECRET_TOKEN | RPC_ADMIN_TOKEN`), `maxDuration=60`. `vercel.json` cron `3,18,33,48 * * * *` (15-min, staggered off the banned `:00/:01/:20/:21/:40/:41` pool-contention minutes and the `:09/:29/:49` flowty-drain slot). Drains ~134k in <2h; then each tick is a fast `done=true` no-op.

**Why not cron-job.org:** a new authed cron-job.org job needs its Bearer header set on the Advanced tab (hard-rule forbidden; secret-bearing = operator-only) and can't use `?token=` (leaks) — and the session has no INGEST token value to set anyway. The Vercel cron injects the secret server-side, needing no dashboard secret. **If cron-job.org is preferred instead:** an operator adds a job (`POST https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/backfill-topshot-base-parallel-probe`, `Authorization: Bearer <INGEST_SECRET_TOKEN>` on Advanced, every 15 min) and the Vercel cron is removed to avoid double-draining.

**Revert:** remove the cron object from `vercel.json` + `git revert 128e2a7` + redeploy.

---

## 6. Verification

```sql
SELECT started_at, ok, extra->>'inserted', extra->>'cursor', extra->>'done'
FROM pipeline_runs WHERE pipeline='topshot-base-parallel-probe'
ORDER BY started_at DESC LIMIT 10;
```
Cursor climbs 0→134071 over ~7 ticks; `topshot_moment_subeditions` count grows; then `done=true`. On the next `drain-conflated-subeditions` run its `extra.cataloged/split/realign` move and the conflation guard trends down. The queue table is safe to `DROP` once `done`. Security at ship: invariants 0, secdef-anon `[]`, 0 tables without RLS.

---

## 7. Guardrails honored

Direct-to-`main`, no branches/PRs; PowerShell git; explicit-path `git add` (never `-A`); no FMV/pricing touched; CRLF-safe full-file writes; hard rule respected (Advanced tab never opened).
