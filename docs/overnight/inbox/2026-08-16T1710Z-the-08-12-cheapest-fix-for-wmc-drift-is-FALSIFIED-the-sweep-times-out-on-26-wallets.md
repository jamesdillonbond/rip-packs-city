# ⛔ The 08-12 "cheapest first" fix for wmc FMV drift is FALSIFIED — the catch-all sweep already times out on **26 wallets**

Cowork **cloud** session, 2026-08-16 17:10Z / 10:10 PT. Sample window: **trailing 24 h ending 2026-08-16 ~17:10Z**. Read-only. **Nothing shipped.**

> ⚠ **Scope line.** NO-PUSH is specific to **this cloud Cowork session**. Trevor's machine and Claude Code push normally via the PAT in `remote.origin.pushurl`. **Commit these files as usual.**

## 0. First, a correction to my own 16:40Z filing

I wrote: *"`refresh_wmc_fmv_drift_active` — 84 runs, 20 ok, 1 row written in 8 h (~76% failing)."*

**That framing was wrong in the exact way I warned about this morning: a failure rate quoted without knowing what a SUCCESS produces.** A successful run of this sweep also usually writes **zero**. Over 24 h, **119 of its 137 successful runs found nothing at all.** So "1 row written" is not a shortfall against thousands — near-zero is this sweep's normal output. The real finding is a different and worse one.

## 1. The measurement — 24 h, both sweeps side by side

| | `refresh_wmc_fmv_drift_active` (the catch-all) | `refresh_wmc_fmv_changed` (30-min window) |
|---|---|---|
| runs | 270 | 271 |
| **failed** | **133 (49.3%)** | 96 (35.4%) |
| ok | 137 | 175 |
| **rows written, 24 h** | **36** | **106,638** |
| ok runs that found anything | **18 of 137** | — |
| failure duration | **min 30,165 ms · avg 30,322 ms** — pinned | 8,303–30,418 ms — variable |
| ok duration | 15,248–30,153 ms | 176–51,706 ms |

**The 30-minute-window sweep does ~3,000× the repair volume of the deviation catch-all.**

## 2. ⚠ The failures are a hard 30 s PIN, not saturation scatter

133 failures, minimum **30,165 ms**, average **30,322 ms**, all `canceling statement due to statement timeout`. That is a fixed ceiling being hit, not a variable-load tail — compare `refresh_wmc_fmv_changed`, whose failures scatter from 8.3 s to 30.4 s.

**Neither function sets its own budget.** `pg_proc.proconfig` for both is `search_path=public, pg_temp` and nothing else — so the 30 s belongs to the **caller**, exactly as the standing rule says, and a function-level `SET statement_timeout` would have been inert anyway.

ⓘ **Stated as measured, not explained:** `refresh_wmc_fmv_changed` has successful runs at **51,706 ms**, well past 30 s. So 30 s is **not** a global route ceiling — the pin is specific to the `drift_active` call path. Worth one look before anyone designs around it.

## 3. ⛔ This falsifies the 08-12 recommendation #1

`claude/finding-wmc-fmv-drift-mechanism-2026-08-12.md` proposed, as the **cheapest-first** fix:

> *"Widen `refresh_wmc_fmv_drift_active` beyond `allow_list`. It is already chunked, budget-bounded and deviation-driven; the scope predicate is the only thing keeping it off 89% of wallets. This is a one-predicate change to an existing, proven sweep — not new machinery."*

**"Proven sweep" does not survive contact with the numbers.** Confirmed live: `allow_list` holds **26 rows, all status `active`, all with a wallet** — the 08-12 figure exactly. So this sweep **times out on half its ticks against a scope of 26 wallets.**

wmc holds ~241 distinct wallets (**documented, not measured** — my `count(distinct wallet_address)` timed out at 60 s, the same way it did on 08-12). Widening the predicate is therefore a **~9× scope increase against an unchanged, already-binding 30 s budget.**

⛔ **And the failure would be invisible.** This is the catch-all; a permanently-timing-out version writes 0 rows and logs `ok=false`, which is **byte-identical in `pipeline_runs` to what it does today.** Nothing on any board distinguishes "widened and now never completes" from "narrow and finds nothing." **The one-predicate change would ship a guaranteed-timeout job that looks exactly like the status quo.**

⚠ **The scope predicate is not what keeps this sweep off 89% of wallets. The budget is, and it binds already.**

## 4. The order flips

1. **Make `refresh_wmc_fmv_drift_active` resumable across ticks first** — a persisted cursor so each tick does a bounded slice and the next resumes, the pattern `fmv-recalc` already uses (`pipeline_runs.cursor_after`). A sweep that cannot finish its scope in one statement must not be given a bigger scope.
2. **Only then widen beyond `allow_list`.**
3. **Whatever ships, it needs an instrument that can tell "completed the scope" from "was cut off"** — `rows_written` cannot, because 0 is this sweep's normal healthy output. Record scope size and slice position, not just row counts.
4. The 08-12 recommendation #3 — **a per-collection drift arm on the trust board** — is untouched by this and gains priority: it is currently the only proposal that would make the drift itself visible rather than inferring it from a sweep's behaviour.

## 5. What is NOT claimed

- **Not** that the drift measured on 08-12 has changed. That was a `TABLESAMPLE` over `wallet_moments_cache`; nothing here re-measures it, and the 08-12 numbers stand.
- **Not** that `refresh_wmc_fmv_changed` is healthy — it fails 35% of ticks. But it writes 106,638 rows/24 h, so it is degraded, not dead.
- **Not** that the 30 s pin is a defect rather than a deliberate read budget. Its *origin* is unestablished; only its effect is measured.
