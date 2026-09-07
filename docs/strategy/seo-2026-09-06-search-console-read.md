# SEO — what Search Console says, and what to do about it (2026-09-06)

Read from `sc-domain:rippackscity.com` on 2026-09-06 (Trevor's logged-in Chrome). Every number is a dated sample.

## The headline

**45 clicks and 3.77K impressions in the property's entire life (data starts 2026-05-30), average position 22, CTR 1.2% — against 31.3K indexed pages and a 34,125-URL sitemap.** Google has crawled and indexed the site at scale and ranks almost none of it. The site is not technically broken; it is technically fine and has **no authority**: **External links: 0. Top linking sites: none.** Not one page anywhere on the web links to rippackscity.com. Nothing below matters as much as that one fact.

The pages that DO get impressions: `/` (90), `/nba-top-shot/overview` (449 impressions, 4 clicks), `/ufc/overview` (156), `/insights/rookies` (89), `/laliga-golazos/overview` (74), `/nba-top-shot/collection` (45). Entity pages (edition / player / team / set — ~30K of the 31K indexed) get essentially nothing.

## What the index looks like

| bucket | pages | what it is | verdict |
|---|---|---|---|
| Indexed | 31.3K | mostly edition/player/team/set entity pages | indexed but not ranking (no authority; programmatic pages at scale) |
| Alternate page with proper canonical | 6,462 | `/moment/<edition uuid>` (canonical → edition page), `?player=` / `?q=` variants | by design, but 6K crawl-budget URLs for duplicates — **fixed: 301 + dropped from sitemap** |
| Crawled – currently not indexed | 4,448 | `/moment/<uuid>`, some edition + pack-dist pages | same duplicate family + Google declining thin programmatic pages |
| Discovered – not indexed | 2,827 | `/disney-pinnacle/pack/dist/*` and similar | Google chose not to spend budget; these pages are near-identical shells |
| Blocked by robots.txt | 1,449 | `/_next/static/*` JS/CSS chunks + `/api/public/ipfs-media/*` | **the chunks were a real problem — fixed: `/_next/static/`, `/_next/image` allowed** |
| Excluded by noindex | 865 | `/profile/0x…` | old "unknown handle" shells (pre-09-03), linked from every sales table — **fixed at the link** |
| Not found (404) | 302 | `/profile/0x…`, UUID-keyed edition URLs, legacy player slugs | the profile links (**fixed**), the inert UUID rows (from the old sitemap; will age out), player 404s (mostly fixed 09-06 morning) |
| Duplicate without user-selected canonical | 61 | `/moment/<uuid>` | same family — fixed |
| Server error (5xx) | 29 | edition / player / pack pages | the saturation-window 60 s timeouts (known) |
| Duplicate, Google chose different canonical | 21 | UUID-keyed edition URLs | inert rows; ignore |
| Indexed, though blocked by robots.txt | 1 | one URL | ignore |

Sitemap: one index, 5 segments, 34,125 discovered URLs, last read 2026-09-06, status Success. Core Web Vitals: "not enough usage data" on both mobile and desktop — the site has too few real-user pageviews for Google to score it.

## Shipped today (code, `main`)

1. **robots.txt no longer blocks `/_next/static/` or `/_next/image`.** `Disallow: /_next/` had put every JS/CSS chunk in the robots-blocked bucket, and Google's own guidance is never to block the resources a page needs to render: a Googlebot that cannot fetch the hydration bundles sees the streaming shell and whatever was server-rendered, and grades layout/CLS blind. The rest of `/_next/` stays blocked. (`__tests__/seo-search-console-2026-09-06-pins.test.ts`.)
2. **`/moment/<edition uuid>` 301s to `/<collection>/edition/<slug>`.** It was the same page with a canonical hint; ~11,000 of them sat in the not-indexed buckets. Serial-grain `/moment/<nft id>` (the shareable URL) is untouched. The `/moment/` block (top 200) is out of the sitemap.
3. **Every buyer/seller/owner cell stops linking to `/profile/<address>`** — a URL that does not exist (`/profile/<handle>` resolves RPC usernames only; Trevor's own address 404s). Four components, thousands of links per crawl, every one a 404 for the reader too. They now link to the wallet analyzer `/<collection>/collection?wallet=<addr>` (anon-public, robots-disallowed via `?wallet=`, `rel=nofollow`), or render plain text where no collection is in scope.

## Shipped later the same evening (code, `main`)

4. ✅ **§5 done — the dollar figure is out of every edition title.** `editionPageMetadata` interpolated the live FMV (`… · Value $1.11 | …`) across ~20K entity URLs. It is now FMV-independent: `<Player> — <Set> · Value, Floor & Sales | …` live, `… · Value History & Sales (<venue> market closed) | …` closed. The number moved to the description, which Google re-reads on the same crawl. Pinned by an ABSENCE assertion (`not.toMatch(/\$[\d,]/)`) over all five entity helpers rather than by the new string, so a re-introduction under a different spelling still fails; the two honesty cases in `honesty-disclosure-2026-08-02.test.ts` were INVERTED, not deleted — the property they held ("a dead price is never titled as a live one") is now pinned one step stronger, and the closed-market title still names the closure.

5. ✅ **§2 turned up an honesty defect, not just a title mismatch: all five UFC tabs advertised a LIVE market.** `PAGE_META` is written for a trading collection and says so — "live FMV", "real-time FMV", "daily market pulse", and, on the sniper tab, **"Live deals below FMV"**. UFC Strike's Flow market has not traded since 2026-05-13. That copy was rendering into `<title>`, `description`, `og:` and `twitter:` on `/ufc/{overview,collection,sniper,sets,analytics}` — `/ufc/overview` being one of only six URLs on this site that earns impressions at all (156). The sniper line is the sharpest: it offers an ACTION the product cannot perform on a dead market, which is the read-only rule reached through metadata. `pageMetadata` now serves closed-market copy DERIVED from `closedMarket()` (keyed by tab, applying to any market that closes, venue + date interpolated) — never a second per-slug list, because `lib/market-closed.ts`'s own header says closure is edited in that map and nowhere else. Guard: `__tests__/closed-market-tab-copy-carries-no-liveness-claim.test.ts`, a ban at zero over `CLOSED_MARKETS × PUBLIC_TAB_PAGES` — the closure must be disclosed with venue AND date, no liveness token (`live|real-time|daily|current|today`) may survive in title, description or `og:description`, no placeholder may leak, the population counts are asserted so it cannot pass vacuously, and a **no-change control** proves a live collection still gets the live copy. Positive control run: deleting one tab's closed entry fails it by name (`ufc/sniper: no venue disclosure`).
   ⓘ **Not changed, and named rather than left implied:** the collection ROOT metadata (`collectionLayoutMetadata`) still reads "FMV pricing, sniper deals, and wallet analytics for UFC Strike moments. Collection migrated to Aptos; 247 NFTs indexed on Flow." It carries its own, more specific disclosure, so it is not making a live-market claim — but "sniper deals" is the same offer one level up and the guard above does not cover that function. Left for a decision rather than swept in.

## What would actually move the number (not code, or not only code)

**1. Links. Zero is the whole story.** With no external links the domain has no authority, so 31K well-built pages rank on page 3. The CLAUDE.md rule "no tweets / Reddit / TC DMs on multi-chain pre-launch" is about announcing the multi-chain product; it does not have to mean zero links. Cheapest first:
- Flow ecosystem listings: flow.com ecosystem/dapp directory, Flowverse, DappRadar, Alchemy's dapp store, DeFiLlama-style Flow trackers — each is a real editorial link.
- The public GitHub repo README (`jamesdillonbond/rip-packs-city`) should link to www.rippackscity.com in its first line; it currently is the one page Google associates with the brand and it carries no link.
- Top Shot / All Day community surfaces that allow tool links: the r/nbatopshot and r/nflallday tools threads, the Discord resource channels, Own The Moment / LiveToken comparison posts, the WNBA Top Shot community (see the query list — "wnba gold slot" is the #1 impression query and nobody clicks because the ranking page is a generic entity page).
- Product Hunt / Indie Hackers launch (free, indexable, real links).
- ⛔ Not a lever: Trevor's Team Captain designation. It stays IYKYK — never lead a post, listing or bio with it (Trevor, 09-06). Anyone who knows the Top Shot side will connect the reused RPC brand on their own; the links above stand on the product.

**2. Match the queries that already show up.** 224 queries in 3 months, most with 0 clicks. They cluster into four intents the site has no dedicated, title-matched page for:
- **"nba top shot value tracker" / "nba top shot value" / "account value" / "account value calculator" / "price tracker" / "valuation"** (~130 impressions combined, position ~15-25). The home page and `/nba-top-shot/overview` half-match. A single page titled *NBA Top Shot Account Value Calculator — free wallet valuation* (the `/insights/account-value` board renamed and expanded, or the collection tab given that title) would match all of them. Same for "nfl all day account value".
- **"wnba gold slot(s)" / "wnba gold"** (73 impressions, 0 clicks). Whatever ranks is an entity page whose title says nothing about gold slots. A short explainer + live table page ("WNBA Gold Slot — what it is, current floor, holders") would take the click.
- **"premiumchance"** (26) — the Top Shot pack "premium chance" mechanic. A pack-odds explainer page linked from the pack-reality board.
- **"ufc strike" / "ufc nft" / "ufc value" / "ufc strike marketplace"** (~60) — `/ufc/overview` ranks; its title should say "UFC Strike" first and mention "closed market — last prices" since the market is closed and readers are searching for what their UFC NFTs are worth now.
- Player queries ("benoit saint denis sell", "patrick ewing top shot", "giannis antetokounmpo coin collection", "victor wembanyama 3.58%") — the player pages exist; they need the player's name FIRST in the title and a sentence of real copy (current floor, best serial sold, lock rate) rather than a template.

**3. Fewer, stronger pages.** 34K URLs with zero authority is worse than 2K. Google's "Discovered – not indexed" (2,827) and "Crawled – not indexed" (4,448) are it saying the marginal page adds nothing. Candidates to drop from the sitemap (keep the pages, stop advertising them): pack-dist pages for closed markets and sold-out drops, editions with no sales and no holders, series pages, WNBA/UFC long-tail sets with a single edition. Keep: overview pages, insights boards, player and team pages, editions with activity. Rule of thumb: if a page would never be the best answer to any query, it should not be in the sitemap.

**4. Internal linking is inverted.** Top internal-link targets are `/pricing` (27,566 links — from the footer on every page, to a page that says the product is free), `/ufc/overview`, the insights boards — all nav/footer. The entity pages that carry the long-tail get one link each from their parent. Add "related" blocks: player page → that player's top 5 editions and team; edition page → player, set, and the 3 nearest editions by FMV; overview pages → the 20 most-traded editions this week. Take `/pricing` out of the footer (or noindex it) until there is a price.

**5. ✅ SHIPPED 2026-09-06 (see item 4 above).** Edition titles were `<Player> — <Set> · Value $1.11 | NBA Top Shot | Rip Packs City`. A dollar figure in the title re-writes the title on every crawl and buries the searchable part; Google often replaces it. The value is now in the description, not the title.

**6. Nothing here is a Core Web Vitals problem** — there is not enough traffic to measure one. Do not spend time on it before the links exist.

## Owned watches

- GSC "Blocked by robots.txt" should fall from 1,449 toward the `/api/public/ipfs-media` residue over the next two crawls; "Alternate page with proper canonical" and "Crawled – not indexed" should fall as the 301s are re-crawled (weeks, not days).
- "Not found (404)" should stop growing on `/profile/0x…` immediately; the existing 302 age out.
- Re-read the Performance report in 30 days; the number that matters is impressions, not clicks, until links exist.
