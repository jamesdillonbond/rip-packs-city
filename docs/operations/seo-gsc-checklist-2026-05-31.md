# SEO lock-in + Search Console checklist — 2026-05-31

Verification of the now-live entity/insights SEO surface, plus the operator steps to get it indexed. The big blocker (sitemap emitting 0 entity URLs) is **resolved** — `app/sitemap.ts` now enumerates by `collection_id` and the live sitemap returns real URLs.

## Verified live (2026-05-31)

- **Sitemap is populated:** `https://www.rippackscity.com/sitemap.xml` → **33,448 URLs** (HTTP 200, 6.6 MB): 23,513 editions, 5,220 packs, 3,510 players, 597 sets, 125 teams, 24 series, 11 insights. Under Google's 50K-per-file limit (split into a sitemap index when it nears 50K).
- **robots.txt is correct:** `Allow: /`; entity + `/insights/*` crawlable; `/api/`, `/admin/`, `/login`, `/dashboard`, `/profile/edit`, `/auth/`, `/share/`, and `?wallet=/?owner=/?address=` query forms disallowed (intentional — per-wallet `/share` is deliberately non-indexed); `GPTBot`/`ClaudeBot`/`CCBot`/`anthropic-ai`/`Google-Extended` blocked (intentional AI-scraper policy); `Sitemap:` declared.
- **Canonical + structured data correct:** edition page `8:133` returns `<link rel=canonical>` = `…/edition/8%3A133` (self-canonical, encoded-colon matching the sitemap), `og:url` matches, `robots: index, follow`, **3 JSON-LD blocks**. No canonical drift between the page and the sitemap entry.

## One refinement (code — see handoff-2026-05-31-next-block, item A)

The sitemap also advertises **auth-gated** routes that 302 anon→`/login`: the per-collection feature tabs `collection / market / sniper / sets / packs` (≈30 URLs) and the **entire `/analytics/*` section** including every `/analytics/wallets/<addr>` (potentially hundreds–thousands). Googlebot crawling these gets a redirect to the login wall → "Page with redirect" coverage status + wasted crawl budget. Fix = prune the sitemap to anon-public routes only (`overview` is public, the other feature tabs are not), OR deliberately open chosen analytics surfaces to anon if they're meant to be discovery surfaces (a product call — they're intelligence pages). Not a blocker; a cleanliness/efficiency win.

## Operator steps (Trevor — in Google Search Console)

1. Confirm the property `https://www.rippackscity.com` is verified in GSC (domain or URL-prefix).
2. **Sitemaps → add/submit `sitemap.xml`.** Resubmit even if previously added (it returned 0 entity URLs before — Google needs the fresh fetch).
3. **URL Inspection** on 2–3 representative entity URLs (one edition, one player, one `/insights/squeeze`): "Test live URL" → should be crawlable + indexable; "Request indexing" on a couple to prime discovery.
4. Over the next 1–3 weeks watch **Pages (Indexing)**: "Discovered/Crawled – not indexed" will dominate early (normal for 33K thin-ish pages); look for steady movement into "Indexed." If a chunk lands in **"Page with redirect,"** that's the gated-routes issue above → ship the sitemap prune.
5. **Performance** report: first impressions on entity/insights queries are the leading signal that the SEO bet is converting to discovery. That's the metric to watch toward the 50-WAU traction bar.

Note: indexing 33K new URLs is a multi-week crawl; don't expect traffic this week. The point is the foundation is finally *reachable* — every entity + insights page the platform already builds is now crawler-visible.
