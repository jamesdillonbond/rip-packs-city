# RPC Claude Code — close the internal-linking gap so the entity corpus is crawlable (SEO growth lever) (2026-06-21)

**This is RPC's single biggest on-page SEO lever pre-traction** (the foundation — sitemap, JSON-LD, OG, canonicals, anon-public entity pages — is already excellent; the gap is the internal link graph). Scoped read-only from Cowork; this is the implementation handoff.

## The problem (grounded)
`app/sitemap.ts` advertises ~33K URLs — including **~17K canonical edition pages** plus set / player / team / series / pack pages. But the only anon-crawlable surfaces are the homepage, `/insights/*`, and `/{collection}/overview` (everything else 302→/login per `proxy.ts`). And the site-wide footer (`components/SiteFooter.tsx`) links **only** to social / about / pricing / legal — **zero links into the collection or entity corpus** (confirmed this session). So Googlebot lands on the public hubs and finds almost no internal path into the 17K-page corpus. A sitemap alone is a weak discovery+ranking signal; internal links are the strong one. The entity pages themselves are already anon-public (the 2026-05-31 entity-pages work + the `proxy.ts` singular-segment carve-outs) and carry JSON-LD + breadcrumbs — **they just aren't linked TO densely.** Result: the corpus mostly sits in GSC's "Discovered / Crawled – currently not indexed" buckets.

## Fix — prioritized by leverage

### 1. Footer "Browse" hub (highest leverage — renders on EVERY page)
Add a Browse/Explore column to `components/SiteFooter.tsx` with server-rendered `<Link>`s to: the 5 collection overviews (`/nba-top-shot/overview`, `/nfl-all-day/overview`, `/laliga-golazos/overview`, `/ufc-strike/overview`, `/disney-pinnacle/overview`), the top ~6 insights boards (`/insights/squeeze`, `/insights/deals`, `/insights/serial-premiums`, `/insights/underpriced-serials`, `/insights/rookies`, `/insights/trophies`), and `/insights`. Instantly gives every page crawl paths into the whole public surface.

### 2. Collection `/overview` drill-downs (the key corpus fix)
`/{collection}/overview` is the anon-public hub for each collection but currently funnels crawl nowhere. Add **server-rendered, crawlable** sections linking into that collection's corpus: **Top Sets** (`/{collection}/set/<slug>`), **Top Players** (`/{collection}/player/<slug>`), **Notable Editions** (`/{collection}/edition/<external_id>`), **Series** (`/{collection}/series/<slug>`), **Teams** (`/{collection}/team/<slug>`). 30–50 links per overview turns each into a hub that flows crawl into the 17K corpus. Source the lists from existing RPCs (top sets/players/editions by FMV or recency). **Must be in the SSR HTML, not client-only/JS-gated** — verify with `curl` of the rendered page. (The tabs live under `app/(collections)/[collection]/`; audit how `overview` is rendered — likely a `[tab]` segment — and add the sections there.)

### 3. Insights board rows → entity drill-downs
The newer boards (serial-premiums, top-sales) already link rows to `/{collection}/edition/<external_id>` (per the `rpc-insights-qa` checklist). Audit the **older** boards (squeeze, deals, rookies, first-mint, set-squeeze, cross-collection, pack-reality) and make every listed edition/player/set a real `<Link>` to its entity page. These are high-authority anon pages → strong internal links.

### 4. Entity-page cross-links + "Related editions"
On edition pages add "More from this set" / "More <player> moments" / "Same series" grids linking sibling editions (breadcrumbs already link set/player/team). On set/player/team pages, confirm the edition grids render as server-rendered `<Link>`s (not a client fetch Googlebot won't run). This densely interlinks edition↔set↔player↔series so crawl flows through the corpus instead of dead-ending.

### 5. (Optional) `/browse` index
A paginated, fully SSR collections → sets → editions index for deep crawl coverage + a real user browse experience.

## Implementation notes
- **Every link server-rendered** (RSC/SSR `<Link>`), so Googlebot sees it without executing JS. This is the #1 correctness criterion — a client-only list does nothing for SEO.
- Entity pages are already anon-public → **no `proxy.ts` change needed**.
- Reuse `lib/entity-labels` `slugifyName` + `lib/collection-slug` helpers so the URLs match the sitemap's exact slug forms (mismatch = duplicate/404 crawl waste).
- Brand tokens (`var(--rpc-*)`); cache the top-N lists so the overview render stays light.
- Additive only — no data/pricing/auth logic touched → low risk.

## Verify
- `curl -s https://www.rippackscity.com/nba-top-shot/overview | grep -c '/edition/\|/set/\|/player/'` → should jump from ~0 to ≥30.
- Footer links to all 5 collections + top insights on every page.
- Over 2–4 weeks: GSC "Discovered/Crawled – currently not indexed" shrinks; impressions on entity URLs climb.

Guardrails: direct-to-main, PowerShell git, `git rev-list --count origin/main..HEAD` = 0, tsc clean; don't touch `.github/workflows/`. Update CLAUDE.md + the ledger.
