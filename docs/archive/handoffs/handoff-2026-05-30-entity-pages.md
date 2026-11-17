HANDOFF — Entity detail pages: media + SEO + the edition-404 fix
Date 2026-05-30. Topic: Player / Set / Edition / Pack / Team / Series detail pages.

CONTEXT
Cowork already shipped 3 DB migrations LIVE this session (verified), so do NOT re-create these — they exist in prod:
  - audit_20260530_fix_get_team_players_dedup_roster (team roster no longer fans out duplicate players)
  - audit_20260530_fix_get_team_detail_player_count_dedup (player_count counts distinct names; Lakers 116 -> 73)
  - audit_20260530_add_get_team_top_editions (NEW rpc: get_team_top_editions(uuid,text,integer,integer) -> EditionTile[] JSON, thumbnailed, FMV-ranked, service_role only)
This handoff is the CODE half (route/.tsx/OG — Cowork has no git creds). HEAD at write time: 44acbe4. Full audit: docs/audits/entity-pages-improvement-2026-05-30.md.
Backing data is already correct — the detail RPCs return everything below; almost nothing here needs new SQL. Confirm each file shape yourself before editing; your direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file.

GUARDRAILS (repeat every time)
- Work directly on main. No branches, no PRs. If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). After push verify: git rev-list --count origin/main..HEAD  (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s — higher sends the deploy to ERROR invisibly.
- CRLF: do NOT string-replace-patch on Windows; use full-file writes or findIndex on split lines.
- Run npx tsc --noEmit clean before pushing. After deploy, poll the deployment to READY and run the smoke test.

=====================================================================
ITEM 1 — P0 — Un-404 every Edition detail page (colon-slug decode)
=====================================================================
FILE: app/(collections)/[collection]/edition/[slug]/page.tsx
WHY: Edition route slugs are setID:playID (a colon; also UUID:UUID for dupe-era rows). The page passes the URL-encoded slug (%3A) straight to get_edition_detail, which only matches the decoded colon, so it returns null and the page calls notFound(). EVERY Top Shot / All Day / Golazos / UFC edition page is currently a 404 in production. Set/Player/Team/Series pages are unaffected only because their slugs are [a-z0-9-] (encoded == decoded).
VERIFIED: get_edition_detail(cid,'2:187') resolves; get_edition_detail(cid,'2%3A187') returns null. Reproduced 404 in prod on /nba-top-shot/edition/2%3A187 (a slug from the Set grid's own href) and /nba-top-shot/edition/197:7080. The sitemap (app/sitemap.ts) emits encodeURIComponent(external_id) URLs for ~16K editions + 5,149 packs, so Google is being pointed at 404s.
CHANGE: decode the slug once, immediately after reading params, in BOTH generateMetadata and the default page component. The current code in each is:  const { collection, slug } = await props.params  then it uses slug. Replace with:
  const { collection, slug: rawSlug } = await props.params
  const slug = decodeURIComponent(rawSlug)
and leave every downstream fetchDetail/fetchHistory/fetchSales/fetchPacks(coll.id, slug, ...) call as-is (they now receive the decoded colon). decodeURIComponent is idempotent on already-decoded values (no % present), so this is safe even if Next changes behavior later.
DEFENSIVE: apply the same  decodeURIComponent  decode to the slug param in the other entity pages too (set/[slug], player/[slug], series/[slug], team/[slug]) and in app/(collections)/[collection]/moment/[momentId]/page.tsx — harmless for their current slugs, robust if any future slug carries an encoded char. (pack/dist/[distId] uses a numeric distId — no decode needed.)
REVERT: git revert the commit (single-line change per file).
VERIFY: after deploy, load /nba-top-shot/edition/2%3A187 and /nfl-all-day/edition/<a real All Day slug from its grid> — both must render the full edition page (video/image hero, FMV, history, recent sales), not "Bingo Bango Bongo". Spot-check one UUID:UUID slug from the Base Set grid too.

=====================================================================
ITEM 2 — P1 — JSON-LD structured data on all six entity pages
=====================================================================
FILES: lib/seo.ts (add helpers) + each of the six page.tsx files (inject one script tag).
WHY: No nested entity page emits structured data today (only the legacy flat /moment/[id] does). Editions are Products; players/teams are Person/SportsTeam; sets/series are CollectionPage+ItemList. This is the highest-leverage SEO win after Item 1 and is zero-DB — the detail RPCs already return every field, and the pages already fetch the edition/player arrays for ItemList.
ADD to lib/seo.ts (after the existing entity *PageMetadata helpers). BASE_URL is already defined at the top of the file. These return a plain object; render it via a script tag (see injection below). Keep types loose (Record<string,unknown>) like the existing helpers.

  export function breadcrumbJsonLd(items: { name: string; url: string }[]) {
    return {
      "@type": "BreadcrumbList",
      itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, item: it.url })),
    }
  }

  // Edition -> Product. detail = get_edition_detail payload; collectionUrlSlug e.g. "nba-top-shot".
  export function editionJsonLd(detail: Record<string, any>, collectionUrlSlug: string) {
    const label = COLLECTION_DISPLAY_NAMES[collectionUrlSlug] ?? "Flow"
    const slug = String(detail.route_slug ?? detail.external_id ?? "")
    const url = `${BASE_URL}/${collectionUrlSlug}/edition/${encodeURIComponent(slug)}`
    const fmv = detail.fmv && typeof detail.fmv === "object" ? Number(detail.fmv.fmv_usd) : null
    const product: Record<string, unknown> = {
      "@type": "Product",
      name: `${detail.player_name ?? detail.name ?? "Edition"} — ${detail.set_name ?? label}`,
      image: detail.thumbnail_url ?? undefined,
      sku: slug,
      brand: { "@type": "Brand", name: label },
      category: detail.tier ?? undefined,
    }
    if (fmv && Number.isFinite(fmv) && fmv > 0) {
      product.offers = { "@type": "Offer", price: Math.round(fmv * 100) / 100, priceCurrency: "USD", availability: "https://schema.org/InStock", url }
    }
    return {
      "@context": "https://schema.org",
      "@graph": [
        { ...product, "@id": url, url },
        breadcrumbJsonLd([
          { name: "Home", url: BASE_URL },
          { name: label, url: `${BASE_URL}/${collectionUrlSlug}` },
          ...(detail.set_slug ? [{ name: String(detail.set_name ?? "Set"), url: `${BASE_URL}/${collectionUrlSlug}/set/${encodeURIComponent(String(detail.set_slug))}` }] : []),
          { name: String(detail.player_name ?? detail.name ?? "Edition"), url },
        ]),
      ],
    }
  }

  // Player -> Person ; Team -> SportsTeam (Pinnacle: keep type Person/Organization via is_character/is_franchise if you prefer, but Person/SportsTeam is fine).
  export function playerJsonLd(detail: Record<string, any>, collectionUrlSlug: string, slug: string) {
    const label = COLLECTION_DISPLAY_NAMES[collectionUrlSlug] ?? "Flow"
    const url = `${BASE_URL}/${collectionUrlSlug}/player/${encodeURIComponent(slug)}`
    return { "@context": "https://schema.org", "@graph": [
      { "@type": detail.is_character ? "Person" : "Person", "@id": url, url, name: detail.name, image: detail.headshot_url ?? undefined, affiliation: detail.team ? { "@type": "SportsTeam", name: detail.team } : undefined },
      breadcrumbJsonLd([{ name: "Home", url: BASE_URL }, { name: label, url: `${BASE_URL}/${collectionUrlSlug}` }, { name: String(detail.name ?? "Player"), url }]),
    ]}
  }

  export function teamJsonLd(detail: Record<string, any>, collectionUrlSlug: string, slug: string) {
    const label = COLLECTION_DISPLAY_NAMES[collectionUrlSlug] ?? "Flow"
    const url = `${BASE_URL}/${collectionUrlSlug}/team/${encodeURIComponent(slug)}`
    return { "@context": "https://schema.org", "@graph": [
      { "@type": detail.is_franchise ? "Organization" : "SportsTeam", "@id": url, url, name: detail.team_name },
      breadcrumbJsonLd([{ name: "Home", url: BASE_URL }, { name: label, url: `${BASE_URL}/${collectionUrlSlug}` }, { name: String(detail.team_name ?? "Team"), url }]),
    ]}
  }

  // Set / Series -> CollectionPage + ItemList. eds = the editions array the page already fetched (EditionTile[]). Cap the ItemList at ~25.
  export function collectionEntityJsonLd(opts: { name: string; url: string; collectionUrlSlug: string; eds: Array<Record<string, any>>; crumbName: string }) {
    const label = COLLECTION_DISPLAY_NAMES[opts.collectionUrlSlug] ?? "Flow"
    const items = (opts.eds ?? []).slice(0, 25).map((e, i) => ({
      "@type": "ListItem", position: i + 1,
      url: `${BASE_URL}/${opts.collectionUrlSlug}/edition/${encodeURIComponent(String(e.route_slug ?? ""))}`,
      name: e.player_name ?? e.name ?? undefined,
      image: e.thumbnail_url ?? undefined,
    }))
    return { "@context": "https://schema.org", "@graph": [
      { "@type": "CollectionPage", "@id": opts.url, url: opts.url, name: opts.name, isPartOf: { "@type": "WebSite", name: "Rip Packs City", url: BASE_URL }, mainEntity: { "@type": "ItemList", numberOfItems: items.length, itemListElement: items } },
      breadcrumbJsonLd([{ name: "Home", url: BASE_URL }, { name: label, url: `${BASE_URL}/${opts.collectionUrlSlug}` }, { name: opts.crumbName, url: opts.url }]),
    ]}
  }

