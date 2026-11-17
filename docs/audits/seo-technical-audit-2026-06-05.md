# RPC Technical-SEO Audit — 2026-06-05 (autonomous overnight pass)

Scope: technical SEO of the public, indexable surfaces, with the thesis that organic discoverability is the guardrail-safe growth lever while promo stays gated. Read-only audit + one low-risk live fix + a turnkey Claude Code handoff for the rest. No promo drafted. No auth/pricing/FMV/ingest logic touched.

---

## TL;DR

The SEO **foundation is excellent** — better than most funded startups. Server-rendered metadata, canonical, and full JSON-LD on every entity page; all 12 `/insights/*` surfaces are public, uniquely titled, canonicalized, and in the sitemap; ~24K entity/pack URLs are intact; robots.txt is correctly scoped (blocks AI-*training* bots, allows Googlebot + AI-*search* bots).

The **gap is internal linking**, not implementation. The 18,245-edition entity corpus (plus sets/players/teams) is reachable by an anonymous crawler essentially **only via the XML sitemap** — it's a well-connected island with a pinhole entrance. The unique-content insights surfaces (the thing no competitor has) are linked almost nowhere and link *out* to the corpus almost nowhere. Sitemap-only URLs with no internal link equity and no backlinks are exactly what Google parks in "Crawled — currently not indexed." Fixing the link graph is the single highest-leverage, no-promo move, and most of it is one-component-deep.

**Shipped live tonight (1):** refreshed the 5-day-stale cross-collection cohort tables. **Packaged as a handoff (5 items):** the internal-linking fixes — all `.tsx`, which I can't push from here.

---

## What I changed live tonight

**Refreshed `/insights/cross-collection` backing data.** The two cohort tables (`cross_collection_cohort_mat`, `cross_collection_ts_set_overlap_mat`) were last computed **2026-05-30** — 5 days 17 h stale — because their refresh is two manual RPCs with no cron. Ran `refresh_cross_collection_cohort_step1()` + `step2()` (the documented path; each is an atomic plpgsql function, so a failure would have rolled back to the existing data — zero partial-state risk). Verified: cohort 143 → **144**, set-overlap 240 → **243**, both now timestamped 06-05 06:51 UTC. The page is live-fresh.

- Revert: none needed — it's a recompute; the next refresh overwrites.
- Recurrence: it will re-stale. Fix is a daily trigger (see P2-6). I did **not** create a standing automation unilaterally — flagging it for your call.

---

## What's already strong (don't re-audit these)

- **Entity pages are fully server-rendered for bots.** `edition/[slug]/page.tsx` is an async server component: `generateMetadata` + body run server-side. Title, rich live-FMV description, canonical, Product + BreadcrumbList JSON-LD all render without JS.
- **JSON-LD coverage is comprehensive and correct** (`lib/seo.ts`): Product (edition/pack), Person (player), SportsTeam/Organization (team), CollectionPage + ItemList (set/series), BreadcrumbList everywhere, WebApplication (org). Price falls back FMV → low_ask and correctly *excludes* STALE FMV so a wrong price never gets indexed.
- **All 12 insights surfaces are anon-200** (`proxy.ts:270`), each with its own `layout.tsx` carrying a unique title + canonical (no duplicate-title problem), none accidentally `noindex`. Backing data is deep on the ones that matter: squeeze 3,135 · offer-spread 5,614 · first-mint 517 · market 548 · deals 334 · set-squeeze 128 · pinnacle-scarcity 103 · rookies 61.
- **Sitemap is complete and intact.** All 12 insights routes + ~24K entity/pack URLs; the robust `.in(collection_id)` query pattern is emitting them (verified: 18,245 editions all with external_id, 5,230 packs, 24 series).
- **robots.txt is correctly scoped.** Blocks training crawlers (GPTBot, ClaudeBot, CCBot, anthropic-ai, Google-Extended) while leaving Googlebot, Bingbot, and AI-*search* bots (OAI-SearchBot, PerplexityBot — not in the disallow list) free to crawl. That's the right posture: protect training, stay citeable in AI search.
- **Homepage collection tiles correctly link `/{collection}/overview`** (the public page), not the gated root. (I checked — this is fine.)

---

## The core finding: the entity corpus is internally orphaned

I mapped the crawl graph an anonymous Googlebot actually sees. Links *into* the 18K-page entity corpus:

