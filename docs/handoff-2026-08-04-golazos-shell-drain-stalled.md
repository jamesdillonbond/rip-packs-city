# Handoff — the Golazos shell drain has stopped, and `on_chain_count: 0` can't be trusted

> ## ✅ FULLY DRAINED 2026-08-04 — do NOT re-execute (banner corrected 2026-08-05)
> **All three steps are closed.** Steps 2–3 were never executed as written because the step-1 borrow fix *dissolved* them: once the scan stopped returning a false empty, the wallets re-enriched themselves on the next tick.
>
> **Re-verified live 2026-08-05 ~14:00Z:** Golazos shells (`edition_key IS NULL`) = **0 across 0 wallets** (was 3,822 / 51). The step-2 canonical wallet `0x4ba45c2312086820` now holds **1,832** wmc rows — the exact figure step 2 predicted would prove the scan healthy. ⚠ **The step-3 mass-delete must NOT be run**: the shells were real holdings, and they were enriched, not erased. Ledger: 2026-08-04 "Gate 1 item 3 CLOSED".
>
> Original step-1 note follows.
>
> **Step 1 is done — do not re-implement it.** A concurrent session landed the exact guard this doc asks for:
> - `922fd2c1` *"stop wallet scan masking a nil borrow as an empty wallet"* — `runAllDayDetailsBackfill` now treats a zero-moment scan on a wallet that still has cached wmc rows as a **failed** scan: logs `ok:false` with `terminated_reason: "empty_scan_but_cached_holdings"` and **skips the `last_refreshed` stamp** so the wallet stays stale and is retried. Opted in per-collection via `flagEmptyWithCachedHoldings` (Golazos only). A non-array resolve is separately surfaced as `non_array_scan_result` rather than coerced to `[]`.
> - `2c18f7ff` *"don't misroute a Golazos details failure into the AllDay paginated path"*.
>
> So `on_chain_count: 0` can no longer silently mean "the script failed" for Golazos — the doc's headline concern is closed at the code layer.
>
> ~~**Still open:** step 2 (force-rescan `0x4ba45c2312086820` and compare against its 1,480 wmc rows) and step 3 (enrich-vs-delete on that evidence).~~ **Superseded — both closed, see the banner above.**
>
> Measured 2026-08-04 ~15:40Z, for whoever picks this up: shells still **3,822 across 51 wallets**, newest `last_seen_at` still **2026-07-25 18:21:45Z** — unmoved, consistent with the doc. The guard shipped ~15:10Z and no `empty_scan_but_cached_holdings` run had been logged yet as of that measurement, so **the guard is deployed but not yet exercised** — the next Golazos wallet tick is what proves it fires.

**Date:** 2026-08-04 · **For:** Claude Code
**Roadmap:** Gate 1 item 3. Also gates the 9.07% Golazos sales undercount (`claude/golazos-shells-cause-sales-undercount-2026-08-04.md`).

---

## The 08-03 roadmap says this was fixed. It isn't.

> *"The root cause was a presence-only cached-id set combined with `skip_cached: true`, which meant an empty shell, once created, was skipped forever. Fixed; the tail is draining."*

The tail drained 99.9% → 44.7% → 40.2% and then **stopped dead**. It has been at **exactly 3,822 shells for 10+ hours** (3,905 → 3,822 between 00:45Z and 04:00Z, then nothing).

## What the shells actually are

| property | value |
|---|---|
| shells | **3,822** across 51 wallets |
| created | **all within 2026-07-25 18:13:30 – 18:21:45Z** — one 8-minute window |
| `last_seen_at` | same window; **0 seen in the last 24h** |
| `moment_id` present | 3,822 / 3,822 |
| have an enriched twin **anywhere** in wmc | **0** |

Distribution: 27 wallets are **mixed** (3,616 shells + 4,573 enriched), 24 are shells-only (206), 64 fully enriched (1,107). So **95% of shells sit in wallets that are being scanned successfully** — the scan reaches those wallets and enriches other rows in them.