INJECTION (each page.tsx, server components — render right inside the returned <div>, before the hero). Example for edition:
  import { editionJsonLd } from "@/lib/seo"
  ...
  <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(editionJsonLd(detail, collection)) }} />
- player/[slug]: playerJsonLd(detail, collection, slug)
- team/[slug]:   teamJsonLd(detail, collection, slug)
- set/[slug]:    collectionEntityJsonLd({ name: detail.set_name, url: `${BASE_URL? use absolute}`, collectionUrlSlug: collection, eds: editions, crumbName: detail.set_name }) — build the absolute url as https://www.rippackscity.com/${collection}/set/${encodeURIComponent(slug)} or import BASE_URL pattern; the helper already builds child URLs, just pass the page's own absolute url.
- series/[slug]: collectionEntityJsonLd({ name: detail.display_label, url: <abs series url>, collectionUrlSlug: collection, eds: editions, crumbName: detail.display_label })
- pack/dist/[distId]: a Product graph (reuse the editionJsonLd shape or a small packJsonLd: @type Product, name=title, image=image_url, offers omitted or retail_price). Optional but nice.
NOTE: COLLECTION_DISPLAY_NAMES already exists in lib/seo.ts. Confirm the exact name and the BASE_URL export; reuse them rather than redeclaring.
REVERT: git revert (additive helpers + one script line per page).
VERIFY: tsc clean; after deploy, view-source on an edition + a set page and confirm the ld+json block; paste each into Google's Rich Results Test (or schema.org validator) — Product and CollectionPage/ItemList should validate.

