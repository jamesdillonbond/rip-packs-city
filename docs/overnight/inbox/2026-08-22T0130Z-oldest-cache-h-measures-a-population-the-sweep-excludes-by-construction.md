# `reconcile-saved-wallet-stats`'s "is the sweep keeping up?" metric measures a population the sweep excludes by construction — and it misled me today

**Filed 2026-08-21 ~18:30 PT (2026-08-22 01:30Z), Claude Code interactive. MEASURED, with a positive
control. NOT fixed — see §5 for why the trade is wrong right now, not because it is hard.**

⚠ **Severity: MODERATE, and I am not inflating it.** `oldest_cache_h` has **no runtime consumer** — no
board, monitor or alert reads it (grep over `app/ lib/ scripts/ supabase/ components/ workers/`: only
migration copies and one test). Nothing automated is silently broken. What it does is mislead a human
reading `pipeline_runs`, which it did to me for six queries this evening.

---

## 1. Two hypotheses I formed and REFUTED, in order — the useful part of this filing

`reconcile-saved-wallet-stats` reports **`ok = false` on 100% of runs** (14/14 in 24h) with
`soft_deadline_reached_partial_sweep_committed`, and `extra.oldest_cache_h` climbing **304.8 → 305.8 →
306.8 → 307.8 across four hourly runs — exactly +1.0/hour**, the signature of an entry that is never
selected.

- **Hypothesis 1: one wallet is starved.** ❌ It is not one wallet. **21 rows** are frozen at
  *precisely* `2026-08-09 04:54:42.69501+00` — a single bulk-write instant, 12.85 days ago.
- **Hypothesis 2: the sweep burns its budget re-processing those 21 and starves everything else.**
  ❌ The candidate query carries `AND EXISTS (SELECT 1 FROM wallet_moments_cache WHERE …)`, so those
  rows are **excluded from the queue entirely**. They starve nothing.

**Positive control on the data itself:** all 21 have `cached_moment_count = 0`, and all 21 hold
**zero** rows in `wallet_moments_cache` right now. The zeros are CORRECT and currently true. This is the
08-09 explicit zero-pass the ledger records — "guarded so it is a no-op on later runs rather than
re-stamping the same rows nightly" — working exactly as designed. **The 308h age is intentional.**

## 2. What the defect actually is

The queue reads one population; the metric reads another:

```sql
-- QUEUE: only wallets that HAVE rows in wallet_moments_cache
WHERE sw.wallet_addr IS NOT NULL AND sw.user_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM wallet_moments_cache w WHERE …)

-- METRIC: every saved_wallets row, no such filter
SELECT ROUND(EXTRACT(epoch FROM (now() - MIN(cache_updated_at))) / 3600.0, 1)
  FROM public.saved_wallets WHERE wallet_addr IS NOT NULL;
```

So `MIN(cache_updated_at)` is pinned forever by 21 rows the sweep **cannot touch by design**. The figure
rises 1.0/hour indefinitely and **can never fall**. This is CLAUDE.md's rule verbatim — *coverage is only
real against what the guard READS* — and the cry-wolf outcome its own neighbouring comment cites.

⚠ **The consequence that matters is the INVERSE.** A genuine starvation — a queued wallet going
unreconciled for days — would be **invisible**, because the metric is already pinned at 308h and
climbing from an unrelated cause. The number cannot move in response to the thing it is named for.

## 3. ⚠ The test asserts something weaker than the promise in its own message

`supabase/tests/reconcile_all_saved_wallet_stats.sql:245`:

```sql
SELECT _assert((SELECT (extra->>'oldest_cache_h')::numeric FROM public._runs) IS NOT NULL,
  'and carries the oldest cache age, the figure that shows whether the sweep is keeping up');
```

The message promises the figure **shows whether the sweep is keeping up**; the assertion checks only
that *a number came out*. It passes with the metric pinned at 308h forever. Textbook instance of
CLAUDE.md's *"a test stating the contract in a comment and asserting something weaker — the tell is the
title"*. ⚠ **Sharper still: the comment eleven lines above cites the `ufc_fmv_stale_hours` cry-wolf as
the lesson being honoured** ("an arm that is permanently red is its own kind of useless"), while the
metric it ships has exactly that failure mode. **Citing the rule is not applying it.**

## 4. `ok = false` on 100% of runs — related, weaker, deliberately not bundled

`ok := NOT v_truncated`, and truncation fires whenever the soft deadline hits. Runs take 10.0–14.3 s
and complete 2–4 of a 4–14 wallet queue, so it truncates every time. **That is mostly the 20-hour
slowdown** (see the 23:15Z filing) meeting a tight `p_max_seconds`, not a defect in this procedure — a
partial sweep genuinely IS partial. But 14/14 red makes the flag useless as a signal, so if §5 is
actioned, decide `ok`'s meaning at the same time rather than separately.

## 5. Fix — specified, not applied

