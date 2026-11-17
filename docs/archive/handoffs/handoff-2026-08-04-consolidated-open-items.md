# Handoff — everything still open after the 08-03/08-04 accuracy thread

**Date:** 2026-08-04 ~16:30Z · **For:** Claude Code
**State:** sweep healthy (`fmv_sweep_stall_pct_24h` 15.8 and decaying toward its ~4% floor, 24 distinct offsets/24h, 9,023 TS editions recalced in 12h). Security invariants clean, secdef drift `[]`, self-contradictory sales-count rows **0**.

---

## 0. A correction to my own earlier advice — Gate 2 item 6 is NOT dissolved

I previously reported the sweep fix had moved All Day FMV confidence **6.3% → 31.9%** and Top Shot **17.3% → 43.7%**, and advised *"do not start Gate 2 item 6 as written."* **That reading was taken mid-sweep and overstated the result.**

Re-measured now that the sweep has settled:

| collection | roadmap 08-03 | my 04:00Z (mid-sweep) | **now (settled)** |
|---|---|---|---|
| Candy MLB | 60.8% | 59.2% | **58.4%** |
| **NBA Top Shot** | 17.3% | 43.7% | **36.5%** |
| **NFL All Day** | 6.3% | 31.9% | **24.7%** |
| LaLiga Golazos | 0.7% | 0.6% | **0.4%** |
| UFC Strike | 3.2% | 10.1% | **0.0%** ← closure guard, correct |

The 04:00Z figures were high because the sweep had covered the actively-traded head first; the numbers fell as it worked into the less-liquid tail. **Same partial-coverage trap I had warned about, committed in my own measurement.**

**The part that actually matters for Gate 2 item 6 — the *gap* — barely moved:**

- Roadmap: All Day 6.3% vs Top Shot 17.3% → **11.0 points behind**
- Now: All Day 24.7% vs Top Shot 36.5% → **11.8 points behind**

Both rose ~4×, and All Day is still ~12 points behind Top Shot. **Gate 2 item 6 is re-based, not resolved.** Its premise ("a collection with 17,240 sales in 30 days has no excuse") still stands — the absolute floor moved, the relative deficit did not. Start it, but scope it against 24.7 → 36.5, not 6.3 → 17.3.

Supporting detail for where the deficit lives — All Day's ask-only share is **26.9%** vs Top Shot's 19.6%, and **14.3%** of its priced editions have no sale inside 30 days vs Top Shot's **4.1%**.

---

## 1. Blocking / time-sensitive

**1a. Trust-health precompute — fix shipped, confirmation pending 18:58Z.**
The 12:58Z run died at its 600s budget inside `public_board_liveness_probe` on `SELECT count(*) FROM v_insights_top_sales`, freezing all 12 precomputed metrics at 06:58Z. Board has been blind ~9.5h and still reads "ok".

Shipped: `CREATE INDEX CONCURRENTLY idx_sales_2026_top_sales_board ON sales_2026 (sold_at DESC) WHERE price_usd >= 100 AND edition_id IS NOT NULL` (288 kB). Plan BitmapAnd → Index Scan, **disk reads 8,295 → 460 (−94.5%)**, 902 rows both sides. Ledger entry in `claude/trust-precompute-outage-2026-08-04.md`.

**Check `cron.job_run_details` after 18:58Z.** If it succeeds, done. If it fails again, the structural fix is a **per-view timeout inside `public_board_liveness_probe`** — because:

> **An `EXCEPTION WHEN OTHERS` handler cannot isolate a `statement_timeout`.** Leg 8 *is* written to isolate (`v_empty := 999; v_slow := 999`) and it did not save the run: the timeout governs the whole outer statement, so the recovery INSERT has no budget and re-cancels. Exception-based isolation only works for failures that leave budget behind.

