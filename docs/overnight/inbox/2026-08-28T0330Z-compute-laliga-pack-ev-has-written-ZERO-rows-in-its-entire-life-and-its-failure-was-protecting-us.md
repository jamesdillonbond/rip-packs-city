# 🚨 `compute-laliga-pack-ev` has written **ZERO rows in its entire life** — three independent defects — and its failure has been **protecting the honesty canon by accident**

**Filed 2026-08-27 20:30 PT (2026-08-28 03:30Z) by Claude Code, cloud session (push-capable).**
Found by generalising tonight's candy diagnosis into a **repo-wide heartbeat correlation** (§1).
⛔ **Cron entry REMOVED. The route file is kept** — see §5 for why the fix is a redesign, not a repair.

---

## 1. The sweep that found it, and its positive control

The candy kill was one instance. The heartbeat correlation generalises to every heartbeated pipeline —
a heartbeat with no terminal row within ±5 s means the `after()` body was killed. Run across all of them
over `pipeline_runs`' ~73 h window:

| pipeline | heartbeats | killed | % |
|---|---:|---:|---:|
| **`compute-laliga-pack-ev`** | 3 | **3** | **100** |
| `pinnacle-sync` | 3 | 2 | 66.7 |
| `fmv-recalc` | 474 | 306 | **64.6** |
| `candy-listings-indexer` | 24 | 14 | 58.3 |
| `candy-editions-ingest` | 3 | 1 | 33.3 |
| `drain-fmv-cold-tail` | 141 | 12 | 8.5 |
| …11 more | | | 0.4–4.4 |

✅ **POSITIVE CONTROL: `fmv-recalc` reads 64.6 %, and CLAUDE.md independently documents that pipeline as
"64–73 % wall-kills".** The query reproduces a figure measured by someone else, by another method. It is
not inventing kills.

## 2. What the 100 % case actually is

⛔ **My first alarm — "Golazos pack EV is dead" — is WRONG and is recorded rather than quietly dropped.**
Golazos `pack_ev_history` is **fresh: 2.6 hours old, 5,664 rows**. A *different* worker keeps it current:
the pg_cron edge function `rpc-compute-golazos-pack-ev` (jobid 44, `37 */6`). **Name the caller before
you touch the function** — this route is not the writer of the thing it appears to write.

Its **unique** contribution is step 3 of its own header: sentinel `fmv_snapshots` rows for thin-coverage
editions. And:

> **`algo_version = 'pack-ev-v1-laliga'` has ZERO rows in `fmv_snapshots`. Ever.**

## 3. Three independent defects, and the lifetime record

`pipeline_runs_daily`, the indefinite rollup, covers **2026-08-02 → 08-23: 20 runs, 19 reported `ok`,
and `sum(rows_written) = 0`, `max(rows_written) = 0`.**

**It has never written a single row, while reporting success 19 times out of 20.**

| window | what actually happened |
|---|---|
| 08-03 → 08-20 | `rows_found: 0`, **49–280 ms** — the pool was empty, so it early-returned and logged `ok: true`. A no-op reporting success in a tenth of a second. |
| **08-23** | `rows_found:` **1000** — ⭐ the PostgREST cap, empirically confirmed against a **1,958-row** Golazos pool. Then `last_error: "pack_ev_history insert: Could not query the database for the…"` |
| 08-24 → 08-27 | killed at `maxDuration = 300` inside the per-dist RPC loop (`canceling statement due to statement timeout`), never reaching the insert |

The three defects, each proven rather than inferred:

1. **The pool read is unbounded.** `.from("pack_drop_pool").select(...).eq(...)` with no `.limit()`/`.range()`
   — PostgREST clamps at 1,000 against a pool of **1,958**. ⚠ **NOT covered by
   `invariants-postgrest-cap`**: that guard's allowlist entry for this file is about a *raw
   `fmv_snapshots` DESC* read, a different statement. This one is unguarded.
2. **`pack_ev_history` has no `algo_version` column**, and line 212 inserts one → PGRST204, which is the
   08-23 `last_error` verbatim.
3. **`confidence: "PACK_EV"` is not a member of the `fmv_confidence` enum** — proven with a control:
   `'PACK_EV' = any(enum_range(...))` → **false**, `'NO_DATA'` → **true**. Enum is
   `HIGH | MEDIUM | LOW | ASK_ONLY | SALES_ONLY | STALE | NO_DATA`.

⚠ **And the sentinel failure is invisible by construction.** Its insert error goes to `console.log` only,
then `logPipelineRun` is called with **hard-coded `ok: true, errorMsg: null`**. The only trace is
`sentinels_written: 0` in `extra` — a number nobody read.

## 4. ⭐⭐ The finding worth keeping: the breakage was protecting us

The obvious repair is to add `PACK_EV` to the enum and drop the bad column. **Do not.**

The sentinel writes **`fmv_usd: 0`** for every matching edition, and **507 pool editions have
`sales_count_30d = 0`**. Making it work would publish **$0 as a price for hundreds of Golazos editions**
into `fmv_snapshots`, which feeds `fmv_current`, portfolio totals and ~34 functions.

🚨 **Golazos already represents those editions honestly: `fmv_current` holds 73 `NO_DATA` and 315
`STALE`.** A working sentinel would **replace an honest "we don't know" with a fabricated "$0"** — the
repo's single worst defect class, aimed at a live pricing surface.

**So three bugs have, between them, prevented a fabricated-price write for the entire life of the
feature.** ⭐ The lesson generalises: *when a broken feature has never produced output, establish what it
WOULD have produced before repairing it.* Repair was the obvious move and it was the wrong one.

## 5. What I did, and what I did not

✅ **Removed the Vercel cron entry** (`30 5 * * *`). It burned a 300 s lambda daily, died, added per-dist
statement timeouts to an IO-bound instance, and emitted a misleading `ok`. **20 runs, 0 rows written —
nothing is lost.** Its EV half is already covered by the working edge function.

⛔ **Did NOT delete the route or its tests.** The pack-EV FMV fallback is a reasonable *idea* for a
collection at 0 % HIGH/MEDIUM confidence; it needs a **redesign**, not a repair. Whoever takes it should
decide what a thin-coverage edition should publish — plausibly nothing at all, since `NO_DATA` already
says it — and if a sentinel is wanted it must carry no `fmv_usd`, not a zero.

⛔ **Did NOT touch `fmv-recalc` (64.6 %) or `candy-listings-indexer` (58.3 %).** The first is documented
as wasteful-not-broken; the second was "fixed" on 08-26 and is still killed on 58 % of ticks, which is
its own investigation and is filed here rather than started.

## 6. Revert

Restore the entry in `vercel.json`:
`{ "path": "/api/cron/compute-laliga-pack-ev", "schedule": "30 5 * * *" }`. Nothing else changed.
