# ✅ SHIPPED — E5: four more `after()` routes made auditable (47 → 42), and the ratchet was counting a **correctly instrumented** route as missing

**Filed 2026-08-27 21:45 PT (2026-08-28 04:45Z) by Claude Code, cloud session (push-capable).**
Acts on the argument in [2026-08-28T0305Z](2026-08-28T0305Z-candy-editions-ingest-is-killed-45pct-of-nights-and-every-kill-is-invisible-in-both-rollups.md) §5:
**the un-heartbeated routes cannot be audited for kills at all**, which tonight's instrument makes concrete.

---

## 1. Four conversions, chosen by the ratchet's own priority rule

Not by convenience, and ⚠ **not by p90 `duration_ms` this time.** The sixth budget entry warns that
`log_pipeline_run` has no `p_finished_at`, so `finished_at` defaults to the INSERT and the duration
absorbs terminal-write queueing. **Confirmed tonight in the worst possible way:
`topshot-active-listings-ingest` records a p90 of 959,294 ms against a 60 s wall.** A ranking built on
that column would have been sorted mostly by write contention.

The rule the ratchet actually states is: **is the pipeline on `pipeline_cadence_watchlist WHERE
is_active`?** Those are the routes where a kill is not merely unlogged but **actively MISREAD** —
`detect_stalled_pipelines()` alerts on the absence of a terminal row, so a killed tick and a cron that
never fired raise the identical alert and need opposite responses.

| route | watchlist | why this one |
|---|---|---|
| `app/api/candy-sales-indexer` | **HIGH**, 450 min | highest severity left un-converted |
| `app/api/wmc-fmv-populate` | medium, 120 min | **6,194 terminal rows** — the largest population left |
| `app/api/cron/offers-sweep` | medium, 120 min | 222 rows, 300 s wall |
| `app/api/topshot-fmv-populate` | medium, 480 min | 480-min arm, so a kill hides for 8 h |

Each is `await writeInvocationHeartbeat(...)` as the **first statement of `after()`**, verified by
inspection after patching. ⚠ All four were **cold** — oldest touch 2026-06-06, newest 2026-08-26 —
checked before editing, because two other sessions are shipping tonight.

## 2. ⭐ The finding: the ratchet was counting a correctly instrumented route as MISSING

`app/api/wallet-backfill-multicollection` predates `lib/pipeline/heartbeat.ts` and hand-rolled the same
correlation under **`-dispatch` / `-complete`**. Its own comment states the contract: *"dispatch row
with no matching complete row within ~15min = killed lambda — that's the visibility we want."* The pair
is live: **2,339 / 1,368 rows** on 2026-08-28. **It is instrumented.** The ratchet greps for
`writeInvocationHeartbeat(` and counted it as a gap.

🚨 **That over-count was NOT harmless, which is why it is fixed rather than noted.** The remedy this
ratchet prescribes is *"add a marker"* — so **the next session working the list would have bolted a
SECOND marker onto the fleet's highest-volume pipeline.** A guard whose false positive prescribes a
harmful action is worse than a silent one.

⚠ **The exemption is asserted at the PROPERTY's granularity, exactly like the rule above it in the same
file:** BOTH halves must be present in the source. **A `-dispatch` alone must never vouch for a route —
`alerts-dispatch` is a REAL pipeline whose name merely ends that way**, and a suffix-only rule would
silently excuse every route that logs it. Same discriminator `lib/pipeline/kill-rate.ts` applies to the
run rows, now applied to the source.

Three tests pin it, including **a count assertion naming the single exempted route**, so a future route
quietly picking up the exemption is visible rather than absorbed.

## 3. The budget

**47 → 42.** ⚠ **Read off the failing no-slack assertion** (set to 0, read the reported live count),
never by subtracting five — the ratchet's own history records a day when two sessions each subtracted
their own conversions and both were wrong. **It is two changes and they are recorded separately: four
conversions and one exemption.** The arithmetic happens to agree here; that is a coincidence, not the
method.

## 4. ⚠ What this does NOT do

- ⛔ **It does not fix a single kill.** It makes kills *visible* on four more routes. `wmc-fmv-populate`
  and the rest may turn out to be killed at any rate; nothing here predicts one.
- ⛔ **No data exists yet.** The marker starts writing on the next tick after deploy, so
  `npm run pipelines:kills` will show these four only once they have run — and ⚠ **their first readings
  will be tiny samples.** Apply the recency rule: a handful of clean ticks proves nothing, and the
  classifier will correctly say so.
- ⛔ **Nothing about the routes' behaviour changed** — one awaited marker write before existing work.

## 5. Revert

`git revert` the commit: removes the four heartbeat calls and their imports, the ratchet exemption and
its three tests, and restores `BUDGET = 47`. No schedule, migration or DB object was touched.
