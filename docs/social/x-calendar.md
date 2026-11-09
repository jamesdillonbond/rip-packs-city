# @RipPacksCity — X posting calendar

Opened 2026-11-08 by Trevor ("Let's look at building out a regular social media calendar for RPC on Twitter/X" → "We should eventually get to daily scheduled tasks for that days posts so everything is fresh" → "Yes do it all"). This supersedes, **for the @RipPacksCity account only**, the 08-03 roadmap's removal of growth tactics: Trevor opened it himself. It does not reopen any other channel (Discord, Reddit, paid, outreach).

**Account:** https://x.com/RipPacksCity (the site's `twitter:site` and footer already point here).

## How it runs

1. **Every morning a scheduled task** (Claude, cloud) runs `scripts/social/x-draft.mjs` for that day's slot. The script reads only the public insight APIs (`/api/public/insights/*`), so it needs no keys; the task fetches it from `raw.githubusercontent.com` and runs it with Node.
2. The script prints the slot's facts, a first-pass draft, its X length, a one-tap post link (`twitter.com/intent/tweet`), any "big sale" extras, and warnings.
3. The task tightens the wording, checks it against the house rules below, and sends Trevor the final draft with the post link.
4. **Trevor posts.** Nothing is posted automatically: a scheduled run has nobody to approve it, and the account speaks for him.

Change the calendar here **and** in the script together.

## Weekly slots

Every post links one insights page. Each page carries a `summary_large_image` card (`/api/og/insights/<slug>`), so the link alone unfurls into the board's live card on X.

| Day | Slot | Source API | Link | What it says |
|---|---|---|---|---|
| Mon | Weekend recap | `top-sales?window=7d&sort=price` filtered to Fri 00:00 → Mon 00:00 PT | `/insights/top-sales` | Top 3–5 sales of the weekend, with how many cleared $1,000 |
| Tue | Top Shot pack check | `pack-sniper` | `/insights/pack-sniper` | Packs listed below the expected value of what's still inside. Qualifies only if EV × 0.95 (Top Shot's 5% selling fee) beats the ask, EV covers ≥ 90% of the pool, and the pack isn't high-variance. None qualifying is posted as "none today", not skipped |
| Wed | Rookie spotlight | `rookies?class=2025&sort=gmv` | `/insights/rookies` | 30-day sales for the 2025 class and its top three |
| Thu | Deal of the week | `deals?sort=discount` | `/insights/deals` | Up to three listings $10+ **and** 15%+ under value. Falls back to Saturday's trade-in post when none qualify |
| Fri | Board drop | one board a week, rotating by ISO week | `/insights/<board>` | A hook written from the board's live stats/rows. The script's draft is a placeholder (`needs_rewrite`) |
| Sat | Week in numbers | `market-pulse` | `/insights/market-pulse` | 7-day sales volume per collection and in total |
| Sun | The RPC Weekly Pack Drop Report | `pack-calendar` | `/insights/drops` (its preview card is the live week) | Every drop open now or starting in the next 7 days on Top Shot, All Day, Pinnacle, Golazos and Panini, plus every Candy MLB drop announcement: price, and when it drops or its pre-orders / draw requests close, in PT. Priciest first. **Every drop is named** — a long week becomes a numbered thread |

Friday rotation: squeeze → serial-premiums → market-cap → offer-spread → underpriced-serials → autographs → first-mint → set-completers → trade-in.

The trade-in finder (Top Shot This pack credits) moved into the rotation on 11-08 to make room for the drops post. Thursday still falls back to it when no deal qualifies.

**Big-sale extra (any day):** a sale in the last 24 h that cleared $1,000 and ranks in the week's top 5 gets its own short draft. It is offered alongside the slot post, never instead of it. Two big-sale posts a day at most.

**Drop reminder (Mon–Sat):** a drop starting, or an RSVP closing, in the next 24 h gets an optional short reminder (≤ 2). Sunday's post already lists them.

**Where drops come from** (`/api/public/insights/pack-calendar`, `lib/insights/pack-calendar.ts`):

