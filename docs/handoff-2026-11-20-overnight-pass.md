# Overnight pass — 2026-11-20 (Cowork cloud, VM blob:none clone + .rpc-git-cred push)

**Run:** genuine overnight (~1:03 AM PT start). Clock verified vs DB — shell/VM 09:03Z = DB `now()` 09:04Z, newest sale 09:03Z, newest FMV 08:48Z; **no skew**. Push **AVAILABLE** (laptop-VM `.rpc-git-cred` route; dry-run clean, `ls-remote` = HEAD `b3a6481b1`). Not frozen. Lock was RELEASED (prior `cowork-20261119T090439Z-21952`, pushed `4115ee681`), taken over as `cowork-20261120T090325Z-9893`.

**Verdict: GREEN, quiet-and-honest night. 0 production changes shipped.** Every candidate was already-closed, off-limits, a product decision, or blocked by the permission classifier. Post-ship watch of last night's heavy evening pass is fully clean.

---

## Reviewed
- **Health baseline:** `rpc_ops_snapshot()`. Security all `[]` (invariants / anon_write_holes / rls_off_base_tables / secdef_anon_violations). `detect_stalled_pipelines()` `[]`. Sentinel `sentinel_ts_uuid_editions_48h` 0, `ts_uuid_dupes_created_24h` 0.
- **Inbox drained (none moved — append-only; dispositions here):**
  - `2026-11-20T0705Z` daytime monitor — **Candy revival breach $429.83** → QUEUED (product/wording decision, below). **Remap one-off IO-timeout** → attempted, permission-denied, self-heals.
  - `2026-11-20T0105Z` daytime monitor (pinnacle-pack-ev 403) → **already CLOSED 11-19** (`20261119171500` caps the Atlas challenge at medium; the `requests_challenged` reclassification was deliberately declined on the write-honesty rule). No action.
  - `2026-11-20T0005Z` Claude Code (`get_set_activity` sparse wide set) → **already CLOSED 11-19 by measurement** (no winning shape; the only cheap gate regresses Top Shot 33k buffers). Reopen trigger "Candy revival breaches" is now technically met, but the measured conclusion is unchanged — a Candy-only branch for one crawler-hit page on a thin market is not worth a Top Shot regression. No action.
  - `2026-11-19T1605Z` (candy-wmc-ghost-purge timeout) → **resolved**; see post-ship watch.
  - Older 11-17/11-18 filings already carry ✅ RESOLVED markers from the 11-19 evening pass.
