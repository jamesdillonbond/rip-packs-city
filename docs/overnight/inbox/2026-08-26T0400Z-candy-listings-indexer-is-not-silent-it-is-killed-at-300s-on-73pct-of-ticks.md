# 🚨 `candy-listings-indexer` is NOT silent — the cron fires, the route runs, and the work is KILLED at 300 s on 73% of ticks. Zero completions in 21 h

- **When:** 2026-08-26 ~04:00Z (2026-08-25 21:00 PT), Claude Code interactive. **Read-only. Nothing shipped.**
- **Why it exists:** it was the one entry I left **unclassified** in [the live alert triage](2026-08-26T0320Z-weekly-db-maintenance-is-daily-and-the-24h-floor-makes-a-healthy-weekly-job-permanently-red.md). Closing that gap turned out to be the largest finding of the night.

## 1. The alarm names the wrong failure

`detect_stalled_pipelines()` reports **`candy-listings-indexer` silent 1202 min** (vs a 400 min ceiling). That reads as *"the scheduler stopped"* and sends you to look at the trigger. **The trigger is fine.**

This is a **Vercel cron** (`vercel.json`: `/api/candy-listings-indexer` @ `35 */3 * * *`), so the pg_cron dispatch/landing discriminator does not apply — but the route already carries the **invocation heartbeat** (deep-audit R11, 2026-08-15), which gives the same three-way split. **The heartbeat is working perfectly. Nothing was reading it.**

| state | evidence | count (72 h) |
|---|---|---|
| ✅ ran to completion | heartbeat **+** terminal row | **6** |
| 🚨 **invoked, then KILLED** | heartbeat, **no** terminal row | **16** |
| ⛔ never fired | **neither** | **2** (24 expected at `*/3`) |

**73% of invocations are killed.** Last completion **2026-08-25 06:35:49Z**; five consecutive kills since (12:35, 15:35, 18:35, 21:35, 00:35). ⭐ **The cadence arm collapses all three states into one number**, and the one it names is the one that is not happening.

## 2. The mechanism, confirmed by a second independent instrument

Vercel runtime errors, **filtered to the route**:

```
Vercel Runtime Timeout Error: Task timed out after 300 seconds
count=17   users=17   routes=/api/candy-listings-indexer
first=2026-06-16T13:24:05Z   last=2026-08-26T00:35:42.000Z
```

`export const maxDuration = 300`, and the sweep exceeds it. ⭐ **The last timeout matches the last heartbeat to the second** (`00:35:42.238`), and 17 route-attributed timeouts in 48 h sits consistently against 16 killed invocations in 72 h. **Two instruments, independently derived, same picture.**

⚠ **NOT the 2,666-event figure.** The 08-26 Sentry filing lists a 300 s timeout group at *2,666 events / 266 users*. **Route-filtering this one gives 17.** Per this repo's own rule that `get_runtime_errors` attribution is **smeared** and must be re-grouped on `requestPath`, the 2,666 is a different or smeared group and **must not be attributed here**. The sound number is **17**.

⚠ **`first=2026-06-16`** — this is not new. What is new is that it now fails *every* tick rather than intermittently.

## 3. Why nothing caught it

- `pipeline_runs` shows `ok:true` on every row it has, because **a killed `after()` never writes a terminal row at all** — the surviving rows are exclusively the successes. **The success rate computed from `pipeline_runs` alone is 6/6 = 100%.** That is the "green pipeline blind to its own work" shape in its purest form.
- ⚠ **`try/catch` cannot catch a `maxDuration` kill**, which is exactly why the heartbeat exists. It did its job; **no instrument consumed it.**
- The cadence arm reads recency, not completion, so it reported *silence* for something that is invoked punctually every 3 h.

## 4. ⛔ NOT SHIPPED — this is ingest logic

The fix is to make the sweep fit inside 300 s (page/chunk the Magic Eden listing walk, or cursor it across ticks). **`ingest` route logic is on the never-auto-ship list**, and the right shape is a real decision: this route's own header documents a *"complete sweep or abort"* invariant — *"any page-fetch failure aborts deactivation, so a transient error can never wrongly mark a still-standing ask dead."* ⚠ **A naive chunking that makes a partial sweep look complete would break that invariant and start deactivating live asks.** That is the trap, and it is why this is filed rather than fixed.

