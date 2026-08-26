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