Scope the metric to the population the queue reads, so it measures what the sweep can act on:

```sql
SELECT ROUND(EXTRACT(epoch FROM (now() - MIN(sw.cache_updated_at))) / 3600.0, 1)
  INTO v_oldest_h
  FROM public.saved_wallets sw
 WHERE sw.wallet_addr IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.wallet_moments_cache w
                WHERE w.wallet_address = sw.wallet_addr
                  AND w.collection_id  = sw.collection_id);
```

…and rewrite the §3 assertion to pin the PROPERTY: insert a saved_wallets row with no `wmc` presence and
an ancient `cache_updated_at`, then assert `oldest_cache_h` **ignores it**. That test reds against
today's definition, which is the point.

⛔ **Why not applied now.** It needs `apply_migration`, which costs a **~10–20 s burst of user-facing
`PGRST002` 500s** (schema-cache re-introspection), and it is currently **01:30Z — inside the measured
20-hour degraded band**, on a site already timing out. Spending a live-site burst during the bad window
to correct a number **nothing automated reads** is the wrong trade. **Batch it into the 20:00–00:00Z
window** with the other pending migrations (the `refresh_wmc_fmv_changed` CTE rewrite in the 00:10Z
filing is a natural pair). Nothing degrades further by waiting — the metric is wrong at a constant rate.

---

## 6. ⭐ RE-MEASURED 2026-08-27 ~08:55 PT (15:55Z) — mechanism confirmed six days on, the missing contrast number, and it caught a SECOND reader

**Nothing new is claimed and nothing is re-filed.** This appends three things the original could not have:
a dated re-measurement, the number this metric *should* be reporting, and a fresh instance of it
misleading someone — me.

### The mechanism is confirmed, exactly as predicted

| | 2026-08-21 filing | 2026-08-27 re-read | predicted |
|---|---|---|---|
| `oldest_cache_h` | ~308 | **442.9** | +1.0/hour, never falls |

**308 → 442.9 across 5.6 days is +1.00/hour to two decimals.** The 21 rows are still frozen at the same
2026-08-09 bulk-write instant, still `cached_moment_count = 0`, still holding zero `wmc` rows. §1's
"the 308h age is intentional" holds without amendment.

### ⭐ The contrast number, which the original filing did not state

Computed with the **queue's own predicate** (`EXISTS` applied BEFORE the `GROUP BY`, i.e. exactly what
`v_pairs` selects):

| | |
|---|---|
| pairs with `wmc` rows | 21 |
| **eligible right now** | **15** — matches the `wallets_total` the sweep reports |
| **oldest ELIGIBLE staleness** | **15.1 h** |
| average | 10.0 h |
| **eligible over 7 days** | **0** |
| **reported `oldest_cache_h`** | **442.9 h** |

⭐ **So the metric overstates the thing it is named for by ~29×, and the sweep is very nearly keeping
up** — 15.1 h against a 6 h target, with nothing starved. **That is the sentence the original filing was
missing:** it proved the number is meaningless, but not that the underlying health is FINE. Both halves
matter, because "the metric is broken" and "the sweep is behind" would need opposite responses.

### ⚠ It caught a second reader, and the near-miss is the reusable part

The original says the figure *"misled me for six queries this evening"*. **It did the same to me, worse.**
Re-deriving staleness I aggregated per **wallet** with `bool_or(has_moments)` instead of filtering rows
by `EXISTS` before grouping — mixing the frozen zero-rows back into the population — and got **"11 of 21
eligible wallets over 7 days stale, oldest 442.9 h"**. On that basis I was one step from filing a
**user-facing alarm** (these columns back the dashboard, `/profile` and `/share` cards). The true figure
is **zero over 7 days**.

⭐ **The rule that would have prevented it, and it is already in this repo: never pair a count from one
population with a property sampled from another.** `bool_or` at the wallet level and `EXISTS` at the row
level are *different populations*, and the difference is invisible in the output — both produce a tidy
per-wallet age. **The only safe way to re-derive a queue's health is to copy the queue's predicate
verbatim, including WHERE the filter sits relative to the GROUP BY.**

### The §5 blocker was re-read rather than inherited — and it still stands

§5 defers the fix because `apply_migration` costs a **~10–20 s burst of user-facing `PGRST002` 500s** and
says to batch it into the 20:00–00:00Z window. ✅ **Re-derived, not assumed** (this repo's rule that a
recorded decision NOT to act is the one nobody re-checks). It holds, and today more strongly: it is
**08:55 PT — daytime**, and **three `apply_migration` bursts have already been spent today** (06:24Z,
15:17Z, 15:21Z). Spending a fourth on a number with **no runtime consumer** is exactly the trade §5
rejects. ⭐ **The fix in §5 is still correct as written and still cheap** — one `EXISTS` clause plus the
property-pinning test. **It should ride along with the next migration that has its own reason to run.**
