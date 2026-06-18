# Handoff 2026-06-18 — Next batch: AllDay deal alerts, FMV throughput, alerts go-live

Plain text, iPhone-pasteable. Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape.

## Context

The 06-18 audit follow-ups are all shipped (prod d5f5f40 READY): buyer-backfill batch, dispatch 0-sub early-exit, pinnacle mojibake hardening, board staleness caption. Trevor greenlit pushing all four next directions. Cowork confirmed feasibility/current state via the DB (read-only); the route + dispatcher + UI builds below are CC's. None of this touches auth/secrets/hot-wallet.

## Section B (biggest) — Extend deal alerts + the deal board to NFL All Day

Why: the cross-collection deal board and /alerts cover only Top Shot + Pinnacle today (607 + 23 rows). AllDay is the next-most-valuable secondary market and the data to back it is already live.

Feasibility CONFIRMED (measured 06-18): cached_listings_v2 holds 18,738 ACTIVE AllDay listings (completed_at IS NULL) across 3,990 distinct editions, latest ingested 18:17Z (a live ~real-time feed, source 'direct_v1'). AllDay FMV exists: 231 HIGH + 591 MEDIUM (+ LOW). So AllDay floor-ask vs FMV deals are buildable now.

Current structure: cross_collection_deals_board is a UNION ALL of two legs — leg 1 = the topshot_deals_vs_fmv view, leg 2 = pinnacle_catalog inline (the Pinnacle gate: fmv_usd>0, floor_ask>=1, fmv_confidence IN HIGH/MEDIUM, fmv_sales_count_30d>=8, floor_ask_updated_at > now()-3d, floor_ask<fmv_usd). Add a 3rd AllDay leg.

Build (CC, in order):
1. Pre-aggregate the AllDay floor-ask. Add a helper — either a view allday_edition_floor_ask or (better for dispatcher perf) a small table refreshed by the existing allday-listings cron — that is one row per edition_id: floor_ask = min(price_usd) over cached_listings_v2 WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070' AND completed_at IS NULL AND price_usd>0 (and listed within ~3d for freshness), carrying that min listing's serial_number / nft_id / listing_resource_id / listed_at. PRE-AGGREGATE — do NOT put a LATERAL min over the 54k-row cached_listings_v2 directly inside cross_collection_deals_board; the dispatcher materializes that whole board into a temp table every run and is already near its 45s statement_timeout (see Section A / the 06-18 Item 2 fix). A pre-aggregated helper keeps the board leg a cheap join.
2. Add the AllDay UNION ALL leg to cross_collection_deals_board, shaped to the existing columns (external_id, name, player_name, set_name, tier, circulation_count, fmv_usd, confidence, low_ask, discount_pct, discount_usd, ask_updated_at, collection_slug, collection_name, render_id, detail_url, thumbnail_url, low_ask_serial, low_ask_nft_id). Source: editions e (collection_id=AllDay) JOIN the helper (low_ask = floor_ask) JOIN latest AllDay FMV (DISTINCT ON (edition_id) ... ORDER BY computed_at DESC) f. Gate mirrors Pinnacle: f.fmv_usd>0, f.confidence IN ('HIGH','MEDIUM'), low_ask>=1, low_ask<f.fmv_usd, ask fresh. collection_slug='nfl_all_day', collection_name='NFL All Day', render_id NULL, detail_url '/nfl-all-day/edition/'||replace(external_id,':','%3A'), thumbnail_url e.thumbnail_url, low_ask_serial/nft_id from the helper. Keep security_invoker semantics consistent with the current board; CREATE OR REPLACE preserves grants.
3. UI: add "NFL All Day" to the Collections multiselect on app/alerts/page.tsx (today it lists only NBA Top Shot + Disney Pinnacle). AllDay deals flow the dispatcher's Pass-1 edition-level path; the serial/jersey/badge filters are TS-only Pass-2 and stay unaffected.
4. Verify: SELECT collection_slug, count(*) FROM cross_collection_deals_board GROUP BY 1 now shows nfl_all_day; time the tmp_deal_pool build inside dispatch_due_deal_alerts and confirm it stays well under 45s; build_deal_alerts_for_subscription preview returns AllDay deals for an AllDay-scoped sub.

