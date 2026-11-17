# The four change-detection-less writers, measured — **1.9 GB of WAL a day**, and only ONE of them is pinned (the handoff said two)

**Filed 2026-08-26 (PT) by Claude Code.** Completes the measurement half of the
2026-08-25 handoff's §7 item. ⭐ **The pin-status claim in that handoff is wrong, and it
is wrong in the direction that makes this cheaper than it looked.**

---

## The four, identified by SIGNATURE rather than by name-guess

Each was matched to its `pg_stat_statements` row through its argument list, because the
PostgREST rows show only `pgrst_source … json_to_record(…)` and the parameter names are
the only discriminator:

| function | signature | WAL/day | blocks dirtied/day | calls |
|---|---|---:|---:|---:|
| `roll_pack_ask_hourly_low` | `()` | **726.3 MB** | **304,851** | 1,344 |
| `apply_sales_counterparty` | `(p_rows jsonb)` | **530.5 MB** | 180,192 | 4,060 |
| `upsert_pack_ask_state` | `(p_collection_slug text, p_listings jsonb)` | **385.6 MB** | 55,879 | 8,222 |
| `refresh_wmc_fmv_drift_active` | `(p_deviation_pct numeric, p_limit integer)` | **282.2 MB** | 140,701 | 2,376 |
| **total** | | **≈1.92 GB/day** | **681,623** | |

That is **~6.6% of all WAL and ~5.6% of every block the database dirties**, on an instance
whose sole constraint is IO. ⓘ Figures are per-day rates derived from a 14.5-day
`pg_stat_statements` window — a dated sample, re-derive before quoting.

## ⛔ CORRECTION: one is pinned, not two

The handoff records *"Mechanical fixes; two of the four are pinned."* Checked three ways —
a `supabase/tests/<fn>.sql` file, a `PINS` entry in
`__tests__/db-invariants-drift-guard.test.ts`, and a grep for the function name across all
of `supabase/tests/`:

- **`roll_pack_ask_hourly_low` — PINNED** (`supabase/tests/roll_pack_ask_hourly_low.sql`,
  in `PINS`).
- **`apply_sales_counterparty`, `upsert_pack_ask_state`, `refresh_wmc_fmv_drift_active` —
  NOT pinned at all.** No pin file, no `PINS` entry, and no `supabase/tests/` file so much
  as mentions them.

⭐ **This matters practically:** the handoff frames "a pinned SQL function is push-gated"
as the barrier. For three of these four **there is no pin to re-point**, so that barrier
does not exist — and the one that does have it is also the largest (726 MB/day).

## 👉 So what IS the blocker? Not the pin — the ROW_COUNT contract

⚠ **The real gate is the one the handoff identified for the pack-sales case and did not
carry forward to these four**: adding a change-detection predicate means a no-op row is no
longer written, so it **stops being counted**. All three unpinned functions are invoked
through PostgREST as scalar RPCs, i.e. something reads what they return.

- For `roll_pack_ask_hourly_low` the count is explicit: `GET DIAGNOSTICS v_rolled =
  ROW_COUNT` immediately after the `ON CONFLICT`, and `v_rolled` is passed to
  `log_pipeline_run` as **both `p_rows_found` and `p_rows_written`** and returned as
  `rolled`. Guarding the upsert changes that number from *"rows touched"* to *"rows
  changed"* — **arguably more honest, and still a changed recorded metric.**
- ⓘ Its pin's own assertions look survivable on inspection (`rolled = 1` is asserted on a
  fresh INSERT, and the two ratchet assertions test VALUES, not counts) — but that is a
  reading, not a run, and this session already learned what an unrun pin assertion is
  worth.

**The equivalence itself is trivially provable for the biggest one.** The clause is
`DO UPDATE SET low_ask = LEAST(existing, EXCLUDED.low_ask)`, so adding
`WHERE pack_ask_hourly_low.low_ask > EXCLUDED.low_ask` skips exactly the writes that would
have stored the value already there. **`LEAST` cannot change a row the predicate excludes.**

⛔ **Not shipped.** The change is small and the equivalence is sound, but it alters a
recorded pipeline metric on four separate pipelines, and this session has already spent
its budget for "a pin change I could not execute locally." **The right sequencing is: land
it when CI's `db-tests` can be watched, one function at a time, starting with an UNPINNED
one so the first attempt carries no pin risk at all** — `refresh_wmc_fmv_drift_active`
(282 MB/day, no pin) is the natural first, not the biggest.

⚠ **And before any of them: read the caller.** Each of the three unpinned functions is
reached over PostgREST, so the consumer is TypeScript somewhere in `app/` or `lib/`, not a
SQL caller — the six-source rule applies, and a caller asserting on the returned count is
exactly the silent breakage the handoff warned about for the pack-sales writers.

