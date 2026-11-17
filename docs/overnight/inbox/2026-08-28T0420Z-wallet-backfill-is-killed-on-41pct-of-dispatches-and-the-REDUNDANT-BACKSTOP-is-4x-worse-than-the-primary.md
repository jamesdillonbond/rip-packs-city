# 🚨 Wallet backfill is killed on **41.5%** of dispatches — and the **redundant GHA backstop is 4.3× worse than the primary it protects**

**Filed 2026-08-27 21:20 PT (2026-08-28 04:20Z) by Claude Code, cloud session (push-capable).**
Found by extending tonight's kill-rate work to the `-dispatch`/`-complete` convention.
✅ **SHIPPED (code, instrument only):** `correlateRuns()` now sees this convention. ⛔ **Nothing about
wallet backfill itself was changed** — §6 says why, and names the experiment instead.

---

## 1. The instrument was silent about the fleet's worst case, one hour after I shipped it

`lib/pipeline/kill-rate.ts` keyed on `-heartbeat`. But `app/api/wallet-backfill-multicollection`
predates `lib/pipeline/heartbeat.ts` and hand-rolled the same correlation under **`-dispatch` /
`-complete`** — its own comment says *"dispatch row with no matching complete row within ~15min =
killed lambda — that's the visibility we want."* **It is correctly instrumented, and my instrument
could not see it.**

✅ Fixed, and ⚠ **the discriminator is structural, not a name list:** a `-dispatch` counts as a marker
only when a `-complete` sibling exists **in the data**. 🚨 **`alerts-dispatch` is a REAL pipeline whose
name merely ends in `-dispatch`** — a suffix rule would have invented a 100%-killed pipeline out of a
healthy one. It is the negative control in the tests. ✅ The 5 s correlation window was **verified
against production before being relied on: 1,366 of 1,370 matched pairs share `started_at` to within
5 s (mean 1.58 s)**, because both rows carry the same `startedAtIso`.

⚠ **The price of the sibling rule is pinned in a test rather than left to be found:** with no
`-complete` anywhere in the window, a dispatch pipeline killed on EVERY tick drops out of the report
instead of reading 100%. It needs ~73 unbroken hours to happen. **The fix, if it fires, is to derive
marker names from the route sources — not to add a list of names.**

## 2. The measurement

Over the ~73 h window, **2,339 dispatches / 1,368 completes → 971 killed = 41.5%**, across 254 wallets.

⭐ **But 41.5% is a PER-ATTEMPT rate, and it is not what a user experiences** — the same discipline as
tonight's retraction. Wallets are re-dispatched ~9× over the window, so most kills self-heal. Per
wallet, on the **latest** attempt:

| | wallets |
|---|---:|
| latest attempt completed | **224 (88.2%)** |
| latest attempt killed | 25 |
| never completed in the window | 5 |
| **total** | **254** |

**So ~30 wallets (11.8%) are currently sitting on a failed refresh**, and the other 224 are fine. That
is the honest user-facing number; 41.5% is the compute-waste number.

## 3. ⛔ Two hypotheses tested, one refuted

**"The 5 always-failing wallets are too big for the 800 s wall."** ⛔ **REFUTED, and in the opposite
direction.** Those 5 are **small** — median **1,106** moments against **4,004** for the other 249
(max 155,411). **A wallet with 155k moments completes and these do not**, so "raise the budget" is the
wrong fix and would have been the obvious one.

**"It is a per-wallet defect."** ⛔ Also wrong. Their dispatch timestamps cluster, and the batches tell
the real story:

| batch minute | wallets | completed | killed |
|---|---:|---:|---:|
| 2026-08-25 03:31 | 36 | 19 | 17 |
| 2026-08-27 13:07 | 32 | **0** | **32** |
| 2026-08-27 23:58 | 30 | 15 | 15 |
| 2026-08-27 23:59 | 37 | 17 | 20 |

⭐ **The 5 "always-failing" wallets are just the tail of a burst lottery they lost three times.** The
subject is the burst, not the wallet.

