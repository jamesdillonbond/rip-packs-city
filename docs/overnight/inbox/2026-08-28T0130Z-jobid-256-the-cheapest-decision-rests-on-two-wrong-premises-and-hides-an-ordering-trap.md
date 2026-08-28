# ⚠ jobid 256 — "the cheapest decision on the list" rests on **two wrong premises**, and the drop it proposes hides a **CI-reddening ordering trap**

**Filed 2026-08-27 18:30 PT (2026-08-28 01:30Z) by Claude Code, cloud session (push-capable).**
Re-derives the jobid-256 bullet in
[2026-08-27T0450Z](2026-08-27T0450Z-PROVEN-48-cron-jobs-declare-a-statement-timeout-that-does-nothing.md) §7,
per CLAUDE.md's rule that **a filed FINDING is a hypothesis** — and this one had already corrected
itself once inside twenty minutes, which is the signal to re-measure rather than inherit.

⛔ **NOTHING SHIPPED. No schedule change, no DDL.** This is a measurement and a revised proposal.

---

## 1. ✅ The load-bearing half CONFIRMS — the cache has no consumer

Re-derived independently across the sources CLAUDE.md requires, not read back from the filing:

| source | readers of `fmv_thin_sale_ask_disclosure_cache` |
|---|---|
| `pg_proc.prosrc` | **1** — its own writer, `fmv_thin_sale_ask_disclosure_refresh()` |
| `pg_views.definition` | 0 |
| `pg_matviews.definition` | 0 |
| `cron.job.command` | 0 (beyond jobid 256 calling the writer) |
| `pg_trigger` | 0 |
| full repo grep (`app/ lib/ scripts/ components/`) | **0** |
| grants | `anon` SELECT **false**, `authenticated` SELECT **false**, RLS on |

**220 rows, 176 kB.** So the conclusion stands: **nothing reads it.**

## 2. 🚨 But both of the filing's supporting numbers are WRONG, in opposite directions

| the filing said | measured 2026-08-28 over 30 days |
|---|---|
| *"jobid 256 never succeeded"*, self-corrected to *"it succeeded once, on 08-13"* | **5 succeeded / 17 failed.** The **most recent run SUCCEEDED** — 2026-08-27 09:25Z |
| *"serves 14-day-old rows to anyone who does"* | `max(refreshed_at)` = 2026-08-27 09:25Z — **0.66 days old** |

⭐ **And the success/failure split is itself the interesting number:** successes average **120.3 s**
(max 416 s); failures average **498.1 s** (max **603.5 s**, i.e. the `cron_heavy` 600 s ceiling).
**The same statement either finishes in two minutes or dies at ten.** That is the signature of
focus.md's PRIORITY 3 — the shared disk-IO budget — not of a job that is intrinsically too big.
⛔ So "it can never finish" is **falsified**; it finishes whenever the instance is quiet.

⚠ **This is the third time this bullet's numbers have moved** (never-succeeded → once → 5-of-22).
**Do not quote any of them without re-reading `cron.job_run_details`.**

## 3. 🚨 The proposed drop has a dependency the filing does not name

`public.fmv_thin_sale_ask_disclosure_refresh` is a **registered DB-invariant pin**:

- `supabase/tests/fmv_thin_sale_ask_disclosure_refresh.sql` (carries the function body verbatim), and
- `__tests__/db-invariants-drift-guard.test.ts:1130` registers it, gated by **CI** and the
  **`DB pin staleness`** workflow.

⛔ **So `DROP FUNCTION` while that pin stands reds main** — the exact ordering trap already recorded
in known-issues #0, where the repo half must land **before** the DDL or main is red for the length of
the gap. "The cheapest decision on the list" is a **three-step, two-commit** change, not one
statement.

## 4. ⭐ A strictly cheaper action the filing did not consider

**Unschedule the cron job; leave the function, the table and the pin alone.**

```sql
SELECT cron.unschedule(256);   -- revert: SELECT cron.schedule('rpc-thin-sale-ask-disclosure-refresh', '25 9 * * *', 'SELECT public.fmv_thin_sale_ask_disclosure_refresh()');
```

- Removes **100 %** of the waste (~17 × 500 s ≈ **2.4 h of `cron_heavy` time per 30 days**, all of it
  at the ceiling, in the 09:00Z hour).
- **Keeps CI green** — the pin still has its function, so no ordering dance.
- **One statement to revert**, with no data migration.
- Leaves the 220 rows in place at their current, fresh state rather than deleting them.

⚠ **Its one real cost, stated:** the table then ages silently. The migration's own
`COMMENT ON TABLE` already anticipates exactly this — *"ALWAYS check `refreshed_at` before rendering
— a dead refresher ages this table rather than emptying it"* — so a future consumer that follows the
comment is safe, and one that does not was already unsafe.

## 5. ⛔ Why I did not do it

This cache was **deliberately built** three weeks ago (`20260805053813`, "handoff 2026-08-04
section 3") to materialise a view that costs **28.8 s / 1.26 M buffers** and cannot be filtered
per-edition. **Whether a consumer is still planned is a roadmap question I have no way to read**, and
retiring infrastructure someone built for a feature in flight is Trevor's call, not a sweep's.

⚠ **And the honest reason to surface rather than act is narrower than "it's a decision":** I just
**refuted both premises the original disposition was argued from**. The conclusion may well survive —
the consumer count is zero either way, and the waste is real either way — but acting on a decision
whose stated grounds I had personally just falsified, without surfacing the falsification, is the
same error in the other direction. **The decision should be re-made on §1–§4, not inherited from §7
of the earlier filing.**

## 6. Revert path

Docs only. Nothing to revert.
