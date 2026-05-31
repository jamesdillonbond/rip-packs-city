# Entity detail pages — audit & improvement plan (2026-05-30)

Scope: the six per-entity detail surfaces — **Player, Set, Edition (of moment), Pack, Team, Series** — across the five published collections. Goal (Trevor): thumbnails/videos on every page, complete relevant info, and SEO depth (these are high-intent, high-volume, indexable pages).

Companion handoff (the code half of this work): [docs/handoff-2026-05-30-entity-pages.md](../handoff-2026-05-30-entity-pages.md).

---

## TL;DR

All six entity routes exist and have `generateMetadata`. The investigation surfaced **one P0 production bug that this brief was not even looking for**, plus a clean set of media/SEO gaps:

- **P0 — every Edition detail page 404s site-wide.** Edition route slugs are `setID:playID` (a colon). The page passes the URL-encoded slug (`%3A`) straight to `get_edition_detail`, which only matches the decoded colon, so it returns null → `notFound()`. Verified: decoded `2:187` resolves, encoded `2%3A187` does not. Set/Player/Team/Series pages survive only because their slugs have no special characters. The **sitemap is feeding Google 16K+ edition URLs (and 5,149 pack URLs) with these `%3A` colons** — i.e. our single highest-SEO-value page type is 100% dead and actively advertised to crawlers. One-line fix (`decodeURIComponent`), code-side → in the handoff.
- **Shipped live this session (3 DB migrations, verified):** team roster was showing the same player ~30× (Lakers = LeBron ×30) — fixed; team `player_count` was inflated (116 → real 73) — fixed; new `get_team_top_editions` RPC added to power a team hero montage + a "Top Editions" section.
- **Everything else is code (handoff):** the edition-404 fix, JSON-LD on all six pages, a visual pack-contents grid, hero montages for Set/Team/Series, branded OG cards, and hover-to-play video in the moment grids.

---

## Current state per page

Verified by reading each `page.tsx`, introspecting every backing RPC's live output, and viewing four pages on production in Chrome (edition, team, pack, set).

| Page | Route | Hero media | Grid/▾ media | Info depth | `generateMetadata` | OG image | JSON-LD |
|---|---|---|---|---|---|---|---|
| **Edition** | `[collection]/edition/[slug]` | video + image ✓ | parallels, "found in packs", special serials ✓ | **richest** (FMV, history chart, recent sales) | ✓ | thumbnail | ✗ |
| **Player** | `[collection]/player/[slug]` | portrait (headshot→1st-edition fallback) ✓ | editions grid ✓ | strong (stats, top sales, set cards) | ✓ | headshot→default | ✗ |
| **Set** | `[collection]/set/[slug]` | **text-only** | editions grid ✓ | good (stats, tier-mix bar) | ✓ | **generic default** | ✗ |
| **Series** | `[collection]/series/[slug]` | **text-only** | top-25 editions grid ✓ | good (sets + players + top eds) | ✓ | **generic default** | ✗ |
| **Team** | `[collection]/team/[slug]` | **text-only** | roster grid ✓ (was buggy) | **thinnest** (stats + roster only) | ✓ | **generic default** | ✗ |
| **Pack (dist)** | `[collection]/pack/dist/[distId]` | cover image ✓ | **contents = text table** | rich (EV, depletion, top-pulls) | ✓ | pack OG ✓ | ✗ |
| **Pack (NFT)** | `[collection]/pack/[id]` | cover image ✓ | lifecycle/pulls | rich (lifecycle, P&L) | ✓ (inline) | — | ✗ |
| **Moment (NFT)** | `[collection]/moment/[momentId]` | — (redirect stub → edition) | — | redirect only | ✗ | — | ✗ |

Two systemic gaps visible in the table: **no JSON-LD on any nested entity page** (only the legacy flat `/moment/[id]` has it), and **Set/Team/Series share the generic OG card**. The data to close both already exists in the RPCs the pages call.

---

## Bugs found (with evidence)

