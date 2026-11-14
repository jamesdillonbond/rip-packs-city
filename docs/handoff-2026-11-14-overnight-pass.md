# Overnight pass — 2026-11-14 (~1:00–1:40 AM PT, Cowork cloud)

> ⚠ **Environment scope:** this run executed in a **cloud session** linked to Trevor's laptop. Push went through the **laptop-VM clone + `.rpc-git-cred`** route (the cloud `add_repo` tool was absent this run). Trevor's own machine and Claude Code push normally via Git Credential Manager — **commit as usual.** Nothing here is blocked by an environment limit; push was AVAILABLE (dry-run exit 0) and all docs below were committed + pushed to `main`.

**Verdict: GREEN · 1 shipped (attended follow-up after Trevor "Fix it all") · 0 queued.**

> **Update ~7:35 AM PT:** Trevor replied "Fix it all", so the one queued item below was shipped: the `atlas-market-events-prune` deadlock fix (`20261114153229`). See **Shipped**. The overnight body below is preserved as-written.

A quiet, honest night. Full health sweep clean, accuracy in band, no regression from the heavy 11-13 day ships. One genuinely new candidate (a harmless, self-healing 40P01 deadlock) was investigated end-to-end and **queued, not shipped**, because its fix replaces a live SECURITY DEFINER function (outside the additive autonomous SHIP set) and the log DETAIL that would positively name the lock partner is dropped by Supabase's log stream.

## Gates
- **Clock:** no skew. shell/VM `date -u` 09:02:35Z vs DB `now()` 09:02:44Z; newest sale ingest 08:54Z, newest FMV 08:54Z. Real local time ≈ **1:02 AM PT** → genuine overnight window, normal shipping permitted.
- **Lock:** was RELEASED (11-13 pass, pushed `7727d446b`). Taken `HELD 2026-11-14T09:03Z overnight-pass a40d6bc8`; released at end.
- **FREEZE:** none.
- **Push:** AVAILABLE. VM clone `$HOME/rpcwork` on `main`; `git push --dry-run` exit 0 via `.rpc-git-cred`. Cloud `add_repo` tool absent this run → VM route (path 1).
- **Collision gate:** origin/main `4c50ca86` at clone and unmoved through the pass (no concurrent push).

