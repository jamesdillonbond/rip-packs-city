# Handoff — 2026-10-17 overnight pass

> ⚠ **SCOPE:** the git-push notes here are specific to this Cowork **cloud** session. Trevor's machine and Claude Code push normally via Git Credential Manager — **commit these files as usual.** This pass pushed its own docs from the device-VM clone (`$HOME/rpcwork` + the mount's `.rpc-git-cred`); push auth was proven by `git push --dry-run` (exit 0).

**[3+ nights routed — FIRST LINE] Oldest open item: #23/#25 edge-fn drift (operator, since 08-22). See "Queued" §3.**

**Run:** cloud nightly, ~01:05–01:20 AM PT (08:05–08:20Z) 2026-10-17. Lock `run=5c1b6404`. Real time anchored to DB `now()` 08:07Z and app rows (max_ingested 08:06Z) — **inside the 00:00–06:00 PT window, a genuine overnight run.** No FREEZE. Last night's lock was RELEASED (10-16 08:17Z).

**Verdict: GREEN · 0 shipped · idle: no clearly-safe, non-hot work open (inbox drained, health green; app + edition/ownership/rip-metadata DB tree HOT from the 10-15/10-16 drain) · carried items routed to Trevor/Claude Code · oldest routed: #23/#25 edge-fn drift (operator, since 08-22).**

## Health sweep — GREEN (one flag, dispositioned benign)
- Security: `invariants`, `anon_write_holes`, `rls_off_base_tables`, `secdef_anon_violations` all `[]`.
- trust_health: 38 arms all ok; `trust_health_breaches` `[]`; `trust_precompute_max_age_hours` 5.37 (breach 13).
- `check_when_others_timeout_blind()` 0 (R118 ok); `check_pgcron_recent_failures()` `[]`; `stalled_pipelines` `[]`; `sentinel_ts_uuid_editions_48h` 0; `ts_uuid_dupes_created_24h` 0.
- Catalog/drift checks all `[]`: function_search_path_drift, procedure_txn_control_pins, procedure_search_path_unpinned, backward_cursor_rewinds, cross_collection_mat_staleness, suppression_parked_claim_drift, suppression_count_predicate_drift, wmc_null_edition_key.
- `public_board_empty_count` 0, `public_board_slow_count` 0.
- db_size 39,297 MB (+410 vs 10-16 = 38,887).

### check_zero_yield_lanes() — 2 offenders, BOTH benign-intermittent (not a stall)
- `pinnacle-pack-openers` (runs every minute, 1,440/day) and `pinnacle-metadata-backfill` (hourly) both read 0 writes over the 7-day window; `last_find` 2026-10-09. The detector's `zero_days=7` crossed threshold on the 8-day dry spell (last pass: 0 offenders).
- **Diagnosis (sample: `pipeline_runs_daily` 10-01→10-17; `pipeline_runs` last 12 ticks):** these lanes write only when Disney Pinnacle pack-opens happen on-chain, and that activity is BURSTY. pack-openers attributed 377 (10-01), 306 (10-02), then a **6-day zero gap 10-03→10-08**, then 414 (10-09), then zero since. metadata-backfill wrote 3 (10-03) and 1 (10-09), zero otherwise. The 10-03→10-08 gap self-resolved with the 10-09 burst — the **positive control** that window-finding + attribution still work.
- Every tick is `ok=true`, `gql_errors 0`, `write_errors 0`; metadata-backfill is actively scanning (`q3_pass` rising daily, 10,656 `distinct_edition_keys`) and finds 0 eligible → catalog current. Pinnacle FMV/floor are fresh (0.6h / 0.4h), so the Pinnacle market pipelines are live; only **primary pack-open** attribution is dry.
- **VERDICT: benign — the Disney Pinnacle pack-open market is genuinely quiet since 10-09; not a stall, not a regression, nothing to ship.** ⛔ **Did NOT add a zero-yield suppression:** the 09-12 genuine failure of `pinnacle-metadata-backfill` was *"ok 63× while 3 of 4 queues wrote nothing"* — a zero-write-while-ok, exactly what this detector catches. A suppression would blind that class. **Re-open ONLY if** a tick turns `ok=false` / `write_errors>0` / `gql_errors>0`, OR upstream Pinnacle pack-opens resume (`enqueued`/`windows_done` > 0 on pack-openers) while `attributed` stays 0.

### pipeline_alerts — all known/attributed
- `topshot-pack-supply-atlas` failure_rate 783/3031 (25.8%, medium) = the chronic "N request(s) failed" 403-retry noise (`pipeline_fails_24h` 401, upstream 0; last hour 0/13). Not a finding.
- 6× Atlas *-upstream-403 + `flow-rest-moment-moved-400` all `info`, attributed, nothing lost (freshness current on every lane; last clean drains within cadence).

