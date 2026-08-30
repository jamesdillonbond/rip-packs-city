# The Top Shot 530 outage: only pack-pool was paused — offers-sweep and topshot-moments-hydrator are still firing 100%-failing runs into the dead endpoint

**Filed by rpc-daytime-monitor, 2026-08-30 ~03:10Z (2026-08-29 20:10 PT). Status: MEASURED (quiet window, not a spell) — READ-ONLY observation, low-risk pause candidate.**

## Context, not a re-raise
The Top Shot GraphQL upstream 5xx outage itself is already thoroughly filed today and is NOT what this candidate is about:
- `2026-08-28T2320Z-topshot-upstream-5xx-outage-from-1800Z-do-not-diagnose-as-internal.md`
- `2026-08-29T1630Z-CORRECTION-it-is-not-a-topshot-outage-...`
- `2026-08-29T1830Z-...-topshot-outage-throttles-four-collections.md` (the sales-history self-throttle module)

And the night pass already shipped a mitigation: it paused **pg_cron jobid 16 `rpc-backfill-pack-pool`** ("pause jobid 16 rpc-backfill-pack-pool while its host is dead", commit `9f417118`). That pause took: `topshot-pack-pool-backfill`'s last run was 02:18Z and it has been quiet since.

## The new observation
The pause was applied to **one** dead-endpoint pipeline. Two others were left running and are still emitting 100%-failing runs into the same dead Top Shot GraphQL endpoint, measured now (last 2 hours):

| pipeline | runs 2h | fails 2h | last run | last error |
|---|---:|---:|---|---|
| `topshot-moments-hydrator` | 12 | 12 | **03:02Z (~5 min ago)** | HTTP 530 / 1033 |
| `offers-sweep` | 6 | 6 | **03:02Z (~5 min ago)** | HTTP 530 / 1033 |
| `topshot-pack-pool-backfill` | 14 | 14 | 02:18Z (then paused) | HTTP 530 / 1033 — HANDLED |
| `topshot-fmv-populate` | 1 | 1 | 01:38Z | HTTP 530 / 1033 |

Over the trailing 2 days the outage accounts for **614** 530/1033 failures (first 08-28 21:28Z, still firing — 15 in the last hour). Positive control: `sales` is unaffected (476 sales/6h, newest 03:01Z) — this is purely the GraphQL enrichment path, not core ingest, and no user-facing freshness metric is breaching yet (topshot_fmv_stale_hours 0.2, ok).

## Why it matters (mildly) and the risk read
These two are burning worker/IO on every tick for zero rows while an upstream RPC cannot fix is down. `topshot-moments-hydrator` was 172/276 (62%) failing and `offers-sweep` 93/141 (66%) over 2 days. It is not urgent — no data loss, self-heals when Top Shot recovers — but it is the same wasteful-into-a-dead-host pattern the jobid-16 pause already addressed, applied asymmetrically.

**Caller note (important — the lever is NOT the same as jobid 16):** neither `offers-sweep` nor `topshot-moments-hydrator` is a pg_cron job (a `cron.job` scan matched only the unrelated `rpc-raise-edition-offers-backstop` jobid 216). They are driven externally — cron-job.org and/or a GHA workflow — so pausing them is a cron-job.org console edit / GHA schedule change, not a one-line `cron.alter_job`. That makes this a night-pass-or-Trevor action, not a trivial DB toggle.

## Suggested action (night pass)
1. Confirm each pipeline's code path is Top-Shot-GraphQL-**only** before pausing (offers-sweep may touch more than Top Shot — verify it does not strand another collection, the way the 1830Z sales-history throttle stranded four).
2. If Top-Shot-only, pause/back off `topshot-moments-hydrator` and `offers-sweep` at their external caller until the 530s clear, mirroring the jobid-16 precedent, and record an explicit exit condition tied to 530 recovery (so the pause is reversed, not forgotten).
3. Alternatively, add upstream-outage backoff to `lib/` so these skip cheaply (like the sales-history saturation self-throttle) instead of a manual pause — the durable fix, but a code change, so a handoff.

Sensed and logged only; no action taken.

---

## ACTIONED 2026-08-29 20:30 PT (2026-08-30 03:30Z) — Claude Code, interactive session. Step 1 verified; step 3 (the durable fix) SHIPPED for `offers-sweep`. `topshot-moments-hydrator` is a genuine handoff.

### Step 1 — "confirm each pipeline's code path is Top-Shot-GraphQL-only" — DONE for `offers-sweep`, and it is.

`app/api/cron/offers-sweep/route.ts` carries a single hardcoded `COLLECTION_ID = 95f28a17-…` (Top Shot) and one `topshotGraphql` query. **There is no second collection in it, so backing it off cannot strand anything** — the failure mode the filing rightly warned about, citing the 1830Z sales-history throttle.

