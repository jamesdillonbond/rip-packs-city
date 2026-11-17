# RPC overnight pass — 2026-10-12 (off-hours monitor-mode)

> ⚠ **Environment scope:** this pass ran in a **Cowork cloud session** linked to Trevor's laptop VM. Git push worked normally via the device-VM clone + `.rpc-git-cred` (dry-run verified). Nothing here is blocked on the environment. **This blocker scoping is belt-and-suspenders — no blocker was hit.** Trevor's machine and Claude Code push normally via Git Credential Manager; commit as usual.

**Fired:** 2026-10-12 23:09 UTC (= **4:09 PM PT**). Scheduled for 08:05 UTC — fired ~15 h late, on app launch after the box had been closed. Real time confirmed from DB `now()` 23:09:43Z + sales ingested 23:07Z + fmv computed 23:08Z (shell clock not skewed).

**Mode:** 4:09 PM PT is OUTSIDE 00:00–06:00 PT, so the quiet-hours guard put this run in **OFF-HOURS MONITOR-MODE**: full review + health sweep + post-ship watch, **queue everything, commit only docs**. (An auto-revert of a regressing recent ship would still have been allowed — none was needed.)

**Verdict: GREEN · 0 shipped · idle: routed (all open items Trevor / Claude-Code / operator-gated; no neglected P1) · oldest routed: #58 OPENSEA_API_KEY (Trevor, shelved by his call 09-23) & #23/#25 edge-fn drift (operator-blocked since 08-22).**

---

## What was reviewed
- **Continuity:** ledger top matter, `metrics-latest.json`, focus.md (all steers), inbox via INDEX.md, latest handoff (2026-10-11), `npm run ops:ready-queue`.
- **Inbox: drained.** The only filing since the last pass — `2026-10-12T0010Z-daytime-monitor-candy-offers-indexer-timeout-28pct-undispositioned.md` — is already ✅ FIXED by Claude Code (`6071d18bd`, 10-11 ~9:30 PM PT) and annotated in its INDEX line. No mount-only monitor filings (mount and clone match). No inbox edit needed; append-only respected.
- **origin/main** at `6071d18bd` (candy-offers fix). No commits all of Monday 10-12 — Claude Code quiet (consistent with the box being closed). No collision risk; origin did not advance during the pass.

