# 🚨 I shipped a guard a concurrent session had explicitly argued against — and the argument was circular, but I did not know it existed

**Filed 2026-08-26 (PT) / 2026-08-27 03:40Z by Claude (Cowork cloud).**
**Read the process failure first; the technical answer is the easy half.**

---

## 1. What happened, in order

`beafd66` (upstream, pushed while this session was working) is a self-correction titled
*"'four unguarded writers' is one, and I propagated the premise."* On `upsert_pack_ask_state`
specifically it concluded:

> *"`upsert_pack_ask_state` has no WHERE but sets `last_checked_at = v_now`, a per-call
> heartbeat, so the row genuinely changes every call and no predicate can skip it. …
> gating the heartbeat would delete the signal that shows the ask feed was polled at all."*

**I then shipped exactly that gate to production**, verified it, and wrote a ledger entry for
it — all without having read `beafd66`, which had landed on `origin/main` in the interval.

⛔ **That is the failure, and it is mine regardless of who is right about the SQL.** The rule
this repo already has — *a filed finding is a hypothesis* — has a sibling it did not have:
**before shipping against an existing writer, re-read what the repo has most recently RECORDED
about that writer, not only what it currently DOES.** A `git fetch` is not a substitute for
reading the commits it brought.

---

## 2. ⭐ The technical answer: the objection is circular, and its specific harm is measurably absent

I have to state this carefully, because "I checked and I'm right" is exactly what someone who
shipped past a review would say. So: the argument, then the falsifiable claims, then the numbers.

### 2a. *"The row genuinely changes every call"* is a tautology, not an argument

The row changes every call **because the function writes a fresh timestamp every call**. That is
true of **any** unconditional write — it cannot distinguish a heartbeat worth paying for from a
no-op rewrite, because the write is being offered as its own justification. ⭐ **The test that
does discriminate is not "does the row change" but "does anything READ it."**

### 2b. Nothing reads it. Measured, not assumed.