### 1. P0 — Edition pages 404 site-wide (colon-slug encoding)
- Reproduced in production: `/nba-top-shot/edition/2%3A187` (a slug taken directly from the Set grid's own `<a href>`) and `/nba-top-shot/edition/197:7080` both render the 404 ("Bingo Bango Bongo").
- Root cause: `get_edition_detail(cid,'2:187')` → resolves; `get_edition_detail(cid,'2%3A187')` → null. The page does `const { slug } = await props.params; fetchDetail(coll.id, slug)` with no decode. Next hands the page the percent-encoded segment for special chars, the RPC can't match it, `!detail` → `notFound()`.
- Why only editions: Set/Player/Team/Series slugs are slugified to `[a-z0-9-]` (no `%` ever), so encoded == decoded. Editions are the only slugs carrying a colon (`setID:playID`, and UUID:UUID for dupe-era rows).
- Blast radius: **all** Top Shot / All Day / Golazos / UFC edition pages (the bulk of the catalog and the top SEO target). The sitemap emits `encodeURIComponent(external_id)` URLs → Google is told to crawl 16K+ pages that 404.
- Fix (handoff item 1): `decodeURIComponent(slug)` in `edition/[slug]/page.tsx` (both `generateMetadata` and the page body), plus defensively in the other entity pages. One line; lowest-risk, highest-impact change in this whole effort.

### 2. Team roster fanout — FIXED LIVE
- Production showed the Lakers roster as "LeBron James" ×6 (and ×30 in data), all "122 editions / $19,662".
- Root cause: `get_team_players` did `players p JOIN editions e ON (e.player_id=p.id OR e.player_name=p.name) GROUP BY p.id`. The `players` table has ~3× duplicate rows per name (30 "LeBron James" rows for TS; 4,039 rows / 1,253 distinct names), so each dup produced a roster card.
- Fix shipped: `audit_20260530_fix_get_team_players_dedup_roster` — drive off `editions`, aggregate by normalized player name, attach player metadata via a headshot-preferring lateral. Verified: Lakers now returns 73 distinct players (LeBron, A. Davis, Magic, Rondo, Wilt, Caruso, Dončić…).

### 3. Team `player_count` inflated — FIXED LIVE
- `get_team_detail` reported Lakers `player_count = 116`; real distinct names = 73. It counted `DISTINCT COALESCE(player_id::text, player_name)`, and the duplicate `players` rows inflated the distinct-id count.
- Fix shipped: `audit_20260530_fix_get_team_detail_player_count_dedup` — count distinct normalized player name. Verified 116 → 73.

### 4. Thumbnail coverage — Top Shot 54%, others ~100% (data, not code)
- Edition media coverage: **Top Shot 8,820/16,278 (54.2%)** with thumbnail (8,792 with video); All Day 100%, Golazos 99%, UFC 100%; 0 TS players have a `headshot_url` (every TS portrait falls back to an edition thumbnail).
- The TS gap is concentrated in the ~7K inert UUID-keyed dupe editions (documented in CLAUDE.md), which carry null thumbnails and shouldn't appear in grids at all. That's why the Set grid shows "No image" tiles. Mitigations: the new `get_team_top_editions` already filters `thumbnail_url IS NOT NULL`; the handoff recommends the same guard (or canonical-only filter) on the other entity grids so dead tiles stop rendering. A genuine thumbnail backfill for canonical TS editions is a separate, larger data task (out of scope here; noted for the backlog).

---

## The four workstreams + hover-video — where the data already is

A key finding for sequencing: **almost none of this needs new DB work.** The pages already fetch arrays carrying thumbnails, and the detail RPCs already return everything JSON-LD needs.

1. **JSON-LD on all six pages.** No DB change. Add helpers to `lib/seo.ts` and a small `<script type="application/ld+json">` on each page:
   - Edition → `Product` (name, image=thumbnail, brand=collection, offers.price=fmv.fmv_usd, sku=external_id) + `BreadcrumbList`.
   - Player → `Person` + `BreadcrumbList`; Team → `SportsTeam` + `BreadcrumbList`.
   - Set / Series → `CollectionPage` + `ItemList` (items from the editions the page already fetched) + `BreadcrumbList`.
   - Pack → `Product`.
2. **Pack contents → visual grid.** No DB change. The dist page's "Top Pulls by EV" is a `<table>` built from a `pack_drop_pool` query selecting only `edition_id, drop_weight`. `get_pack_contents(cid, dist_id, …)` already returns `thumbnail_url`, `route_slug`, `fmv_usd`, `drop_weight`, `hit_probability`, `tier` per edition — render a "What's Inside" thumbnail grid from it (keep the EV table below for the analytics).
3. **Set/Team/Series hero montages.** No DB change for Set/Series (pages already fetch edition arrays → montage the first N `thumbnail_url`). Team uses the **new `get_team_top_editions`** (shipped) for a moment montage consistent with the others.
4. **Branded OG cards.** No DB change. New `/api/og/{edition,set,player,team,series}` modeled on `app/api/og/collection/route.tsx` (1200×630, `next/og`, edge, accent-themed) — edition/player can embed the real thumbnail; set/team/series can montage 3–4 thumbnails. Wire each page's `generateMetadata` to its new card.
5. **Hover-to-play video in grids (opt-in, Trevor said yes).** `EditionsGridPaginated` renders a static `<img>`. Add a `videoUrl` field to `EditionTile` (Edition RPCs already return `video_url`; the grid RPCs would need it added — small, additive) and play on hover with the thumbnail as `poster`, matching nbatopshot.com. Gate to TS/All Day (the collections that have video) and respect `prefers-reduced-motion`.

---

## Prioritized plan

**P0 — ship immediately (handoff):**
1. Edition-page `decodeURIComponent` fix. Un-404s the entire edition catalog. ~1 line × 2 call sites.

**P1 — highest SEO/UX leverage (handoff):**
2. JSON-LD on all six pages (+ visible breadcrumb nav, which doubles as the `BreadcrumbList` rich-result source).
3. Pack contents visual grid (dist page).
4. Grid dead-tile guard (`thumbnail_url IS NOT NULL` / canonical-only) so "No image" tiles stop rendering.

**P2 — polish & richness (handoff):**
5. Set/Team/Series hero montages (Team uses the shipped `get_team_top_editions`; also add a "Top Editions" section to the thin Team page).
6. Branded OG cards for edition/set/player/team/series.

**P3 — nice-to-have (handoff):**
7. Hover-to-play video in moment grids.
8. Backlog: TS canonical-edition thumbnail backfill (data task); a real per-NFT moment view to replace the redirect stub.

---

## Shipped live this session (Cowork → DB, verified)

All three are read-only `STABLE SECURITY DEFINER`, `search_path=public`, `statement_timeout=8s`, granted to `postgres` + `service_role` only (no anon). Verified post-apply.

| Migration | Effect | Revert |
|---|---|---|
| `audit_20260530_fix_get_team_players_dedup_roster` | Roster returns 1 row/distinct-player (Lakers 30→ proper). | Re-`CREATE OR REPLACE` prior body (saved in this doc's git history / prior `pg_get_functiondef`). |
| `audit_20260530_fix_get_team_detail_player_count_dedup` | `player_count` counts distinct normalized name (116→73). | Re-`CREATE OR REPLACE` prior body. |
| `audit_20260530_add_get_team_top_editions` | New RPC: FMV-ranked, thumbnailed team editions. | `DROP FUNCTION public.get_team_top_editions(uuid,text,integer,integer);` |

The two `CREATE OR REPLACE` fixes kept the same signatures, so existing grants were preserved (re-asserted defensively in-migration). The new function got an explicit `REVOKE … FROM PUBLIC, anon, authenticated` + `GRANT … TO postgres, service_role`.

---

## What's in the handoff (code Cowork can't push)

`decodeURIComponent` edition fix · JSON-LD helpers + per-page injection · breadcrumb nav · pack contents grid · grid dead-tile guard · Set/Team/Series hero montages + Team "Top Editions" section · branded OG routes · hover-video grid. Each item lists exact files, the reason, and a revert path.
