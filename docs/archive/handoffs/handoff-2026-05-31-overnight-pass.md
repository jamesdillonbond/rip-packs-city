# RPC nightly autonomous pass — handoff 2026-05-31 (overnight)

**Run mode: OFF-HOURS monitor + NO-PUSH + .git locks un-removable → review/queue only. SHIPPED NOTHING.**

- **Off-hours:** local time at start was **08:02 UTC** (machine TZ = UTC), outside the ~00:00–06:00 overnight window → MONITOR-MODE per the task spec: full review + health triage + post-ship watch, queue everything that would otherwise ship, no production changes (auto-revert of a regressor would still be allowed — none needed).
- **No-push:** `git push --dry-run origin main` → `fatal: could not read Username for 'https://github.com'` (scheduled sandbox has no GitHub credentials). Code commits/deploys can't reach prod (Vercel builds from GitHub `main`), so they're queued for the operator regardless.
- **.git locks:** `.git/index.lock` (06:19Z) + `.git/HEAD.lock` (06:18Z) are present and **cannot be removed** (`rm` → `Operation not permitted` on the `.git` mount) — left by the daytime monitor's failed `git pull --rebase` (inbox-2 C3). So even a *local* commit is impossible this run. All outputs below are written **to disk only (uncommitted)**; they persist on Trevor's machine via the mount and future runs pick them up (same as the inbox files did this run).
- **Lock:** took over a STALE `docs/overnight/.lock` (runid 8a4b884c, 2026-05-30T22:14:02Z, ~9h48m old) with a fresh one (runid 14099792); removed at end of run.
- **Freeze:** none.
- **Collision gate:** `origin/main` at run start = `6c6950b` (last advanced ~06:29 UTC, ~1.5h before this run). Local HEAD == origin/main (0 ahead, 0 behind). No human pushing during the run.

---

## 1. Post-ship regression watch (done FIRST)

Re-measured the last ~24–48h of ships against their target metrics. **No regressions; no auto-revert needed.**