## Health-drift findings + deltas (all instruments GREEN)
- **Security:** invariants / anon_write_holes / rls_off_base / secdef_anon all `[]`.
- **Structural:** all drift checks `[]` (search_path, txn pins, mat staleness, backward cursors, wmc null-key, parked-claim drift).
- **Trust: 0 breaches**, 38 arms ok. precompute 5.42 h; unmapped_backlog 5; public_board_slow/empty 0.
- **Sentinels:** ts_uuid_editions_48h 0, ts_uuid_dupes_24h 0.
- **`check_pgcron_recent_failures`** none; **`check_when_others_timeout_blind`** 0; **`check_zero_yield_lanes`** 0 offenders / 324 inspected / 8 suppressed.
- **Stalled lane (only one):** `topshot-active-listings-ingest` silent **1,320 min** (last run 10-12 01:13Z). This is Trevor's **residential Windows Task Scheduler feeder box being dark** — known-class (medium/visibility-only, >900 min = "the box's only feeder has been dark", by design). The TS live-listings/ask book is therefore ~22 h stale, **but TS FMV itself is fresh** (topshot_fmv_stale_hours 0.1). Self-heals when the box is back on. No code fix.
- **Vercel 24 h:** 8 error groups, all chronic/by-design — ipfs-media 12 s timeout ×10; candy-opensea OPENSEA_API_KEY ×3 (#58); one Supabase-502 Cloudflare blip at 09:58Z (surfaces as the market-cap tile for nba_top_shot/271:9039 and `get_edition_detail error undefined` ×2); collection-snapshot RPC_READ_TIMEOUT 8 s (chronic since 09-11); entity-section special-serials degrade (chronic since 07-31). **No new group traces to the 10-11 batch.**
- **Sentry:** dark (quota off since 08-18, SDK removed #34) — not used; health read from Vercel + DB + beacon.

**Deltas vs 10-11:** db_size 35,701→36,440 MB (+739; panini catalog walks +1,881 editions + flowty_archive scratch growth). FMV HIGH+MED — topshot 8,245→8,207 (-38), panini 6,470→6,424 (-46), pinnacle 850→868 (+18), nfl_all_day 1,650→1,663 (+13), **candy 31→68 (+37 — the 10-11 ask-corroboration lift, exactly as predicted)**, golazos 7, ufc 0. misattrib #101 observed 1,485→**987** (draining; <500 in ~2-3 d).

## Post-ship watch on the 10-11 daytime batch (~15 commits + 4 migrations) — CLEAN
Batch: growth/accuracy-gate, SEO (Dataset JSON-LD / llms.txt / RSS), bearer constant-time compare, account deletion, Terms/giveaway rules, funnel 180-day retention, laliga-pack-ev retire, light-mode conversion, candy-offers degrade.
- **Deploy:** latest prod `dpl_CJNBQuNpiPGMJLjkftPT2oZ4age6` = `6071d18bd`, **READY**. (One CANCELED build = superseded docs commit `9ae835e6`, normal.)
- **candy-offers-indexer:** last 5 ticks `ok=true`, rows_written 14, **no `activity_discovery_error`** — the flaky Magic Eden activities page did not recur; the degrade branch has not had to fire. Watch: a future `ok=false` tick should now show `rows_written > 0`.
- **DB migrations:** all 5 new fns present (`get_rpc_traction_activity`, `delete_user_account`, `claim_welcome_email`, `record_welcome_email_failure`, `purge_old_funnel_events`). `user_profiles` welcome_state = `pre_existing:38` (every existing profile backfilled; nobody spuriously welcomed), **welcome_errors 0**.
- **Pipelines:** **0 unexplained hard-fails in 24 h** (excluding the known #58 / by-design / upstream lanes).

## Queued — carried forward (all gated on others; +1 night)
Numbered for mechanical reading; none is a neglected P1 (the chain-arrival P1 was closed 10-09 and is no longer carried).

1. **[P-med, Trevor, ~19 nights] #58 OPENSEA_API_KEY** — candy-opensea listings/offers/sales indexers 100 % fail on the missing env var; also the Panini half. One env var in Vercel (all envs) + redeploy closes both. **Shelved by Trevor's own call 09-23** (Candy is green via Magic Eden; OpenSea is additive), so this is a dormant decision, not neglected work.
2. **[P-low, operator-blocked, since 08-22] #23 / #25** — 25 edge functions not running `main`; the three daily drift detectors (edge-fn-drift, db-pin-staleness, migration-parity) have no sentinel arm, so a correct red detector goes unnoticed. Blocked on a GitHub token with `actions: read` in Vercel env + the redeploy footgun (needs `deno.json` in `files` + `import_map_path`).
3. **[P-low, Claude Code, ~2 nights] `topshot_offers_history_backfill` cursor_stalled HIGH** — FALSE POSITIVE from a completed one-time backfill (`done=true`, no cron). Retire by excluding done backfills or retiring the event_cursor row. Owns-offers-lanes → Claude Code.
4. **[watch only] topshot-misattrib-drain #101** — 987 open candidates, draining (1,485→987). No action; watch it falls below 500.
5. **[P-low, Trevor] topshot-active-listings-ingest feeder** — the residential box being dark stalls the TS live-listings feed (visibility-only). No code fix; box availability or a second datacenter-independent feeder.
6. **[operator-gated, Trevor] 0410Z drop_scratch residue** — items 1+2 (dedupe + drop) already RAN 10-10; the remaining ~185 MB `flowty_archive` scratch is destructive/SQL-editor-only, Trevor's call.

## Failed / blocked / reverted
None. Nothing shipped (off-hours monitor-mode + nothing novel+low-risk surfaced); nothing to revert (post-ship watch clean).

## Output
- Ledger: one `### 2026-10-12` entry spliced above the first `### ` (revert n/a, docs only).
- `metrics-latest.json` overwritten with tonight's values.
- This handoff committed + pushed (device-VM clone + `.rpc-git-cred`) and mirrored to the claude.ai Project.
- Inbox untouched (append-only; the one filing already resolved).
- Lock released.
