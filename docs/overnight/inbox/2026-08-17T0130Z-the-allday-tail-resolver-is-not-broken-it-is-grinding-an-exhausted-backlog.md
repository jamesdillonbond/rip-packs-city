# `allday-unmapped-resolver-tail` — NOT broken; it is grinding an exhausted backlog at ~52 min / 3 days for 5 rows

Filed 2026-08-16 18:30 PT / 2026-08-17 01:30Z (Claude Code, interactive). **QUEUED — nothing shipped. This is a cost/benefit judgment with a data-coverage cost, not a defect fix.**

Origin: found while correcting [2026-08-16T2145Z](2026-08-16T2145Z-unmapped-resolver-is-stuck-in-december.md). That filing's real lead was its sibling, not its subject.

---

## ⚠ Read this first — the "it's broken" framing is WRONG, and the refutation is in the route itself

The telemetry below looks exactly like a dead pipeline, and it is not. `app/api/cron/allday-resolve-unmapped-tail/route.ts:419-425` records a prior measurement that pre-empts that reading:

> *"This WAS a fatal clause; demoted 2026-07-27 … an independent probe resolved 0/40 backlog rows and 0/11 head rows with ZERO transport errors, so '0 resolved on a healthy transport' is the expected steady state of an exhausted backlog, not a fault."*

So `onchain_unproductive` and `scan_ineffective` are **deliberately non-fatal**, and a zero-resolution run is the designed steady state. **Do not open this as an incident, and do not "fix" the decode leg** — someone already checked, and the rows genuinely do not resolve. The open question is only whether the grinding is worth its cost.

## The measurements (full `pipeline_runs` retention window, 24 runs, ~73 h)

| | |
|---|---|
| runs / ok | **24 / 11** (13 failed, all `resolve:upstream request timeout`) |
| candidates seen | 1,822 |
| decode attempts | **977** |
| → `onchain_nil` | **971** |
| → `onchain_err` | **1** |
| → **resolved via decode** | **0** |
| scan chunks burned | **4,706** |
| → resolved via scan | **5** |
| resolved via buyer | 0 |
| **rows promoted** | **1** |
| mappings written | **0** |
| **total runtime** | **3,093 s ≈ 51.5 min** |

**0-for-977 on decode. 5-for-4,706 on scan. 51.5 minutes of Flow REST work and DB time to promote one row**, with ~54% of runs ending in an upstream timeout at p95 190–320 s.

⚠ The transport is HEALTHY — `onchain_err` is **1** across 977 attempts. These are clean nils, which is precisely the exhausted-backlog signature the route's comment describes.

## Why it is worth raising anyway

The cost lands on the **2 GB IO-throttled instance whose saturation is a documented platform-wide problem** (it kills `fmv-recalc` at the wall, fails insights board warms, and drives the pg_cron 2–4% tick loss). ~52 min / 3 days of scanning plus 13 upstream timeouts is a non-trivial share of a budget that other pipelines are visibly starved of.

Against that, the yield is **~5 resolutions per 3 days**, i.e. roughly **1.7/day**, against an All Day open backlog of **105,991** rows.

## Options (NOT taken — each has a real cost)

1. **Cut the scan budget, keep the resolver.** The scan leg is 5-for-4,706 chunks. Lowering the per-tick chunk allowance keeps the cheap decode/buyer legs and drops the expensive-and-near-useless one. ⚠ Smallest blast radius, but it does forfeit the one leg that produced all 5 resolutions.
2. **Cut the cadence** `40 */3` → daily. Same yield per unit work, ~⅛ the platform cost, strictly slower drain.
3. **Retire the schedule** (keep the route, the `sync-sales-ingest-dune` disposition). ⚠ **This is a data-coverage decision, not a cleanup** — it is the only thing working the priced >7 d tail, so retiring it means those rows are never revisited unless something else picks them up.

⛔ **Do NOT simply raise the timeout or the budget.** CLAUDE.md's standing rule for this class is that the lever is the WORK, never the clock, and a longer run holds a pooled connection longer on the instance whose saturation caused the timeout.

⛔ **Do NOT read this as an argument to also retire `allday-resolve-unmapped` (the non-tail sibling).** That one is the working drain — ~200 rows/day, and the thing actually holding outflow near inflow.

## The check that settles it

Whether the tail's candidate pool is genuinely exhausted (nils are permanent) or merely *currently* unresolvable (nils would clear as `wallet_moments_cache` grows) decides between options 1–2 and option 3. The route already stamps `last_onchain_attempt_at`, so the question is answerable directly: **take rows that returned nil ≥ 2 weeks ago and re-probe a sample.** If they still nil, the pool is exhausted and option 3 is defensible; if a meaningful share now resolve, the grinding is doing real work slowly and option 2 is right.
