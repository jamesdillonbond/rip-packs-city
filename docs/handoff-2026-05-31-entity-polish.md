HANDOFF — Entity-page polish: broken hero/tile images (dead CDN thumbnails)
Date 2026-05-31. Topic: player hero portrait + edition grid tiles. Low priority / cosmetic, but visible on high-value pages.

CONTEXT
Found during post-launch QA of the now-public entity pages. The entity edition grids ARE correctly thumbnail-filtered (verified: get_player_editions returns 89/148 for LeBron, 0 null, 0 dupe slugs — the thumbnail_url IS NOT NULL filter from audit_20260530_entity_edition_rpcs_thumbnail_filter_and_video_url is working). The remaining issue is a tail of canonical editions whose thumbnail_url is NON-NULL but DEAD (404 on the nbatopshot CDN), plus the player hero using editions[0] without a load-failure fallback. All code (Cowork can't deploy) → handoff. Your file inspection wins over this doc.

GUARDRAILS: direct to main, no branches/PRs; PowerShell git + verify push (git rev-list --count origin/main..HEAD = 0); no CRLF string-replace patches (full-file writes); npx tsc --noEmit clean before push.

=====================================================================
ITEM 1 — onError image fallback on the player hero portrait + lead tiles
=====================================================================
FILE: app/(collections)/[collection]/player/[slug]/page.tsx (portrait), and the shared tile component components/entity/EditionsGridPaginated.tsx (grid tiles) + components/entity/PlayersGridPaginated.tsx (roster portraits).
WHY: The player hero computes portrait = detail.headshot_url ?? editions[0]?.thumbnail_url ?? null and renders a plain <img>. For Top Shot, headshot_url is 0% populated, so it always uses editions[0].thumbnail_url. When the top-FMV edition's thumbnail is a dead CDN url (e.g. LeBron 245... "2020 NBA Finals" $4049), the hero + that grid tile render a broken-image box. The grids already filter null thumbnails, so this is specifically the dead-URL (404-on-load) case, which a server-side filter can't catch.
CHANGE (cheap, client-side): on the portrait <img> and the tile media <img>, add onError handling that (a) hides the broken <img> and shows the existing tier-colored placeholder / "No image" state, or (b) for the player hero, swaps to the next edition that has a thumbnail. Since these are server components rendering plain <img>, the simplest robust approach is a tiny client wrapper component (e.g. components/entity/ImgWithFallback.tsx: a "use client" <img> that onError sets a state flag and renders the placeholder). Use it for the player portrait, the EditionsGridPaginated tile image, and the PlayersGridPaginated portrait. Respect existing alt text.
NOTE: PackThumb (components/packs/PackTable.tsx) already has a tier-aware fallback when a pack image 404s — mirror that pattern/feel for consistency.
REVERT: git revert.
VERIFY: load /nba-top-shot/player/lebron-james — the hero shows a clean placeholder (not a broken-image icon) when the top edition's art is dead; a player whose top edition has live art still shows it.

=====================================================================
ITEM 2 — (optional, low value) refresh dead/null canonical thumbnails via TS GQL
=====================================================================
WHY: Root cause behind Item 1 + the "No image" gaps. Two populations on Top Shot (collection 95f28a17-…): (a) 24 real tradeable canonical editions (circulation>0) with NULL thumbnail_url — 216 more are circulation-null stubs, ignore those; (b) a tail of canonical editions with non-null but DEAD thumbnail_urls (404 on assets.nbatopshot.com). Both are fixable only via a Top Shot GQL fetch (the assets URLs come from searchEditions), which must go through the topshot-proxy worker (Cloudflare blocks Vercel/Supabase egress) — so Cowork can't do it; it's a small ingest script.
SCOPE: write a one-off admin route or script that, for TS editions where thumbnail_url IS NULL (and optionally a HEAD-check finds the existing url dead), resolves set_id_onchain:play_id_onchain via the TS GQL searchEditions (bySetIDs/byPlayIDs) through topshot-proxy, and updates editions.thumbnail_url + video_url. Bounded (~tens to low-hundreds of editions). Gate behind INGEST_SECRET_TOKEN like the other admin routes. Low priority — these editions are still reachable by direct link; this is image-quality polish, not a functional gap.
REVERT: it's an additive data backfill (writes thumbnail_url where null); no destructive step. To undo a bad fetch, null the affected rows' thumbnail_url back.
VERIFY: after running, get_player_editions('…','lebron-james',…) lead tile + hero render real art; count of circ>0 canonical TS editions with null thumbnail trends to 0.

EXPECTED END STATE
Item 1 on main + deploy READY → no broken-image boxes on player heroes/tiles (graceful placeholder instead). Item 2 (if pursued) → the artless/dead-thumbnail tail heals. Both are cosmetic polish on already-functional pages.
