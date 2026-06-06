# Handoff — SEO internal-linking (2026-06-05)

Plain text on purpose (no code fences) so it pastes clean from an iPhone. Full audit context: docs/audits/seo-technical-audit-2026-06-05.md.

CONTEXT

Cowork already shipped one thing live for this workstream: it refreshed the two cross-collection cohort tables (cross_collection_cohort_mat 143->144 rows, cross_collection_ts_set_overlap_mat 240->243) via refresh_cross_collection_cohort_step1()/step2(). Nothing else was pushed because everything below is .tsx/route code and Cowork has no git creds.

This is a NEW workstream (not in docs/overnight/ledger.md, not in the nightly pass queue). The audit found the SEO foundation is excellent but the 18,245-edition entity corpus is internally orphaned: an anonymous Googlebot can only reach it via the XML sitemap. Nothing public links INTO it (homepage 0, /overview 0, all 12 /insights surfaces 5 links total, SiteFooter 0) and entity pages link back to /insights 0 times. These items fix the link graph. All are link-only / read-only — no auth, pricing, FMV, ingest, or sniper logic is touched.

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape. I read SiteFooter.tsx, edition/[slug]/page.tsx, lib/seo.ts, and overview/page.tsx directly; the per-insights-page row locations below I did NOT open line-by-line, so locate the row-render JSX yourself before wrapping it.

---

ITEM 1 (P0, do first — highest impact for least code) — SiteFooter "Explore" links

File: components/SiteFooter.tsx (verified exists; mounted in app/(collections)/layout.tsx line 40, so it renders on every entity page — edition/set/player/team/series/pack — plus overview, home, about, analytics).

Why: SiteFooter currently links only /about, /pricing, /legal/fmv-methodology, /terms, /privacy. It is the one component already rendered on all ~18K entity pages, so adding hub links here gives the whole corpus an internal link into /insights and the collection overviews in a single edit — the biggest crawl-equity win in the audit.

Change: add a new link group above the existing bottom strip (the © / About / Terms row). Use next/link <Link> and brand tokens (var(--rpc-text-muted), var(--font-mono)) consistent with the file. Add two short columns:
- "Insights" column linking: /insights, /insights/squeeze, /insights/pack-reality, /insights/rookies, /insights/deals, /insights/first-mint, /insights/market. (These are the highest-depth public surfaces.)
- "Collections" column linking: /nba-top-shot/overview, /nfl-all-day/overview, /laliga-golazos/overview, /disney-pinnacle/overview, /ufc/overview. (Pull from publishedCollections() in lib/collections.ts and map col.id -> /{col.id}/overview rather than hardcoding, so it stays correct if a collection publishes.)

Also mount SiteFooter on the two public surfaces that currently lack it: add <SiteFooter /> to app/insights/layout.tsx (inside the returned fragment, after {children}) and to the /moment layout (app/moment/[id]/layout.tsx if present, else the page). Verify those layout files exist first; if /moment has no layout, add the footer at the bottom of app/moment/[id]/page.tsx's returned JSX.

Revert: git revert the commit.

Verification: npx tsc --noEmit clean; deploy READY; load /nba-top-shot/edition/187:6905 logged-out and confirm footer shows the new /insights links; load /insights logged-out and confirm the footer now renders.

---

ITEM 2 (P0) — Insights -> entity drill-down links

Goal: each data row on the insights boards should link to the matching public entity page. This flows authority from the unique-content pages down into the corpus and is a clear UX win. The backing views already carry the keys (I verified the columns) — no DB change needed. All these surfaces are Top Shot, so the collection url slug is always nba-top-shot.

Helpers to import where needed: slugifyName from @/lib/entity-labels (same one the sitemap + edition page use). Wrap with next/link <Link>.

Files + the link to build (locate the row-render JSX in each page/component, then wrap the player/edition name cell in a Link):

