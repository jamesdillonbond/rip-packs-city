# Handoff 2026-06-18 — Audit follow-ups (route + function fixes Cowork can't push)

Plain text, iPhone-pasteable. Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

## Context

The 2026-06-18 full platform audit (docs/audits/full-platform-audit-2026-06-18.md) found the platform GREEN with one operational yellow flag and a few polish items. Cowork already shipped the one safe live fix this session: migration audit_20260618_pinnacle_editions_fix_double_encoded_mojibake (de-mojibake'd pinnacle_editions display strings — verified 0 remaining). This handoff covers the items that require route/.tsx/worker changes or touch hot CC-owned alerts code. Current prod HEAD at audit time: ac50ae1 (READY). Items are in priority order.

## Item 1 (priority) — Lower topshot-buyer-backfill BATCH 200 to 150 to clear the 600s lambda ceiling

File: app/api/admin/backfill-topshot-buyers/route.ts (line 25: const BATCH = 200)

Why: The after() drain does one ~2.9s on-chain decode (decodeTopShotSaleTx) per row, so BATCH=200 → ~577s runtime against export const maxDuration = 600 (line 33). That is only ~23s of headroom. A single run that tips over 600s dies silently at the Vercel lambda ceiling BEFORE the finally block writes its pipeline_runs row — the invisible-failure class — which stalls recent-sales buyer resolution and reads as a "silent cron gap." Measured run durations the last 24h: 577s, 552s, 576s, 577s, 539s, 505s. This is creeping into the cap.

Change: const BATCH = 200  →  const BATCH = 150. (150 × ~2.9s ≈ 435s, comfortable headroom under 600.) Leave maxDuration = 600 and TX_DECODE_DELAY_MS = 40 as-is.

Throughput is fine after the change: recent (7d) TS sales are 83% buyer-resolved; 150/run × ~10 runs/day = ~1,500/day, far above the ~270/day new-null inflow. The 208,719 total null-buyer backlog is overwhelmingly a historical 2020→ tail (only ~3,000 rows are <30 days old) and is low priority.

Revert: set BATCH back to 200.
Verify: npx tsc --noEmit clean; Vercel deploy READY; over the next 12h, pipeline_runs for topshot-buyer-backfill show duration_ms comfortably < 600000 and keep logging ok=true.

## Item 2 — Add a 0-active-subscription early-exit to dispatch_due_deal_alerts (DB migration)

What: The dispatcher has SET statement_timeout TO '45s' and, even when there are zero active subscriptions, it still materializes BOTH deal-board temp tables on every run (DROP/CREATE TEMP TABLE tmp_deal_pool FROM cross_collection_deals_board, and tmp_serial_pool FROM topshot_underpriced_serials_board). Under DB load that build alone exceeds 45s — pipeline_runs shows alerts-dispatch failing "deal: canceling statement due to statement timeout" ~3x/24h. It is harmless TODAY (0 subscriptions → nothing would be delivered anyway), but it is noise now and will matter when alerts go live.

Fix (ship as a migration; pull the current body with pg_get_functiondef, insert the guard right after BEGIN — before the first "DROP TABLE IF EXISTS tmp_deal_pool;" — then CREATE OR REPLACE). Same signature (p_max integer) so grants are preserved; v_bucket is already assigned in DECLARE. Guard to insert:

  IF NOT EXISTS (SELECT 1 FROM public.alert_subscriptions WHERE active = true) THEN
    RETURN jsonb_build_object('subscriptions_scanned',0,'enqueued',0,'serial_enqueued',0,'deal_pool_size',0,'serial_pool_size',0,'bucket',v_bucket,'ran_at',now(),'skipped','no_active_subscriptions');
  END IF;

This is purely additive: when subscriptions exist the guard passes and behavior is identical.

Scale path (do when subscriptions are turned on, not now): the temp-table builds are the cost driver even with the early-exit removed once subs exist. Either bump the function statement_timeout 45s→90s (the cron route's maxDuration must cover it), or refresh the two boards into a materialized/cached table on a separate cron and have the dispatcher read the cache instead of the live views each run.

Revert: CREATE OR REPLACE the function body without the guard (re-fetch the pre-change body first).
Verify: SELECT public.dispatch_due_deal_alerts(1000); returns fast with "skipped":"no_active_subscriptions" while subs are 0; pipeline_runs alerts-dispatch stops logging the deal-leg timeout. check_secdef_anon_execute_violations() still []; check_public_security_invariants() still clean.

## Item 3 (durability) — Stop the Pinnacle mojibake from coming back

Why: Cowork's one-time data fix corrected pinnacle_editions, but the double-encoding originated upstream (pinnacle_catalog is written correctly with real • / ™, so only the pinnacle_editions write path double-encodes). There is a BEFORE INSERT OR UPDATE trigger trg_normalize_pinnacle_edition → normalize_pinnacle_edition() on the table that did NOT catch this (it normalizes tokens/whitespace, not byte-level double-encoded UTF-8). Set names are static catalog data so the fix will likely hold, but make it durable.

Two options (pick one):
- (a) Fix the writer: find where pinnacle_editions.set_name/franchise/character_name are populated (likely the Pinnacle catalog/edition seed path — grep for inserts/upserts into pinnacle_editions; candidates: the pinnacle catalog backfill route, scan-pinnacle-wallet / pinnacle-nft-resolver edge fns) and decode the GraphQL string correctly (it is being read as Latin-1 and re-encoded as UTF-8). Mirror whatever pinnacle_catalog's writer does, since that one is correct.
- (b) Harden the trigger: add a de-double-encode pass to normalize_pinnacle_edition() so any future write self-heals. The exact transforms (proven this session): replace(replace(x, chr(226)||chr(128)||chr(162), chr(8226)), chr(226)||chr(132)||chr(162), chr(8482)) applied to set_name, franchise, character_name. chr(8226)=• , chr(8482)=™.

Revert: option (a) git revert the writer commit; option (b) CREATE OR REPLACE normalize_pinnacle_edition() without the de-double-encode pass.
Verify: re-run the audit count — SELECT count(*) FROM pinnacle_editions WHERE set_name LIKE '%'||chr(226)||'%' OR franchise LIKE '%'||chr(226)||'%' OR character_name LIKE '%'||chr(226)||'%' should stay 0 after the next Pinnacle ingest cycle.

## Item 4 (polish) — /insights/underpriced-serials freshness honesty

Why: At audit the board read "UPDATED JUN 17, 2026, 10:49 PM" (~9h stale) while the page copy promises "Every row is a live, buyable deal." The Atlas listings ingest runs from a residential home-machine runner every 3h (Atlas WAFs datacenter IPs) and appears to skip overnight, so the board can silently go stale.

Two parts:
- Operator/infra: confirm or repair the Atlas residential runner's overnight schedule so the board refreshes on its ~3h cadence around the clock.
- Optional frontend (app/insights/underpriced-serials/UnderpricedSerialsBoardClient.tsx + the server page app/insights/underpriced-serials/page.tsx): compute the age of the board's max updated timestamp and, when it exceeds ~4-6h, show a muted "Listings last refreshed N hours ago" caption near the UPDATED line instead of implying real-time. Keeps the surface honest when the runner lags.

Revert: git revert the frontend commit; runner schedule is an ops change.
Verify: tsc clean, deploy READY, board shows the staleness caption when the source timestamp is old.

## Guardrails (every item)

- Commit and push directly to main. No branches, no PRs (CLAUDE.md non-negotiable). If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify the push with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s — anything higher sends the deploy to ERROR invisibly. (Item 1 stays at 600.)
- CRLF: don't string-replace-patch on Windows; use full-file writes or findIndex on split lines.
- After Items 2/3 (DB), log them in CLAUDE.md Recent sessions + docs/overnight/ledger.md with the exact revert command. Also add the ledger entry for the Cowork mojibake migration audit_20260618_pinnacle_editions_fix_double_encoded_mojibake (Cowork did not edit ledger.md to avoid the large-file truncation hazard).

## Expected end state

Item 1: buyer-backfill BATCH=150 on main, deploy READY, run durations < 600s. Item 2: dispatch_due_deal_alerts early-exits at 0 subs, alerts-dispatch timeout fails stop. Item 3: pinnacle mojibake cannot reappear on re-ingest. Item 4: the deal board is honest about staleness. None of these touch FMV/pricing/auth/secrets.
