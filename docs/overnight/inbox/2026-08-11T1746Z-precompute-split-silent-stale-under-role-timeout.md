# Inbox — 2026-08-11T17:46Z (10:46 PDT Aug 11) — Claude Code (interactive, read-only DB)

## Finding — the per-leg precompute split can lose a late leg SILENTLY (not as a loud 999) under a saturated tick, because `cron_heavy`'s role `statement_timeout=600s` caps the whole `CALL` cumulatively

**New signal the 03:19Z daytime monitor could not have (it ran before the tick).** Candidate 1 of `inbox/2026-08-11T0319Z-daytime-monitor.md` asked only "confirm the 06:58Z scheduled tick succeeds." It did (233.3s). But the **12:58Z tick FAILED**, and the failure exposes a gap in the split's design intent.

### Evidence (all read-only, `cron.job_run_details` + `rpc_trust_health_precompute` + `pg_roles`)

- **pg_cron jobid 287** (`rpc-trust-health-precompute-refresh`, `58 */6`, owned by `cron_heavy`, cmd `CALL public.rpc_trust_health_precompute_refresh_p()`):
  - `00:58Z` failed — `permission denied for procedure …_p` (the split-cutover grant gap; since fixed, verified 03:45Z).
  - `06:58Z` **succeeded**, 233.3s.
  - `12:58Z` **FAILED at exactly 600.0s** — `canceling statement due to statement timeout`.
- Post-12:58Z table state: `rpc_trust_health_precompute` has rows from **BOTH `06:59` and `12:59`** (n=19), **`value=999` count = 0**, `trust_precompute_max_age_hours` = **10.99 (ok, breach 13)**.
- `pg_roles`: **`cron_heavy` `statement_timeout = 600s`** (role-level); `postgres` null; `service_role` 30s.

### Interpretation

1. **The per-leg COMMIT split is working as far as damage-containment goes** — the legs that finished before the cap COMMITted and their rows are fresh (`12:59`); only the later leg(s) stayed at `06:59`. No wholesale rollback. Good.
2. **But the killed leg did NOT write a 999** (sentinel count 0). Its row is **silently stale**, not loudly `999`. That contradicts the split's stated promise ("a saturated-tick kill loses ONE leg — a loud 999 for its own arm").
3. **Root cause:** the whole `CALL` runs under `cron_heavy`'s **role-level `statement_timeout=600s`**, which (per the already-documented "`statement_timeout` does NOT re-arm per `COMMIT`" finding in CLAUDE.md's 2026-08-10 split entry) counts **cumulatively across all legs**. Under the extreme 12:58Z saturation the cumulative leg time hit 600s and the cap cancelled whatever leg was running **from outside that leg's own `EXCEPTION` block** — so the leg's `EXCEPTION→999` handler never ran. The per-leg `SET statement_timeout` budgets (e.g. impossible_parallel 480s) only fire when a *single* leg exceeds its *own* budget; they don't help when the *cumulative* 600s cap fires mid-leg.

### Why it matters (and why it's low urgency, not zero)

- **Not user-facing right now:** max precompute age 10.99h < 13h breach, and `v_rpc_trust_health` only maps a precompute row to 999 at >24h. So the silently-stale leg is currently invisible rather than harmful.
- **The risk is a silently-stale arm, not data loss.** If a specific arm's leg is consistently the one killed by the cumulative cap (the cheapest-first order puts `impossible_parallel` last, so it's the most likely victim), that arm could sit stale across multiple saturated ticks while the board reads "ok" — the exact "an instrument goes quietly blind" class the split was meant to prevent. Worth closing before it bites.

### Suggested fix direction (for the owning session / night pass — NOT auto-applied here)

The orchestrator should not be subject to a *cumulative* 600s cap; each leg should get its own budget. Options to evaluate (all touch the sentinel-critical precompute, so they belong to whoever owns the split):

1. **Make the orchestrator lift the cumulative cap for its own run** — e.g. `SET statement_timeout = 0` (or a generous ceiling) as the orchestrator procedure's first statement, so the ONLY effective bounds are the per-leg `SET` clauses. (The procedure already can't carry a `SET` *clause* — this is a runtime `SET` statement inside the body, before the first `PERFORM`.) This makes a leg-budget breach the ONLY way a leg dies → its `EXCEPTION→999` always fires.
2. **Or** confirm `Σ(per-leg budgets)` stays < 600s even under worst-case saturation — but the 12:58Z data shows it does NOT (the run reached 600s), so option 1 is the real fix.
3. Either way, add a leg that, on `statement_timeout` cancellation, still records a 999 for the arm that was mid-flight — so a cumulative-cap kill is never silent.

⚠ **Do NOT just raise `cron_heavy`'s role `statement_timeout`** — it protects every other `cron_heavy` job from runaways; widening it globally to paper over this is the wrong lever.

### Verify-after

- Next scheduled tick `18:58Z 08-11`; then `SELECT status, start_time, round(extract(epoch from (end_time-start_time))::numeric,1) FROM cron.job_run_details WHERE jobid=287 ORDER BY start_time DESC LIMIT 3;`
- After any fix, force a run under load and confirm `SELECT count(*) FROM rpc_trust_health_precompute WHERE value=999` reflects the RIGHT arm (loud), not a stale row.

*(Filed read-only; no grants, DDL, or cron touched. The 03:45Z grant-chain verification in the 0319Z monitor file remains correct — this is a distinct issue one layer down.)*
