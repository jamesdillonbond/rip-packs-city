# Overnight pass — 2026-11-05 (~1:00–1:20 AM PT)

**Session:** Cowork cloud, laptop-VM clone + `.rpc-git-cred` (push available, dry-run authenticated). Genuine overnight run (clock verified against DB: shell 09:02:50Z, DB now 09:03:21Z, newest sale ingest 09:03:09Z — all agree, no skew; 09:0xZ = ~1:0x AM PT, inside 00:00–06:00). Not frozen.

**Verdict: GREEN · 0 production shipped · 0 reverted · idle: no-work (every inbox item dispositioned, carried queue all OFF-LIMITS/operator) · oldest routed: none.** Docs only: this handoff, ledger line, metrics, session entry.

## What was reviewed

- **CLAUDE.md** in full; continuity state (`ledger.md`, `inbox/`, `metrics-latest.json`, `focus.md`, latest handoff = 11-04 evening pass).
- **Inbox** — every item dispositioned:
  - `2026-11-05T0105Z` refresh-conflated-editions silent (missed 11-04 tick) → **RESOLVED**: re-fired 11-04 6:02 PM PT (cron-job.org Test run, 77 s, thin-FMV guard 20→31); `stalled_pipelines` now `[]`. Watch: the 11-05 ~8:17 AM PT (16:17Z) tick lands on its own.
  - `2026-11-02T0713Z` artifact-roster-drift (11 vs 16) → RESOLVED in register (13 live dashboards, 3 retired); all sources' SQL objects resolve live; no broken dashboard.
  - `2026-11-02T1908Z` gha-schedule-tick-stall → SELF-HEALED (GitHub-side schedule delay; `detect_stalled_pipelines()` never non-empty).
  - `2026-11-01T1545Z` panini-ingest-enum silent → RESOLVED, no action (laptop runner asleep, resumed; threshold left as is).
  - `2026-11-03T0705Z` net._http_response above sawtooth → open as a weekly read (see db note).
  - Older items (10-20 → 11-04) all dispositioned in prior handoffs. Inbox left untouched (append-only; dispositions here).
- **Dashboards:** none flagged broken by the monitor; recent schema changes (fmv_restatements, market_cap_current.mcap_restated_7d_usd, fmv_accuracy_weekly) are additive — no dashboard query broke. No repair in scope.

## Post-ship regression watch (FIRST, before any shipping) — CLEAN

Re-measured the 11-04 FMV pricing ships and their target metrics:

- **TS ask-only last-sale cap (`20261105024000`), TS offer floor / `_bidfloor` (`20261105033000`), thin-sale haircut stops at bid (`20261105044500`), All Day LOW unknown-depth haircut 0.55→0.75 (`20261105050000`), #233 market-cap 7-day restatement (`20261105043000`), #234 confidence labels, Pinnacle wmc fingerprint (`20261105030303`):** no regression signal. `fmv_sanity_flags` 0, `edition_integrity_flags` 22 (<250), `topshot_fmv_stale_hours` 0.3, `panini_fmv_stale_hours` 0, `topshot_impossible_parallel_serials` 0, `topshot_sold_floor_asks_found` 8 (<50), 0 trust breaches. No new Vercel crash group.
- **#228 /api/collection-snapshot cold-whale timeout:** **absent from the 24h runtime-error window** (last occurrence 11-04 12:32 AM PT) — the 11-04 AM route-budget fix is holding. Not recurring.
- The 11-04 7:47–7:48 PM PT Vercel timeout cluster (edition/player/set + one fmv-recalc `55P03` lock timeout) was the three bulk re-price applies; last trace 03:48Z 11-05 = 7:48 PM PT 11-04, cleared by 7:57 (evening pass). Nothing since.
- No auto-revert needed or taken.

## Health-drift findings + deltas (`rpc_ops_snapshot()` 09:06Z)

