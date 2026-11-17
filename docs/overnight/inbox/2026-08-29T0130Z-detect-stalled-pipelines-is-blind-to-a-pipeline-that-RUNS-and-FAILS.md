# `detect_stalled_pipelines()` reported **ALL CLEAR** through a 7-hour total outage of Top Shot ingest — it measures whether the cron FIRED, not whether it WORKED

**2026-08-29 01:30Z · Claude Code**

## The finding

At 01:25Z, with a Top Shot upstream outage running since ~18:00Z and three pipelines at **100% failure**:

```
select jsonb_array_length(detect_stalled_pipelines())  ->  0
```

**Zero breaching.** The live body explains it in one line — `last_run` is

```sql
SELECT max(started_at) FROM pipeline_runs pr WHERE pr.pipeline = w.pipeline
```

**with no `ok` filter.** A pipeline that runs every two minutes and fails every time is never *silent*, so
the arm can never trip. ⭐ **The louder a pipeline fails, the more reliably this detector calls it
healthy.**

| pipeline | severity | arm (min) | **mins since SUCCESS** | mins since any run |
|---|---|---:|---:|---:|
| `topshot-fmv-populate` | medium | 480 | **1,065** | 345 |
| `offers-sweep` | medium | 120 | **522** | **2** |
| `topshot-moments-hydrator` | info | 30 | **432** | **2** |

`topshot-moments-hydrator` is **14× past its own arm** and invisible. ⚠ **And `topshot-pack-pool-backfill`
— 100% failed for 3+ h — is not on the watchlist at all**, so it is outside this instrument entirely.

⭐ **`topshot-fmv-populate` is the one to look at FIRST and it is NOT part of the outage.** 1,065 minutes
(17.7 h) without a success, against an outage that started ~7 h ago. It is a separate, older failure that
nothing has reported. **This is what the blindness costs: a real fault sitting under a green light.**

## ⛔ The obvious fix is REFUTED — do not ship it

*"Add `AND pr.ok` to the lateral"* is one word, and it is wrong. Measured over 48 h, replaying the arms
against last-**success** instead of last-**run**:

| | count |
|---|---:|
| watchlisted pipelines with success history | **83** |
| breaching RIGHT NOW on last-success | 3 |
| **would have breached AT SOME POINT in 48 h** | **21 (25%)** |

🚨 **The snapshot says 3; the distribution says 21.** I nearly shipped on the snapshot — it is exactly
this repo's own rule (*"a directional claim needs a DISTRIBUTION, not a snapshot"*) and the snapshot was
off by 7×. **An alerting channel that fires on a quarter of the fleet is worse than the gap it fixes**,
because the next real outage arrives inside the noise.

**The reason is structural: `max_silent_minutes` was TUNED against last-run semantics.** Flipping the
predicate silently redefines all 85 arms at once — a pipeline that legitimately fails a third of the time
and retries has always been fine under "did it fire", and becomes a flapper under "did it work".

## What a real fix needs (design work, not a predicate)

1. **A SECOND arm, not a redefined one** — e.g. `max_minutes_without_success`, defaulting to NULL (opt-in)
   so no existing pipeline changes behaviour on day one, then populated per pipeline from its own measured
   success-gap distribution.
2. **Seed it from data, never by taste:** the 48 h max success-gap per pipeline is computable today (the
   query in this filing); an arm at, say, 3× that is a defensible starting point.
3. **Consider a distinct severity.** "Has not succeeded" is a different claim from "has not run" and
   probably wants its own channel rather than sharing the stall alert's.

⚠ **Two callers must be checked before touching the existing function:** `get_pipeline_alerts_core` and
`rpc_ops_snapshot`. **Adding a new function is additive and safe; changing this one is not.**

## Not established

⛔ **Why `topshot-fmv-populate` has not succeeded in 17.7 h.** Not investigated — flagged only because
this instrument should have surfaced it and did not.
⛔ **That 21 is the right number for any specific arm** — it is the count that would have breached under a
blanket flip, which is the thing being argued against, not a proposal.
⛔ **That the 85 arms are individually correct.** Not audited; this filing is about the predicate, not the
values.

---
## ✅ SHIPPED AS DESIGNED — the second, opt-in arm (2026-09-04 01:5xZ, Claude Code on Trevor's box)

Exactly the three points of "What a real fix needs", nothing from the refuted section: **(1)** `pipeline_cadence_watchlist.max_minutes_without_success` (NULL = not armed) + `detect_pipelines_without_success()` (same shape and posture as the sibling; service_role only), migration `20260904012510`; **(2)** seeded from data — `GREATEST(3 × each pipeline's own max ok-gap over retention, 2 × max_silent_minutes)`, or `3 × max_silent` with fewer than two ok runs, the rule written into each row's `notes`; pre-seed reading: 0 of 87 past 3× their own max ok-gap, so the function returned `[]` on first call; **(3)** its own channel — a new sentinel check "Pipeline Success" beside "Pipeline Silence" (high severity pages), fail-closed on error/shape like its sibling. `ingest` is the one active arm left NULL (dead host, alert already suppressed). Callers `get_pipeline_alerts_core`, `rpc_ops_snapshot`, `check_pipelines_running_but_not_succeeding` untouched, as this filing insisted. Ledger 2026-09-03.