| Recent ship | Target / intent | Status tonight |
|---|---|---|
| `6c6950b` fix(sitemap) pagination past 1000-row cap | sitemap emits all ~23.5K editions + ~5.2K packs; deploy READY | **READY** as `dpl_9wcL2WjtViVDSFGqBnou9eoXbYUo` (current prod). Resolves inbox-2 C1. |
| `b20e483` + `26fa6be` (funnel+SEO; retrigger) | ship the wallet-paste funnel fix + entity/pack sitemap URLs | Both ERRORed post-compile (~06:00–06:08Z), but **superseded**: `a99ce2f` (docs) and `6c6950b` both built clean on the same tree → the post-compile ERROR was transient build-infra, not tree-deterministic. The funnel+SEO changes ARE live (in `6c6950b`'s ancestry). |
| `audit_20260531_pack_reality_views_security_invoker_and_revoke_anon_write` (Q1) | clear 3 SECDEF-view advisor ERRORs | **Verified:** `topshot_pack_reality_{top_ev,stats,dist}` all `security_invoker=on`; 0 RLS-off base tables; 0 base-table anon/auth write grants. |
| Entity-pages migrations (team dedup, player-detail team, recent-sales offset, edition thumbnail/video RPCs) | un-404 + de-dupe entity pages | Validated healthy by the daytime monitor + cross-collection render check; no regression seen in security/FMV/pipeline metrics. |
| `bd4d8c4` fix(sentry) pinnacle-listings-indexer counter | quiet `JAVASCRIPT-NEXTJS-15` (listing_resolution_failures_inserted) | **Did NOT move its metric** — NEXTJS-15 still firing (23 events / last seen ~05:10Z). NOT a regression (no worsening; warning fired before too) → no revert. Re-queued with a new hypothesis (Q4). |

---

## 2. Health-drift triage + overnight deltas

**Headline:** one NEW operational finding — a silent **TopShot sales-indexer stall** (Q3). Everything else green or transient.

### NEW — Q3: `topshot-sales-indexer` stalled since 01:32 UTC (~6.5h) [HIGH, operational]
- `topshot-sales-indexer` + `topshot-listing-cache`/`-v2` chain has **no `pipeline_runs` entries since 2026-05-31 01:32/01:35 UTC**. Prior cadence was every 1–2.25h (…19:43→20:56→22:03→23:17→01:32); a 6.5h gap is 3–5× the normal max.
- The 01:32 run **succeeded cleanly** (`ok=true`, `rows_written=26`, no error). The chain isn't crashing — it simply **isn't being invoked**. Classic stopped-external-trigger (cron-job.org) signature.
- Confirmed by data freshness: `sales` max `ingested_at` for `nba_top_shot` = **01:32:31Z** (6h37m stale); max `sold_at` = 01:31:56Z. By contrast **AllDay sales are fresh** (ingested 08:00Z) — so this is TS-specific, not a global ingest outage.
- **Not attributable to any deploy:** the stall began ~01:35Z, *before* the entity-pages deploys (02:27–03:08Z) and the funnel/sitemap deploys (06:00–06:29Z). No co-incident code change.
- **Why the daytime monitor missed it:** its sweep keys on `ok=false` failures; a pipeline that stops being *invoked* logs nothing, so an absence-of-runs stall is invisible to a failures-only scan. (Suggest the monitor add a max-age-per-pipeline check.)
- **User impact:** none acute — prod is READY, FMV is fresh via `fmv-recalc` (latest write 08:08Z), AllDay unaffected. But TS sales-based FMV/analytics freshness degrades the longer it persists.
- **Corroboration:** Sentry `JAVASCRIPT-NEXTJS-B` ("sales pipeline healthy") is the smoke check designed to catch exactly this — it's flapping (8 events/19h). This reframes inbox C2 (below): tonight that smoke "false degraded" is a **true positive**.
- **Owner / why not auto-fixed:** off-limits for the night pass (ingest pipeline route logic + external cron + NO-PUSH). **Operator action:** check the cron-job.org entry for `topshot-sales-indexer` (and the chained `topshot-listing-cache`); manually re-fire to confirm (`curl -H "Authorization: Bearer $INGEST_SECRET_TOKEN" <route>` or the cron-job.org "run now"). The route itself is healthy (last invocation succeeded) — this is a trigger problem.

### Security — clean
- RLS-off public base tables: **0**.
- anon/authenticated write grants on RLS-off **base** tables (`relkind in (r,p)`): **0**. (An un-filtered version of the check returns 46 rows — all **VIEWS** with by-design blanket grants; not a finding. RLS lives on the underlying base tables.)
- Q1 SECDEF-view ERRORs: **resolved** (3 → 0; all 3 `topshot_pack_reality_*` views `security_invoker=on`).

### Pipelines (24h) — all transient-with-recovery except Q3
Every `ok=false` row had its **most recent run succeed** (last_run == last_ok): `compute-topshot-pack-ev` 6/92 (targets statement timeout), `evm-transfers-ingest` 6/21 (Base-429, Q6), `pack-events-ingest-backfill` 3/94, `wmc-fmv-populate` 2/344 (deadlock), `pinnacle-nft-resolver` 2/299, `pack-events-ingest` 2/96, and seven more at 1 fail each (pool/statement timeouts). `snapshot-institutional-wallets` 1/2 (external cron, last_ok 19h — known/low-cadence). No logic bugs; all connection-pool/time-budget contention.

### Sentry — no new real issues
- A **cluster of 6 smoke-test issues** all fired **once each ~06:00–06:10Z** (the `b20e483`/`26fa6be` failed-deploy window + coincident pool timeouts): NEXTJS-1C/1D (security), -12 (pricing page), -A (fmv healthy), -4 (market listings), -14 (Pinnacle drift). Not recurring (firstSeen==lastSeen). Independently verified clean: security guards return `[]`/`[]`, FMV fresh, prod READY. → transient deploy-window noise, no action; confirm non-recurrence.
- `NEXTJS-B` (sales healthy) — flapping; now a true positive (Q3).
- `NEXTJS-15` (pinnacle listing warn) — still firing post-`bd4d8c4` → Q4.
- `NEXTJS-1B` (pinnacle/moment null destructure) — resolved, 15h clean (operator/monitor can mark Sentry-resolved at 24h clean; did not touch Sentry status in monitor mode).

### Overnight deltas vs `metrics-latest.json` (2026-05-30T22:25Z → 2026-05-31T08:10Z)
| Metric | Baseline | Tonight | Δ |
|---|---|---|---|
| TS FMV HIGH+MED | 780 | 776 | −4 (noise) |
| TS NO_DATA | 6091 | 6055 | −36 (improving) |
| AllDay FMV HIGH+MED | 241 | 243 | +2 |
| Sentinel TS-UUID-keyed 48h | 1707 | 1099 | −608 (improving, well under 2000 WARN) |
| unmapped_sales open | 144 | 144 | 0 |
| editions (TS) | 16274 | 16279 | +5 |
| DB size | 5815 MB | 5827 MB | +12 MB |
| Latest prod deploy | bd4d8c4 READY | 6c6950b READY | current |

All FMV/sentinel/security metrics flat-to-improving. (Q3 doesn't show in these snapshot counts yet; it manifests as growing TS sales staleness if it persists.)

### Cowork artifacts
10 in the manifest; all re-query live on open; none flagged broken in either inbox; the daytime monitor validated all OK ~2h ago. No drift to repair. (`rpc-live-health` / `rpc-pipeline-reliability` will now correctly surface Q3 when opened.) Per off-hours posture, did not regenerate working artifacts.

---

## 3. SHIPPED
None. (OFF-HOURS + NO-PUSH + un-removable `.git` lock.)

## 4. QUEUED — for the operator / a genuine overnight window

- **Q3 [HIGH] — `topshot-sales-indexer` external-trigger stall.** See §2. Operator: re-fire / fix the cron-job.org entry for the TS sales-indexer chain. Route is healthy; trigger stopped ~01:35Z. Night pass cannot fix (ingest logic + external cron + NO-PUSH).
- **Q4 [MED] — `NEXTJS-15` pinnacle-listings warning still fires post-`bd4d8c4`.** The `.select()`-counts-only-new-inserts fix didn't reduce the warning (23 events/22h, ~every tick). New hypothesis: either (a) Pinnacle genuinely inserts ≥3 NEW unresolved listings/tick so the `>=3` threshold sits under normal churn → raise the Pinnacle threshold or exclude the ~1.5k permanently-capped retry backlog from the "new" count; or (b) the `.select()`-returns-only-inserted-rows assumption is wrong for that ignoreDuplicates upsert. Touches `app/api/pinnacle-listings-indexer` (pipeline-adjacent) → operator/Claude-Code, not night-pass.
- **Q5 [MED] — smoke `analytics_pipeline_health.sales` lag threshold.** 30m max < the ~2h indexer cadence → intermittent `degraded`. **Caveat (important): do NOT blindly raise it** — tonight it is correctly flagging the real Q3 stall. Better fix: compute lag from the last *successful sales-indexer run* (not newest `sales.sold_at`), so "no sales happened" ≠ "pipeline unhealthy" while still catching a real multi-hour stall. Touches `analytics_pipeline_health` RPC + smoke config.
- **Q6 [LOW] — `evm-transfers-ingest` Base-429.** 6/21 fails/24h, "over rate limit"; Beezie/Base parallel plane, no product consumer, self-recovers. Add backoff/jitter or lower per-tick block range. Pure cadence tweak.
- **Q7 [INFRA] — `.git/index.lock` + `.git/HEAD.lock` un-removable from the sandbox.** Left by the daytime monitor's failed rebase; `rm` denied (`Operation not permitted` on the `.git` mount). Blocks autonomous *local* commits (compounding the no-creds push gap). If the mount shares Trevor's real `.git`, clear them there (`rm -f .git/index.lock .git/HEAD.lock`); if sandbox-only, it's an environment issue for the scheduled-task runner (no GitHub creds + read-only `.git` together make autonomous shipping impossible — both need fixing for the night pass to ever ship code again).
- **Q2 [LOW, carry-forward] — `compute-laliga-pack-ev` cadence.** Ran 05:30Z (2.6h ago), so it is firing now — the earlier "idle ~17h" concern appears addressed. Keep an eye; operator can confirm the cron entry.

## 5. FAILED / AUTO-REVERTED
None.

---

### Note for the daytime monitor
Add a **per-pipeline max-age (silent-stall) check** to the sweep — a pipeline that stops being invoked logs no `ok=false` row, so the current failures-only scan can't see a stall like Q3. A "pipelines whose newest run is older than N× their normal cadence" query would have caught the TS sales stall ~4h earlier.
