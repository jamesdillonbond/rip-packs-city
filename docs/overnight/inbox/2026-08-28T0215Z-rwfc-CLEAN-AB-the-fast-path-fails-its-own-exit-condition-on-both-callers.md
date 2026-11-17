# 🚨 `refresh_wmc_fmv_changed` — the CLEAN A/B is in, and the fast path **FAILS its own exit condition on both callers**

**Filed 2026-08-27 19:1xZ PT (2026-08-28 02:1xZ) by Claude Code, cloud session (push-capable).**
Closes **open reading #5** from the 2026-08-27 handoff and the ⏳ scheduled re-read the 2026-08-26
ledger entry left for #36. ⛔ **NOT REVERTED — see §5 for the specific reason, which is not caution.**

---

## 1. The reading, taken under both conditions the steer demanded

The steer required a **quiet window ≥24 h after** the `T1_CLEAN` baseline (captured 2026-08-27 02:05Z,
after all index work settled). Both were checked before reading, not assumed:

- **24.13 h** elapsed since the baseline.
- **Instance quiet at read time: 1 active backend, 0 IO waiters.** (It was 34 active / 31 IO waiters
  ninety minutes earlier — reading then would have produced exactly the confound this window exists to
  remove.)

Measured as a **FLOW** — the delta between the `T1_CLEAN` snapshot and now, divided by calls in that
interval — never as a per-call figure off a cumulative stock:

| caller | calls in window | **reads/call** | exit threshold | verdict |
|---|---:|---:|---:|---|
| **pg_cron** | 143 | **87,352** | 74,159 | 🚨 **+17.8 % — FAILS** |
| **PostgREST** | 222 | **10,029** | 7,195 | 🚨 **+39.4 % — FAILS** |

**The stated exit condition is met: *"if reads are still not below the T1 per-call figures
(74,159 / 7,195), the fast path is not paying for itself and should be reverted."***

## 2. ⭐ The control that makes this robust: two windows, one confounded, one clean, AGREE

The 2026-08-26 reading was refused — correctly — because its AFTER period contained a 94 MB index
build, a 120 MB drop, repeated 900k-buffer `EXPLAIN`s and a saturation spell. That refusal was right
discipline. ⭐ **But now that the confound is gone, the numbers barely moved:**

| caller | confounded (n=66/109) | **clean (n=143/222)** | move |
|---|---:|---:|---:|
| pg_cron | 86,533 | **87,352** | +0.9 % |
| PostgREST | 10,472 | **10,029** | −4.2 % |

**If the churn had been driving the result, removing it would have moved the number.** It did not, on
a sample more than twice as large. ⚠ **This does not make the earlier refusal wrong** — that it agrees
was only knowable afterwards, and refusing to claim a direction from a confounded A/B is the rule.
What it does is remove the last reason to doubt the direction.

⚠ **One limitation, stated rather than glossed:** `pg_stat_statements` is cumulative since reset, so I
**cannot date** the index builds from it. My claim that the window is clean rests on the ledger (which
records `T1_CLEAN` as captured after that work settled, and records no index work by any session in
the 24 h since), not on a direct measurement of the window's contents.

## 3. What the fast path actually trades

| metric | pre-fix | clean post-fix | direction |
|---|---:|---:|---|
| reads/call (cron) | 73,704 | **87,352** | 🚨 **+18.5 % worse** |
| dirtied/call (cron) | 36,604 | 36,029 | flat — **as the original filing predicted** |
| **sec/call (cron)** | 297.4 s | **218.5 s** | ✅ **26.5 % faster** |

⭐ **So it is a genuine two-resource trade: ~26 % less wall time for ~18 % more disk reads.** ⛔ **That
does not reopen the decision.** The same ms/call figures were in the 2026-08-26 entry's own table when
its author chose reads as the exit metric, so the trade was already weighed — and CLAUDE.md's standing
finding is that this instance's saturation is **IO-bound, not CPU-bound**, which makes reads the
binding resource. **The exit condition picked the right metric.**

## 4. ✅ Reverting costs no correctness — checked, not assumed

The obvious objection is that the current version carries a *proven* freshness guard (3,439/4,028 fast
path, **0 disagreements**, **28 stale rows correctly rejected**). Read against the migration that
introduced it, that guard is **scaffolding for the optimisation, not an independent improvement**: its
own header states that rows failing it *"fall through to the incumbent subquery and are computed
exactly as before."* The revert target reads `fmv_snapshots` directly and is inherently fresh, so it
needs no guard. **Reverting removes the fast path and its guard together and loses nothing.**

## 5. ⛔ Why I did not execute the pre-authorised revert

**Not caution, and not a judgement that the condition is unmet — it is met.** One specific blocker:

**The revert is a coordinated DB + pinned-file landing that I cannot validate here.**
`refresh_wmc_fmv_changed` is a **registered DB-invariant pin** whose test file carries the function
body **verbatim** (9 `edition_fmv_current` references today). Reverting means `CREATE OR REPLACE` in
production *and* rewriting that pin. ⚠ **`SUPABASE_SERVICE_ROLE_KEY` is absent in this sandbox, so
`npm run db:pins:check` cannot run** — I would be mutating the instance's **single largest writer**
(36.7 % of every block the database dirties) while the pin half stayed unverified until CI saw it,
with `migration-parity` red in between and a 10–20 s burst of user-facing `PGRST002` 500s from the
`apply_migration` itself.

**That is the wrong order of risk on the highest-blast-radius object in the database**, and this repo's
own rule is that one validated push beats three speculative ones.

👉 **For whoever has the key** (Trevor's box, or any session with `SUPABASE_SERVICE_ROLE_KEY`), the
whole operation is specified: `CREATE OR REPLACE` back to
`supabase/migrations/20260822213000_audit_20260822_rwfc_temp_build_materialized_cte.sql`, move
`supabase/tests/refresh_wmc_fmv_changed.sql` + its PINS entry to match, land the migration file in the
**same** push, then confirm `db:pins:check` and `migration-parity`.

## 6. ⏳ And the follow-up the old entry asked for

`public._rpc_waste_baseline_20260825` was retained *"until that decision is made, not before."*
**The reading is now taken and is no longer inconclusive**, so the table's last purpose is served the
moment the revert lands (or is declined on the record). **Drop it then, not now.**

## 7. Revert path

Docs only.