---

# ⛔⛔ CORRECTION, ~20 MINUTES AFTER FILING — "four unguarded writers" is **ONE**, and I propagated the wrong premise

**Appended 2026-08-26 by the same session.** Everything above about **cost** and **pin
status** was measured and stands. **The premise it inherited — that all four carry no
change-detection predicate — is FALSE for two of them and misleading for a third.**

⭐ **I re-derived the figures and the pin status and did NOT re-derive the claim itself.**
That is the exact failure mode this repo names: *a filed FINDING is a hypothesis*. I
treated "these four have no change detection" as the given and measured around it.
**Reading the four function bodies takes five minutes and reverses the conclusion.**

| function | handoff / my filing said | what the body actually contains |
|---|---|---|
| `roll_pack_ask_hourly_low` | no change detection | ✅ **TRUE.** `DO UPDATE SET low_ask = LEAST(existing, EXCLUDED)` with **no `WHERE`**. The one genuine target. |
| `apply_sales_counterparty` | no change detection | ⛔ **FALSE.** Its UPDATE carries `AND (s.seller_address IS NULL OR s.buyer_address IS NULL)` — it touches **only rows missing a counterparty** — and its `ON CONFLICT (sale_id)` is **`DO NOTHING`**. Already guarded, twice. |
| `upsert_pack_ask_state` | no change detection | ⚠ **TRUE, BUT NOT A MECHANICAL FIX.** The `DO UPDATE` has no `WHERE`, but it sets **`last_checked_at = v_now`** — a per-call HEARTBEAT, so the row genuinely changes on every call by the function's own contract. **No `IS DISTINCT FROM` can skip it.** |
| `refresh_wmc_fmv_drift_active` | no change detection | ⛔ **FALSE.** Its UPDATE carries `AND (wmc.fmv_usd IS NULL OR abs(wmc.fmv_usd - p.fmv_usd) > p.fmv_usd * v_frac)` — a **deviation threshold, STRICTER than `IS DISTINCT FROM`**. |

## Why this matters more than a tidy-up

**Two of the three non-targets would have been actively damaged by the "fix".** Adding a
predicate to `apply_sales_counterparty` duplicates a guard that is already there; and
removing or gating `upsert_pack_ask_state`'s `last_checked_at` write would **delete a
liveness signal** — `pack_ask_state.last_checked_at` is how anything knows the ask feed
was polled at all, which is the same class of loss this repo keeps paying for.

⭐ **And their cost is mostly NOT waste.** `apply_sales_counterparty` is a **backfill in
progress**: it is updating `sales` rows that genuinely lack counterparties, so its
530 MB/day is work being done, not work being redone. `refresh_wmc_fmv_drift_active`
likewise updates only rows that have actually drifted past the threshold.

## 👉 The corrected picture

- **One genuine mechanical target:** `roll_pack_ask_hourly_low`, **726.3 MB WAL/day and
  304,851 blocks dirtied/day**. The fix is one clause —
  `WHERE pack_ask_hourly_low.low_ask > EXCLUDED.low_ask` — and it is provably equivalent
  because `LEAST` cannot change a row that predicate excludes. It is also **the pinned
  one**, so it needs the pin re-pointed and CI watched.
- **One design question:** is a per-call `last_checked_at` heartbeat worth **385 MB of WAL
  a day to maintain a 4 MB table**? That is the "worst ratio on the instance" from the
  handoff, and the answer is not a predicate — it is whether the heartbeat should be
  written on every poll, or only on change plus a periodic keepalive.
- **Two closed:** already guarded; **do not re-open them.**

⚠ **So the honest total is ~726 MB/day of addressable WAL, not the ~1.92 GB/day this
filing led with.** The 1.92 GB figure is correct as a measurement of what those four
statements write; it is wrong as an estimate of what could be saved.

---

## ✅ SHIPPED 2026-08-26 ~20:00 PT (2026-08-27 03:00Z) — the design question above is ANSWERED BY MEASUREMENT, and `upsert_pack_ask_state` is now change-detected

This filing closed with a design question rather than a fix, and it was the right call to
leave it open:

> *"is a per-call `last_checked_at` heartbeat worth 385 MB of WAL a day to maintain a 4 MB
> table? … the answer is not a predicate — it is whether the heartbeat should be written on
> every poll, or only on change plus a periodic keepalive."*

**The answer is: not on every poll — because the poll is already recorded elsewhere and
nothing reads the per-row copy.**

### ⛔ The one factual claim that does not survive measurement

> *"removing or gating `upsert_pack_ask_state`'s `last_checked_at` write would delete a
> liveness signal — `pack_ask_state.last_checked_at` is how anything knows the ask feed was
> polled at all."*

**Nothing reads it.** Six caller sources swept:

