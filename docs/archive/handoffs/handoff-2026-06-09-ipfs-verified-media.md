# Handoff 2026-06-09 — IPFS verified media: edition-page badge + blog post

## Context

NBA Top Shot announced (2026-06-08, blog.nbatopshot.com/posts/authentic-permanent) that every Moment's media — video, thumbnail, metadata — is now pinned to IPFS, retroactively and at-mint going forward, with CIDs to be embedded in on-chain Edition Metadata next. Their public IPFS Reference App (dapperlabs.github.io/dapperlabs-ipfs-reference-app) embeds a full machine-readable dataset.

Cowork already shipped the DB half live today:

- Migration audit_20260609_topshot_ipfs_assets_catalog — new public.topshot_ipfs_assets table (12,546 rows: one per play_flow_id + set_uuid + parallel, with video_cid / video_square_cid / video_tall_cid / video_vertical_cid / hero_cid / player_cid / image_player_cid). RLS on, anon SELECT only, service_role writes. Unique key (play_flow_id, set_uuid, parallel). Index idx_topshot_ipfs_assets_int_pair on (set_flow_id, play_flow_id).
- Migration audit_20260609_backfill_editions_media_from_ipfs — filled 23 NULL thumbnail_url + 26 NULL video_url on canonical int-keyed TS editions from the catalog (gateway URLs https://ipfs.dapperlabs.com/ipfs/<cid>, verified serving image/png and video/mp4). Null thumbs 75 -> 52; the remaining 52 are mostly 2026 WNBA plays not yet present in Dapper's dataset — they will fill when the catalog refreshes.
- Edge function ipfs-catalog-loader (v2, verify_jwt off, own deploy-time token retrievable via Supabase MCP get_edge_function — do NOT commit the token; this repo is public). It accepts POST {rows:[...]} batches of up to 2000 and upserts on (play_flow_id, set_uuid, parallel). Re-load recipe whenever Dapper refreshes their bundle: fetch the largest _next/static/chunks/*.js from the reference app (~17 MB), extract the JSON.parse('...') single-quoted literal, unescape backslash-quote and backslash-backslash, JSON.parse, group assets per play+setId+parallel mapping assetType to the matching *_cid column, then POST in chunks. Note: the v2 function does not write pipeline_runs (it is an on-demand ingest endpoint, not a cron); the response JSON carries upserted counts per call.

This handoff covers the code half Cowork cannot push: the edition-page verified-media block and the new blog post.

IMPORTANT catalog gotcha discovered during the backfill: parallel rows (Diced, Coded, etc.) carry the PARENT set's set_flow_id in the catalog (e.g. Honors Diced rows say set_flow_id 149, while the on-chain parallel set is 152). So an exact (set_flow_id, play_flow_id, parallel='Base') join only covers base sets; parallels need play + parallel-name + normalized base-set-name matching. The migration above already encodes both joins; reuse its logic if you query the catalog.

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

## Item 1 — "Media verified on IPFS" block on TS edition pages

File: app/(collections)/[collection]/edition/[slug]/page.tsx (verified exists; slug format setID:playID, arrives URL-encoded — the file already does decodeURIComponent per the 2026-05-31 fix; keep that).

What: for collection nba-top-shot only, after the existing get_edition_detail fetch, parse the decoded slug into setId/playId ints and query topshot_ipfs_assets (anon-readable; use the same server-side supabase client pattern the page already uses) for one row where set_flow_id = setId AND play_flow_id = playId AND parallel = 'Base'. If no row, render nothing (WNBA and very new drops are not in the catalog yet — absence must not imply anything is wrong). If found, render a small section in the page body, styled with brand tokens (var(--rpc-red), var(--font-display), var(--font-mono)):

- Heading: MEDIA VERIFIED ON IPFS (display font, uppercase treatment matching the page's existing section headings).
- One line of copy: "This Moment's video and artwork are pinned to the InterPlanetary File System — content-addressed, tamper-evident, and retrievable from any IPFS gateway without a Top Shot account."
- Two mono rows: Video CID and Artwork CID, each showing the truncated CID (first 10 + last 8 chars) as an outbound link to https://ipfs.dapperlabs.com/ipfs/<cid> (target _blank, rel noopener). Use video_cid and hero_cid.
- A small footer link: "Verify independently via Dapper's IPFS Reference App" -> https://dapperlabs.github.io/dapperlabs-ipfs-reference-app/ and note any gateway works (ipfs.io, dweb.link).

Why: zero-risk differentiation — RPC surfaces the authenticity story natively, on pages that are already public + in the sitemap, the day after the announcement. No pricing logic touched.

Optional (your call if cheap): in the edition Product JSON-LD (lib/seo.ts editionJsonLd or wherever the page builds it — verify actual location), add the IPFS gateway video URL as an additionalProperty or subjectOf. Skip if it complicates the GSC-clean JSON-LD shape from the gsc-product-jsonld work.

Verified counts: 12,546 catalog rows; 11,119 have video_cid, 11,101 have hero_cid; join coverage against canonical int-keyed TS editions on the Base join is 7,518 editions (verified read-only 2026-06-09). So the block renders on roughly 80 percent of TS edition pages.

Revert: git revert the commit.

Verification: npx tsc --noEmit clean; deploy READY; anon load of /nba-top-shot/edition/2%3A188 (Iguodala Base Set — confirmed present in catalog join) shows the block with two working CID links; an edition absent from the catalog renders unchanged.

## Item 2 — Blog post: "Your Moments Just Became Permanent. Here's What That Actually Means."

Files: new app/blog/permanent-moments-ipfs/page.tsx + add one POSTS entry in app/blog/page.tsx (verified: POSTS array, currently one entry, shape slug/title/date/collection/blurb/readMin). Mirror the existing app/blog/pinnacle-star-wars-day-2026/page.tsx structure and styling.

Copy: full draft in docs/drafts/blog-permanent-moments-2026-06-09.md (committed alongside this handoff). Use it verbatim or tighten; keep the facts exactly — they were verified against the announcement and our own catalog load.

POSTS entry suggestion: slug permanent-moments-ipfs, title "Your Moments Just Became Permanent. Here's What That Actually Means.", date June 9, 2026, collection NBA Top Shot, readMin 6, blurb "Top Shot just pinned every Moment's video to IPFS. What content-addressing actually guarantees, how to verify a Moment yourself in 30 seconds, and what we built with the data."

Check app/sitemap.ts: /blog is already listed (eb39370); verify whether individual post slugs are enumerated — if the star-wars post is in the sitemap, add this one the same way.

Revert: git revert the commit.

Verification: tsc clean; deploy READY; anon GET /blog lists both posts; anon GET /blog/permanent-moments-ipfs renders.

## Item 3 — OPTIONAL, queued: IPFS fallback for dead CDN images

Not in this handoff's must-ship. The entity-grid tiles and PackHeroArt already have onError fallbacks; a follow-up could thread hero_cid through get_edition_detail / the entity RPCs so the client can fall back to the IPFS gateway when assets.nbatopshot.com 404s. That's a DB-RPC + component change pair — package separately if wanted. Do not blanket-swap thumbnail_url to IPFS gateways: the Dapper gateway's latency/caching behavior under page-grid load is unproven, and CDN URLs still work.

## Guardrails (repeat every handoff)

- Direct to main. No branches, no PRs. If a claude/* branch is pre-checked out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify push with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s.
- CRLF: no string-replace patches; full-file writes or findIndex on split lines.
- Run the smoke test after deploy; verify the deploy reaches READY.
- Log the ship in docs/overnight/ledger.md (Cowork deliberately did not edit the ledger — mount truncation risk).

## Expected end state

One or two commits on main, deploy READY: TS edition pages show a verified-on-IPFS block with working gateway links on ~80 percent of editions, /blog has the permanent-moments post live, and the ledger records both plus the three Cowork-shipped DB/edge pieces (table + backfill migrations, ipfs-catalog-loader edge fn).
