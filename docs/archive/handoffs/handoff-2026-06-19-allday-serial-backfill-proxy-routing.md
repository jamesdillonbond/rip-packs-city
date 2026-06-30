# Handoff 2026-06-19 — backfill-allday-listing-serials gets Cloudflare 1009 (proxy-routing fix)

Plain text. Defect in the Item 2 build (backfill-allday-listing-serials edge fn). Found on the first live test run.

## Symptom

Cron "RPC AllDay Listing Serial Backfill" wired (34 */3 * * *) + test-run fired clean (202). But pipeline_runs (pipeline=allday-listing-serial-backfill) logged ok=false:
chunks=5, chunk_errors=5, rows_upserted=0, serials_resolved=0, targets_returned=165, first_chunk_error="http_403:error code: 1009". All 5 byFlowIDs chunks failed with Cloudflare error 1009 (Access denied — region/IP banned). 0 serials written; allday_moment_serials still at the 2 seeded rows.

## Diagnosis — it's the transport, not the GQL

This is NOT the general intermittent allday-consumer-gql-403 block. At the same moment, the proven allday-unmapped-resolver (which hits the SAME searchMomentNFTsV2 consumer GQL) is healthy: v_rpc_trust_health unmapped_resolution_backlog_max = 9 (ok), allday-sales-indexer last 4 runs all ok. So the topshot-proxy -> consumer-GQL path works fine right now.

Cloudflare 1009 is a region/IP ban (not a 429 rate-limit). Getting it 5/5 means the backfill's request reaches nflallday's Cloudflare from a banned source — i.e. the function is calling the AllDay consumer GQL on a path that does NOT go through the topshot-proxy worker the way the resolver does (most likely a direct fetch to nflallday.com/consumer/graphql from the Supabase edge runtime, whose datacenter IP/region nflallday 1009-bans; or the proxy call is missing the X-Proxy-Secret header and falling back to direct). CLAUDE.md is explicit: edge functions MUST reach the AllDay consumer GQL through topshot-proxy /allday-consumer — Cloudflare blocks Supabase egress directly.

CC's commit note said "byte-identical query to the proven resolver" — the QUERY may match, but the TRANSPORT (fetch URL + headers) does not. That's the fix surface.

## Fix

In the backfill-allday-listing-serials edge function, route the searchMomentNFTsV2(byFlowIDs) call through the topshot-proxy worker exactly like supabase/functions/allday-unmapped-resolver does:
- POST to the topshot-proxy /allday-consumer route (the worker URL the resolver uses — read it from the resolver source; it's the topshot-proxy.tdillonbond.workers.dev /allday-consumer path), NOT directly to nflallday.com/consumer/graphql.
- Send the X-Proxy-Secret: <TS_PROXY_SECRET> header (from Deno.env) that the resolver sends.
Copy the resolver's exact fetch wrapper, not just its query string. Keep the 40/page chunking + 429/5xx backoff already in place.

## Verify

cron test-run again -> pipeline_runs allday-listing-serial-backfill ok=true, serials_resolved > 0, allday_moment_serials count climbs 2 -> ~165, and cross_collection_deals_board AllDay low_ask_serial coverage climbs from 1 toward ~163. Spot-check: nft_id 2789792 already verified = serial 58.

## Until fixed

The cron logs ok=false but writes nothing (harmless; cron-job.org sees the 202 so it won't auto-disable). RECOMMEND: toggle the cron-job.org entry Inactive until the fix ships (no point running a known-failing job every 3h), then re-enable after a green test run. Flagged in docs/overnight/focus.md so the monitor doesn't treat the ok=false as a new incident. This is the LOW-priority Item 2 — no urgency; the AllDay buy links (Item 1) already deliver the value.

## Guardrails

main only; PowerShell git; edge-fn redeploy ships live from Cowork or CC; route the consumer GQL via topshot-proxy (never direct from Supabase egress).
