# RPC overnight autonomous pass — 2026-09-08

*rpc-nightly-autonomous-pass · Cowork cloud · run start 2026-09-08 08:03Z (01:03 PT, genuine overnight window).*

## 🚦 Mode: NO-PUSH — DB-and-local only

`git push --dry-run origin main` failed with `could not read Username for 'https://github.com'` — the mount's `remote.origin.pushurl` is empty and the `remote.origin.url` fallback carries no credentials. Same condition as the 09-07 run. Per the runbook this run:

- **still applies** DB migrations and Cowork artifact repairs (neither goes through git) — **none were needed or shipped tonight**;
- **cannot** push code commits or trigger Vercel deploys — anything requiring a push is **queued**;
- writes this handoff as a **new untracked file on the mount** (persists on Trevor's machine, no pull conflict). The ledger entry and `metrics-latest.json` update live in the disposable clone only: the mount is at `dd574c69`, **behind** origin (`f8206931`) but clean, so overwriting those tracked files would create a pull conflict for Trevor. This handoff is the durable record; the next push-capable run will write ledger/metrics to origin.

Not off-hours. No `FREEZE.md`. Lock was `RELEASED` at start; taken for this run, released at close.

## Outcome in one line

**Quiet, honest night — nothing shipped, nothing needed shipping.** Health is green across the board; the three ships from the last 24h are all holding; every open candidate is either already resolved by the concurrent Claude Code / audit-drain session, or is a Trevor / off-limits / push-gated item.

---

## What was reviewed

- **Continuity state:** ledger head, `focus.md`, `metrics-latest.json` (09-07 01:05 PT baseline), the last two overnight handoffs, and the last 30 commits.
- **Inbox:** 415 files (mostly an un-archivable backlog — archival needs a push run, noted 09-07). Genuinely-new items since the last pass (~09-07 08:05Z) read in full. No new artifact-broken flags.
- **Artifacts:** all 11 enumerated. None flagged broken; all re-query live (so the morning's edition retirement flows through as corrected numbers, not breakage). `rpc-qa-scorecard` was already fixed 09-07 by the concurrent session. **No repair warranted.**
- **Health baseline:** `rpc_ops_snapshot()` + targeted drill-downs.

## Concurrent session

A Claude Code / audit-drain session pushed as recently as **00:57 PT** (~6 min before this run started): the non-canonical Top Shot edition retirement (`891dd777`), the browser Sentry SDK switch-off (`2e6d5f89`), the sales-indexer parking fixes (`c3dba41c` / `a3378e49`), and several docs. origin/main held steady at `f8206931` for the duration of this run (re-fetched 3×). It was already stable, so no queue-only degrade was triggered — but the active concurrent work on the same DB is a second reason (beyond NO-PUSH) that shipping a DB migration tonight would have been the wrong call.

---

## Section 2 — health-drift triage

**GREEN.**

| check | reading |
|---|---|
| security invariants / anon_write_holes / rls_off_base / secdef_anon | all `[]` |
| trust_health_breaches | `[]` (0) |
| stalled_pipelines | only `topshot-catalog-backfill` (info, seeded no_marker — dispositioned, register #38) |
| sentinel_ts_uuid_editions_48h | 0 |
| ts_uuid_dupes_created_24h | 0 |
| db_size_mb | 20321 |

**Pipeline alerts** — one `medium`, rest `info`:

- `allday-lock-refresh` — `failure_rate 17/54 (31.5%) over 2 days`, medium. **Benign, no action.** Direct query: **24/24 runs ok=true in the last 24h**, zero failures, latest 07:23Z. The alert is pooling pre-fix failures across the 09-06 17:23Z trypdub fix (the "rate pooled across a fix" trap CLAUDE.md names); it will age out of the 2-day window.
- `unmapped-sales-nfl_all_day` (info) — 38,698 actionable open rows, ~31.6 d to clear at the 7-day net rate. Standing backlog, by design.
- `atlas-editions-upstream-403` / `atlas-market-upstream-403` (info) — 10.8% / 11.2% Cloudflare challenges, **attributed not guessed**, no rows lost (re-walk from offset 0), freshness current. Escalate only if a drain stops landing.
- `flow-rest-moment-moved-400` (info) — 24.2% `panic: no nft`, the **designed** borrowMoment outcome for sold/transferred moments.

## Post-ship regression watch (last 24–48h ships)

All **holding — nothing reverted.**

- **`891dd777` — retire 6,597 non-canonical Top Shot editions + edition-verify lane 2→4/tick** (DB, ~03:58Z). Target: TS FMV HIGH+MED %. **Landed & correct:** editions 20,612 → **14,015** (= 20,612 − 6,597 ✓); FMV HIGH 2,016 + MEDIUM 5,256 = 7,272 of 14,015 = **51.9%** (M1 ≥50% met). `topshot_fmv_pct_stale_30d` = 0, sentinel dupes 0 — no regression.
- **`2e6d5f89` — browser Sentry SDK off** (code, ~05:29Z). Removes a dead POST path (quota 429 since 08-18); client-error beacon is the detector. No new error surface attributable.
- **`c3dba41c` / `a3378e49` — sales-indexer parking / cursor-hold** (code, ~03:0x–03:1xZ). Key post-ship signal — the duplicate-write race these could have opened — is clean: `ts_uuid_dupes_created_24h = 0`.

## Overnight deltas vs 09-07 metrics

| metric | 09-07 | 09-08 | note |
|---|---|---|---|
| TS editions total | 20,612 | 14,015 | retirement `891dd777` |
| TS FMV HIGH+MED (count) | 7,636 | 7,272 | count down (retired rows had FMV) |
| TS FMV HIGH+MED (%) | 37.4% | **51.9%** | denominator corrected — M1 met |
| db_size_mb | 18,191 | 20,321 | +2.1 GB, benign (see below) |
| sentinel ts_uuid 48h | 0 | 0 | |

**DB +2.1 GB day-over-day is benign.** Top tables are normal (`wallet_moments_cache` 3.0 GB, `pack_rips` 2.0 GB, sales partitions, `fmv_snapshots` 0.9 GB). `topshot_atlas_market_events` is **absent from the top 12**, confirming the 7-day prune (jobid 473, shipped by the audit-drain pass) is holding. The delta is ordinary ingest plus un-vacuumed dead tuples from the retirement DELETE.

---

## Shipped

**None.** NO-PUSH blocks code/deploys; no additive DB migration or artifact repair was justified against a green board with an active concurrent session on the same DB.

## Failed / blocked / reverted

**None.** No verification failures; production shipping was not hard-stopped (nothing was shipped).

## Queued — needs a push-capable run or Trevor

New this pass:

- **`pack_drop_pool` frozen since 2026-08-28 (dead Top Shot GQL host).** `/insights/pack-reality`'s +EV ranker is empty because the Top Shot pool's `gql_historical` source froze when the upstream host died; the `atlas` fallback is a 57-distribution static seed (last refresh 2026-07-17). The page itself is **honest** (verified by rendered DOM 09-07 — the third-state `rankerStale` copy, not a false "No +EV packs"). This is an **upstream/product decision** (no free replacement for broad Top Shot pool history per the 09-07 counterparty-source map `9bf4120a`), not a low-risk fix. *Trevor.*
- **Five lanes still fire into the dead Top Shot GQL host** (inbox `2026-09-08T0530Z`, committed `dd574c69`) — code/route change, push-gated. *Queue / Claude Code.*
- **6 UFC anon-public soft-404s** (inbox `2026-09-07T0330Z`) — folds into the standing ~19 anon-public soft-404 tab class (product call + `proxy.ts`). *Trevor.*

Carried forward from 09-07:

- `best-offers` break-on-error (0× warn in 24h; close after 1 wk of zeros) — still queued.
- ~19 anon-public soft-404 tabs (product + `proxy.ts`) — still queued.
- `sync-nba-projections` dry ≥72h (likely NBA offseason) — still queued; benign.
- **Inbox archival** — 415 un-archived files back to 2026-08-09; needs a push run to clear. Deferred again (NO-PUSH).

Already resolved by the concurrent session (not queued, recorded so they aren't re-opened):

- Fabricated `refresh_atlas_pack_ev()` `total_unopened = 0` → shipped as migration `20260908003056` (register #65).
- `topshot_atlas_market_events` unbounded growth → pruned to 7 d (jobid 473).
- `refresh_wmc`/reconcile heartbeat verifications — closed.