- **Known-issues register:** 259 items, 245 closed / 7 partial / 7 open. Remaining partials (#66 Search Console accuracy half, #181, #189) are long-standing decision/measurement items; nothing new, nothing overnight-shippable.
- **Git:** prod `main` tip `b3a6481b1`; files committed in the last 48 h are all last night's evening-pass work (hot-file gate noted — none touched).

## Health-drift findings + deltas
- **One trust breach, known + sense-only:** `candy_revival_sales_since_recorded_silence` = **$429.83** (floor 250). This is the arm working as designed — Candy resumed real trading (11-19: 44 sales, 15 buyers, 23 sets, incl. a 2026 set). `candy_sales_stale_hours` 4.8 h/ok confirms flow. No user-facing staleness. See QUEUE.
- **All other trust arms ok** (`v_rpc_trust_health` status<>'ok' → only the candy_revival row; no UNKNOWN rows). `fmv_sanity_flags` 0, `edition_integrity_flags` 8, `topshot_impossible_parallel_serials` 0.
- **pipeline_alerts:** all medium/info. Mediums are the recovering #218 Dapper Studio 530 window (3-day pool) + designed Atlas Cloudflare base-rate (~5–15 %) lanes; several #218-pooled rows streak-split to info. `topshot-pack-supply-atlas` 38 fails/24h = the designed Atlas 404/403 challenge base-rate on a per-minute cadence (~2.6 %), nothing lost (tick re-asks). **0 HIGH/CRITICAL.**
- **Deltas vs 11-19 metrics:** db 55,451 → **57,936 MB** (+2,485). Editions: panini 49,346 → **51,071** (+1,725), nba flat 15,151, candy +1. FMV HIGH+MED: nba 7,172→7,027 (−145), panini 21,082→**21,852** (+770), nfl 1,803→1,759 (−44), pinnacle 981→973 (−8), candy 6→9 (+3), golazos 1→0, ufc 0. Trust breaches 0 → 1 (candy_revival; Candy trading resumed).

## Post-ship watch — last night's evening pass (all CLEAN)
- **Panini stored board MV (`6efd74e`, `ff383f0b`):** `panini-market-board` last 6 runs all ok (06:37Z 83.6 s under cron_heavy's 600 s ceiling, 07:37Z 14.5 s, 08:37Z 20.5 s). The one `55006` ok=false at 06:07Z is the known concurrent-refresh transient; the 10 s-later retry succeeded. **Only jobid 898** (`37 * * * *`, cron_heavy) is scheduled — the old 30-min jobid 896 was correctly unscheduled, no duplicate work. No "panini stored board err, reading live" expected.
- **TopNav + share CTA "stole it" fix (`6f87d4a76`):** `usage_events.client_error` with "stole it" = **0 in 48 h**. Holding.
- **candy-wmc-ghost-purge prefilter fix (`20261119110000`):** the 11-20 09:10Z tick **succeeded in 33.4 s** ("1 row") — well under the 60 s regression line (11-19 had timed out at 2 min pre-fix). Fix confirmed.
- **apply-fmv-haircut HEAVY_LAST fix:** `HEAVY_LAST_SLUGS={nba_top_shot}` is deployed in prod `ff383f0b0`. The only run since (11-19 22:35Z / 2:35 PM PT, legs_skipped=3) is the **pre-fix** run that motivated the fix. Its falsifier (legs_skipped 0 or only nba) fires at the **next daily tick, 2:35 PM PT 11-20** — after this pass. Re-check tomorrow.
- **failure_rate caps (`20261119171500`, `20261119214500`):** compute-pinnacle-pack-ev and pinnacle-wmc-render-id read medium (not high) as intended; 0 HIGH rows this sweep.
- **Vercel:** prod = `dpl_8J1T1y1S1gErzCTeH7m8QV3myDL6` = `ff383f0b0` **READY** (rollback candidate). The newer CANCELED deploys are all docs-only tips (correct — docs-only suppresses the build). No ERROR deploys.

## Shipped
None.

## Attempted but blocked
- **`remap_topshot_from_onchain_map()` one-off** (daytime inbox candidate 2): the daily `rpc-topshot-misattrib-remap` pg_cron job hit a one-off IO-spike statement timeout at its 11-20 05:53Z slot, leaving today's Top Shot sale re-attribution one day behind. I attempted to run the function once in this quiet window (it is a plpgsql FUNCTION → single transaction → a timeout rolls back cleanly, zero partial-write risk; it is the exact idempotent operation the daily job runs). **The Cowork permission classifier denied the call** (flagged the write as destructive) — same block the 11-19 evening pass hit for the pg_cron one-off. Not worked around. **Self-heals on the 11-21 05:53Z daily tick.** Low urgency (one-day lag in sale attribution; no user-facing staleness). If Trevor wants it closed sooner, run `SELECT public.remap_topshot_from_onchain_map();` by hand (50–120 s).

## Queued — needs Trevor's decision
- **Candy marketplace status row — re-verify, and decide the wording (NOT a blind re-date).** `candy_revival_sales_since_recorded_silence` breached ($429.83 > $250) because Candy is **genuinely trading again**, not trickling: 11-19 had 44 sales / 15 buyers / 9 sellers / 23 sets, first 5:50 AM–last 8:15 PM PT, incl. a 2026 set (2026 MLB Base Series ICONs, 4 sales). The `v_collection_marketplace_status` candy_mlb row reads `silent_since_2026_11_17`. The arm clears when that row is re-verified, but **a sixth re-date of `silent_since` would record a falsehood** (the market is open, not silent). The honest options are (a) flip the status to open/thin, or (b) re-date to a genuine recent silence if one exists. Which the user-facing status should say when a market is open-but-thin is a wording/product call (flagged the same way by the 11-19 evening pass). Sense-only; harmless to leave until decided. **Night-count: 1.**

## Failed / reverted
None. No shipping, so no hard-stop triggered.

## Not read this run (chronic, not load-bearing)
- The three daily instrument logs (edge-fn-drift / db-pin-staleness / migration-parity) need `gh api .../actions`, which stays blocked in scheduled cloud sessions (known-chronic #23). Same as prior passes.