- **Security:** invariants `[]`, anon_write_holes `[]`, rls_off_base_tables `[]`, secdef_anon_violations `[]`.
- **Trust:** 40/40 ok, 0 breaches. Notable legs: candy_sales_stale_hours 581.8 (<1114.9; re-verify candy_mlb ~11-27), edition_integrity_flags 22 (<250), panini_coverage_pct_drop 5.9 (<15), fmv_sanity_flags 0, trust_precompute_max_age 5.3 (<13).
- **Pipelines:** `stalled_pipelines` `[]`. `pipeline_fails_24h` all upstream 0 — atlas-pack-market 16, topshot-pack-supply-atlas 5, atlas-editions-refresh 4, atlas-market-feed 3, fmv-recalc 1, ingest-topshot-challenges 1 (all designed/small). Structural checks all `[]` (wmc_null_edition_key, backward_cursor_rewinds, function_search_path_drift, procedure pins/txn, cross_collection_mat_staleness, suppression drifts). sentinel_ts_uuid_editions_48h 0, ts_uuid_dupes_created_24h 0.
- **Alerts:** 6 `info`, all designed — Atlas Cloudflare 403s on editions (2.7%), market-feed (1.5%), pack-supply (403+404), pack ask-book (24/643), plus moved-Moment hydration panics. Each lane with a fresh 200 at 09:05–09:06Z. None at escalation.
- **Sentry:** dark (SDK removed #34). **Client beacon:** 1 in 24h = `rpc-positive-control-probe 2026-11-04` (the instrument's own liveness probe), no real client error.
- **Vercel:** prod last READY `dpl_9Y9e5iY4xiGnrqYLDFZYM3Rb4iUZ` on `1ff682000` (= origin/main = clone HEAD). CANCELED siblings are docs-only rapid-succession supersessions. 24h runtime: 11 groups, all chronic (first-seen June–Oct), no new crash group.
- **DB size:** 46,351 MB, +1,088 vs last night (45,263). Composition: `net._http_response` 3,830 MB (+797 vs 3,033 — Atlas market-feed 6h-TTL TOAST sawtooth, the bulk of the delta), `panini_card_serials` 9,382 MB (ongoing backfill), no new unexpected >200 MB public table. Within the ±1.3 GB band; no leak.

### Deltas vs `metrics-latest.json` (11-04 evening)

- db +1,088 MB (45,263 → 46,351), within band (net._http_response sawtooth).
- FMV HIGH+MED: nba 6,663→6,662 (−1); panini 18,027→17,991 (−36); nfl 1,672→1,646 (−26); pinnacle 925→935 (+10); candy 63→65 (+2); golazos 1 flat; ufc 0 flat. Normal churn (0 stale/sanity flags).
- editions: panini 40,217→40,249 (+32); nba 14,682 flat; others flat.
- trust breaches 0→0.

## Shipped

None.

## Queued — unchanged carry (no new items this pass)

All carried items are OFF-LIMITS (route/edge, secrets, ingest route-logic) or operator/Claude-Code owned; none is a sandbox lever:

1. **#228 cold-whale /api/collection-snapshot timeout** — SQL lever exhausted; next lever is a CDN warm of top wallets (route/edge, OFF-LIMITS). Not recurring at present (last 11-04 12:32 AM PT). Trevor/Claude Code, or accept ~1 honest-503/day on cache-cold ~63k-moment wallets.
2. **Staged destructive wmc index swap** — ✅ already done 11-04 (`20261104161510`); no longer open (the earlier `-STAGED.sql` proposal is superseded).
3. **Panini old-catalogue backlog drain** — on the dated focus.md watch (11-05 → 11-07); falling ~3.2k/day, FMV fresh, coverage 5.9% ok. Drain = laptop Task-Scheduler + ingest route-logic (OFF-LIMITS). Claude Code/Trevor.
4. **saved_wallets username root-cause code fix** — ✅ shipped 11-03; 21 null rows backfilled. (Carry retained only for the follow-up code hardening; Claude Code.)
5. **#58 OPENSEA_API_KEY** (P2, Trevor; candy re-verify ~11-27) — secret, no sandbox lever.
6. **panini-ingest-enum max_silent_minutes (738) recalibration** — OPTIONAL, low value; decision was to leave as is.
7. **net._http_response growth lever** (P4, Trevor) — decide whether `atlas_market_drain` should delete consumed 200 responses. Re-read weekly; +797 MB this interval, still a high-water mark not a leak.
8. **cron-job.org account has no MFA** (P3, Trevor) — from the 11-04 incident; `claude/note-2026-11-04-cron-job-org-incident-and-notify-thresholds.md`.

## Failed / blocked / reverted

None.