| Collection | Source | What it gives | Notes |
|---|---|---|---|
| Top Shot, All Day | Atlas pack book (`atlas_pack_market`, products `nba` / `nfl`, refreshed every 15 min) | Every Dapper drop with its start/end time, price and RSVP flag | Read only from the last complete pass |
| Pinnacle | Same book, product `disney` (added 11-08) | Same | Pack drops only (Limited Edition packs) |
| Pinnacle Open Editions | `get_pinnacle_open_edition_drops()` over `pinnacle_mint_events` (added 11-08) | Each Open Edition set minting now ("minting now"), or that started and stopped this week | Not packs: the pins are minted straight into buyers' wallets while the drop is on sale, so a drop is seen only once it mints. No price and no announced end are ever stated. "Unread" unless the mint lane is at the chain head |
| Golazos | Same book, product `laliga` (added 11-08) | Same | Dapper parks every Golazos window ~100 years out (2122–2123), so no Golazos pack is datable today; a real dated drop would show |
| Panini | `panini_pack_drops`, from Panini's own NFT store lists (`packs` on sale now, `packsTimeline` every release), captured by the residential runner each pass | Panini's release date (8 AM PT, stored UTC), price, cards per pack, in stock | "Unread" if the runner has not refreshed it in 36 h; `panini_products.first_seen_at` is discovery time and is never used as a release date |
| Candy MLB | blog.candy.io RSS | Drop-titled posts from the last 7 days, linked (`announcements`) | Candy's store has been offline since its October wallet migration, so no store lists Candy drops; no date or price is ever invented |
| UFC Strike | — | — | Market closed; listed as not covered |

A source that could not be read is named in `warnings` and `facts.collections_unread`; the post must never read as "no drops" for it. For a Dapper "RSVP" dist the copy uses each app's own word: Top Shot / All Day "pre-orders close", Pinnacle "draw requests close", never "RSVP" and never "sale ends". A pre-order or draw whose packs are already being opened (Top Shot `pack_rips`, Pinnacle `pinnacle_pack_opens`) is over and is not posted. Pack mints do not count: Pinnacle mints a release's whole supply on its first day. Atlas's end time can be a leftover waiting room (Pinnacle Stitch in Costume Vol.1 read "closes Fri 11-13" while its requests had closed 11-06 and it had sold out).

**Verify before posting.** Before a drops post goes out, check every drop against its official page: nbatopshot.com pack details (`?packDetail=<dist>`), disneypinnacle.com/releases, and the Panini NFT store. The 11-08 trial caught two Pinnacle drops that were already over.

**Event-driven posts** (new Top Shot drops, rookie debuts, milestone games) are not automated. The daily task mentions them when it sees one in the data; Trevor decides.

## House rules