| instrument | result |
|---|---|
| `pg_proc` — any other function whose body mentions `last_checked_at` | **0** |
| `pg_views` / matviews whose definition mentions it | **0** |
| repo grep across `app/ lib/ scripts/ components/ supabase/functions/` | **0** (the single hit is `ingest-topshot-atlas-pool` writing a *different table's* column) |
| migrations mentioning it | 1 — the one that created it |

**`pack_ask_state.last_checked_at` has no consumer anywhere in the system.** It was costing
~385 MB of WAL a day and 16.7M row versions to maintain a value that is never read.

### 2c. The signal the objection wanted to protect exists, is per-tick, and is strictly better

*"the signal that shows the ask feed was polled at all"* is a real thing to want. It is already
recorded, in the table built for it:

- **`snapshot-pack-asks-heartbeat` — 278 runs / 278 ok in the last 24 h**, one row per tick.
- **`snapshot-pack-asks` — 277 runs / 277 ok**, and its `extra.per_collection` carries, *per
  collection per tick*, `total_listed`, `new`, `changed`, `dropped` and the RPC's own `at`
  timestamp.

So a poll leaves a durable, queryable, per-collection record whether or not any row changed.
**`last_checked_at` was the weaker copy of a signal that already existed** — and unlike
`pipeline_runs`, it could not distinguish "polled and nothing changed" from "polled and 2,981
things changed", because it wrote the same value in both cases.

### 2d. The one case the objection is actually about is still covered

A row that **stops appearing in the feed** is the case where "was this dist polled?" genuinely
matters. That row does **not** go silent: the delist arm

```sql
UPDATE public.pack_ask_state s SET is_listed = false, last_checked_at = v_now
WHERE s.collection_slug = ... AND s.is_listed = true
  AND NOT EXISTS (SELECT 1 FROM _fresh f WHERE f.dist_id = s.dist_id);
```

is **outside** the guard and still stamps `last_checked_at`. The only rows whose timestamp now
freezes are rows that were present and unchanged — precisely the case `pipeline_runs` answers.

### 2e. And the shipped change was proven equivalent over the population

Both bodies were generated from `pg_get_functiondef()`, applied to two full 3,025-row copies, and
symmetric-diffed: **0 rows only-in-OLD, 0 rows only-in-NEW**, excluding `last_checked_at` itself.
Live after deploy: `found = 2,981` both sweeps, `ok = true`, `is_listed` unchanged at **2,981**,
`n_tup_upd` **5 rows** where the same two ticks previously moved **5,962**.

---

## 3. 👉 What I am asking for, and the revert is one statement

**I am not asking for the objection to be overruled by assertion.** Everything above is a
falsifiable claim about the live system; if any of it is wrong the change should go.

⭐ **Falsifier, stated plainly: name one reader of `pack_ask_state.last_checked_at`.** One
function, view, route, script, or dashboard. If one exists, the guard is wrong and should be
reverted immediately, because the meaning of that column has changed from *last checked* to
*last changed* and any reader is now silently wrong.

**Revert:** `CREATE OR REPLACE` the prior body from migration history — drop the three-line
`WHERE` and the `COMMENT ON COLUMN`. One statement, no data migration, no rebuild; the column's
values become correct-by-definition again from the next tick.

⛔ **Do not revert it "to be safe" without checking 2b** — reverting restores 385 MB of WAL a day
on an instance whose sole measured constraint is disk IO, to maintain a value with no consumer.
Both mistakes are real; only one of them is cheap.

---

## 4. ⚠ AND THE CHANGE HAS A RESIDUAL I FOUND BY READING THE INSTRUMENT, NOT BY ASSUMING THE WIN

At the **02:58:2xZ tick, all 2,981 listed rows in BOTH collections were rewritten anyway**, while
the RPC reported `new: 0, changed: 0, dropped: 0` for each. Those three zeros exclude two of the
three guard arms by construction, so **the `pack_listing_id` arm fired for every row at once**.
Corroborated on the rows themselves: `ask_changed_at` values of 2026-08-21, 2026-08-14 and
2026-06-21 — no price moved. The 15 surrounding ticks each rewrote **0–3 rows**, so this is
periodic, not the steady state; the 99.92% cut is real and this rides on top of it.

⛔ **Two hypotheses fit equally well and I am not guessing between them.** Either the upstream
rotates listing ids in bulk (one rewrite per rotation, and the rewrite is *correct work*), or one
tick's feed omits `pack_listing_id` and `NULLIF(...,'')` writes NULLs that the next tick writes
back — **two** rewrites per occurrence, and a transiently-NULL id in a column other code reads.

✅ **An instrument is armed rather than a fix shipped:** `audit_20260827_pack_listing_id_churn`
(RLS on, anon revoked, 2,981-row baseline at 03:31:07Z, second snapshot 03:36:17Z) captures
`(dist_id, pack_listing_id)` across successive ticks. **Discriminator: if the mass event coincides
with ids that are NULL in one snapshot and restored in the next, it is the flip-flop and the fix
is to skip the arm when the incoming id is NULL. If the ids are all non-NULL and simply different,
it is a genuine rotation and the rewrite is work, not waste.**

✅ **AND THE INSTRUMENT IS NOW SELF-SAMPLING, so nobody has to sit and watch for it.** The mass event
has not recurred in the ~55 minutes since (ticks rewrite **1–3 rows**), so its period is longer than
a single watch and manual polling would have missed it. Armed instead — all via `execute_sql`, so
**no migration-parity debt** (CLAUDE.md's scratch-DDL rule):

- **`audit_20260827_pack_ask_rewrite_rate`** — pg_cron **jobid 370**
  (`rpc-audit-pack-ask-rewrite-rate`, `*/5 * * * *`, owned by `postgres`) writes **ONE row per tick**
  recording how many rows the last sweep actually rewrote. ⭐ **Cheap by construction: 1 row a tick,
  not 2,981 — an instrument for a write-amplification problem must not be a write-amplification
  problem.** 288 rows/day.
- **On a mass tick (`> 100`) it ALSO snapshots the ids** into `audit_20260827_pack_listing_id_churn`.
  The five manual baselines already captured (03:31 / 03:36 / 03:42 / 03:47 / 03:52Z, **2,981 rows
  each, zero NULL ids**) are the **BEFORE** side, so the comparison is complete the moment the event
  fires.
- **It self-unschedules after 2026-08-29** rather than becoming permanent furniture, and
  `check_secdef_anon_execute_violations()` returns `[]` with the function revoked from
  `public`/`anon`/`authenticated`.

**Cleanup when answered:** `SELECT cron.unschedule('rpc-audit-pack-ask-rewrite-rate');` then
`DROP FUNCTION public.audit_20260827_sample_pack_ask_rewrite_rate();` and `DROP TABLE` both audit
tables.

⛔ **Do not "fix" this by dropping `pack_listing_id` from the guard.** That column is written to
state other code reads; a guard that ignores a column it writes is the original bug in the other
direction. `DROP TABLE public.audit_20260827_pack_listing_id_churn` once the question is settled.

---

## 5. ⭐ The durable lessons, both of them

1. **Before shipping against an existing writer, read what the repo most recently RECORDED about
   it — not just what it currently does.** Two sessions on one tree can each be individually
   careful and still collide, and the cheap check is reading the commits a fetch just brought.
2. **"The row genuinely changes every call" is never evidence that a write is worth keeping** —
   it is a restatement of the write. The discriminating question is *who reads it*, and it takes
   four queries to answer.
