# Daytime monitor candidates — 2026-08-31T06:10Z (2026-08-30 23:10 PT, late tick)

Context: NOT in a saturation spell at sweep time (`pg_stat_activity` IO-wait 0, active 0; `rpc_ops_snapshot()` returned fast). Sweep otherwise clean — security invariants/anon-write/RLS/secdef all `[]`; trust health all `ok` except the chronic `unmapped_resolution_backlog_max=275` (known nfl_all_day residual, ~598d to clear, do-NOT-raise-breach_at); `detect_stalled_pipelines()` `[]`; Vercel no ERROR (last READY = c3241997 "arm 2 cron triage"; the two newer commits are docs-only tips, CANCELED as expected); rpc-live-health payload spot-validated and runs clean. Sentry still dark since 08-18 (standing operator blocker, not re-probed).

**Written to mount — push unavailable this session (no `remote.origin.pushurl`; `git push --dry-run` → "could not read Username"). Night pass picks up locally.**

## Candidate 1 (INFO / sensing) — Top Shot legacy-endpoint FMV freshness has RECOVERED; reassess the queued Studio-client migration + compute-topshot-pack-ev un-pause before treating them as still-blocked
- **Source:** `rpc_ops_snapshot()` + direct recency read, 06:06–06:09Z 08-31:
  - `topshot_fmv_stale_hours` = **0.2** (breach_at 6) and `topshot_fmv_pct_stale_30d` = 31.7% — both healthy; these were the metrics aging into STALE all through the outage.
  - Top Shot `max(sold_at)` = **05:52Z** (16 min old), `max(fmv computed_at)` = **06:08Z** (live), and `topshot%` pipelines **77 ok / 1 fail over the last 3h**.
  - `fmv_by_collection` HIGH+MED rebounded vs the night-pass 08:06Z baseline: **nba_top_shot 6983 → 8000** (HIGH 2184 / MED 5816), **nfl_all_day 1279 → 1629** (HIGH 144 / MED 1485). The night pass attributed 100% of the prior decline to the outage; the rebound tracks the same mechanism in reverse.
- **What this changes:** every prior artefact from today and the night pass treated `public-api.nbatopshot.com`'s ~38h+ 530/1033 outage as ONGOING and queued a **Studio-endpoint client migration** (`lib/chains/flow/topshot*.ts`) as the durable fix, plus held **compute-topshot-pack-ev** paused/suppressed to 2026-09-13. Those queued items were sized against an outage that, on these three concordant signals, is no longer suppressing the FMV path. This filing is NEW — it postdates every inbox file, all of which predate the recovery.
- **Risk:** none — sensing only, no state touched.
- **Suggested action (night pass / Trevor — RE-VERIFY, do not conclude from this snapshot):**
  1. Confirm the recovery is durable, not a flicker on a "decommissioning-shaped" host: re-read `topshot_fmv_stale_hours` + `topshot%` ok-rate over a fresh 3–6h window, and establish **whether the FMV path recovered because the legacy host is answering again or because the sweep is now sourced elsewhere (Atlas/Studio)** — inbox `2026-08-30T1610Z-topshot-has-moved-to-atlas-and-atlas-is-reachable-from-the-database.md` is the relevant lead. The distinction decides whether the Studio-migration is still needed.
  2. If durable, **re-read the "blocked" tags** on (a) the Studio-client migration and (b) the compute-topshot-pack-ev un-pause/deploy before inheriting them — per the CLAUDE.md rule "re-read a 'blocked' item's blocker before inheriting it." The pack-EV depletion leg being NULL (`pack_reality_top_ev` board still reads 0 rows, already filed 2026-08-30T2115Z) is a **separate** blocker from the outage and does **not** auto-clear with freshness — keep the two apart.
- **Explicitly NOT concluded here:** that the legacy host is permanently back, that the Studio-migration is now unnecessary, or that pack-EV can un-pause. Those are re-measures + a Trevor product/IO (R46) decision, not readings this tick can make.

---

## ✅ ANSWERED — 2026-08-31 ~02:55 PT (09:55Z), Claude Code overnight pass

**Candidate 1's step 1 asked the deciding question: did the FMV path recover because the legacy host
is answering again, or because it is sourced elsewhere?** Measured, not inferred:

| probe | result |
|---|---|
| `POST https://public-api.nbatopshot.com/graphql` from **this box (residential egress)** | 🚨 **HTTP 530**, still dead |
| `compute-topshot-pack-ev` in `pipeline_runs` | **last tick 2026-08-30 03:37Z — 30.3 h ago, 0 runs in 24 h** |
| `pipeline_alert_suppression` for the dead-host cohort | **7 pipelines** still suppressed to **2026-09-13** |

⭐ **So the answer is "sourced elsewhere", and the queued items do NOT auto-clear.** The legacy host
is still 530 — and this probe is from the **residential** egress, i.e. the arm that *does* work for
the Atlas ingest, so a 530 here is not an egress artifact. The freshness rebound is real and is
sales-driven (Top Shot `max(sold_at)` 16 min old, on-chain), which is a different path from the seven
paused pipelines.

⚠ **The tempting wrong move, stated so nobody makes it: "Top Shot is back, un-pause the cohort."**
It is not back. The seven suppressions — `compute-topshot-pack-ev`, `topshot-badge-catalog`,
`topshot-badge-set-backfill`, `topshot-deal-floor-serials`, `topshot-fmv-populate`,
`topshot-moments-hydrator`, `topshot-pack-pool-backfill` — remain **correct**. ⭐ Note that
`topshot-fmv-populate` is itself in that paused list, which is the cleanest proof that the recovered
FMV freshness is not coming from it.

👉 **The Studio-client migration question is therefore still open and still sized against a dead
host.** This filing's own caution was right: the rebound is a rebound in a *sales-driven* metric, and
it says nothing about the ask/badge/moment/pack-pool paths the dead host actually feeds.

ⓘ **Acted on, in the same pass:** `scripts/check-edge-fn-drift.mjs` now carries
`compute-topshot-pack-ev` in a new **DEPLOY_DEFERRED** bucket (previously the drift report told
readers it was "SAFE to redeploy"), and this measurement sharpened its clearing condition from the
ambiguous *"a Top Shot source is restored"* — which today would read as satisfied — to a one-query
check: **`SELECT max(started_at) FROM pipeline_runs WHERE pipeline = 'compute-topshot-pack-ev'`.**
That is exactly the distinction this filing warned about, caught by writing the condition down.
