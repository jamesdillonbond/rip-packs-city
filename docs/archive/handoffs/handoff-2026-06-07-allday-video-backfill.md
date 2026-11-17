# Handoff 2026-06-07 — AllDay editions.video_url backfill (0 → ~6,191)

CONTEXT

editions.video_url is 0 of 6,191 for NFL All Day (thumbnails are 6,191/6,191). The hover-to-play video in EditionsGridPaginated/TileMedia is already gated to TS + AllDay (shipped 29d2e46) — so AllDay tiles silently no-op on hover today purely for lack of data. Closing this gives AllDay full tile parity with Top Shot. This is a probe-first task: the repo has NO verified AllDay video field names (lib/alldayGraphql.ts selects no media fields anywhere), so do NOT trust any guessed schema — including anything this doc speculates.

STEP 1 — probe the consumer GQL for the video field shape (you have TS_PROXY_SECRET locally)

Probe getMintedMoment (worker route /allday-consumer on topshot-proxy, header X-Proxy-Secret) for one known AllDay moment and inspect the media/asset fields in the response — expect something in the family of media/assets/videos with URL + type entries on the moment's edition/play. Also probe searchMomentNFTsV2 (route /allday, byFlowIDs) for the same — if the batched search carries the video URL, prefer it (40 ids per page = ~160 calls for full coverage instead of ~6k). Record the exact field path in the implementation comment.

STEP 2 — pick a representative on-chain moment id per edition (the GQL is moment-keyed, editions table is edition-keyed)

One SQL shape (verify column names first — information_schema, never memory): for each AllDay edition with video_url IS NULL, pick any moment id from wallet_moments_cache (wmc.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070', join on wmc.edition_key = editions.external_id, take min(moment_id)). wmc holds 324k AllDay rows so coverage should be near-total; for editions with no held moment, fall back to the moments table, and whatever small tail remains gets picked up by re-runs as moments appear.

STEP 3 — backfill route or script

A new admin route (Bearer INGEST_SECRET_TOKEN) or one-off script that: pages the null-video editions with their representative moment ids, batches 40 per consumer-GQL call, extracts the verified video URL field, and writes editions.video_url. Idempotent (NULL-only), budget-bounded, logs pipeline_runs (pipeline name allday-video-backfill) so the run is observable. Store the SAME asset-domain URL style the TS rows use (raw https URL; the tile player consumes it directly — check one TS row's video_url for the expected shape before writing thousands).

STEP 4 — freshness tail

New AllDay editions are rare post-primary-shutdown, but fold a small NULL-only call (limit ~200) into an existing AllDay cron tick (allday-listings-indexer or the daily catalog touch) so future editions self-heal. Do NOT create a new cron-job.org entry for this.

VERIFY

SELECT count(video_url) FROM editions WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070' → expect ~6,000+ (some editions may genuinely lack video assets — log the miss count, don't force). Then eyeball: an NFL All Day set page tile plays video on hover like TS does; npx tsc --noEmit clean; deploy READY; smoke green.

REVERT

UPDATE editions SET video_url = NULL WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070' (data-only, regenerable); git revert the route commit.

GUARDRAILS (standard)
- Direct-to-main, no branches, no PRs. PowerShell git; verify push with git rev-list --count origin/main..HEAD (expect 0). maxDuration cap 800s. Full-file replacements. Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual shapes, especially the GQL fields and the moments/wmc column names.

END STATE: AllDay tiles hover-play like Top Shot's; editions.video_url ~complete for AllDay; a small NULL-only tail keeps it that way.
