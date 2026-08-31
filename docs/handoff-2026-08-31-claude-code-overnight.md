# Handoff — Claude Code overnight pass, 2026-08-30 evening → 2026-08-31 08:05 PT

**Session closed at `main` tip with a clean tree, CI green, and nothing uncommitted.**
Everything below is in the ledger in full; this is the map, not the record.

---

## Shipped to `main`

| what | where | verified |
|---|---|---|
| **`refresh_mv_pack_ev_latest` pin repointed** + a new §1c pinning the watermark gate's own contract | `supabase/tests/mv_refresh_wrappers.sql`, `__tests__/db-invariants-drift-guard.test.ts` | `db:pins:check` 188/1-stale → **189/189**; `DB invariants (SQL)` CI green (first real execution) |
| **`supabase/analysis/cron-waste-triage.sql`** — known-issues #42's named remaining action, 5 verdicts + a second arm for `job startup timeout` | new dir | ran verbatim; corrected #42 in both directions |
| **`OFFSET 0` fence on `refresh_unmapped_backlog_growth`** (jobid 261) | migrations `20260831132548` + `20260831133323` | function-level **1,550 ms → 560 ms**; equivalence proven both directions |
| **`DEPLOY_DEFERRED`** third deploy state in the drift report | `scripts/check-edge-fn-drift.mjs` | 45/45 tests, mutation-tested; CI render shows **18 SAFE + 1 DEFERRED + 6 DO-NOT-REDEPLOY = 25** |
| **Recovered fileless migration** `idx_wmc_metadata_fillable` | migration `20260831111157` | md5 `346faa…` + length 4,664 **identical to prod**; `Migration parity` red → **green** |
| **Doc corrections** — accuracy-gate denominator, pack-EV gate sizing, known-issues **#25** now ACTIVE | `roadmap-status.md`, `known-issues.md`, ledger | — |

Also committed **three no-push sessions' artifacts** on their behalf (nightly handoff, weekly health report, daytime-monitor filing) with corrections appended in-file.

---

## 🚨 Needs Trevor — three, in priority order

1. **`Pipeline Sentinel` is CRITICAL and cannot clear by engineering work.** The Detector Health arm
   went live 2026-08-30 (someone set `GITHUB_ACTIONS_READ_TOKEN` between 17:42Z and 19:54Z) and its
   first real reading was `edge-fn-drift` at a 12× streak. **The arm is working as designed** — #25
   commissioned it to page on a correct-and-unread red. But **6 of the 25 drifted edge functions must
   NOT be redeployed** (unset `*_GATE_KEY` → gate fails closed, the 08-11 outage mechanism), so the
   streak can never reach zero, and a permanently-red top alarm masks every other arm.
   👉 **Fix: an ACK with `reason` + `expires_at`** on `sentinel_threshold_config`, mirroring
   `pipeline_alert_suppression` — two nullable columns + a small route change. **Specified, not built.**
   ⛔ **Not `crit_at`, and not `enabled=false`** (a permanent silencer with no reason and no expiry;
   measured — nothing uses it today). **The decision to ack this red is yours; building the mechanism is not.**
   → known-issues **#25**, inbox `2026-08-31T0700Z`.
2. **`mv_pack_ev_latest` rewrite** — equivalence-proven, **17.2× fewer buffers**, but it is a
   `DROP … CASCADE` over two views, one carrying `security_invoker=on` with deliberately asymmetric
   ACLs. Same class as the 211/237 index calls you made. Full one-transaction recipe + revert in
   inbox `2026-08-31T0545Z`.
3. **`compute_pack_ev_per_edition_weighted`'s `fmv_current` leg** — unchanged blocker (off-limits
   lane), now with a price tag: **1,806 wasted s/day** on jobid 71, a job that **cannot be retired**
   because it is the sole feeder for 89 of 598 packs. → inbox `2026-08-31T0620Z`.

---

## Open, not blocked

- **Four cron jobs genuinely fit the `SET statement_timeout` prefix fix** — 261 (already fenced), 78,
  11, 87, all `prokind='f'`. Follow #42's order: *can it complete at all* → then the one-liner → then
  watch `wasted_s`. ⛔ **259 is a PROCEDURE and must NOT get the prefix** (`2D000`); its lever is its
  bounded arguments. → inbox `2026-08-31T1425Z`.
- **jobid 261's fence needs a bad IO band to confirm.** Two post-fix ticks: 3.01 s (a re-planning tick
  — `CREATE OR REPLACE` invalidates cached plans) then **0.97 s**, below the entire pre-fix range. The
  claim was always about the cold tail; watch the 120 s kill population over a week.
- **The Studio-client migration is still open and still sized against a dead host.** The Top Shot
  legacy endpoint is **still 530** (4/4 probes, positive control 200) — the FMV rebound was
  sales-driven. All 7 suppressions to 2026-09-13 remain correct.

---

## ⚠ Three of my own claims I retracted — read these before trusting the rest

1. **The sentinel arm does NOT confuse "found something" with "could not run".** I diagnosed it from
   behaviour; #25 says plainly it was built to page on a correct-and-unread red. My proposed fix was
   also wrong and did not generalise (1 of 3 watched workflows uploads the artifact I keyed on).
2. **The `OFFSET 0` fence is 2.8×, not ~7×.** I sized it from an inline `EXPLAIN` that describes a plan
   the *function* does not use — the tell was in `cron.job_run_details` all along (~2 s ticks, not ~10 s).
3. **The pg_cron 120 s finding is a REDISCOVERY**, shipped 2026-08-10 (migration `20260810040308`,
   8 jobs), and its recommendation was wrong for jobid 259.

⭐ **The common shape, now in memory:** *diagnosing a mechanism from its BEHAVIOUR without reading the
record that already described it.* Reasoning carefully about the thing in front of you produces a
confident, coherent, wrong answer — and the coherence is what stops you looking. **Two cheap greps
before publishing:** the entry that COMMISSIONED an instrument, and `grep -ril` over `memory/` **and**
`supabase/migrations/`.

---

## State at close

`db:pins:check` **189/189 clean** · `Migration parity` **green** · full suite **1417/1417, 15,624
passed** · production **94/94 rendered-DOM** (smoke 78 incl. the React #418 detector, entity 8,
mobile-layout 8) · DB idle at close.
⚠ `Pipeline Sentinel` remains **CRITICAL by design** — item 1 above.