| source | result |
|---|---|
| repo grep (`lib`, `app`, `components`, `scripts`) | **0** |
| `pg_proc.prosrc` | 5 functions touch `pack_ask_state`; **only `upsert_pack_ask_state` itself names the column — it is the writer** |
| views / matviews | 3 read the table (`v_topshot_atlas_pool_targets`, `pack_table_rows`, `pack_ev_latest`); **none read the column** |
| `cron.job.command` | 0 |
| `pg_trigger` | 0 |
| indexes on `pack_ask_state` | 2 (`pack_ask_state_pkey`, `idx_pack_ask_state_listed_recency`); **neither on it** |

⚠ **The seventh source — a Cowork artifact — was NOT swept and cannot be from SQL.** That
residual is exactly why the column was **kept and COMMENTed rather than dropped.**

⭐ **And the liveness answer never depended on it:** `snapshot-pack-asks` writes a
`pipeline_runs` row on **every** tick — **277 in the last 24 h**, plus 278 heartbeat rows.
"Was the ask feed polled?" was already answerable there, at **one row per tick instead of
2,981**. The per-row stamp was a duplicate of that answer maintained at ~3,000× the cost.

⭐ **The transferable half: "this column is a liveness signal" is a claim about READERS, and
it is cheap to check.** Both this filing and I reached for the same instinct — that gating a
`*_checked_at` write destroys freshness — and it is a good instinct that happened to be
false here. The discriminator is not the column's name; it is whether anything consumes it.

### What shipped

One `WHERE` clause on the `DO UPDATE`:

```sql
WHERE s.is_listed = false
   OR s.lowest_ask      IS DISTINCT FROM EXCLUDED.lowest_ask
   OR s.pack_listing_id IS DISTINCT FROM EXCLUDED.pack_listing_id
```

⚠ `pack_listing_id` is tested explicitly because it is **not** covered by the ask
comparison — it can change while `lowest_ask` does not. Dropping it from the predicate would
silently stop tracking **relistings at an unchanged price**.

Plus a `COMMENT ON COLUMN` recording that `last_checked_at` now means *last CHANGED*, that it
must not carry a freshness monitor (the `saved_wallets.cache_updated_at` /
`edition_fmv_current.refreshed_at` trap), and where the real answer lives.

### Equivalence, proven over the population rather than argued

Both bodies were generated **mechanically from `pg_get_functiondef()`** — so the OLD one
could not drift by transcription — repointed at two independent copies of the real table
(3,025 rows each) and run on the same 2,000-row payload, mutated to exercise every branch:
bulk unchanged · one changed ask · **one changed `pack_listing_id` AT THE SAME ASK** · one
relist (`is_listed` false → true) · one brand-new dist · one drop by omission.

| | |
|---|---|
| return values | **identical** |
| symmetric diff EXCLUDING `last_checked_at` | **0 only-in-OLD, 0 only-in-NEW** |
| symmetric diff INCLUDING `last_checked_at` | 1,996 of 2,000 rows differ |

### Verified in production, on the pipeline's own telemetry

Two real sweeps after the change: **`found=2981 written=1 ok=true`** and
**`found=2981 written=0 ok=true`**, `is_listed` still **2,981**. `n_tup_upd` on
`pack_ask_state` moved by **5 rows** across both, against **5,962** before.

**A 99.92% cut in row writes, measured in production, with `found` unchanged** — so the
sweep is seeing and doing identical work.

### ⚠ The WAL number is NOT yet a rate, and the residual is real

`shared_blks_dirtied` and `wal_bytes` over the first **4 calls / 9.3 minutes** give
**~172 KB of WAL per call against ~680 KB before** (385.6 MB/day ÷ 567 calls/day) and
**53 dirtied blocks per call against 99**. ⛔ **Do not turn 9 minutes into a daily rate** —
that is the spot-rate-as-a-rate error, and I was the only meaningful load on the instance
while measuring.

⭐ **But the shape of it is a finding: row writes fell 99.9% while WAL per call fell ~75%, so
something else in this function writes.** Leading hypothesis, offered as a hypothesis: the
per-call `DROP TABLE IF EXISTS _fresh` + `CREATE TEMP TABLE _fresh` cycle is catalogue churn
(`pg_class`/`pg_attribute`/`pg_type`) 562 times a day, which is WAL-logged. **The test that
would settle it is a `wal_bytes` comparison of the same body with `_fresh` replaced by a
CTE.** Not done, not claimed.

**Falsifier for the headline, to be RUN over 24 h:** `n_tup_upd` on `pack_ask_state` should
track the real change rate (~97/day + drops/relists), not ~1.68M/day. If `rows_found` on
`snapshot-pack-asks` drops below ~2,981 or `is_listed` falls, the guard is excluding rows it
should not — revert by re-applying the body without the `WHERE`.
