# ✅ SHIPPED 17:38Z — the trust-health freshness view is APPLIED. Its first query proves the pre-split monolith needed **928.6 s of a 600 s budget**.

Cowork **cloud** session, 2026-08-16 17:38Z / 10:38 PT.

> ⚠ **Scope line.** NO-PUSH is specific to **this cloud Cowork session**. Trevor's machine and Claude Code push normally via the PAT in `remote.origin.pushurl`. **Commit as usual.**

## What shipped

**`audit_20260816_trust_health_freshness_companion_view`** — prod version **`20260816173845`**.
Applied verbatim from the committed file `supabase/migrations/20260816153000_…` (pulled from a fresh clone, **not retyped**).

⚠ **The prod version differs from the filename BY DESIGN — do NOT rename the file.** `scripts/check-migration-parity.mjs` matches on **NAME**, not version; its own header says matching by version *"would flag that as missing forever."* I checked the checker before "fixing" the mismatch, and there was nothing to fix.

**Revert:** `DROP VIEW IF EXISTS public.v_rpc_trust_health_freshness;`

## The gate was measured, not asserted

This file set its own bar: *"APPLY IN A LOW-TRAFFIC WINDOW."* At **16:09Z I refused** a 3.9%/30 min reading because it sat **nine minutes after a 14.9% hour** — one point off the back of a spike is not evidence a spell has ended.

At 17:20Z the failure rate formed a clean **descending ladder across four nested windows**:

| window | 15 min | 30 min | 60 min | 180 min |
|---|---:|---:|---:|---:|
| fail % | **1.8** | 3.3 | 4.3 | 9.5 |

Against 13.8% at write time and an all-day hourly band of **0.9–18.6%**. **The ladder is the evidence a single reading could not be.** Nothing else was pending to batch — `audit_20260816_price_only_alerts` had already landed as prod version `20260816162403`.

## Verified after applying (separate step, not batched with the apply)

- **19 of 19 rows resolve; `refreshed_by_leg` NULL count = 0** — every metric maps to a real leg. A NULL would have been a finding (an orphaned precompute row nothing refreshes), not a display gap.
- **anon SELECT `false` · authenticated SELECT `false` · service_role SELECT `true`.**
- **`pg_class.reloptions = {security_invoker=on}`** — carried in the `WITH` and re-asserted by `ALTER VIEW`, as the file intended.

## 💡 The payoff, on the very first query — the retrospective case for the 8-leg split

Per-leg `duration_ms`, visible per metric **for the first time**, because each leg finally has a budget it can complete under:

| leg | ms | | leg | ms |
|---|---:|---|---|---:|
| `impossible_parallel` | **421,471** | | `serial_supply` | 164,763 |
| `pinnacle_fmv_share` | 128,777 | | `fmv_coverage` | 121,225 |
| `pack_ev` | 75,080 | | `panini` | 12,468 |
| `fmv_sanity` | 4,707 | | `board_liveness` | **120** |
| | | | **TOTAL** | **928,611** |

⚠ **928.6 s of work against the pre-split monolith's single 600 s statement budget.** The old one-`CALL` design was **arithmetically incapable of completing** — not merely unlucky under saturation. And `impossible_parallel` alone is **45% of the total**, which is why it was always the *casualty* rather than merely the last in line; the ledger's "stalest by POSITION, not because its query is slowest" read was half right — it is last **and** it is by far the most expensive.

⚠ **This total was unmeasurable before the split.** The monolith always died partway, so no run ever reported what a full pass actually costs. **The instrument had to be built before the number could exist.**

ⓘ Also visible: `board_liveness` completes in **120 ms** and was starving behind a 421 s leg.

## Repo half

Comments-only patch delivered to `C:\Users\TDill\rip-packs-city\freshness-view-applied-2026-08-16.patch` — replaces the file's now-false `COMMITTED **UNAPPLIED**` banner with the applied record, and adds the 928.6 s finding. **Executable SQL is byte-identical, proven by md5 over all non-comment lines**; every changed line is a comment. Verified to `git apply --check` cleanly against origin/main **`3927014`**.

Apply with `git am freshness-view-applied-2026-08-16.patch`, then push.

## Current state of the board

14 of 19 metrics read `is_stale = true` — **expected mid-convergence**, not a defect. The 15:08Z split's legs are still cycling for the first time; per the 16:15Z filing the arm clears ~18:48Z, re-breaches ~20:07–20:48Z as leg 326's pre-split 07:07Z write ages past 13 h, then holds green at ~5.7 h steady state.
