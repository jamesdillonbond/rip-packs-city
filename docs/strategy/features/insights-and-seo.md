# Insights & SEO — feature roadmap (refreshed 2026-10-17, PT)
> Dated snapshot; re-derive any number before quoting. Canonical plan: [roadmap-2026-10-17.md](../roadmap-2026-10-17.md). Per-collection detail: [collections/](../collections/). Defects: [known-issues.md](../../reference/known-issues.md).

## What it is today

**`/insights` is the public, anonymous face of the product.** It has ~32 live boards (the hub's ItemList JSON-LD, 10-14):
- **Market reads:** squeeze, set-squeeze, squeeze-check, panini-squeeze; market, market-cap, market-pulse; top-sales; deals; offer-spread.
- **Scarcity and serials:** serial-premiums, parallel-premiums, underpriced-serials, first-mint, pinnacle-scarcity, allday-scarcity, trophies.
- **Collectors:** rookies, rookie-board, account-value, new-collectors, set-completers, tc-report.
- **Packs:** pack-reality, allday-pack-reality, topshot-pack-market, allday-pack-market, pack-drops, pack-sniper, panini-premiums.
- **Cross-collection:** candy-mlb, cross-collection.

Boards read precomputed MVs or cached reads. Their honesty layer is `boardUnavailable()` / `summarizeDegraded()`, with OG cards built through `boardEmptyCopy()`.

**SEO surface:**
- `/sitemap.xml` with 9 children: Panini edition shards 5–8, and a 50,000-URL per-file refusal. ~70k URLs were audited on 10-14.
- Registry-derived metadata.
- Blog posts with Article schema, RSS, and their own OG cards.
- `llms.txt`.
- noindex on gated tab shells and on series measured at 0 editions.

**Demand (10-08 → 10-14 baseline):** ~61 human browsers and 94 visits; Google 26 (19 of 26 saw one page), ChatGPT 4; 6 external signed-in users; 1 signup (via ChatGPT → `/insights/account-value` → share card). In the 09-06 Search Console read: 3.77K impressions, 45 clicks lifetime, **0 external links**.

## Shipped recently (since mid-September)

- **09-18 → 10-03 (R94/R106):** the board fabrication class fixed past `top-sales`/`squeeze` to all boards, using an SSR absence test as the template.
- **10-03:** `/insights/market-cap` on collector-held supply (`get_market_cap_board`, 7 grains).
- **10-10:**
  - #33: `/insights/pack-drops` serves its last complete board when a live read fails.
  - The board cache's fresh window (10 min) had been shorter than its warm interval (15 min) since 08-30. Fixed.
  - `/insights/panini-premiums`.
- **10-11:**
  - Structured data on public pages.
  - Default insights OG card.
  - noindex on gated shells.
  - The accuracy gate is public at `/legal/fmv-methodology#accuracy`.
  - Admin WAU / MAU / D7 / D30 with internal accounts excluded.
- **10-12/13:** accessibility (axe + jsx-a11y ratchet 772 → 684). Pack Reality and the collection overview KPI band server-render their first frame (E2).
- **10-14:**
  - **Pack Reality's "11 % delivered nothing" was fabricated** (`COALESCE(…,0)`). Fixed.
  - Market Pulse says "No sales indexed" instead of "$0.00".
  - The sitemap split ahead of two cliffs that were days away.
  - 677 one-edition set pages left the sitemap.
  - Pinnacle pin titles and breadcrumbs; Flow-only and "Prizm World Cup" self-descriptions fixed.
  - `/blog/premium-chance-hit-vs-chance-hit`; blog OG cards.
  - Live audits: 42 structural pages plus 120 random sitemap URLs, all clean.
- **10-14 (from the traffic read):** Panini username band, share-card sign-up CTA, dashboard first-alert card, `/login` `magic-link-requested` beacon.
- **10-15:** squeeze "Top 5 hold" is walk-confirmed against live supply. The Panini squeeze MV refreshes hourly.
- **10-17:** UFC Series 0 is noindex and out of the sitemap ("Submitted URL marked noindex" avoided).
- **10-22 (Claude Code cloud):** player hubs `/players/<slug>` (every collection carrying a name, grouped by sport; indexable when one sport group gathers 2+ collections) and Panini on the franchise hubs (`/teams/nba/<slug>` indexable once the Panini panel counts); accent-blind search platform-wide (#207); the 2026 rookie class on both rookie boards.
- **10-23 (Cowork cloud, `20261023073556`):** **the sitemap lists those hubs** — segment 3 gains ~2,008 player hubs (basketball 866, football 845, soccer 228, baseball 45) and 31 franchise hubs (30 NBA + MLB tigers) from two bulk readers that apply the pages' own indexability predicates and get_player_hub's canonical slug (40/40 sampled agree). Read the two families in Search Console ~10-30.

## Open issues

- **#66 (open, needs Trevor):** every code item is done. What remains:
  - external links, held by the accuracy gate;
  - the GitHub repo "Website" field;
  - the Search Console re-read owed **2026-10-28**. The ~10-06 title click-rate re-read was never recorded and folds into it.
- ✅ **The 10-22 demand re-read is done** (Claude Code cloud, 10-22 morning): method codified as `scripts/demand-read.sql`, numbers and read in roadmap-status.md ("DEMAND RE-READ, WEEK OF 10-15..10-21"). Next on/after 10-29 — run the script with the new week's params.
- **Instrument caveats:**
  - Vercel Web Analytics counted 5,710 "visitors", almost all headless.
  - 29,580 of 29,914 beacons were automated.
  - `bot_ua` under-catches (R59).
  - Discount the unflagged headless fingerprint before reading anything (the script does: a visit needs a `vid` and a page-view).
  - ⚠ `signin_click` is in `funnel_events`, not `usage_events` (both earlier reads said "0" from the wrong table).
- **Frozen-market boards** (Candy since 10-12, Golazos since 10-01, UFC closed) must keep saying "none indexed", never $0, and never conclude.
- **The rookie boards still read the 2025 class** (a view over Series 8 set names) until the Series 9 rookie sets exist (11-11).

## Next — prioritized

**Now**
1. ✅ **10-22 demand re-read — done** (roadmap-status.md): Google flat (24 → 23 visits, ~70 % one-page), share-CTA 0 → 1 click → 1 signup (the first), `magic-link-requested` 5 sent, signups 1 → 2. The share-card reload loop the read found is fixed. **Next: 10-29 re-read** with `scripts/demand-read.sql`; the falsifier stands (no further movement → acquisition is the binding problem).
2. **Series 2026-27 (10-20).** New sets appear on the squeeze, market-cap and pack boards with correct series labels, and the sitemap picks up new series pages. 📏 **Pre-checked 10-18 ~2:40 PM PT (Claude Code cloud):** the sitemap's series segment is DB-driven (`lib/sitemap-data.ts` `getCollectionSeries()` over `collection_series`, which `registerNewSeries` inserts by itself). A series the rollup measures at 0 editions is left out (it is noindex), and one with no rollup row yet is kept as unknown. So Series 9 enters `/sitemap/0.xml` with no code change once its editions exist. The 10-20 read only has to confirm it. Falsifier: a new-series page missing from `/sitemap/0.xml` 24 h after its first edition.

**Next**
3. **10-28 Search Console re-read** (checklist in the SEO doc §"2026-10-14 pass"). Gate for any further sitemap pruning: "Crawled – not indexed" and "Duplicate" counts.
4. **11-11 rookie class rebuild**, then repoint `/insights/rookies` and `/insights/rookie-board`. Do not seed from the draft or the four partners.
5. **A "cost to climb into the top N" Yearbook board**, only after Trevor supplies the official scoring.

**Later**
6. **External links and outreach**, only once the accuracy gate is declared passed (M2 is not met). Never lead with the Team Captain designation.

## Decisions on record (do not re-litigate)

- **No outreach and no growth tactics until the gate passes** (Trevor). The 10-14 SEO thread deliberately did not draft outreach.
- **No paid tier shown or considered until 100 WAU.** `/pricing` and any Pro copy stay off. The points programme was switched OFF (10-04).
- **"wnba gold slot" gets no page.** It is a BetMGM casino game (10-14).
- **Dollar figures stay out of edition titles** (09-06 §5).
- **Board row links stay as they are** (#132, 09-23).
- **Public per-edition confidence chips stay banned.**
- **Measured nulls, do not re-open without new evidence** (10-14): page weight, and edition-page DB reads per call.

## Where the detail lives

- [seo-2026-09-06-search-console-read.md](../seo-2026-09-06-search-console-read.md): the SC read, the 10-14 pass, what is owed.
- [roadmap-status.md](../../reference/roadmap-status.md) ("DEMAND READ, WEEK OF 10-08..10-14").
- [routes-and-surfaces.md](../../reference/routes-and-surfaces.md): sitemap layout, adding a blog post.
- [key-files-and-honesty.md](../../reference/key-files-and-honesty.md): board error helpers, ISR caching of a failed read.
- Platform review: [platform-review-security-marketing-seo-compliance-2026-10-11.md](../../audits/platform-review-security-marketing-seo-compliance-2026-10-11.md).
- Register: #33, #66, #132 in [known-issues.md](../../reference/known-issues.md); R59, R106 in [deep-audit-register.md](../../audits/deep-audit-register.md).
