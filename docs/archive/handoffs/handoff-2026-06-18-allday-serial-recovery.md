# Handoff 2026-06-18 — Item 2: AllDay floor-listing serial recovery (LOW PRIORITY / optional)

Plain text. This is the deferred Item 2 from handoff-2026-06-18-allday-deal-link-serial.md. Build only if AllDay-serial demand shows up — see "Why it's optional" below.

## Why it's optional (read first)

Item 1 (the AllDay "Buy on All Day" link, fixed in 7a70a31 -> /moments/) already lets a user click straight to the cheapest listing, which shows its serial. The floor serial is volatile (changes as listings come/go) and AllDay is far less serial-driven than Top Shot. So this only adds an informational "#serial" tag to AllDay deal-alert lines. Recommended: leave deferred unless there's demand.

## Why it needs a build (no cheap path)

Confirmed 2026-06-18 the serial is NOT in any existing table: `moments` is Top-Shot-only (0 AllDay rows); wmc.moment_id and sales.nft_id are null for the floor `flow_id`s (they're listed-but-untracked/unsold moments). So it must be fetched from the AllDay consumer GQL — only reachable from a Supabase edge function/worker (the topshot-proxy secret lives in Supabase env).

## Build (turnkey)

1. DB migration — side table:
   CREATE TABLE public.allday_moment_serials (nft_id text PRIMARY KEY, serial_number integer, edition_flow_id text, fetched_at timestamptz NOT NULL DEFAULT now());
   RLS ON. Because cross_collection_deals_board is security_invoker=on and anon-public, any table it joins must be anon-SELECTable: add a permissive SELECT policy for anon + GRANT SELECT to anon, authenticated, service_role; writes service_role only. (Re-run check_public_security_invariants() after — expect still clean.)

2. Edge function backfill-allday-listing-serials — model it on the deployed allday-unmapped-resolver (which already calls searchMomentNFTsV2(byFlowIDs) via the topshot-proxy /allday-consumer route for editionFlowID):
   - Read distinct nft_id from allday_edition_floor_ask (carries floor_flow_id) that are missing/stale in allday_moment_serials. Scope to the deal-board set (~163) first for cheapness, or all ~3,900 floor editions.
   - Chunk byFlowIDs in groups of 40 — the consumer searchMomentNFTsV2 hard-caps at 40 edges/page regardless of `first` (documented gotcha in CLAUDE.md; it bit the resolver before). Use first:40.
   - Select node { flowID, serialNumber, editionFlowID } — CONFIRM the serial field name against the live GQL / the resolver's existing query (the moment page shows the serial, so the data exists; verify it's `serialNumber` on this node).
   - Upsert (nft_id, serial_number, edition_flow_id, fetched_at=now()) ON CONFLICT (nft_id) DO UPDATE.
   - log_pipeline_run('allday-listing-serial-backfill', ...). Respect the proxy: bounded concurrency + backoff (the topshot-deal-floor-serials cron already hit 429s on TS-GQL — same shared proxy class).

3. Floor view: LEFT JOIN allday_moment_serials s ON s.nft_id = allday_edition_floor_ask.floor_flow_id::text; expose floor_serial. Additive — keep the existing columns so the board leg keeps working.

4. Board AllDay leg (cross_collection_deals_board): re-fetch the current 3-leg def with pg_get_viewdef first, then in the AllDay leg only, change low_ask_serial from NULL to the joined floor_serial (low_ask_nft_id already = floor_flow_id). CREATE OR REPLACE (preserve security_invoker + grants). The dispatcher Pass-1 payload already maps serial_number from low_ask_serial, so no dispatcher change.

5. Formatter: NONE — lib/alerts/format.ts dealSerialTag already renders "#<serial>" when serial_number is present.

6. Cron: add a cron-job.org entry for /api/... (or invoke the edge fn) at a low cadence (hourly or every few hours, board-scoped). Watchlist it once cadence is steady.

## Verify

After a backfill run: allday_moment_serials populated; spot-check nft_id 2789792 -> serial 58 (Michael Pittman Jr. "Locked In" #58/1199) and 6839516 -> 207 (Stan Humphries #207/1999) — both confirmed on nflallday.com/moments/<id> this session. Then an AllDay deal alert line reads "#58 · Rare · Locked In · /1199 · NFL All Day". check_public_security_invariants()=0, check_secdef_anon_execute_violations()=[].

## Revert

Drop the board-leg serial line (CREATE OR REPLACE without it); drop the floor-view join column; DROP the edge function + cron; DROP TABLE allday_moment_serials. Formatter untouched so nothing to revert there.

## Guardrails

main only; PowerShell git; Supabase edge fn deploys live from Cowork OR CC; anon-SELECT + RLS on the new table (it's read by the anon-public board); maxDuration/concurrency mindful of the shared topshot-proxy 429 limits.
