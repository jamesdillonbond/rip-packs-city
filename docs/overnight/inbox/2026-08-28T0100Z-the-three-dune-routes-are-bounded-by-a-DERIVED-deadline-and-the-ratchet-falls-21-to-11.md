# ✅ SHIPPED — all three `*-dune` routes bounded, unbounded-fetch ratchet **21 → 11**, and the bound is DERIVED rather than guessed

**Filed 2026-08-27 18:00 PT (2026-08-28 01:00Z) by Claude Code, cloud session (push-capable).**
Takes the largest-budget block of the class triaged in
[2026-08-27T0320Z](2026-08-27T0320Z-unbounded-fetch-is-a-class-29-sites-carry-the-shape-whose-failure-is-invisible.md).

---

## 1. What shipped

`lib/http/sweep-deadline.ts` — a shared `sweepDeadlineSignal(startedMs, budgetMs, { reserveMs, maxMs })`
— applied to **all 10** unbounded `fetch()` sites in the three `maxDuration = 800` Dune routes
(`/execute`, the `/status` poll, the `/results` page walk, and the ownership route's stale-cache probe).

⭐ **It is a shared module and not another inline constant on purpose.** The triage filing's own
headline was that the fix for the candy outage *already existed one file away* (`solUsd()`, 8 s cap,
a comment naming the exact failure mode) **and had never spread**. Re-derived here: **20 sites across
`lib/` already carry an inline `AbortSignal.timeout(...)` and there was no shared helper at all.**
CLAUDE.md says "grep for the EXPRESSION, not the file"; this is that rule pointed at the fix, so the
reasoning now lives somewhere importable instead of in a comment only a reader of that file sees.

## 2. ⭐ The part worth keeping: the bound is DERIVED

The triage filing warns that "a short cap converts working behaviour into failure", and that the
correct timeout is **not** a constant. That risk is real whenever the cap is a guess about the
upstream — and here **there was nothing to guess from**:

- All three routes are currently **drained** (`extra.windows_done: 0`, `drained: true`,
  `duration_ms` 116–1,347 ms), so they make no Dune calls at all right now.
- `pipeline_runs` holds **zero** runs with `windows_done > 0` inside its ~73 h retention.
- So **no fetch timing for these upstreams exists anywhere I can read.**

🚨 **This is exactly the trap the 2026-08-27 handoff names as its own headline lesson** — *"refusing
to guess an unmeasured number is a reason to MEASURE it; it is never a licence to conclude it is
small."* Picking "60 s feels right for `/execute`" would have been that error wearing the costume of
its discipline.

✅ **So the bound is not chosen for Dune at all.** Each signal is derived from `HARD_BUDGET_MS` — the
sweep deadline the route **already declares and already checks between iterations** — less a 30 s
`DUNE_LOG_RESERVE_MS` for the terminal `logRun`. The safety argument is structural, not empirical:

> A request that would outlive the remaining sweep budget is **already doomed** — the loop stops on
> its next check regardless. Aborting it therefore **cannot** turn a working call into a failing one.
> It can only turn a **SILENT kill** into a **LOGGED failure**.

That property is asserted directly in `__tests__/sweep-deadline.test.ts` (sampled across the whole
sweep), not merely "returns a positive number" — which would pass against a constant.

## 3. The count, and why I trust it

**21 → 11 sites, 13 → 10 files**, corroborated by **three independent detectors agreeing exactly**:
the repo's own `unbounded-fetch-in-after-routes-ratchet` test, an ad-hoc paren-balancing walk written
here, and the diff itself. Not one instrument read three times.

⭐ **The ratchet has an anti-slack arm and it fired**, refusing to pass at 21 once only 11 remained
(*"RATCHET is 21 but only 11 sites remain — lower RATCHET to 11"*). That is a ratchet doing the job
CLAUDE.md says most ratchets fail at: **falling**.

⚠ **My first ad-hoc sweep read 22, not 21 — and the extra one was `check-alerts`, a FALSE POSITIVE
caused by the stripper defect fixed in the sibling filing** (a comment above a bounded `fetch` was
being counted as a call site). The two findings met in the middle: **fixing the stripper is what made
the two detectors agree.** The repo's ratchet was already immune, having been deliberately built not
to depend on stripping succeeding — the tactic its filing recommended, vindicated.

## 4. ⛔ What was NOT done

- **No retries added.** The triage filing is explicit — one ownership walk is already 87.7 % of the
  monthly Dune datapoint budget. Timeouts only.
- **No `maxMs` upstream caps set.** The helper supports them and the composition is tested, but
  choosing one for Dune needs a measurement that does not exist yet. Left for whoever has a run with
  `windows_done > 0` to read.
- ⚠ **An aborted `/execute` may still run server-side on Dune and consume datapoints.** It can only
  happen once the route is already past `HARD_BUDGET_MS`, so it is rare by construction — but it is
  **not zero**, and it is not something I measured. Stated rather than assumed away.

## 5. Verification

`npx tsc --noEmit` clean · `sweep-deadline` **9/9** · ratchet **6/6** at 11 · full suite green.
⚠ **None of the three routes is currently doing real Dune work, so the new code paths are NOT
exercised in production yet.** The honest exit condition is the first run with `windows_done > 0`
completing normally — until then this is proven by tests and by construction, not by traffic.

## 6. Revert path

`git revert` the commit. Removing `lib/http/sweep-deadline.ts` additionally requires reverting the
ratchet to 21. No DB state, no prod data, no schedule change.