⚠ **`skip_cached` is NOT the cause — I checked and it is behaving correctly.** The run reporting `on_chain_count: 9, skipped_cached: 9, rows_written: 0` was for wallet `0x623412c649a42fdf`, which has **0 shells and 9 correctly-enriched rows**. Skipping those is right. Don't re-fix that.

## The actual lead: a zero that may mean "error"

Across the last 72h, `wallet-backfill-golazos` ran 1,489 times. **Only ~23% of runs return any moments at all** (70 of 304 today, max 86; 136 of 543 on 08-03, max 168). And `rows_written` is **0 on three of the last four days** (834 on 08-03 only).

Every one of the six highest-shell wallets reports `on_chain_count: 0` on its most recent scan — including **`0x4ba45c2312086820`, which holds 1,480 enriched Golazos moments in wmc and was scanned at 13:00Z today**. A wallet with 1,480 moments returning zero on-chain is not credible as a genuine emptying.

Meanwhile the route throws **`Flow script HTTP 400: Invalid Flow argument: failed to execute the script on the execution node execution-00{1,2}.mainnet28.nodes.onflow.org:3569`** — three times in the last 8 hours alone.

**The question to answer first:** does the Golazos wallet scan distinguish *"this wallet holds nothing"* from *"the Cadence script failed"*? Right now both present identically as `on_chain_count: 0` with `terminated_reason: "no_more_moments"` and `ok: true`.

If a script failure degrades to an empty result rather than a throw, then:
- shells are never enriched (nothing comes back to enrich them with),
- the run logs `ok: true` so no monitor fires,
- and the 3,822 look permanently stuck for a reason that is actually transient.

That is the silent-failure class the repo already catalogues — a zero read as absence rather than as an error.

**I could not settle it from telemetry.** Distinguishing the two requires reading the scan's error handling in the route/worker, which is why this is a handoff rather than a fix.

## What I'd check, in order

1. **In `wallet-backfill-golazos`'s scan path, find where `on_chain_count` is set.** If a caught Flow error falls through to an empty array, that is the bug — make it throw (or log `ok:false` with a distinct reason) so a failed scan is never indistinguishable from an empty wallet.
2. **Re-scan `0x4ba45c2312086820` with `force: true`** (bypassing `skip_cached`) and compare `on_chain_count` to its 1,480 wmc rows. If it returns ~1,832 (1,480 + 352 shells), the scan is fine and the shells are genuinely stale — different remedy. If it returns 0 again, the script is failing.
3. **Only then decide the remedy.** If the shells are stale ownership records for moments no wallet holds, the honest fix is **deletion**, not enrichment — a wmc row asserting wallet A owns moment X when it doesn't is a wrong-inventory claim against Trevor's bar #4, and worse than a missing row.

⚠ Do not mass-delete before step 2. All 3,822 have no enriched twin, so if the scan is broken these are real holdings we'd be erasing.

## Why it matters beyond the shell count

45 of the 134 unresolved Golazos sales have their moment present in wmc **as a shell with NULL `edition_key`**, so `promote_unmapped_sales` has nothing to map them to. Golazos loses **9.07%** of its sales versus All Day's 0.26% — 35× the rate, on the thinnest book on the platform. Draining these closes both Gate 1 item 3 and a sales-history gap.

## Guardrails

- Direct to `main`, no branches. PowerShell `git`; `git rev-list --count origin/main..HEAD` = 0.
- Ledger before code, with the revert path.
- ⚠ A docs-only tip commit shows as **CANCELED** in Vercel — `ignoreCommand` working, not a failed deploy.

**Claude Code's direct file inspection wins over this doc on any disagreement.**

## Expected end state

`on_chain_count: 0` means only "this wallet holds nothing", never "the script failed" — and the 3,822 shells are either enriched or deleted on the evidence of step 2, with the Golazos sales-loss rate re-measured afterwards.