⚠ **That warning was well-founded and it shaped the design.** The existing saturation throttle counts *other* pipelines' recent failures, which is exactly why a Top Shot outage was able to throttle four unrelated collections. **A per-collection outage must never be able to pause another collection**, so the breaker shipped here keys ONLY on the calling pipeline's own most recent run.

### Step 3 SHIPPED — `lib/pipeline/upstream-breaker.ts`, wired into `offers-sweep`

Chosen over step 2 (a manual pause at cron-job.org) for the reason the filing itself gives: a manual pause must be remembered and reversed by a person. This one **cannot be forgotten, because there is no stored state to forget** — the window is measured from the last failing run, so once it elapses the next tick makes a real attempt. If the upstream is still down, that buys another window; if it recovered, the breaker never trips again. Half-open by construction.

**The safety property is structural, not a promise:** the breaker can only trip when the pipeline's most recent *real* run FAILED with an upstream signature. A healthy pipeline's newest run is `ok`, so no state exists in which this pauses working work. Asserted directly, with a negative control.

**Deliberate choices worth not re-litigating:**
- **Fails OPEN on every unreadable state.** ⚠ This is the OPPOSITE of the saturation throttle, whose fail-open `count ?? 0` was a real bug — there "open" meant hammering a saturated DB. Here "open" is one ordinary tick and "closed" is a silently paused pipeline, so the cost argument inverts. Do not "harden" it without redoing that argument.
- **The signature is not a bare `/530/`.** It matches the four spellings actually present in `pipeline_runs` and is pinned against prose like `"wrote 530 rows"`, so a bug in our own code can never trip the breaker and then hide behind it.
- **The declined tick still writes a `pipeline_runs` row** (`extra.skipped = 'upstream_outage'`), because a gate returning before any write is the 4th cause of `cron_silent`. `rows_*` are **NULL, not 0** — a declined tick measured nothing.
- **The gate sits AFTER the cursor read and carries `startCursor` forward.** The sweep resumes from the newest row's `cursor_after`; a marker with a null cursor would have silently reset an ~80 min cycle to head on every skipped tick. That is pinned by its own assertion.
- Skip markers are excluded when finding "the last real run", or the breaker would disarm itself after exactly one skip.

⭐ **A real bug in the breaker was caught by the EXISTING route test, not by mine**: `rows.find()` sat outside the try, so a non-array payload threw *past* the module into the route's own fatal handler — a breaker whose failure mode is "abort the pipeline it protects". Fixed and pinned as a regression.

**Effect:** at the ~20 min cadence a 30 min window means roughly one real attempt per 40 min instead of three per hour. Verified against live data: newest real run failed 03:02Z matching the signature, so the next tick declines and the one after attempts.

**Verified:** 10/10 offers-sweep route tests · 20/20 breaker tests · **5 mutations all red** (breaker never trips · breaker always trips · marker with null cursor · `rows_*` as 0 · gate does not return) · `tsc --noEmit` clean.

### NOT shipped, and the reason is access, not judgement

- **`topshot-moments-hydrator` is a Cloudflare Worker** (`workers/topshot-moments-hydrator/`). Pushing `workers/**` to `main` deploys **nothing** — CF Workers need a `wrangler deploy`, which this session cannot do. It is also the higher-volume offender (12 runs / 12 failures in 2 h). **Owed: port the same breaker to the worker and `wrangler deploy` it.** Its cron is declared in no file in this repo (known-issues #21), so the pause lever is external either way.
- **`topshot-fmv-populate`** (1 failure / 2 h) was left alone — too low-volume to be worth a gate, and it is a different route family.
- **The 530 outage itself is untouched.** This reduces the cost of waiting it out; it does not fix Top Shot.

### ✅ VERIFIED IN PRODUCTION 03:42:13Z — and ⛔ a CORRECTION to my own cost claim above

Deploy READY 03:34:10Z with production aliases, so the 03:42Z tick was the first that could exercise the gate. **It declined, and every pinned property held live:** `extra.skipped = upstream_outage` · `window_minutes = 30` · `last_error` = the 530 · `rows_found/written/skipped` all **NULL** · **`cursor_after` preserved** · heartbeat present at 03:42:09Z.

⛔ **The cost claim was wrong and it was mine.** I wrote that a failing tick paid *"a full 40-page walk"*. **No failing tick completes a walk** — it dies on the first GQL call, and the cost is retry-grinding. Caught because the three newest failures read `duration_ms` **3.7–4.5 s**.

⚠ **The fast reading was not the answer either — three runs is not a distribution.** Across 88 failed runs in 29.7 h: **p10 3.8 s · median 32.3 s · p90 107.7 s · max 208.3 s**, **32 of 88 under 6 s**, total ~57 min of lambda.

**Honest benefit:** a skip costs a measured **3.8 s** of fixed route overhead against a **39.2 s** mean failing tick ⇒ **~35 s saved per skipped tick in expectation, ≈0 on the ~36% already failing fast**. The breaker's own read is **23 buffers / 0.33 ms**. Real, and smaller than I first said.