### Vercel 24h — 18 groups, all chronic / transient / known
- The two classes watched from 10-16 are GONE: `get_edition_special_serials` statement-timeout (last 10-15 19:13Z, before the 22:48Z index) — zero recurrence; `get_topshot_rookie_collectors` lock-timeout (10-15 MV rebuild) — zero recurrence. Both fixes holding.
- Remaining: pack-detail bounded-read 5s timeouts (chronic since 08-23, count 1–2, degrade-to-empty), market-cap 8s tiles (known-dispositioned), pack-sniper initial fetch (chronic), 2× cloudflare 502 (transient, degrade-to-empty), 1 Telegram-send timeout @/api/sentinel (transient). No new class tracing to a ship.
- Sentry stays dark (quota off 08-18, SDK removed #34); GREEN asserted on the Vercel number, never a Sentry zero.
- client-error beacon (`usage_events`): 0 client-error rows in 24h.

## Accuracy gate (R125 backtest, 7d — read tonight) — HOLDS
- NBA Top Shot: published ALL 13.3% median_abs_err, 66.0% within 25%, **ratio 1.000**; HIGH 9.5% / 84.3%, ratio 1.000. last3_median ALL 13.6% / ratio 1.000. ASK_ONLY ratio 1.350 (n=102) known worst bucket.
- NFL All Day: published ALL 20.0%, 56.4% within, **ratio 1.059** (inside 0.90–1.10); HIGH 13.3% / 71.6%, ratio 1.053; MEDIUM 17.6% / ratio 1.000; median_abs_err_usd ALL $0.04 (sub-dollar sales). ASK_ONLY ratio 1.800 (n=68) / STALE 2.167 (n=10) = known tiny worst buckets. No estimator drift.

## Post-ship watch — 10-16's ships, all holding, 0 regressions
- `ownership-onchain-walk` (Dune-gap sets + unplaced-id hydration): 10-16 8/8 ok, 143,496 rows (expected first pass over the 8 added sets); 10-17 1/1 ok, 11,255 rows. 0 fails.
- `topshot-index-unmapped-hydrate` (new 10-16 lane): 118/118 then 93/93 ok, dispatch 40/tick. ⚠ **Backlog grew ~27k → ~133k** after the Dune-gap walk queued the newly-covered sets' unplaced ids (anticipated by the 10-16 "Watch"), now draining ~40/tick with the walk burst over (≈9 days at current rate; little new feed between walks). **Watch:** backlog should trend DOWN — re-check next pass.
- `backfill-pack-rip-metadata` (eligibility-as-sets rewrite): 10-16 24/24 ok (7,939 rows), 10-17 6/6 ok; 0 timeouts. Holding.
- `topshot-ownership-walk-candidates`: 10-16 1/1 ok (14 rows).
- Address-normalizer consolidation / issuer-split / atlas open-listing covering index: committed 10-16, CI green, verified in the 10-16 ledger; no regression surfaced.

## Overnight deltas vs 10-16 metrics
- db 38,887 → 39,297 MB (+410).
- FMV HIGH+MED: nba 8,044 → 8,033 (−11); panini 7,929 → 10,048 (**+2,119**, coverage expansion from the collector walks; `panini_coverage_pct_drop` 4.7 ok, no drop); allday 1,616 → 1,634; pinnacle 912 → 930; candy 72 → 71; golazos 6; ufc 0.
- editions: panini 32,086 → 33,025 (+939); others flat.
- Vercel groups 11 → 18 (the increase is the pack-detail bounded-read family split into per-RPC groups — all chronic since 08-23 — plus normal 1-count transient churn; no new class).
- trust breaches 0 → 0.

## Nothing shipped — why
Inbox drained (newest filing 10-15, all closed; none dated 10-16/10-17). The only health flag (zero-yield Pinnacle) is benign-intermittent (above). Accuracy gate holds; all 10-16 ships holding. The app tree and the edition/ownership/rip-metadata DB functions are HOT (real commits 10-15/10-16 from the drain), so the collision gate forbids touching them. The remaining open items need a human/Claude Code executor this headless cloud pass is not.

## Queued for Trevor / Claude Code
1. **[P3, Trevor, ~22 nights, shelved] #58 OPENSEA_API_KEY** — the three candy-opensea indexers fail every tick on the missing key. Shelved 09-23; R129 refuted (unschedule intent recorded). Set the key + redeploy, or mark inactive in `pipeline_cadence_watchlist`.
2. **[Housekeeping, Trevor] Windows mount is behind origin** (mount HEAD `7ba2d1e0f`, an ancestor of origin `27f0e6199`) and holds the deep-audit's uncommitted edits. Copy local edits aside, then `git pull --ff-only`.
3. **[Operator, since 08-22 — OLDEST] #23/#25 edge-fn drift** (25 edge functions not on `main`; the surfacing sentinel arm is blocked on a GitHub `actions:read` token in Vercel env) and **drop_scratch residue** (~185 MB `flowty_archive.scratch_*`, SQL-editor only, Trevor's data). Long-standing operator items.

Closed since the last queue (not re-carried): the **[P2, Claude Code] ~17 address normalizers** item — Claude Code consolidated them into `lib/address.ts` on 10-16 (`f610c2ac3`), and the `#E03A2F` half was dispositioned 10-15 as legitimate OG/email/data/SVG exceptions.

## Failed / blocked / reverted
None. No ship attempted; no revert needed.

## This pass wrote
This handoff (committed + pushed from the VM clone; mirrored to the claude.ai Project), one `### 2026-10-17` ledger line (spliced above the first line-start `###`), a focus do-not-re-flag line for the Pinnacle zero-yield lanes, and an overwritten `metrics-latest.json`. Lock released.
