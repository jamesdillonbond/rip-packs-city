# Candidate: `_rpc_waste_baseline_20260825` is ANON-READABLE and is what is reddening the smoke test right now

**Source:** found 2026-08-26 06:35Z (23:35 PT 08-25) by Claude Code autonomous, while checking whether tonight's own deploys had caused runtime errors — it surfaced in the project-wide Vercel error control, not by looking for it. Read-only throughout. Risk: **NOT ACTED ON — see the decision below.**

## The finding

`/api/smoke-test` is logging a HARD FAILURE, most recently **2026-08-26T06:32:45Z**:

```
SMOKE-TEST HARD FAILURES: [
  { "endpoint": "rpc:check_public_security_invariants",
    "error": "1 violation(s): rls_off_base_table:_rpc_waste_baseline_20260825" }
]
```

Measured directly against `pg_class` / `pg_policies`:

| property | value |
|---|---|
| `relrowsecurity` | **false** |
| policies | **0** |
| `has_table_privilege('anon', …, 'SELECT')` | 🚨 **true** |
| `has_table_privilege('authenticated', …)` | true |
| owner / size / rows | `postgres` · 16 kB · **11 rows** |

**It is in `public` with an `anon` SELECT grant, so it is queryable over the internet at `/rest/v1/_rpc_waste_baseline_20260825`.**

## Sensitivity — deliberately checked before deciding, and it is LOW

Columns: `captured_at, label, calls, rows_, total_exec_ms, blks_hit, blks_read, blks_dirtied, wal_bytes, n_tup_ins, n_tup_upd`. **Internal `pg_stat_statements`-style performance counters. No user data, no PII, no secrets, no addresses.** The practical disclosure is "which internal workloads cost what".

## ⛔ DELIBERATELY NOT FIXED, and the reasons are measured rather than asserted

The one-statement fix is `ALTER TABLE public._rpc_waste_baseline_20260825 ENABLE ROW LEVEL SECURITY;` — non-destructive and reversible (`postgres` and `service_role` **BYPASSRLS**, so the owning session keeps full access; only `anon`/`authenticated` lose it). I did not run it:

1. 🚨 **It is another session's IN-FLIGHT artifact.** The name stamps it **20260825** — created today — and it holds 11 captured snapshots of an "rpc waste baseline". A concurrent session was actively doing waste/cost analysis tonight. **Dropping it destroys their working data; altering it out-of-band diverges the object from any migration they are about to commit** (`apply_migration` bypasses the repo unless the repo file is written in the same turn).
2. ⚠ **There is an ACTIVE SATURATION SPELL, measured not assumed:** `io_wait 17 / active 24 / 48 total` at 06:35Z (~71 % of active sessions in IO wait), alongside 37 Vercel error groups whose newest timestamps are minutes old and are almost entirely `canceling statement due to statement timeout`. **Any DDL triggers a ~10–20 s user-facing `PGRST002` burst** from PostgREST schema-cache re-introspection — the worst possible moment to add one.
3. ✅ **The exposure is genuinely low-harm** (see above), so it does not outweigh 1 and 2 overnight.

## What the morning should decide

- **If the baseline is still needed:** `ENABLE ROW LEVEL SECURITY` (no policies) in a quiet window — invariant restored, owning session unaffected.
- **If it is finished with:** `DROP TABLE` — **owner's call, not a sweeper's.**
- Either way, ⚠ **re-stat the object immediately before acting** — a live writer can rename or replace it between the read and the write.

⭐ **The reusable half:** this was found by a **positive control**, not by a security sweep. Checking "did MY deploys break anything" required querying project-wide runtime errors to prove the instrument was not simply quiet — and the answer to the control question contained a finding nobody was looking for. **A null result's positive control is worth reading, not just passing.**

⚠ **Also visible in that same control and NOT investigated here:** a broad, live saturation spell — `/[collection]/pack/dist/[distId]` alone shows ~7 distinct `read exceeded 5000ms` groups, and `refresh-insights-cache` shows 8 candy-MLB board timeouts. Symptom only; the known IO-bound root-cause class, deliberately not re-opened at 06:35Z.

⚠ **TIMESTAMP CORRECTED.** This filing first said **06:50Z**, which I ESTIMATED from elapsed time rather than reading a clock. The git commit is `23:36:51 -0700` = **06:36:51 UTC**, and the `io_wait` sample was taken ~2 minutes before that, so the measured time is **06:35Z**. Corrected throughout. ⓘ **The FILENAME still reads `0650Z` and is deliberately left alone** — it is an identifier cited by the ledger and `INDEX.md`, and the inbox guard keys on that exact link target; renaming it to fix a 15-minute stamp would break citations for no measurement gain. ⭐ The repo's rule is to read the zone before converting; the failure mode here was subtler — I converted correctly at 06:30Z and then **assumed the elapsed time since**, which is the same error one step later.

**Risk read:** none from this filing — read-only. The action is one statement, in a quiet window, by whoever owns the table.