Leg 8 probes 47 views and took 78.7s of the last good 214s run. I measured the other high-budget boards: `topshot_pack_reality_top_ev` 4.6ms (now an MV — its 25s budget is legacy), and the rest 3.9–4.4s warm. ⚠ They measure ~50s *combined cold* — don't read that as a second risk, it's first-touch cache cost.

**1b. Golazos shell drain — stalled, and the recorded root cause is wrong.**
3,822 shells / 51 wallets, unmoved for 12h+. See `docs/handoff-2026-08-04-golazos-shell-drain-stalled.md`. Two things to carry:

- **`skip_cached` is NOT the cause** — the 08-03 roadmap says it is. The run showing `skipped_cached: 9, rows_written: 0` was a wallet with **0 shells and 9 correctly-enriched rows**. Don't re-fix it.
- **Step 1 of that handoff is stale** (the guard shipped). **Step 2 is now the first action:** force-rescan `0x4ba45c2312086820` — it holds 1,480 enriched Golazos moments yet reports `on_chain_count: 0`. If it returns ~1,832, the scan is fine and the shells are stale ownership → delete. If it returns 0, the Cadence script is failing and `on_chain_count: 0` is indistinguishable from a genuine empty wallet. ⚠ **Do not mass-delete first** — all 3,822 lack an enriched twin, so if the scan is broken these are real holdings.

Gates the 9.07% Golazos sales undercount (45 of 134 unresolved sales have their moment in wmc as a shell).

**1c. Tail resolver — UNION split now warranted by your own criterion.**
You said *"take the UNION split only if the rate doesn't fall."* It hasn't. Post-index: 2 fails of 4, all `load_open: canceling statement due to statement timeout` — the same error and the same query stage as pre-index (2 of 6). Throughput did improve (134 rows in one run vs 50 across six), so the index earned its place; the OR-form residual is unresolved.

---

## 2. Ready to ship, no decision needed

**2a. Pins #120–121 — prerequisite now met.**
Neither `fmv_snapshots_block_stale_ingest_algo` nor `tg_fmv_snapshots_set_collection` had a committed migration (I grepped the 61KB `fmv_snapshots_rename_wap_to_asp` — only `block_phantoms` is in it). Snapshot migration written and committed to `supabase/migrations/20260804210000_audit_20260804_snapshot_fmv_snapshots_remaining_write_guards.sql` — live bodies verbatim, no-op vs prod.

Emphasis for each test, both fail in the "silent" direction:
- `block_stale_ingest_algo` **RETURNS NULL** (drops the row) for `algo_version LIKE '1.1.0%'`. A widened predicate silently discards live FMV writes platform-wide — no error, no row. Pass-through cases carry the weight. Note: deliberately **not** SECURITY DEFINER.
- `tg_fmv_snapshots_set_collection` RAISEs on NULL/unknown `collection_id`. Softening either RAISE into a default lets unattributed snapshots accumulate; every per-collection metric keys off that column.

⚠ Register both in the drift guard's `PINS` array — an unregistered `supabase/tests/*.sql` is invisible to it and asserts nothing.

**2b. `fmv_snapshots_cap_closed_market_confidence` pin** — `supabase/tests/fmv_snapshots_cap_closed_market_confidence.sql` was delivered earlier this thread (12 rows; caps all five confident labels, and pins the negatives: `NO_DATA` survives, open markets untouched, unmatched/NULL `collection_id` fails **open**). Confirm it's registered.

---

## 3. Needs your product/calibration call

**3a. `topshot_fmv_pct_stale_30d` — retire or re-scope, don't re-baseline.**
It reads 32.2% and **essentially 100% of that is inert UUID-keyed dupe rows** — canonical stale is **0**, worst canonical age 7.0 days. Its 07-25 baseline of 32.3% was captured while the sweep was stuck, so `breach_at = 50` sits 18 points above a broken steady state and can only fire if the *dupe* count grows — which `ts_uuid_dupes_created_24h` already watches. Adding the canonical predicate makes it read 0.0% against a 50 threshold: decorative in a new way. With `fmv_sweep_stall_pct_24h` now catching a stall inside 24h, the honest question is whether a 30-day-lagging backstop earns its slot at all.