| Source surface | Links to entity pages (edition/set/player/team)? |
|---|---|
| Homepage (`HomePageMarketing`) | **0** (links /insights ×2, 5× /overview, /nba/fast-break) |
| `/{collection}/overview` (the only public per-collection page) | **0** — and it's a `"use client"` page whose prominent links (Tools, "View all") point at **auth-gated** tabs (`/sniper`, `/collection`, `/sets`, `/market`), which 302→/login for anon |
| All 12 `/insights/*` surfaces combined | **5 total** (squeeze 4, first-mint 1; the other 10 have 0 drill-down links *despite their backing views carrying the entity keys*) |
| `SiteFooter` (mounted on **all** entity pages) | **0** — links only About/Pricing/FMV/Terms/Privacy |
| Entity → `/insights` (reverse direction) | **0** |

So: the only inbound path to the corpus is the XML sitemap. Once a crawler is *in*, the corpus links itself well (edition ↔ set ↔ player ↔ team ↔ parallels ↔ packs), but nothing public funnels authority into it. For a pre-traction site with no backlinks, internal links are the primary ranking signal — and the corpus has none. This is why accurate pages can be technically perfect and still not rank.

The fix is to widen the entrance, and the surfaces that should do it (the footer, the insights pages) are already built and already carry the data needed — they just don't emit the links.

---

## Prioritized fixes (all in the handoff: `docs/handoff-2026-06-05-seo-internal-linking.md`)

Every item below is guardrail-safe (read-only/link-only, no auth/pricing/FMV/ingest logic). All are `.tsx`/route code → they go through Claude Code; I can't push from Cowork.

**P0 — the lever (internal linking)**

1. **`SiteFooter`: add an "Explore / Insights" link section.** It's *already mounted on every entity page* via `app/(collections)/layout.tsx`. Adding links to `/insights` + the top surfaces + the 5 `/overview` pages instantly gives ~18K pages an internal link into the hubs — the highest leverage for the least code in the whole audit. Also mount the footer on `/insights` and `/moment` (currently absent from both). ~1 file.
2. **Insights → entity drill-down links.** Make each row on squeeze / deals / first-mint link to its edition page, rookies to the player page, set-squeeze to the set page. The backing views already carry the keys (verified — `external_id`, `edition_id`, `player_name`, `set_name`). This pushes authority from the unique-content pages *down* into the corpus and is a straight UX win. ~5-6 files.
3. **Edition "Featured in Insights" block.** On an edition page, show membership: squeeze % (→ /insights/squeeze), below-FMV deal (→ /insights/deals), first-mint trophy (→ /insights/first-mint). I verified the join SQL works and included it in the handoff (optionally as a small additive RPC). Closes the entity→insights direction. ~1-2 files.

**P1 — consolidation + hygiene**

4. **`/moment/[id]` canonical consolidation.** It self-canonicalizes *and* is in the sitemap (top 200), duplicating the richer `/{collection}/edition/{slug}`. Point `/moment` canonical at the edition URL (it has the data to resolve it) to consolidate ~200 near-duplicate URL pairs.
5. **`/overview` crawl hygiene + a public fan-out.** Its most prominent links send anon crawlers to gated tabs (302→/login = wasted crawl budget). Repoint those to public equivalents and add a small server-rendered "Popular on {collection}" block linking real public entity pages — turning the 5 highest-authority public collection pages into corpus entrances.

**P2 — secondary**

6. **Wire a daily cross-collection refresh** (cron-job.org route hit, or a Cowork scheduled task calling the two step RPCs) so the page I refreshed tonight doesn't re-stale. Your call on mechanism.
7. **`/insights/pack-reality` is thin** (6 distribution rows, 3 top-EV) — genuine data-coverage limitation (pack-rip metadata only resolves ~75%, drop-pool coverage starts April 2026), not a bug. It renders but won't rank for much yet. Option: `noindex` it until it has depth so it doesn't dilute the strong surfaces; otherwise harmless to leave.

---

## Notes / non-issues confirmed

- The AI-bot blocks are deliberate and correctly scoped — not a problem to fix.
- 10 of 12 insights backing relations are live views (zero staleness risk); only the two cross-collection tables needed refresh.
- No `noindex` leaks, no broken canonicals, no missing-meta surfaces found on the public routes audited.

## Suggested sequence

Ship P0-1 first (one footer file — biggest ratio of impact to effort), then P0-2/P0-3 together, then submit the sitemap in Search Console and watch the "Crawled — currently not indexed" bucket over 2-4 weeks as internal links take effect. P1/P2 are cleanup that can trail.
