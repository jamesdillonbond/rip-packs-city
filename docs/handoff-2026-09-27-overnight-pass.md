# Overnight autonomous pass — 2026-09-27 (~1:10 AM PT / 08:10 UTC)

**Verdict: GREEN, honest-quiet night. 0 shipped, 0 reverted, 0 new queued.** Full review + Section 2 health triage + post-ship regression watch all clean. Push was AVAILABLE (Path A: laptop VM + `.rpc-git-cred`); only these output docs were committed. Real time confirmed via DB `now()` (08:07 UTC) against app-stamped rows (sales 08:03Z, fmv 07:55Z) — sandbox clock agreed, no skew; ~1 AM PT = genuine overnight, normal shipping was permitted but nothing met the bar.

## What was reviewed
- **Continuity**: CLAUDE.md (full), ledger top (~09-26 daytime pass, 20+ ships), focus.md (latest steer 09-20, nothing tonight-specific), metrics-latest.json (09-26 18:00Z baseline), latest daytime handoff.
- **Inbox**: 549 files in `docs/overnight/inbox/` — a long-standing backlog going back to 2026-08-09 that prior passes have NOT mass-archived (INDEX.md carries CI assertions; archival is deliberately conservative). Processed the two genuinely-new candidates:
  - `2026-09-26T0006Z … sync-nba-projections 100% failure` — DISPOSITIONED: known-issue #8, shelved under Trevor's delegation ("no paid projections provider before revenue"), alert muted to 10-13, lane fails SAFE (ok=false, no rows). Not a regression, not shippable. Do not re-suggest.
  - `2026-09-26T0308Z … two low candidates` — both RESOLVED upstream by Claude Code: C1 (player-stats-sync within-batch dup keys) fixed by `4ea939c5e`/migration `20260925235606`; C2 (storefront-reconcile co-fire at :19:01) resolved — lanes now :13 / :43, 30 min apart, 0 QuickNode 429s. No action.
- **Artifacts**: none flagged broken/stale by the monitor; nothing regenerated (working artifacts are left alone by policy).

## Section 2 — health-drift findings + deltas
`rpc_ops_snapshot()` baseline (08:10 UTC):
- **Security**: invariants / anon_write_holes / rls_off_base_tables / secdef_anon_violations all `[]`.
- **trust_health**: 38/38 ok, `trust_health_breaches` = `[]`.
- **Sentinels**: `sentinel_ts_uuid_editions_48h` = 0; `unmapped_resolution_backlog_max` = 2; `edition_integrity_flags` = 7 (breach 250).
- **Sentry**: 0 new unresolved issues in 24h. **client_error beacon**: 11 in 24h, ALL crawler UA (Lightpanda/Lightworks class — known, not user-facing, per the 09-26 ledger correction).
- **Vercel**: last READY production build = `492f8cb5` (Pinnacle #150). Tip `2c351bae` (circulation sampler) shows CANCELED — correct: it touched only `docs/known-issues.md` + a migration `.sql` (both in the ignoreCommand skip-set), the pg_cron change went through the DB not the build, so there was nothing to deploy. No ERROR-state deploys. `public_board_empty_count` = 0, `public_board_slow_count` = 0.
- **Pipeline alerts / fails (24h)**: only known/designed —
  - `topshot-active-listings-ingest` cron_silent 958 min (**medium, visibility only**): the load-bearing caller is Trevor's residential Windows Task Scheduler task, dark since 09-26 16:13 UTC. Expected behaviour of the 900-min arm; needs Trevor's box, not code.
  - `atlas-market-feed` 15 fails / `atlas-editions-refresh` 4: Cloudflare 403 challenges (~5%), self-healing, freshness ok (last drain 08:09Z, newest event 08:07Z). info.
  - `flow-rest-moment-moved-400` (pack-pull hydration): designed borrowMoment panic on sold/transferred moments. info.
  - `unmapped-sales-nfl_all_day`: 7,098 actionable open rows, non-stationary drain. info.
  - `sync-nba-projections` 8 fails: known-issue #8 (see inbox). wallet-backfill 2/2/1, pack-mint-probes 2, candy-listings-indexer 1, pinnacle-wmc-render-id 1 — transient, self-recovered.
- **db_size**: 29,433 MB (net._http_response TOAST refill, expected to plateau ~ documented; not chased).

### Overnight deltas vs 2026-09-26 18:00Z metrics
FMV HIGH+MED per collection (up or flat everywhere — no regression):
- nba_top_shot 8007 → **8043** (+36)
- nfl_all_day 1511 → **1522** (+11)
- disney_pinnacle 801 → **823** (+22)
- panini_blockchain 1845 → **1846** (+1)
- candy_mlb 23 → 23 · laliga_golazos 4 → 4
Editions stable/up (panini 5095 → 5101). Sentinel 0 → 0.

## Post-ship regression watch (24–48h ships)
All 09-26 daytime-pass ships' target metrics are green in the snapshot (Pinnacle franchise/character/series/set pages, checklist ownership, pack values & retail, % listed, undercut verify lane). No metric got worse; no new Sentry issue traces to any of them; no touched pipeline now fails. **No auto-revert needed.**

⚠ **One watch NOT yet closeable — carry forward:** the circulation-sampler fix (`2c351bae` / migration `20260927042000`, applied 09-26 ~9:20 PM PT = 04:20 UTC 09-27) changed `rpc-circulation-chain-dispatch` schedule `25 3 * * *` → `25-29 3 * * *` and command `(50)` → `(10)`. Confirmed live: schedule = `25-29 3 * * *`, command `dispatch_topshot_circulation_sample(10)`, active. BUT tonight's 03:25 UTC tick fired ~1h BEFORE the fix applied, so it still shows the pre-fix 10×429 / 40 ok (and 10×429 in `net._http_response` for that window). **This is expected pre-fix behaviour, NOT a failure of the fix.** The fix's falsifier — 0×429 and 50×ok — is first exercised at the **03:25–03:29 UTC 09-28** tick (~8:25 PM PT 09-27). Next pass: re-check that window; do not misread tonight's 10×429 as a regression.

## Shipped
None. Nothing was both genuinely low-risk/reversible AND not already handled upstream.

## Needs Trevor (carried forward — all off-limits for autonomous: hardware / secrets / operator deploys)
- **TS active-listings ingest**: the residential Windows Task Scheduler task on the laptop is the board's only live feeder and is dark (silent 958 min). Board freshness depends on the box being awake.
- **#144**: rotate `ATLAS_POOL_INGEST_KEY`.
- **wrangler deploy `pack-events-ingest`** (#134/#123); **enrich-ufc-wallet** CLI deploy.
- Long-standing: **#22** (credential-purge residue), **#64** (Panini is_active decision), **#140**.

## Failed / blocked / reverted
None.

## Housekeeping
- Inbox backlog (549 files) left as-is — consistent with every recent pass; archiving is gated by INDEX.md CI assertions and is not a safe unattended action. The two processed candidates are dispositioned above.
- No ledger SHIP entry (no change touched main/prod state this pass, per CLAUDE.md no-op rule).

_Concurrency lock held at run start (prev was RELEASED), released at end. Push Path A verified by `git push --dry-run` (exit 0)._