**3b. `unmapped_resolution_backlog_max` — the recorded fix is wrong.**
Its `catches` text prescribes *"make the resolver record a permanent-failure reason and exclude by REASON."* Don't. `v1_dapper` is **not** permanently unresolvable — it resolved 7,163 rows in 7 days and last resolved minutes before I measured. Excluding it would blind the arm to real All Day stalls forever. The 105 are **retry-queue depth**: the resolver cycles the whole priced backlog in 7–8 days (attempt recency <6h 309 · 1–3d 6,575 · 3–7d 21,150 · oldest 7.5d, nothing starved). Real fix needs an attempt counter — `unmapped_sales` has only `last_onchain_attempt_at`, a single overwritten timestamp, so "attempted 3× and still failing" is inexpressible. Add `onchain_attempts int NOT NULL DEFAULT 0`, increment it in the resolver, arm counts `>= 3`. Not shipped: the column is inert until the resolver writes it, and the predicate change clears a standing breach.

**3c. Gate 1 item 5 — pack EV needs three states, not two.**
`primary_available`/`secondary_available` are **NULL, not false, on 3,883 of 4,596 rows (84.5%)**. Labelling those "retired" asserts something never measured. Buyable is **713** (all Top Shot secondary; exactly **1** row platform-wide is `primary_available`). The roadmap's "108 of 4,596 actionable" is a misread — 108 is *positive-EV-but-unbuyable*, the acute case. Full detail in `claude/gate1-item5-pack-ev-actionability-2026-08-04.md`, including why the All Day product→distribution bridge isn't worth building for 33 packs.

**3d. The 237-edition ASK disclosure.** ~$81,430 across circ-1..49 grails with 1–4 sales in 90 days. **Do not widen the clamp's `n_real >= 5` gate** — clamping a circ-5 LeBron would fabricate a *low* price. Disclosure ("Asking $3,999 · last sold $650 on May 15 · 1 sale in 90 days"), not arithmetic.

**3e. Panini `is_listed` — pre-flip, not post.**
`true` on all 58,587 rows, no false, no NULL, while 38,216 have a NULL ask. `panini_deal_board` is safe (no-op term next to `price_usd > 0`); `panini_special_serials_board` **selects it as an output column**, so it would publish "listed = true" for every row. Latent — all Panini boards are `service_role` only — and becomes a live false claim the moment `PANINI_PUBLIC` is wired. Also: replace `pct_trustworthy` in any launch gate with the four-way `coverage_flag` distribution; **62% of Panini editions come from biased/partial sets** and a single number hides that.

---

## 4. Roadmap state after this thread

| Gate 1 | status |
|---|---|
| 0 · unstick FMV sweep | ✅ done, verified |
| 1 · dust-floor verification | ✅ closed in direction **and** magnitude |
| 2 · Candy wallet FMV | ✅ 0 NULL |
| 3 · Golazos shells | ⛔ **stalled** — §1b |
| 4 · dead-market labels | ✅ substantially closed; rendered-DOM verified on both surfaces |
| 5 · pack EV actionability | needs §3c |

**Gate 2** is re-based per §0 — item 6 is live, not dissolved.

---

## Guardrails

- Direct to `main`, no branches. PowerShell `git`; `git rev-list --count origin/main..HEAD` = 0.
- Ledger before code, with revert paths.
- ⚠ A docs-only tip commit shows as **CANCELED** in Vercel — `ignoreCommand` working, not a failed deploy.
- ⚠ `CREATE INDEX CONCURRENTLY` must be a standalone statement, never inside `apply_migration`.
- ⚠ A manual `SELECT rpc_trust_health_precompute_refresh()` rolls back on the 60s MCP client timeout — verified. Wait for the cron tick.

**Claude Code's direct file inspection wins over this doc on any disagreement.**