## 5. 👉 The cheap durable instrument, independent of the fix

Nothing watches heartbeat-without-terminal anywhere. **A single arm — *"invocations with a heartbeat and no terminal row in N hours"* — would have caught this on 06-16**, and would generalise to every `after()` route that already writes one. **That is the reusable half of this finding.**

## 6. ⓘ Sibling control (so this is not read as a Candy-wide outage)

`candy-offers-indexer`: **11 terminal / 12 heartbeat** over the same 72 h — ~92% completion. `candy-sales-indexer`: 23 rows. **Candy ingest as a whole is healthy; this is one route's sweep outgrowing its budget.**

---

## ⛔ ADDENDUM (~04:20Z) — I SPECIFIED THE ARM IN §5, THEN MEASURED IT AND MY OWN PREDICATE FAILED

§5 proposed *"an arm for invocations with a heartbeat and no terminal row"*. **Measured across every `-heartbeat` pipeline before recommending it further — the obvious forms are unusable.**

| candidate predicate | why it FAILS |
|---|---|
| `killed > 0` | ⛔ **`fmv-recalc` fires 104×/day.** CLAUDE.md already records it as *"wasteful, NOT broken"* — 72.7% wall-kills **by design**, work committed incrementally. A `killed>0` arm is pure noise and would bury the real signal. |
| `max_consecutive_kills > N` | ⛔ **Also fails: `fmv-recalc` has a 38-kill streak**, against `candy-listings-indexer`'s 5. The streak is *larger* on the healthy one. |

⭐ **THE PREDICATE THAT WORKS IS `hours_since_last_completion`** — because a pipeline that commits incrementally still *completes* constantly, however often it is killed. Measured over 48 h:

| pipeline | invocations | completed | max consec kills | **hrs since completion** |
|---|---|---|---|---|
| `fmv-recalc` | 343 | 142 | **38** | **0.1** ✅ |
| `drain-fmv-cold-tail` | 96 | 87 | 2 | 0.2 ✅ |
| `topshot-sales-indexer` | 202 | 196 | 2 | 0.2 ✅ |
| *(all other healthy)* | — | — | ≤2 | **≤0.8** ✅ |
| 🚨 `candy-listings-indexer` | 14 | 3 | 5 | **20.4** |
| 🚨 `compute-laliga-pack-ev` | 2 | **0** | 2 | **never** |
| ⚠ `pinnacle-sync` | 2 | 1 | 1 | **40.8** |

**The healthy population is ≤0.8 h and the unhealthy one is ≥20 h — a clean separation with two orders of magnitude of margin**, which is what makes a threshold here safe rather than a cry-wolf risk. ⚠ It must be **per-pipeline relative to that pipeline's own cadence**, not one global constant: a 6-hourly job legitimately sits at 6 h.

## ⓘ AND THE ARM'S OWN FINDING WAS ALREADY WRITTEN DOWN — 6 DAYS AGO, STILL TRUE

`app/api/allday-pack-listings/route.ts` records, dated **2026-08-20**, that the marker used to be written under the pipeline's **own** name — which **defeated the alarm it was added to protect**, since `detect_stalled_pipelines()` takes `max(started_at)` with **no phase filter**, so a self-named marker refreshed `last_run` every tick and the arm could never fire. *"A monitor whose input set includes its own output."* It notes in passing: **"pinnacle-sync and compute-laliga-pack-ev had markers ONLY, zero completions."**

⭐ **Both are STILL zero-completion on 2026-08-26** — six days later, unfixed, and nothing has surfaced them since, because the fix that made the three states *readable* was never paired with anything that *reads* them. **That is the argument for the arm, and it is stronger than the one I made in §5.**

⚠ **Credit where due: my measurement re-derived a known result.** The genuinely new parts are `candy-listings-indexer` (not in that list, 300 s mechanism confirmed) and the **predicate design** above. ⓘ Note also that `compute-laliga-pack-ev` (Vercel cron `/api/cron/compute-laliga-pack-ev`) is a **different pipeline** from `compute-golazos-pack-ev` (pg_cron jobid 44 → edge fn) despite both concerning LaLiga Golazos pack EV — **do not conflate them; I nearly did.**
