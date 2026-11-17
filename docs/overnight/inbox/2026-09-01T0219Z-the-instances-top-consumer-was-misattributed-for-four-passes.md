> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 2026-09-01T0219Z — the instance's top pg_stat_statements line item was misattributed for four passes, and the read nobody could explain is an ordering-index walk

**Pass:** cloud-only, `trig_018AyNcnbCZuYb1Ztts6rbBR`, fired 2026-09-01 02:18:44Z = 2026-08-31 19:18 PT.
**Repo read:** `origin/main` 7c63fa3, clone 02:19Z. **No push** (cloud proxy; scope line in the handoff).

## 1. The finding

`public.query_sql` is a **shared** raw-SQL escape hatch. The Cowork MCP calls it, and so does
`app/api/fmv-recalc/route.ts` — three times per run. Because both land on the same
`pg_stat_statements` queryid (`-2504733205258152844`), four consecutive passes ranked it #1 on the
saturation board and then wrote it off as *"the pass's own measurement channel"*.

**It is not.** Splitting the queryid by payload — using `auto_explain`, which is **already loaded on this
instance at `log_min_duration = 10000`** and therefore already logging every >10 s execution with its full
parameters — gives, over 24 h to 02:45Z (lower bounds, since only >10 s runs are logged):

| step | site | runs | total | max |
|---|---|---:|---:|---:|
| 5c `edition_offers` ASK fallback | `route.ts` ~1380 | 119 | 1,843 s | 28.6 s |
| 5d All Day floor-ask fallback | ~1573 | 5 | 95 s | 25.1 s |
| 5e TS per-parallel ask floor | ~1477 | 3 | 43 s | 15.9 s |

~33 minutes of DB time a day, **returning zero rows** — a caught-up safety net paying a full scan to prove
a negative.

## 2. What shipped

Migration **`20260901023633`**: `fmv_snapshots_2026_edition_id_computed_at_conf_idx`, the existing
`(edition_id, computed_at DESC)` key with `confidence` added as an INCLUDE payload. 65 MB, built
CONCURRENTLY by one-off postgres pg_cron jobid 426 at 02:34:00Z, unscheduled 02:35Z.

Step-5c payload, same session, same warm state, five minutes apart:
**1,345,197 buffers / 2,022 ms → 94,137 buffers / 1,441 ms**. `Index Scan` → `Index Only Scan`
(Heap Fetches 73,658). **14.3× on total buffers touched** — a plan change, so not a cache effect.

**Exit:** < 150,000 buffers on the same EXPLAIN next pass. **Falsifier:** `idx_scan` still 0 on the new
index ⇒ drop it. **Revert:** `DROP INDEX CONCURRENTLY`.

⛔ **Mitigation, not the fix.** `public.edition_fmv_current` is a 13 MB table already holding
latest-FMV-per-edition **with `confidence`**, refreshed by watermark, last refreshed 01:59Z. All three
`latest` CTEs should read it. Route code → queued.

## 3. The second correction

The 01:00Z filing concluded that `queryid 1387451210050502049` (the PostgREST `fmv_snapshots` read) came
from an **unchunked ~4,000-id caller with no emitter on `origin/main`**. Falsified on the request URL:
`edge_logs` shows exactly **three fixed arrays** — 7,914 / 7,914 / 4,716 chars, each fired 264–265×/24h.
The ids are UUIDs, so `39n − 3` gives **200 / 200 / 118 = 518 = the UFC Strike edition count exactly**. The
caller is `supabase/functions/enrich-ufc-wallet/index.ts:171-189`, chunked at 200, exactly as the repo says.

The 29× cost gap it was explaining away is real but has a different cause. Same SQL over **all 518**
editions: **6,430 buffers / 11.9 ms**. Forced seq scan of the whole 223 MB partition: **28,621**. So no plan
over this table reaches the observed **185,457 buffers/call** in one pass — and pgss calls (64) are *fewer*
than logged requests (84), so there is no hidden caller. `auto_explain` at **01:30:05Z on a 29.46 s
execution** whose parameters carry the 118-id array names the plan:
**`Scan using idx_fmv_snapshots_2026_computed_at_desc`** — the ordering index walked in `computed_at` order
with `edition_id` as a Filter, accumulating toward `LIMIT $2`, on a slice that holds only ~1,100 rows and
therefore never reaches 1,000. It is hitting the 30 s `service_role` cap.

⚠ **I could not reproduce that plan choice, only observe it.** My custom plan *and*
`EXPLAIN (GENERIC_PLAN)` on the byte-identical statement both pick the cheap `edition_id` index.
⭐ **So `EXPLAIN (GENERIC_PLAN)` is not evidence about what a live PostgREST prepared statement runs** —
which means the 00:30Z conclusion "not an item-13 `plan_cache_mode` case" is **unproven**, not established.

## 4. Recommended action

1. **Claude Code:** repoint the three `latest` CTEs in `app/api/fmv-recalc/route.ts` at
   `public.edition_fmv_current`.
2. **Claude Code:** give `enrich-ufc-wallet` a latest-per-edition RPC. ⛔ Not a one-liner —
   `get_fmv_for_editions` returns `(edition_id, fmv_usd)` only and the function needs `confidence` +
   `sales_count_30d`. Prefer a new `get_fmv_snapshot_for_editions(uuid[])` with a CROSS JOIN LATERAL body
   (same shape as `20260831151141`); its DB half is shippable from a cloud pass. **Do not** just reorder
   the PostgREST query — that turns the 1,000-row cap from harmless into a truncation at ~edition 100 of
   200.
3. **Trevor:** delete `trig_01AZzLzkTPp5xbSjK1EFmeCw` (still enabled, still firing 40 min offset), and
   check whether `trig_018AyNcnbCZuYb1Ztts6rbBR` can be given a real device binding — `list_triggers`
   reports `bound_device: null` for **both**, so the v2 task's "device-bound" label is false.
4. **Desktop:** `node scripts/recover-fileless-migrations.mjs --window 3` — **8** migrations are now applied
   to prod with no committed file and `check-migration-parity` is exiting 1.