## What was reviewed
- **Continuity:** ledger top matter (current, not stale), `metrics-latest.json` (11-13), focus.md steers, `ops:ready-queue`, the 11-13 overnight handoff.
- **Carried queue (11-13):** **empty** — all three 11-12 items closed before this pass (mv_panini_squeeze_retired DROP applied 11-12; Candy Titan/Unique/Rainbow = tier_absent_at_source; candy-editions-ingest 01:10Z stagger cleared). `ops:ready-queue` confirmed 0 still-open.
- **Inbox since 11-13:** 4 filings dated 2026-11-14 —
  - `2026-11-14T0709Z` daytime monitor — **atlas-market-events-prune 40P01 deadlock, new today (2/48), LOW/harmless** → the night-pass candidate; **QUEUED** (see below).
  - `2026-11-14T0420Z` Claude Code → Cowork: firewall CHALLENGE rule for the Tencent Cloud scraper (#235) → **not mine** — a persistent-config/firewall change already routed to an attended Cowork session; left for Trevor/attended.
  - `2026-11-14T0120Z` / `2026-11-14T0020Z` — both **already applied 11-13** (#247 alias work); dispositions recorded in the 11-13 ledger. No action.
  - Inbox left untouched (append-only).

## Health-drift findings + deltas
Fast baseline `rpc_ops_snapshot()` + drill-downs:
- **Security:** clean — invariants [], anon_write_holes [], rls_off_base_tables [], secdef_anon_violations [].
- **Trust:** 0 breaches. `edition_integrity_flags` **8** (was 34; the 11-13 residual migration `20261113200000` took it the predicted 34→~8). precompute fresh 5.28 h, so the zero is real.
- **Stalled:** the 09:04Z snapshot flagged `topshot-pack-supply-atlas` silent 32 min — a **transient by-design hold** while the Atlas market lane is mostly Cloudflare-403s; it resumed at 09:05Z and runs every minute at ~0.2 s. Not a real stall.
- **pg_cron fails 24h:** all the chronic Atlas Cloudflare lanes (`topshot-pack-supply-atlas` 30, `atlas-pack-market` 19, `atlas-editions-refresh` 8, `atlas-market-feed` 7, `pack-nft-identity` 6, …, `atlas-market-events-prune` 2). Every row `upstream=0`, self-retrying, no data lost. `check_when_others_timeout_blind` **0**.
- **Zero-yield:** offenders **[]** (inspected 393, suppressed 5, excluded_by_writes 1).
- **Sentinel:** TS-48h 0, ts_uuid_dupes 0, wmc_null_edition_key []. pipeline_alerts 5 (1 medium = the hold above, 4 info by-design).
- **Accuracy gate (`fmv_sales_backtest`, 7 d) — in band:**
  - Top Shot published ALL `median_ratio` **1.000** (12.9% median abs err, within-25 68.0%); HIGH **1.000** (10.0%, within-25 79.5%); `last3_median_30d` ALL 1.000. (ASK_ONLY/STALE published 2.000 are the by-design buckets.)
  - All Day published ALL **1.000** (16.7%, within-25 63.5%); HIGH **1.000** (13.6%, within-25 74.3%, abs_err $0.02). No ALL/HIGH ratio outside 0.90–1.10.
- **Vercel 24h:** 17 error groups, **all count 1–3**, all known-chronic (candy top-collectors, set activity, panini_deal_board_all, allday/pack-detail 5 s lifecycle reads, cost-basis 8 s, Panini premiums 8 s, market-cap edition 8 s) **or** the 11-13 12:00Z cold-sweep cluster (franchise-hub `get_team_activity` 45 s, player-hub matt-manning/joey-bart 4 s — investigated and resolved 11-13 as a concurrent cold sweep, not query cost). `pack-summary` 57014 (1, 04:13Z) is the **known cold tail the 11-13 UI-retry ship tolerates**; `/api/sentinel` "Email send failed" (1, 05:04Z) a transient Resend timeout. **No new crash group.** Giveaway/signup clean. (Sentry dark since 08-18 #34 — not a health signal; GREEN rests on the Vercel groups being chronic per the pairing rule.)
- **Production:** `0b61a0fc` (dashboard packs expanded-pack) **READY**. The tip `4c50ca86` is a docs-only monitor-inbox commit whose Vercel build was skipped (state CANCELED) — by-design for a docs-only diff, no runtime impact.

### Metric deltas vs 11-13 ~1:15 AM PT
- `edition_integrity_flags` 34 → **8** (residual migration landed).
- Trust breaches 0 → **0**.
- DB size 51,769 → **52,252 MB** (+483; net._http_response sawtooth + Candy churn).
- FMV HIGH+MED: nba 6,977 → 6,844; panini 20,065 → 20,208; nfl 1,787 → 1,764; pinnacle 983 → 984.
- Editions: candy_mlb 24,414 → **21,472** (−2,942; #247 alias-edition retirement + orphan cleanup drained); panini 45,902 → 46,556 (+654); nba/nfl/golazos/ufc flat.

### Post-ship watch on the 11-13 ships — CLEAN
- **#247 alias-edition retirement** (cron 878, every 15 min): **drained** — last non-zero delete 435 at **7:07 PM PT 11-13**, `deleted=0` every tick since (through 01:07 AM PT 11-14). Confirms the 11-13 "✅ CLOSED #247" entry.
- **pack-history v27/v28/v29** functions live; `/api/wallet/pack-summary` cold tail is handled by the new UI retry (single 57014 in 24 h, not a crash).
- **pg_net request log (#241)**: capturing; `edition_integrity_flags` decline matches intent. No regression attributable to any 11-13 ship.

## Shipped
- **`atlas-market-events-prune` 40P01 deadlock — FIXED** (migration `20261114153229`, ~7:32 AM PT; Trevor: "Fix it all"). md5-asserted catalog splice appended `FOR UPDATE SKIP LOCKED` to the prune's oldest-first temp-page SELECT in `prune_topshot_atlas_market_events(int,int)` so it never waits on a tuple the concurrent `atlas_market_upsert_events` upsert holds (partner-agnostic; guards 1/2 and ordering unchanged; prune is idempotent so skipped rows return next tick).
  - **Evidence:** base body md5 `e98dbcf6…` → `6dd86d4f…`; anon/authenticated EXECUTE preserved false; SECURITY DEFINER + search_path preserved. SKIP-LOCKED+ORDER BY+LIMIT pre-validated read-only (locked 5). **Positive control (real caller):** `SELECT prune_topshot_atlas_market_events(7,20000)` post-splice ran clean — page 1171 / deleted 1171 / error null / kept_hydration 0. **Independent subagent verification: PASS** (live body has exactly one SKIP LOCKED, both guards + base DELETE intact, anon/auth EXECUTE false, version recorded, no new deadlock row after 15:32Z).
  - Migration file `supabase/migrations/20261114153229_audit_20261114_prune_tame_market_events_skip_locked.sql` committed (self-asserting DO block; inverse-splice revert in the header).
  - **Revert:** the inverse splice in the migration header (removes the clause, base md5 `6dd86d4f…` asserted). **Watch (target metric):** 0 `deadlock detected` rows for `atlas-market-events-prune` in `pipeline_runs` over the next 48 h (was ~2/day; the two pre-fix rows were 17:27 & 21:27 PT on 11-13).

## Resolved this session (was queued) — nothing open

**✅ SHIPPED — see the Shipped section above.** The item below is the original diagnosis, kept for the record; it is CLOSED (applied as `20261114153229`, subagent-verified PASS).

1. **[✅ SHIPPED 2026-11-14] `atlas-market-events-prune` 40P01 deadlock — ready `FOR UPDATE SKIP LOCKED` splice (not autonomous-SHIP-eligible: replaces a live SECURITY DEFINER fn).**
   - **What it is:** `prune_topshot_atlas_market_events(7, 20000)` (jobid 473 `rpc-prune-atlas-market-events`, hourly at `:27`) DELETEs aged `completed` `nba` rows from `topshot_atlas_market_events`. It threw `deadlock detected` on **2 of 48** runs today (05:27Z, 01:27Z); none in the prior 48 h.
   - **Why it is harmless:** the DELETE sits inside the function's own `BEGIN … EXCEPTION WHEN query_canceled OR OTHERS` block, so the 40P01 rolls back that block, is logged `ok=false`, and the function returns normally. The prune is idempotent — the next `:27` tick re-prunes the same aged rows. **No data is lost** (confirmed: 20:27 ok after 21:27… the fail at 21:27 PT was followed by 22:27 ok=true deleting the aged rows).
   - **Lock partner — inferred, NOT log-confirmed:** `process … detected deadlock while waiting for ShareLock on transaction …` = an overlapping-tuple row-lock race. The only concurrent *writer* that can hold those tuples is **`atlas_market_upsert_events`** (the feed upsert — the sole INSERT/ON-CONFLICT on the table; the other two writers are narrow UPDATE paths). Supabase's log stream drops the deadlock DETAIL/CONTEXT lines (the `query` fields come back empty), so the exact partner statement could not be read — which is precisely the precondition the monitor set ("after confirming the lock partner").
   - **Ready fix (partner-agnostic, reversible):** append `FOR UPDATE SKIP LOCKED` to the temp-page SELECT so the prune never *waits* on a tuple a concurrent writer holds — it skips it this tick and takes it next tick (guards 1/2 unchanged, order unchanged). This eliminates the deadlock regardless of which writer is the partner, so partner confirmation is not required for this specific fix. Apply as a catalog splice (`pg_get_functiondef` → insert the clause → `EXECUTE`, md5-asserted base), with the migration file and a pin; `apply_migration` under the exact recorded version:

     ```sql
     -- in prune_topshot_atlas_market_events, change the temp-page build:
     CREATE TEMP TABLE _tame_prune_page ON COMMIT DROP AS
     SELECT ev.uuid, ev.nft_id
       FROM public.topshot_atlas_market_events ev
      WHERE ev.product = 'nba' AND ev.completed AND ev.last_seen_at < v_cutoff
      ORDER BY ev.last_seen_at
      LIMIT p_max
      FOR UPDATE SKIP LOCKED;   -- <<< the only change
     ```
   - **Why queued, not shipped:** (a) it replaces a live SECURITY DEFINER function — outside the additive autonomous SHIP set (new views/indexes/comments/read-only RPCs); (b) the value is low (harmless, self-healing, ~4% of hourly runs) so it does not warrant spending a production ship unattended; (c) a pin test (positive control: a planted body without the clause still deadlocks under concurrent load; the fixed body cannot wait) should accompany it. Revert = re-apply the prior body (remove the clause).
   - **Alternatively:** leave as-is. It is genuinely harmless; the only cost is 2 `ok=false` rows/day that never escalate.

## Failed / blocked / reverted
None. No production change was attempted, so nothing was reverted and shipping was not hard-stopped.
