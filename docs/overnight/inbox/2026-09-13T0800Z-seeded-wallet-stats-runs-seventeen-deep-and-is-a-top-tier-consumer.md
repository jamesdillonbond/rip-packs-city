# `refresh_seeded_wallet_stats` ran **17 deep** during a live spell, and over 32 days it is a top-tier consumer — 41,384 calls at a 9.5 s mean

*Claude Code (cloud), 2026-09-13 01:0x PT / 08:00Z. **READ-ONLY. Nothing shipped, and the reason is at the bottom rather than implied.** Found while watching a saturation spell that was preventing a fix shipped minutes earlier from arming — i.e. found by accident, which is stated because it means nothing here was systematically swept.*

---

## 1. The observation, and the measurement error I made first

At **07:54Z** the instance read **31 active backends**. A first aggregate grouped `pg_stat_activity.query` by its leading 70 characters and reported *"24 backends on one RPC"*.

⛔ **That reading was an ARTIFACT and is retracted.** Every PostgREST RPC begins with the identical `WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar FROM (SELECT ...` boilerplate, so a prefix-truncated GROUP BY collapses *different functions into one row*. Two samples pulled at 400 characters were `get_pipeline_alerts()` and `get_edition_market_bundle(...)` — not one function at all.

⭐ **PROMOTE: never group `pg_stat_activity` or `pg_stat_statements` on a truncated prefix — PostgREST's wrapper makes every RPC look identical for the first ~60 characters.** Extract the function name (`regexp_match(query, '"public"\."([a-z0-9_]+)"')`) and group on that.

**Re-aggregated on the function name, same instant:**

| function | concurrent | IO-waiting | oldest |
|---|---:|---:|---:|
| `refresh_seeded_wallet_stats` | **17** | 9 | 28.6 s |
| `backfill_wmc_metadata_from_editions` | **6** | 6 | 35.4 s |
| `wallet_moments_cache` (table read) | 3 | 3 | 1.2 s |
| `allday_resolve_unmapped_vi…` | 1 | 1 | 91.6 s |
| `atlas_listing_verify_tick` | 1 | 1 | 91.0 s |

## 2. Why 17 is the interesting number: it is ~120× the steady-state concurrency

`pg_stat_statements`, window **774.4 h (32.3 days, since 2026-08-12 01:33Z)**, the two entries whose text contains `refresh_seeded_wallet_stats`:

| calls | mean | total exec | blocks read |
|---:|---:|---:|---:|
| 41,384 | 9,520 ms | **6,566 min (109.4 h)** | 54.3 M |
| 12,218 | 9,287 ms | 1,891 min (31.5 h) | 27.6 M |

⚠ **The two rows cannot be separated from the truncated text** and may be two parameter shapes of the same function; they are reported as a pair, not summed into a claim about one call site.

**Combined: ~4.4 exec-hours/day and ~82 M block reads over the window.** For scale, this register books `refresh_wmc_fmv_changed` as "the estate's single biggest statement" at 208 exec-hours / 31 days ≈ 6.7 h/day — **so this pair is roughly two-thirds of the acknowledged worst, and it is not on any list.**

⭐ **AND THE CONCURRENCY IS A BURST, NOT THE WORKLOAD.** 41,384 calls over 32.3 days is **1,281/day ≈ 0.89/minute**; at a 9.5 s mean, expected average concurrency is **0.89 × 9.5 / 60 ≈ 0.14**. Observing **17** is ~120× that. So this is a fan-out or a pile-up in a narrow window, and the daily totals above understate its instantaneous cost.

## 3. What is NOT established — and it is the half that decides the fix

⛔ **The cause of the 17 is NOT identified.** `app/api/seed-wallet-refresh/route.ts` already paces itself: `DISPATCH_BATCH_SIZE = 6`, and `dispatchPaced` **awaits each batch before starting the next**, so a single invocation cannot exceed 6 concurrent. Three callers exist (`seed-wallet-refresh`, `wallet-backfill`, `lib/chains/flow/wallet-backfill-helpers.ts`) plus pg_cron **jobid 259** `rpc-reconcile-saved-wallet-stats` (hourly at :44, calls the *procedure* `reconcile_all_saved_wallet_stats`, not this function).

**So 17 implies ~3 overlapping invocations of a route that paces to 6** — i.e. the route is being re-entered before it finishes. That is a hypothesis with an obvious test (invocation start/end times against the 9.5 s mean and the wave arithmetic) and **it was not run**.

⚠ **Also unestablished: whether the spell is CAUSED by this or merely VISIBLE in it.** In a fleet-wide slowdown every lane is slower and deeper, so a 17-deep reading during a spell is partly symptom. The 32-day totals are independent of that; the concurrency figure is not.

## 4. Blast radius, observed in the same window

The spell this was observed in produced **four consecutive `statement_timeout` failures** on `sales-counterparty-backfill` (07:40, 07:45, 07:50, 07:55Z, each 60–67 s), which is what made it visible: a fix shipped at 07:49Z needs one tick that COMPLETES in order to arm, and could not get one for twenty minutes. `allday_resolve_unmapped_vi…` and `atlas_listing_verify_tick` were both at ~91 s in the same instant.

## 5. Why nothing was shipped

⛔ **The cause is not identified, and this estate's own rule is that a plausible mechanism is not a measurement.** The pacing constant is already there and already correct for one invocation; "lower DISPATCH_BATCH_SIZE" would be tuning a number that is not the one at fault if the real shape is re-entrancy.

⛔ **And the measurement that would settle it should not be taken during a spell** — the standing rule that an exploratory query is production load on this tier, which this session had already tripped once tonight.

**Suggested order for whoever picks this up:**

1. **Test the re-entrancy hypothesis first**, from `pipeline_runs` start/finish stamps for the `seed-wallet-refresh` lane against its own cadence — no `sales`-class scan required, so it is safe to run any time.
2. If re-entrant: a lock or an in-flight guard on the route is the fix, not a smaller batch. If NOT re-entrant, the fan-out is coming from a caller nobody has enumerated, and the eight-source caller rule applies (two of the eight are invisible from a sandbox).
3. **Only then** consider the 9.5 s mean itself. 9.5 s for a per-wallet stats refresh is high enough to be worth a plan read on its own merits, independent of the concurrency question.

⚠ **Do not quote the 41,384 / 9,520 ms figures without re-deriving them** — they are a 32-day cumulative sample and `pg_stat_statements` has not been reset since 2026-08-12.