Revert: CREATE OR REPLACE cross_collection_deals_board without the AllDay leg; DROP the helper; remove the UI option.

## Section D — FMV quality is throughput-bound (not a coverage gap)

Measured 06-18, latest-confidence x recent-sales for Top Shot:
- NO_DATA 3,525 and ASK_ONLY 2,621 have ~0 sales in 30d → structurally un-pricable (troll-ask / no-sale tail). Correct as-is; leave them.
- 497 STALE editions are ACTIVELY TRADING (>=1 sale/30d; 116 with >=3) — mislabeled STALE only because fmv-recalc's cursor has not re-priced them recently.
- 2,623 LOW editions have >=3 sales/30d — escalation candidates to MEDIUM/HIGH via the serial-residual confidence gate once re-evaluated.

Action (operator/CC — throughput, NOT a writer-logic change, which is why Cowork did not touch it): raise the "RPC FMV Recalc Force Stale" cron cadence and/or run a targeted fmv-recalc pass over the union of {497 STALE-with-recent-sales, 2,623 LOW-with->=3-sales} so they re-price/escalate. This is the lever that moves TS HIGH+MED up from the current 3,136 toward ~4,000. No FMV formula change.

Serial-FMV power model (serial_fmv_power_model, weekly pg_cron job6) validation: well-fit for RARE (r .80, n125), LEGENDARY (r .80, n54), perfect/ALL (r .74, n41); COMMON-first is weak (r .44, n167, is_reliable=true); FANDOM-first is correctly is_reliable=false (negative beta, suppressed). One optional refinement: treat COMMON #1 as a 'coarse' (~) estimate on the Underpriced #1s board even though the segment is flagged reliable — its variance is high (the board already marks Common #1s coarse via the population multiplier path, so confirm there's no double-counting).

## Section A — Alerts go-live (the retention lever) is unblocked

Pipes are LIVE end-to-end (measured 06-18): alerts-dispatch 96 runs/24h, alerts-send 144 runs/24h, and all three of Trevor's channels (email, telegram, discord) are verified. 0 active subscriptions today, so nothing dispatches (the Item 2 early-exit is confirmed working).

To test end-to-end (Trevor, via the UI — no SQL needed): logged in, go to /alerts, create an alert (e.g. min discount 25%, leave collections = all, cadence instant), save. The next alerts-dispatch tick (~15 min) matches the live deal board and alerts-send delivers a digest to your email/Telegram/Discord. Confirm receipt on each channel, then decide whether to open alerts to the 25 allow-listed users (e.g. a one-line in-app nudge or a direct note).

Go-live caveat (pair with Item 2 scale path): once subscriptions are active the dispatcher materializes the deal boards every run, and that build is already near the 45s statement_timeout. Before opening to multiple users, do the Item 2 scale path — bump dispatch_due_deal_alerts statement_timeout 45s→90s (the alerts-dispatch route maxDuration must cover it) OR refresh the boards into a cached table on a separate cron and have the dispatcher read the cache. This matters more once Section B widens the board with AllDay.

## Guardrails (every item)

- Commit and push directly to main. No branches, no PRs. If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify the push with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s — higher sends the deploy to ERROR invisibly.
- New/changed public views ship WITH (security_invoker = on); re-check check_public_security_invariants() and check_secdef_anon_execute_violations() = [] after DB changes.
- Log DB changes in CLAUDE.md Recent sessions + docs/overnight/ledger.md with revert commands.

## Expected end state

AllDay deals appear in cross_collection_deals_board + /alerts; the dispatcher materialization stays under 45s (scale path applied); TS HIGH+MED climbs via recalc throughput; alerts are tested end-to-end and ready to open to the allow-list.
