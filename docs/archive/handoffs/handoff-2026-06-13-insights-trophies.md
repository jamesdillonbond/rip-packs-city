# Handoff 2026-06-13 — New public surface: /insights/trophies (Trophy Room)

Cowork shipped the backing view live + verified it. CC builds the route + page + OG + sitemap + canonical (Cowork can't push .tsx/route code). This is the one "killer surface" from the research thread (squeeze / rookies / cross-collection already public; **trophies was the gap**).

## What it is
A public Trophy Room: the rarest grail editions across Flow — **1-of-1 editions + Ultimate-tier** moments — ranked by FMV, with collection / player / set / tier / circulation / FMV + confidence. Trophy-hunting is core collector behavior and none of the 13 existing /insights surfaces cover it.

## Backing data — ALREADY SHIPPED + VERIFIED (Cowork, migration `audit_20260613_v_insights_trophies`)
View `public.v_insights_trophies` — `security_invoker = on`, `GRANT SELECT` to anon/authenticated/service_role (verified: reloptions `{security_invoker=on}`, anon present). Light: edition-level filter (~746 base rows) + per-edition latest-FMV lateral on `idx_fmv_edition_time`; sub-second.

Live counts at ship: **683 rows** (after `thumbnail_url IS NOT NULL`), **94 priced**, 0 HIGH/MED (grails rarely trade → FMV is mostly ASK_ONLY / STALE / NULL — this is honest, see Honesty below). Collections present: nba_top_shot + nfl_all_day only (Golazos/UFC have no Ultimate tier or 1-of-1s in `editions`; Pinnacle is a separate table — out of scope v1).

Columns: `edition_id, external_id, collection, collection_id, name, player_name, set_name, team_name, tier, series, circulation_count, thumbnail_url, video_url, is_one_of_one (bool), is_ultimate (bool), fmv_usd, confidence, fmv_computed_at`.

Top of board verified live: Steph Curry "Supernova" /10 $10,000 (STALE); 1-of-1 Rookie Ultimates $4,500–6,750 (ASK_ONLY); AllDay Drake Maye Rookie Marquee /10 $3,149.

## Build (mirror an existing surface end-to-end)
Closest existing analog: **`/insights/squeeze`** (ranked editions + FMV grid) and `/insights/rookies`. Copy their shape for all of:

1. **Route** `app/api/public/insights/trophies/route.ts` — read `v_insights_trophies`. Filters: `?collection=` (nba_top_shot|nfl_all_day), `?type=` (one_of_one|ultimate|all), `?sort=` (fmv desc default; also circ asc). `ORDER BY fmv_usd DESC NULLS LAST` so priced grails lead. Cache `s-maxage=3600` (FMV recomputes on its own cron; trophies move slowly). Cap rows (e.g. LIMIT 500) — view is bounded anyway. Mirror the squeeze route's auth/cache headers exactly.
2. **Page** `app/insights/trophies/page.tsx` — anon-public (front door is public). Hero strip of the top priced trophies (FMV-desc), then a grid. Tile: thumbnail (use `thumbnail_url`; hover-video via `video_url` like the entity grid if cheap), player/set, a TROPHY badge (`is_one_of_one` → "1 of 1", else `is_ultimate` → "Ultimate"), circulation, FMV + confidence chip. **Brand tokens only** (`var(--rpc-red)`, `var(--font-display)`, `var(--font-mono)`) — no `#E03A2F`/`'Barlow Condensed'` literals (CI guard `scripts/check-brand-tokens.mjs` will fail otherwise). Light-mode clean (use `--rpc-*` neutral tokens, not hardcoded darks — this is a fresh public surface, get it right at birth).
3. **Canonical** `app/insights/trophies/layout.tsx` — param-stripped self-canonical (copy squeeze's layout) so `?collection=`/`?type=` filtered URLs don't index as dup content.
4. **OG card** — add `/api/og/insights-trophies` (or extend the shared insights OG helper). 1200×630, branded, e.g. a 2×2 montage of top-FMV trophy thumbnails. Mirror the existing `/api/og/...` insights pattern; point the page's `openGraph`/`twitter` image at it.
5. **Sitemap** `app/sitemap.ts` — add `'trophies'` to the insights slug array (the `r` list around L331-335) and bump the "12 routes" comment (L315) to 13.
6. **Discovery / internal links** — add a Trophy Room card to the `/insights` index (`app/insights/page.tsx`) surface list, and consider a "Featured in" link from entity/edition pages where `is_one_of_one || is_ultimate`. Internal linking is RPC's SEO lever ([[rpc-seo-internal-linking-lever]]).

## Honesty (do NOT fake it)
- Only ~94 of 683 are priced; the rest are real grails that have **never traded** → NULL FMV. Render unpriced as "—" / "Awaiting a comp", NEVER `$0`. Lead the hero with priced rows; show unpriced in the grid as legit rare editions.
- Confidence is mostly ASK_ONLY / STALE — surface the confidence chip honestly (same vocabulary as the rest of the app). A $10K STALE Supernova is "last-known", not a live quote.
- `circulation_count = 10` Supernovas appear (Ultimate but not 1-of-1) — the `is_one_of_one` / `is_ultimate` flags distinguish them; badge accordingly ("/10 Ultimate" vs "1 of 1").

## QA before calling done (per rpc-insights-qa)
Backing view ✓ (shipped+verified). Then: `/api/public/insights/trophies` → 200 JSON; `/insights/trophies` renders for anon; OG → 200. Confirm it's in the sitemap. Drill-down (`?type=one_of_one`) renders rows, not an empty page. Add it to the `rpc-insights-health` artifact surface list. Re-run `check_public_security_invariants()` (expect 0 rows — the view is already invoker-safe, base tables editions+fmv_snapshots are RLS-on anon-SELECT).

## Revert
Frontend: `git revert <commit>`. Backing view: `DROP VIEW public.v_insights_trophies;` (no other consumer). Sitemap/index-card revert with the frontend commit.