## 4. ✅ Two factors, separated with a two-way control

Burst size and hour are confounded (big bursts happen at busy hours), so neither is readable alone.
Held against each other:

| burst size | QUIET (00,01,12Z) | BUSY (03,09,13,15,16,21,23Z) | ratio |
|---|---:|---:|---:|
| 1–9 | **2.5%** | 58.0% | 23× |
| 10–18 | **2.4%** | 43.1% | 18× |
| 21–29 | 12.5% | 76.8% | 6× |
| 30–38 | **20.0%** | **78.4%** | 4× |

**Both effects are real and separable.** The hour dominates — 4–23× at every burst size — and burst
size adds a genuine secondary effect visible *within* the quiet band alone (**2.4% → 20.0%**, 8×).

✅ **This is a THIRD independent instrument reaching tonight's hour conclusion**, after pg_cron busy
time (#42) and public-board view latency (the 0235Z filing). Different table, different mechanism,
same direction.

## 5. 🚨 The finding: it is the REDUNDANT BACKSTOP that is failing, not the primary

The hours are not load — they are **triggers**. `seed-wallet-refresh` is fired by cron-job.org cohorts
(:45/:59 on 0,6,12,18Z and :13/:27 on 1,7,13,19Z) and, redundantly, by the GHA workflow
`wallet-backfill-backstop.yml` at **:38 on 2,8,14,20Z**, whose four cohorts fire **60 s apart** and
spill into the following hour. Attributed:

| trigger | dispatches | killed |
|---|---:|---:|
| **cron-job.org primaries** | 1,324 | **17.0%** |
| **GHA backstop** | 788 | **73.1%** |
| other / manual (16Z, 23Z) | 227 | 74.9% |

🚨 **The path that keeps user wallets fresh runs at 17%. The path that exists only as insurance runs at
73% — 4.3× worse — and burns ~575 killed 800 s lambdas every three days on an IO-bound instance.**

⭐ **And that inverts the backstop's own value proposition.** It exists to cover cron-job.org dropout;
at 73% killed **it is mostly not completing either**, so the redundancy it buys is far smaller than its
header assumes while its cost is far larger. Its density is the likely reason: **four cohorts in ~3
minutes against the primaries' ~42**, which is exactly the burst axis measured in §4.

## 6. ⛔ Why nothing was shipped for this

The obvious change — widen the backstop's inter-cohort `sleep` — is **a plausible mechanism, not a
measurement**, and §4 says the hour dominates burst size. **14:38Z sits in the measured worst band
whatever the spacing**, so spreading the cohorts might buy little. Moving its hours instead would break
the design its header documents (~2 h after each primary window, on a GHA-empty minute).

⛔ **I am not shipping a guess into the component whose entire job is reliability.** The experiment,
stated so it can be run rather than re-derived:

- **Change:** `sleep 60` → `sleep 300` between cohorts in `wallet-backfill-backstop.yml`, and raise
  `timeout-minutes: 10` → `25` **in the same commit** — 4 cohorts × 300 s exceeds the current timeout,
  and without both the last two cohorts simply never fire.
- **Falsifier:** if the backstop stays near 73% at the wider spacing, burst density is not the cause
  and the hour is; the fix is then to move it to a quiet hour and accept the weaker "2 h after primary"
  property, or to accept the backstop as low-value and retire it.
- **Read it with the same discipline as tonight's retraction:** split at the change, do not pool.

⛔ **Also not claimed:** that the 17% primary rate is acceptable — it is not measured against any
target, and 30 wallets are currently stale. ⛔ And this filing does **not** establish what a killed
dispatch costs a user beyond a delayed refresh; the children are row-idempotent and `skip_cached`
defaults true, so a later attempt repairs it.

## 7. Revert

The shipped half is instrument-only: `git revert` removes the `-dispatch`/`-complete` support from
`lib/pipeline/kill-rate.ts` and its 5 tests. No route, schedule, workflow or DB object was touched.