=====================================================================
ITEM 3 — P1 — Visible breadcrumb nav on the six pages
=====================================================================
FILES: the six entity page.tsx (add a small breadcrumb row at the very top of the returned markup). Optional shared component: components/entity/Breadcrumbs.tsx.
WHY: Doubles as the human-visible counterpart to Item 2's BreadcrumbList (Google can render breadcrumb sitelinks) and improves internal linking/crawl depth. The edition page already derives setHref/playerHref/teamHref — reuse those. Pattern: Home › <Collection> › <Set/Player/Team/Series> › <this entity>, each a Link, last item plain text. Use var(--rpc-text-muted), font var(--font-mono), small. Keep it one line.
REVERT: git revert.
VERIFY: visual; links resolve (note set/player/team links go to slugs — fine; edition links inherit Item 1's fix).

=====================================================================
ITEM 4 — P1 — Pack "What's Inside" visual grid (dist page)
=====================================================================
FILE: app/(collections)/[collection]/pack/dist/[distId]/page.tsx
WHY: The pack cover already renders (PackThumb, ~line 491). But the contents are a TEXT TABLE ("Top Pulls by EV", the <table> around line 772) built from a pack_drop_pool query that selects only edition_id, drop_weight (~line 145) — no moment art. Users want to SEE what's inside.
CHANGE: add a "What's Inside" section ABOVE (or beside) the EV table that renders moment thumbnails. Source it from the existing RPC get_pack_contents(p_collection_id, p_dist_id, p_limit, p_offset) — VERIFIED to return per-edition: thumbnail_url, route_slug, player_name, set_name, set_slug, tier, tier_rank, fmv_usd, fmv_confidence, drop_weight, hit_probability. Either call it server-side in this page (supabaseAdmin.rpc) for the top ~24, or reuse the EditionsGridPaginated component (it already renders thumbnail tiles and links to /edition/route_slug). Each tile links to the edition page (now un-404'd by Item 1). Keep the EV table below for analytics. There is also an existing route app/api/entity/pack/route.ts that wraps get_pack_contents if you want client-side pagination.
REVERT: git revert.
VERIFY: /nba-top-shot/pack/dist/1681 shows a thumbnail grid of contained moments (dist 1681 = Base Set S2 R2, 80-edition pool, all thumbnailed — confirmed). Tiles link to working edition pages.

=====================================================================
ITEM 5 — P1 — Stop rendering dead "No image" tiles in grids
=====================================================================
FILES: components/entity/EditionsGridPaginated.tsx (and the entity RPCs only if you choose the server-side filter).
WHY: Top Shot edition thumbnail coverage is 54% (8,820/16,278) — the gap is the ~7K inert UUID-keyed dupe editions (null thumbnails) that still appear in Set/Player/Series grids as "No image" placeholders (seen in prod on /nba-top-shot/set/base-set). All Day/Golazos/UFC are ~100% so unaffected.
CHANGE (pick one): (a) cheapest — in EditionsGridPaginated, when thumbnail_url is null keep the current placeholder but also de-prioritize/sort those tiles last; OR (b) better — filter thumbnail-less rows out of the entity edition RPCs the grids read (get_set_editions / get_series_editions / get_player_editions) by adding AND e.thumbnail_url IS NOT NULL, matching what the new get_team_top_editions already does. Option (b) is a DB change (CREATE OR REPLACE, same signatures, grants preserved) — if you do it, REVOKE/ GRANT is not needed (same sig) but re-assert defensively; tag audit_YYYYMMDD_entity_edition_rpcs_require_thumbnail. Recommend (b) for Set/Series/Player edition lists, but keep the Edition page's own "Parallels" unfiltered.
REVERT: git revert (a) or re-CREATE OR REPLACE prior bodies (b).
VERIFY: /nba-top-shot/set/base-set grid no longer shows "No image" tiles.

=====================================================================
ITEM 6 — P2 — Hero montages for Set / Team / Series (+ Team "Top Editions")
=====================================================================
FILES: set/[slug]/page.tsx, series/[slug]/page.tsx, team/[slug]/page.tsx (+ optional components/entity/HeroMontage.tsx).
WHY: Set/Team/Series have text-only heroes. The pages already have the media in hand.
CHANGE:
- Set: the page already fetches editions (get_set_editions, top by FMV). Render a HeroMontage of the first 4-5 editions[].thumbnail_url next to the title.
- Series: same, from its top-25 editions array.
- Team: the page now has access to the NEW get_team_top_editions(coll.id, slug, 24, 0) — call it server-side. Use the top 4-5 thumbnails for the hero montage, AND add a "Top Editions" Section (reuse EditionsGridPaginated with showSort) so the thin Team page reaches parity with the Player page. The roster grid stays.
HeroMontage spec: a small fixed-size flex row/grid of 4-5 square thumbnails (object-fit cover, var(--rpc-border)), graceful when fewer exist; hide entirely if zero. Keep the existing text hero beside it.
REVERT: git revert.
VERIFY: the three heroes show moment art; Team page shows a Top Editions grid; Lakers team page roster now shows 73 distinct players (DB already fixed).

=====================================================================
ITEM 7 — P2 — Branded OG cards for edition/set/player/team/series
=====================================================================
FILES: new app/api/og/edition/route.tsx, .../set/route.tsx, .../player/route.tsx, .../team/route.tsx, .../series/route.tsx ; then wire each entity page's generateMetadata to its card.
WHY: edition/player currently pass a raw thumbnail/headshot to OG; set/team/series fall back to the generic /api/og/default. A branded 1200x630 card lifts social/search CTR.
MODEL: app/api/og/collection/route.tsx (query-param based, next/og, runtime="edge", every flex node sets display:"flex", accent from lib/collections). For entity cards that embed a real thumbnail, model the data-fetch on app/api/og/moment/[id]/route.tsx (it fetches entity data then renders <img src=...>). Suggested shapes:
  - /api/og/edition?collection=<slug>&slug=<routeSlug> -> hero thumbnail + player/set + tier + FMV pill.
  - /api/og/player?collection=&slug=  -> headshot or first-edition thumb + name + team + edition count.
  - /api/og/set?collection=&slug=  and  /api/og/series?collection=&slug=  and  /api/og/team?collection=&slug= -> montage 3-4 thumbnails + title + counts. Fetch the montage via get_set_editions / get_series_editions / get_team_top_editions with a small limit.
WIRING: in lib/seo.ts the entity *PageMetadata helpers currently set openGraph.images to thumbnail/headshot/default. Point them at the new routes, e.g. editionPageMetadata -> images: [{ url: `${BASE_URL}/api/og/edition?collection=${collectionUrlSlug}&slug=${encodeURIComponent(routeSlug)}`, width:1200, height:630 }]. Keep the default as fallback when slug is missing.
NOTE: if get_* RPCs aren't reachable from edge runtime with the service key, set the new OG routes to runtime="nodejs" (the moment OG route's approach) rather than "edge".
REVERT: delete the new route files + git revert the lib/seo.ts wiring (falls back to default card).
VERIFY: paste an edition + a set URL into the Twitter/X card validator (or opengraph.xyz) — the branded card renders 1200x630.

=====================================================================
ITEM 8 — P3 — Hover-to-play video in moment grids
=====================================================================
FILES: components/entity/EditionsGridPaginated.tsx (+ the entity edition RPCs to add video_url to the tile payload).
WHY: Moments are videos; grids show static thumbnails. Hover-to-play matches nbatopshot.com. Trevor opted in.
CHANGE: add video_url to EditionTile (the type ~line 13-29) and have the grid RPCs (get_set_editions/get_series_editions/get_player_editions/get_team_top_editions) also SELECT e.video_url (small additive CREATE OR REPLACE, same signatures -> grants preserved; tag audit_YYYYMMDD_entity_edition_rpcs_add_video_url). In the tile, render the <img thumbnail> as the resting state and on mouseenter swap to a muted, loop, playsInline <video> with poster=thumbnail_url; on mouseleave pause/reset. Gate to collections that have video (nba-top-shot, nfl-all-day — All Day editions have thumbnails but video_url is null in our data, so effectively TS only today) and bail when window.matchMedia('(prefers-reduced-motion: reduce)') matches. Lazy: only mount the <video> on first hover to keep large grids cheap.
REVERT: git revert (+ re-CREATE OR REPLACE prior RPC bodies if you added video_url).
VERIFY: hovering a TS moment tile plays the clip; reduced-motion users and non-video collections keep the static thumbnail; scroll/initial paint is not slowed (videos mount on hover only).

=====================================================================
SEQUENCING / DEPLOY
=====================================================================
Ship Item 1 ALONE first (P0, one line) and confirm editions render before stacking the rest — it un-blocks every edition link the other items create. Then Items 2-5 (one deploy is fine), then 6-7, then 8. Update CLAUDE.md Recent sessions and docs/overnight/ledger.md (the 3 shipped migrations are already noted in the audit doc) when you commit. Do NOT collide with ledger Q1 (pack_reality security_invoker views) — unrelated files.

Your direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

EXPECTED END STATE
Item 1 on main + deploy READY -> every edition page renders (the catalog un-404s, sitemap URLs resolve). Items 2-3 -> Product/Person/SportsTeam/CollectionPage + breadcrumb JSON-LD validates on all six pages. Items 4-6 -> pack contents grid, no dead grid tiles, Set/Team/Series moment-montage heroes, Team "Top Editions" section. Items 7-8 -> branded OG cards + hover-video. tsc clean, smoke test green throughout.