- **Only numbers from the public APIs, read that morning.** Never a figure from memory, from page metadata, or from an earlier run.
- **No FMV confidence**, ever — no tier, no "high confidence". Confidence is used only as an internal filter (Thursday).
- **Dollars only.** The word "DUC" never appears.
- **Pinnacle assets are characters**, not players.
- **UFC Strike is excluded** — its market is closed.
- **A collection with no sales in the window is left out**, never posted as "$0".
- **Collectors are never named or tagged** — not buyers, not sellers, not trophy-case owners — unless that person has said yes for that post.
- **Never lead with the Team Captain designation.**
- **No hype the data can't back**: no "best deal on Flow", "guaranteed", "can't lose", price predictions, or advice to buy.
- **Under 280 characters by X's count** (every link counts as 23), except the long-form drops report (`long_form: true`). The script measures it.
- **A list is never cut to "+N more"** (Trevor, 2026-11-08: "These posts need to name all the drops"). When every item will not fit one post, the script returns `thread[]`: numbered posts (`1/3`…), each under 280, that together name every item; the link rides the last one. Trevor posts 1, then replies to it with 2, and so on (X's post link cannot thread). The same rule covers every image and the `/insights/drops` link card (Trevor, 11-08: "always name them all. Never do the + 2 more thing"): the card sizes its grid to the count and falls back to one line per drop past 16.
- **Plain voice**: the number first, one line of context, the link. One emoji at most, except in the drops report, which uses one per line (below).
- **Official accounts may be tagged** — the collections' own handles, read from each app's site footer 11-08: @NBATopShot, @NFLAllDay, @LaLigaGolazos, @DisneyPinnacle, @PaniniAmerica (as "@PaniniAmerica Blockchain"), @CandyDigital. Never a collector.

### The RPC Weekly Pack Drop Report (Sunday) — Trevor's format, 11-08

One long post (the account posts long-form, so no thread) with the drops image attached and **no link**, then the link as a reply (Trevor, 11-08: "split the link into a 2/2 off this post so the link doesn't bring down the algo on the first main post of it, and then the 2/2 uses the link preview image"). First one posted: https://x.com/rippackscity/status/2119601226279272741 (Sun 11-08 evening PT).

Post 1:

```
The RPC Weekly Pack Drop Report, 11/8-11/15 📦

🏀 @NBATopShot: Rookie Debut Case ($2,500) — pre-orders close Wed 12 PM PT
🎸 @PaniniAmerica Blockchain: Prizm The Rolling Stones Packs ($25) — on sale now
🏀 @NBATopShot: Caleb Wilson Tip-Off Pack ($10) — pre-orders close Mon 12 PM PT #SeeRed
…
```

Post 2/2, a reply to post 1 (the script's `reply[]`):

```
Learn more about this week's drops here 👇
https://www.rippackscity.com/insights/drops
```

**X caches a link's preview card for about 7 days** from the first time the URL is shared, and there is no longer a way to force a refresh. The drops page's card is the live week, so a URL X first saw last week can show last week's card. Check the preview in the composer; if it is stale, post the link with a query string (`?v=2`, `?w=1115`…), which X treats as a new URL.

Dates are today to 7 days out, M/D in PT. One line per drop, priciest first: the collection's emoji (🏀 Top Shot, 🏈 All Day, ⚽ Golazos, 📌 Pinnacle, ⚾ Candy MLB; Panini takes its pack's sport — 🎸 entertainment, 🏀/🏈/⚽/⚾ by sport, 🃏 otherwise), then the handle, title, retail price, and when, in PT. The script also emits `thread_fallback` in case long posts are ever unavailable.

**Player packs end with the team's hashtag** (Trevor, 11-08: "use the team's hashtag emoji at the end, like #LakeShow"). On X these hashtags show the team's emoji. Add it to any pack named for one player: Top Shot This, Tip-Off, auction and reward packs. The player's team comes from RPC's editions data (`editions.team_name`). Use the team's official hashtag; if you are not sure of it, leave the line without one and say so. Known, 2026-27: Lakers #LakeShow · Bulls #SeeRed (Trevor, 11-08). The calendar does not carry a pack's team, so the script adds a warning for each Top Shot player pack (title matches Tip-Off / Top Shot This / auction / reward) and the hashtag is finished by hand.

**Live this week also means still on sale.** A Panini pack released in the last 60 days that the store still has in stock is listed ("on sale now", plus "almost sold out" under 5 % of supply left). A trade-in-only pack such as Top Shot This is in no feed. When the pre-post check finds one on nbatopshot.com, add it by hand, and to the image with `x-image.mjs --add extra.json`.

## Images

Every post that has a template ships with an RPC-branded image. On X, a post with an attached image is shown as the image, and posts whose main link card is the content have reached fewer people (Buffer's link study; Nieman Lab). So the image carries the post, and the link rides the last post of a thread.

- `node scripts/social/x-image.mjs --slot <slot> --out <dir>` renders `rpc-<slot>-<n>.png` (2400×1350, 16:9) with Playwright from the same public API the text uses. Every item in the post is on an image. Up to 9 fit one image (a 3×3 grid with tighter type; a card pushed below the footer is a warning, 11-08); a longer list is split across images (X allows 4 per post), never cut. A card whose text overflows is reported in `warnings`.
- **Brand art only.** No pack art, player photos or partner artwork is composited in: those belong to their owners, and pack art often carries real players' photos. Fonts and colours are RPC's (`public/fonts`, collection accents from `lib/collections.ts`).
- Templates: **Sun — drops this week** (live 11-08). Other slots post with their link card until they get one.
- The daily task sends the image as a file with the draft. Trevor saves it and attaches it to post 1 (the one-tap post link cannot carry an image).

## When the data isn't there

If the script sets `skip_reason`, the task says so and offers the "week in numbers" post (`--slot sat`) as a fallback. If an API fails, nothing is drafted from a guess.

## Revert

Delete the scheduled task "RPC daily X draft", then `docs/social/` and `scripts/social/`. Nothing in the site depends on either.