- app/insights/squeeze/page.tsx — view topshot_squeeze_board has external_id. Link each row to /nba-top-shot/edition/{encodeURIComponent(external_id)}. (squeeze already has 4 entity links — confirm it covers the main row.)
- app/insights/deals/page.tsx — view topshot_deals_vs_fmv has external_id. Link to /nba-top-shot/edition/{encodeURIComponent(external_id)}.
- app/insights/first-mint/page.tsx — view topshot_first_mint_trophies has external_id. Link to /nba-top-shot/edition/{encodeURIComponent(external_id)}.
- app/insights/rookies/page.tsx — view topshot_2025_rookie_index has player_name only (no edition id; it's a player cohort). Link each row to /nba-top-shot/player/{encodeURIComponent(slugifyName(player_name))}.
- app/insights/set-squeeze/page.tsx — view topshot_set_squeeze_board has set_name (and set_id). Link each row to /nba-top-shot/set/{encodeURIComponent(slugifyName(set_name))}.
- app/insights/offer-spread/page.tsx — if the row exposes external_id, link to the edition page same as deals; if it only exposes a set/player, link accordingly. Confirm the column in the page's fetch before wiring.

Note on render mode: if any of these pages is a "use client" component that renders rows from a client fetch, the <Link> still works and still helps (Google renders JS), but prefer server-rendering the initial list where it's a cheap change — server-rendered links are the stronger signal. Don't refactor a whole page for this; just wrap the existing rows.

The corresponding /api/public/insights/* routes already SELECT these columns (I checked the .from() targets), but confirm the column is actually returned in each route's select list and threaded to the page; add it to the select if a needed key (e.g. external_id) is dropped before reaching the client.

Revert: git revert.

Verification: tsc clean; deploy READY; on /insights/squeeze logged-out, click a row -> lands on the edition page (200, not /login).

---

ITEM 3 (P0) — Edition "Featured in Insights" block (entity -> insights direction)

File: app/(collections)/[collection]/edition/[slug]/page.tsx (verified — server component, already fetches 6 things in a Promise.all around line 257; detail.id is the edition uuid, slug/external_id is available).

Why: closes the reverse direction. An edition that is highly squeezed, a below-FMV deal, or a first-mint trophy should say so and link to the board it appears on.

Two implementation options — pick one:

OPTION A (no DB change, simplest): in the page, for Top Shot only (collection === "nba-top-shot"), add three small reads via supabaseAdmin alongside the existing fetches (mirror how fetchSpecialSerials reads special_serial_holders directly):
- topshot_squeeze_board: select squeeze_pct where edition_id = detail.id (maybeSingle)
- topshot_deals_vs_fmv: select discount_pct where external_id = slug (maybeSingle)
- topshot_first_mint_trophies: select multiplier where edition_id = detail.id (maybeSingle)
Then render a small "Featured in" Section with a Link to /insights/squeeze ("Top X% squeeze"), /insights/deals ("N% below FMV"), /insights/first-mint ("#1 sold Nx the field") for whichever returned a row. Skip the whole section for non-TS collections and when all three are empty.

OPTION B (one round trip, additive RPC): apply this migration first (I verified the join keys return correct rows for the top-squeeze editions). It is additive, read-only, SECURITY INVOKER, and reversible with one DROP:

  create or replace function public.get_edition_insight_links(p_edition_id uuid, p_external_id text)
  returns jsonb language sql stable security invoker set search_path = public as $func$
    select jsonb_strip_nulls(jsonb_build_object(
      'squeeze_pct',   (select round(squeeze_pct)        from topshot_squeeze_board     where edition_id = p_edition_id limit 1),
      'deal_pct',      (select round(discount_pct)       from topshot_deals_vs_fmv      where external_id = p_external_id limit 1),
      'first_mint_x',  (select round(multiplier::numeric,1) from topshot_first_mint_trophies where edition_id = p_edition_id limit 1)
    ));
  $func$;
  revoke execute on function public.get_edition_insight_links(uuid, text) from public, anon, authenticated;
  grant  execute on function public.get_edition_insight_links(uuid, text) to service_role;

  Then call it once in the page's Promise.all and render the same "Featured in" Section.
  Revert for Option B: drop function public.get_edition_insight_links(uuid, text);

Either way: brand tokens, and make the section render nothing (no empty box) when there are no memberships.

Revert: git revert the page commit (+ the drop above if Option B).

Verification: tsc clean; deploy READY; load a known-squeezed edition (e.g. /nba-top-shot/edition/187:6905, Alex Caruso, 95% squeeze) logged-out and confirm a "Featured in: Squeeze" link renders and points to /insights/squeeze.

---

ITEM 4 (P1) — /moment canonical consolidation

File: app/moment/[id]/page.tsx (verified — generateMetadata around line 366 sets alternates.canonical to /moment/{id}, i.e. self-canonical).

Why: /moment/{id} is also in the sitemap (top 200 editions) and shows essentially the same content as /{collection}/edition/{slug}. Two self-canonical URLs for the same moment = ~200 near-duplicate pairs diluting each other. The edition URL is the richer, collection-scoped, better-linked one, so it should be the canonical.

Change: in /moment/[id] generateMetadata, resolve the moment's collection url slug + edition route slug (the detail RPC the page already calls returns enough to build it — confirm the fields) and set alternates.canonical to the absolute /{collectionUrlSlug}/edition/{encodeURIComponent(routeSlug)} instead of /moment/{id}. If the collection/slug can't be resolved for a given id, fall back to the current self-canonical (don't emit a broken canonical). Optionally also switch the internal "Parallels" links on the edition page (they currently point at /moment/{id}) to the edition URL, but that's optional polish.

Revert: git revert.

Verification: tsc clean; deploy READY; view-source on a /moment/{id} that maps to an edition and confirm the canonical points at the /{collection}/edition/{slug} URL.

---

ITEM 5 (P1) — /overview crawl hygiene + public fan-out

File: app/(collections)/[collection]/overview/page.tsx (verified — "use client"; its Tools grid and "View all ->" links point at gated tabs /sniper, /collection, /sets, /analytics, /market, which 302->/login for anon crawlers; it links 0 public entity pages).

Why: the 5 /overview pages are priority 0.9 in the sitemap and are the only public per-collection pages, but they waste crawl budget pointing at login redirects and pass nothing into the corpus.

Change (two parts):
a) For the anon/crawler view, stop foregrounding gated-tab links. Simplest: keep the Tools grid for signed-in users but ensure the prominent always-rendered links include public destinations (the /insights surfaces for that collection, and the entity fan-out below). Do NOT add nofollow as the fix — replace dead-for-anon links with real public ones.
b) Add a small server-rendered "Popular on {collection}" block linking real public entity pages. Cheapest source: a handful of top editions/players/sets for the collection (you can reuse an existing RPC such as the squeeze/deals boards for TS, or a top-by-circulation/recent query for the others) rendered as <Link> to /{collection}/edition|player|set/{slug}. Server-render this list so the links exist without JS. Keep it to ~12-20 links.

Note: because the page is "use client", consider rendering the "Popular on" block from the server layout (overview/layout.tsx) or a small server component imported into the page, so the links are in the initial HTML.

Revert: git revert.

Verification: tsc clean; deploy READY; view-source /nba-top-shot/overview logged-out and confirm it now contains server-rendered links to public edition/player/set pages and no longer foregrounds /sniper-type gated links to anon.

---

GUARDRAILS (every item)

- Direct to main. No branches, no PRs (CLAUDE.md non-negotiable). If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify the push with: git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s — anything higher sends the deploy to ERROR invisibly.
- CRLF: don't string-replace-patch on Windows; use full-file writes or findIndex on split lines.
- After deploy, run the smoke test and confirm the new /insights footer links + a drill-down both resolve 200 logged-out.

END STATE

One commit on main (or a few), Vercel deploy READY, tsc clean. Net effect: the ~18K entity pages gain internal links to /insights via the footer; the insights boards link down into the corpus; edition pages link back up to the boards; /moment stops competing with /edition; /overview stops wasting crawl budget and starts feeding the corpus. Watch the GSC "Crawled — currently not indexed" bucket shrink over 2-4 weeks.
