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
| Mon | The week's top sales | `top-sales?window=7d&sort=price` (trailing 7 days) | `/insights/top-sales` (rides the 2/2 reply) | **One long post naming the top 10 sales** — asset, serial, price, collection and the buyer's username — with a top-10 image, then the link as a reply. Weekend-only until 11-09; Trevor, 11-09: "We should have it be top sales from a week" → "include the full top 10 in the text, with an accompanying graphic to use, that has the images of the assets, the sale price, and the buyer" |
| Tue | Top Shot pack check | `pack-sniper` | `/insights/pack-sniper` | Packs listed below the expected value of what's still inside. Qualifies only if EV × 0.95 (Top Shot's 5% selling fee) beats the ask, EV covers ≥ 90% of the pool, and the pack isn't high-variance. None qualifying is posted as "none today", not skipped |
| Wed | The 2026 rookie class top 10 | `rookie-sales?class=2026&limit=10` | `/insights/rookies?class=2026` (rides the 2/2 reply) | **One long post naming the class's top 10 by Top Shot sales since release**, every edition, each line ending with the team's confirmed hashtag, with the top-10 image (`--slot wed`), then the link as a reply. Trevor, 11-14 (first posted that Saturday: https://x.com/rippackscity/status/2121696498002084324) → "Yes do that, but might be worth skipping the one in a few days since we did today": **Wed 11/18 is skipped** (`SKIP_DATES` in `x-draft.mjs`; `--force` drafts it anyway). The open slot carries a draft about the no-account collection look-up: `docs/social/posts/2026-11-18/` (11-17) |
| Thu | Deal of the week | `deals?sort=discount` | `/insights/deals` | Up to three listings $10+ **and** 15%+ under value. Falls back to Saturday's trade-in post when none qualify |
| Fri | Board drop | one board a week, rotating by ISO week | `/insights/<board>` | A hook written from the board's live stats/rows. The script's draft is a placeholder (`needs_rewrite`) |
| Sat | Week in numbers | `market-pulse` | `/insights/market-pulse` | 7-day sales volume per collection and in total |
| Sun | The RPC Weekly Pack Drop Report | `pack-calendar` | `/insights/drops` (its preview card is the live week) | Every drop open now or starting in the next 7 days on Top Shot, All Day, Pinnacle, Golazos and Panini, plus every Candy MLB drop announcement: price, and when it drops or its pre-orders / draw requests close, in PT. Priciest first. **Every drop is named** — a long week becomes a numbered thread |

Friday rotation: squeeze → serial-premiums → market-cap → offer-spread → underpriced-serials → autographs → first-mint → set-completers → trade-in.

**Bid vs Floor (offer-spread) quotes only a bid seen open in the last 6 h** (Trevor, 11-27: the draft quoted Ace Bailey's /99 Rookie Debut at a $91 top offer; Top Shot showed $68 — that bid was cancelled 11-10 and had stood on the board since). The board itself now lists a Top Shot bid only while it was seen open in the last 24 h (`offer_seen_at`, audit_20261127); `x-draft.mjs` keeps rows seen within 6 h, gives each `offer_seen_pt`, and skips the slot when none is. Quote it "as of <offer_seen_pt>" and check the edition on Top Shot before posting. Each row also carries its Top Shot badges (`top_rows[].badges`, from `/api/entity/edition-badges`); name a quoted row's badge (Trevor, 11-27: the SGA row was his Top Shot Debut).

The trade-in finder (Top Shot This pack credits) moved into the rotation on 11-08 to make room for the drops post. Thursday still falls back to it when no deal qualifies.

**Big-sale extra (any day):** a sale in the last 24 h that cleared $1,000 and ranks in the week's top 5 gets its own short draft. It is offered alongside the slot post, never instead of it. Two big-sale posts a day at most. Format as first posted (Trevor, 11-14: https://x.com/rippackscity/status/2121645350356476091):

```
This season's first Rookie Ultimate sale is in 🏀

Aday Mara, Rookie Ultimate #1/1 — $2,000 on @NBATopShot · bought by Flanete94

#ThunderUp
```

then the link as a 2/2 reply ("See the week's top sales here 👇"), and the big-sale image or video attached (Images, below). The script's opening line is generic ("One of the week's top sales"); when the sale is a first or a record the data shows (e.g. the first sale in a new set), the task rewrites the line and passes the same words to `--headline`. A player moment may end with the team's official hashtag, as on Sunday.

**Drop reminder (Mon–Sat):** a drop starting, or an RSVP closing, in the next 24 h gets an optional short reminder (≤ 2). Sunday's post already lists them.

**Where drops come from** (`/api/public/insights/pack-calendar`, `lib/insights/pack-calendar.ts`):

| Collection | Source | What it gives | Notes |
|---|---|---|---|
| Top Shot, All Day | Atlas pack book (`atlas_pack_market`, products `nba` / `nfl`, refreshed every 15 min) | Every Dapper drop with its start/end time, price and RSVP flag | Read only from the last complete pass. **REWARD dists are never listed** (earned, not sold), and an unpriced dist with no close is listed only while upcoming (11-15: four such packs read "on sale now" a week after release) |
| Pinnacle | Same book, product `disney` (added 11-08) | Same | Pack drops only (Limited Edition packs) |
| Pinnacle Open Editions | `get_pinnacle_open_edition_drops()` over `pinnacle_mint_events` (added 11-08) | Each Open Edition set minting now ("minting now"), or that started and stopped this week | Not packs: the pins are minted straight into buyers' wallets while the drop is on sale, so a drop is seen only once it mints. No price and no announced end are ever stated. A set is listed only once a pin has reached a collector's wallet: Pinnacle sometimes mints supply into its own contract account first (11-08, Walt Disney Mugs Vol.1, ahead of its capsule sale), and that is staged supply, not a drop. A set the catalog has not named yet is named from the Pinnacle contract. "Unread" unless the mint lane is at the chain head |
| Golazos | Same book, product `laliga` (added 11-08) | Same | Dapper parks every Golazos window ~100 years out (2122–2123), so no Golazos pack is datable today; a real dated drop would show |
| Panini | `panini_pack_drops`, from Panini's own NFT store lists (`packs` on sale now, `packsTimeline` every release), captured by the residential runner each pass | Panini's release date (8 AM PT, stored UTC), price, cards per pack, in stock | "Unread" if the runner has not refreshed it in 36 h; `panini_products.first_seen_at` is discovery time and is never used as a release date |
| Candy MLB | blog.candy.io RSS | Drop-titled posts from the last 7 days, linked (`announcements`) | Candy's store was offline from its October wallet migration until **the new candy.io opened Wed 11-18** (blog.candy.io, 11-17). RPC does not read candy.io/drops yet (it refuses automated fetches), so a Candy drop sold there and not blogged is missed — check candy.io/drops by hand on Sundays; no date or price is ever invented |
| UFC Strike | — | — | Market closed; listed as not covered |

A source that could not be read is named in `warnings` and `facts.collections_unread`; the post must never read as "no drops" for it. For a Dapper "RSVP" dist the copy uses each app's own word: Top Shot / All Day "pre-orders close", Pinnacle "draw requests close", never "RSVP" and never "sale ends". A pre-order or draw whose packs are already being opened (Top Shot `pack_rips`, Pinnacle `pinnacle_pack_opens`) is over and is not posted. Pack mints do not count: Pinnacle mints a release's whole supply on its first day. Atlas's end time can be a leftover waiting room (Pinnacle Stitch in Costume Vol.1 read "closes Fri 11-13" while its requests had closed 11-06 and it had sold out).

**An upcoming Pinnacle "RSVP" reads "opens <time>"** (11-22), on the post, image and drops page alike: Dapper's book marks both timed draws and mystery-capsule sales RSVP, and $49.95 Limited Editions have been each (Stitch a draw; Predator, Star Wars Halloween capsules). Once the official page says which, a `DROP_CORRECTIONS` entry sets `kind: "capsule"`, or the draft uses "draw requests close" from the page. **Pinnacle drops carry their minted supply** (`minted` on the calendar API → "($49.95, 490 minted)" in the post, "490 minted" on the image card and the /insights/drops card): Pinnacle mints a Limited Edition's whole supply into its own account before the release opens (11-19 for 11-24's Frozen Seasonal Harvest Vol.1 and Winnie the Pooh: Friends-Giving Vol.2), so the chain sizes a drop the official page has not listed yet. It is pins *minted*, not capsules on offer — some pins ride other releases (98 Friends-Giving Vol.2 LE pins hid in Mugs Vol.1 capsules) — so keep the word "minted".

**Panini card art shows the serial that sold** (11-22): a Panini catalog thumbnail is one serial's image with that number printed on the card (`…_28_219.png`), and Panini hosts one per serial, so `x-image.mjs` swaps in the sold serial (`…_92_219.png`) on the Monday and big-sale images. Before this, an Ohtani #92/219 big-sale image showed "28/219" on the card.

**Verify before posting.** Before a drops post goes out, check every drop against its official page: nbatopshot.com pack details (`?packDetail=<dist>`), disneypinnacle.com/releases, and the Panini NFT store. The 11-08 trial caught two Pinnacle drops that were already over.

**Event-driven posts** (new Top Shot drops, rookie debuts, milestone games) are not automated. The daily task mentions them when it sees one in the data; Trevor decides.

## House rules

- **Only numbers from the public APIs, read that morning.** Never a figure from memory, from page metadata, or from an earlier run.
- **No FMV confidence**, ever — no tier, no "high confidence". Confidence is used only as an internal filter (Thursday).
- **Dollars only.** The word "DUC" never appears.
- **Pinnacle assets are characters**, not players.
- **UFC Strike is excluded** — its market is closed.
- **A collection with no sales in the window is left out**, never posted as "$0".
- **Collectors are never named or tagged** — not buyers, not sellers, not trophy-case owners — unless that person has said yes for that post. **Two exceptions: the Monday top-sales post and image (Trevor, 11-09) and the big-sale post and image (Trevor, 11-14) name the sale's buyer** — tagged only when Trevor has confirmed the X handle (`X_HANDLES`), otherwise by marketplace username; never a wallet address.
- **Never lead with the Team Captain designation.**
- **No hype the data can't back**: no "best deal on Flow", "guaranteed", "can't lose", price predictions, or advice to buy.
- **Under 280 characters by X's count** (every link counts as 23), except the long-form drops report (`long_form: true`). The script measures it.
- **A list is never cut to "+N more"** (Trevor, 2026-11-08: "These posts need to name all the drops"). When every item will not fit one post, the script returns `thread[]`: numbered posts (`1/3`…), each under 280, that together name every item; the link rides the last one. Trevor posts 1, then replies to it with 2, and so on (X's post link cannot thread). The same rule covers every image and the `/insights/drops` link card (Trevor, 11-08: "always name them all. Never do the + 2 more thing"): the card sizes its grid to the count and falls back to one line per drop past 16.
- **Plain voice**: the number first, one line of context, the link. One emoji at most, except in the drops report, which uses one per line (below).
- **Official accounts may be tagged** — the collections' own handles, read from each app's site footer 11-08: @NBATopShot, @NFLAllDay, @LaLigaGolazos, @DisneyPinnacle, @PaniniAmerica (as "@PaniniAmerica Blockchain"), @CandyDigital. Never a collector.

### The week's top 10 sales (Monday) — Trevor's format, 11-09

One long post with the top-10 image attached and no link, then the link as a reply (`reply[]`), as on Sunday. First one posted: https://x.com/rippackscity/status/2119935610509222119 (Mon 11-09 afternoon PT). 11-23 (first with confirmed buyer handles and a team hashtag): https://x.com/rippackscity/status/2125065405966537203, archive `docs/social/posts/2026-11-23/`.

```
This past week's top 10 sales, 11/2-11/9 📈

1. Lamine Yamal, Manga #20/25 — $2,500 on @PaniniAmerica · bought by arbrevert
4. LeBron James, Run It Back: Origins (Animated) #1/17 — $2,250 on @NBATopShot · bought by @THEMECCA212
…

💰20 sales cleared $1,000 in the last 7 days.
```

- The collection is named by its official X account (`BRAND` in `x-draft.mjs`). **Panini is "@PaniniAmerica Blockchain" in every post's text** — Monday, big sale and Sunday alike (Trevor, 11-27: "to clearly differentiate physical vs digital"); the images keep the plain collection label ("Panini", and "Candy" — not "Candy MLB" — since 11-27).
- **Buyers are tagged only from `X_HANDLES`** (marketplace username → X handle) in `x-draft.mjs`, each one confirmed by Trevor — **in the post text only; the image always shows the marketplace username** (Trevor, 11-23: "don't edit the image with their Twitter handle … just tag them in the Twitter post"). Anyone else is named by marketplace username, untagged; `buyers_untagged` lists them. Confirmed 11-09: THEMECCA → @THEMECCA212, hichi → @chrisschlei, Lions_For_Breakfast → @FollowJay. Confirmed 11-16: Jason3555 → @jason3555, Karso → @orangekarso. Confirmed 11-23: Incog8 → @incog_eth, spinotron → @spinotron.
- A buyer the API returns only as a wallet address is looked up on Pinnacle's public GQL (one Dapper username per wallet); never post the address.

### The 2026 rookie class top 10 (Wednesday) — Trevor's format, 11-14

```
The 2026 rookie class on @NBATopShot: top 10 by sales since release 📈

1. AJ Dybantsa — $15,061 · 92 sales #ForTheDistrict
2. Darius Acuff Jr. — $12,966 · 108 sales #LightTheBeam
…

All 38 rookies: $98,114 across 2,971 sales.
```

- **Posted 11-25** (first with the ESPN live check; archive `docs/social/posts/2026-11-25/`): https://x.com/rippackscity/status/2125692265284894921
- **Since release, every edition** (parallels and Ultimates included): `/api/public/insights/rookie-sales` (`lib/insights/rookie-sales.ts`). Not the rookies board's 30-day views — the first 2026 rookie sale was 10-22, so the two part ways from 11-21.
- **Hashtags:** `TEAM_HASHTAG` in `x-draft.mjs` holds only hashtags Trevor confirmed live; a team missing from it gets none and a warning.
- **ESPN live check** (11-25): the draft re-derives every top-10 player's games / PPG / RPG / APG from ESPN's live box scores (`facts.espn_check`) and warns on any line that differs from RPC's stored one — ESPN corrects box scores days after a game (Darryn Peterson 11-25: 15.8 / 4.1 shown, 15.9 / 4.0 true). On a warning, put ESPN's line on the image and tell Trevor. RPC re-reads box scores hourly since 11-25 (`espn_gamelog_restat`), so a warning means the correction is newer than the last re-read.
- **Image** (`x-image.mjs --slot wed`): ten cards, each with the player's **standard** Rookie Debut moment (never a parallel — Trevor, 11-14), a "No. N pick" tag (2026 NBA Draft, `lib/insights/draft-2026.ts`; none for a player not drafted in 2026), team, the season's points / rebounds / assists per game (ESPN box scores, games played only), sales volume and count.

### The RPC Weekly Pack Drop Report (Sunday) — Trevor's format, 11-08

One long post (the account posts long-form, so no thread) with the drops image attached and **no link**, then the link as a reply (Trevor, 11-08: "split the link into a 2/2 off this post so the link doesn't bring down the algo on the first main post of it, and then the 2/2 uses the link preview image"). First one posted: https://x.com/rippackscity/status/2119601226279272741 (Sun 11-08 evening PT). Second, the first in the new-drops-only format (WNBA Finals + NWSL, balanced 3+2 image, last line on the first NWSL / Thorns collectibles on RPC): https://x.com/rippackscity/status/2122070905216217277 (Sun 11-15).

**Posted reports and their exact text/images are archived** in `docs/social/posts/<date>/` (11-15 onward).

**Trevor's rules from the 11-15 report** (all in force):
- **New drops only** — nothing already on an earlier report or its follow-up (see below).
- **Full details in parentheses** — price plus the one fact that sizes it: supply ("30 made") or contents ("7 Moments", "4 cards", "10 trade tickets").
- **A closing line may highlight what is new on RPC** for the week (11-15: "New on RPC: Friday's Prizm Black NWSL packs are the first NWSL collectibles we support, Portland Thorns included.") — Trevor chose that over an early-access line for the biggest drop. Only state support RPC actually has (the Thorns hub `/teams/nwsl/thorns` was live). No official team account is tagged unless its handle is confirmed.
- **No analysis riders** — price comparisons, supply stats, "insights" do not go into the report or as an unrequested extra ("Don't put that extra stuff in").
- **Read official sources beyond the feed** before drafting: the Top Shot blog's drop guide named the 2026 WNBA Finals drop four days before the pack book did. The script now warns (missed-drop probe, below).

Post 1 (11-15, as posted — https://x.com/rippackscity/status/2122070905216217277):

```
The RPC Weekly Pack Drop Report, 11/15-11/22 📦

🏀 @NBATopShot: 2026 WNBA Finals Case ($1,250, 30 made) — pre-orders close Wed 12 PM PT
🏀 @NBATopShot: 2026 WNBA Finals Box ($195, 200 made) — pre-orders close Wed 1 PM PT
🏀 @NBATopShot: 2026 WNBA Finals Collector Pack ($25, 7 Moments) — pre-orders close Wed 2 PM PT
⚽ @PaniniAmerica Blockchain: Prizm Black NWSL Soccer Packs ($10, 4 cards) — drops Fri 8 AM PT
🏀 @NBATopShot: 2026 WNBA Finals Trade Ticket Pack (10 trade tickets) — on sale Wed 12:30 PM PT

New on RPC: Friday's Prizm Black NWSL packs are the first NWSL collectibles we support, Portland Thorns included.
```

The first report (11-08) for comparison:

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

**X caches a link's preview card for about 7 days**, keyed by the page URL **and** by the og:image URL, and it keeps a failed image fetch as a **blank grey card** (11-23: the top-sales 2/2 reply; 11-15: last week's drops card). Everything is now keyed on both sides (11-23):
- **og:image** — `/insights/drops`, `/insights/top-sales` and pack-dist pages carry `?d=<PT YYYYMMDD>` (a new image URL every day); every other `/insights/*` board carries `?v=<deploy sha>` (a new one every deploy). Both from `lib/og/card-day-key.ts`; the OG routes ignore the param.
- **page link** — `x-draft.mjs` appends `?w=<MMDD>` (PT) to every rippackscity.com link in every post it drafts (slot, 2/2 reply, threads, big-sale and drop-reminder extras).
- **pre-check** — `x-draft.mjs` then fetches each link as Twitterbot, reads its og:image and fetches that image (which also warms the CDN for it); a non-200, a non-image, a slow (> 8 s) card or an unkeyed og:image is a `warnings[]` line — do not send the link until it clears.
- If the composer still shows a stale or blank card, that exact page URL was fetched before: add a letter (`?w=1123c`) and re-paste.

**Top Shot This trade-in packs are REWARD dists in the book, so the calendar never lists them** (11-22): one with no `MANUAL_DROPS` entry reached no report (Stephen Curry, 11-16). The calendar API now names them in `meta.needs_hand_entry` and the draft warns on each, so it is hand-entered from its official page. **Overtime packs** (Top Shot, $10, one rookie or a Trio, one day each) follow each drop ("After each drop, Overtime Packs bring that drop's biggest hits back", blog 10-14): seven ran 11-12 → 11-20 after Rookie Debut. They reach the book ~a day ahead, so the daily drop reminder, not the Sunday report, is where they show.

**Trade Ticket Packs sell out within minutes** (Trevor, 11-15), so post them by their opening time only ("drops Wed 12:30 PM PT"), never as "on sale" afterwards; a hand-entered one closes an hour after it opens.

**New drops only** (Trevor, 11-15: "Feels like we covered a lot of these last week" → "We need to pull the pinnacle drop since we already covered it last week and it's not a new drop"): a drop already on sale when the report runs (opened more than 36 h earlier) was on an earlier report and is left out of the post and image; `facts.carried_over` names them. The drops page still lists everything live. **Missed-drop probe:** the script reads blog.nbatopshot.com ("Drop Guide" posts in the last 10 days, and since 11-22 trade-in / auction posts, which no feed carries) and disneypinnacle.com/releases (purchasable now or opening within 7 days) and warns on anything the calendar lacks. **And the reverse** (11-22): a NEW Pinnacle drop on the calendar that the releases page does not list yet is a warning (format and close unconfirmed — 11-22 Frozen Seasonal Harvest Vol.1 and Winnie the Pooh: Friends-Giving Vol.2 were in the pack book and minted days before the page had them); a page that parses to zero releases is a warning, never a silent pass — 11-15 it would have caught the 2026 WNBA Finals drop and Friends-Giving Vol.2's waiting-room sale. A Pinnacle draw that did not sell out keeps selling in its waiting room until the page's stated end; only a sold-out draw's waiting-room end is a leftover.

Dates are today to 7 days out, M/D in PT. One line per drop, priciest first within each group: the collection's emoji (🏀 Top Shot, 🏈 All Day, ⚽ Golazos, 📌 Pinnacle, ⚾ Candy MLB; Panini takes its pack's sport — 🎸 entertainment, 🏀/🏈/⚽/⚾ by sport, 🃏 otherwise), then the handle, title, retail price, and when, in PT. The script also emits `thread_fallback` in case long posts are ever unavailable.

**Player packs end with the team's hashtag** (Trevor, 11-08: "use the team's hashtag emoji at the end, like #LakeShow"). On X these hashtags show the team's emoji. Add it to any pack named for one player: Top Shot This, Tip-Off, auction and reward packs. The player's team comes from RPC's editions data (`editions.team_name`). Use the team's official hashtag; if you are not sure of it, leave the line without one and say so. Known, 2026-27: Lakers #LakeShow · Bulls #SeeRed (Trevor, 11-08) · Wizards #ForTheDistrict (Trevor, 11-14: "still live"). Mavericks #MFFL (Trevor, 11-23; #RepTheHalo and #VamosArgentina showed no logo, so they are not used). Also confirmed live by Trevor 11-14 (each showed its team logo in the composer): Kings #LightTheBeam · Grizzlies #GrindCity · Jazz #TakeNote · Warriors #DubNation · Thunder #ThunderUp · Cavaliers #LetEmKnow · Clippers #ClipperNation · Bucks #FearTheDeer. The calendar does not carry a pack's team, so the script adds a warning for each Top Shot player pack (title matches Tip-Off / Top Shot This / auction / reward) and the hashtag is finished by hand.

**Live this week also means still on sale.** A Panini pack released in the last 60 days that the store still has in stock is listed ("on sale now", plus "almost sold out" under 5 % of supply left). A trade-in-only pack such as Top Shot This is in no feed, so it is **hand-entered in `lib/insights/manual-drops.ts`** (fields from the official page, with `source` and `verified_at`; `end_time` required). From there it reaches the calendar API, `/insights/drops`, its link card, the draft text and the image like any other drop, so the post, image, page and card always name the same drops (Trevor, 11-08: "I thought there were 9, like the post we did?"). **Corrections** to a drop the feed does carry go in `DROP_CORRECTIONS` in the same file, also from the official page: Dapper's book marks some Pinnacle mystery-capsule sales as draws, and a Pinnacle draw's end there is the waiting room's, not the draw's close (11-08: Walt Disney Mugs Vol.1 capsules, Friends-Giving Vol.2 draw closing Fri 11/13 9 AM PT, not 11/20). A scheduled draft session cannot commit, so when the pre-post check finds one that is not listed it adds it to the text and image (`x-image.mjs --add extra.json`) and tells Trevor the page and card are missing it until it is entered.

## Images

Every post that has a template ships with an RPC-branded image. On X, a post with an attached image is shown as the image, and posts whose main link card is the content have reached fewer people (Buffer's link study; Nieman Lab). So the image carries the post, and the link rides the last post of a thread.

- `node scripts/social/x-image.mjs --slot <slot> --out <dir>` renders `rpc-<slot>-<n>.png` (2400×1350, 16:9) with Playwright from the same public API the text uses. Every item in the post is on an image. Up to 9 fit one image (a 3×3 grid with tighter type; a card pushed below the footer is a warning, 11-08); a longer list is split across images (X allows 4 per post), never cut. A card whose text overflows is reported in `warnings`.
- **Brand art only on the drops image.** No pack art, player photos or partner artwork is composited in: those belong to their owners, and pack art often carries real players' photos. Fonts and colours are RPC's (`public/fonts`, collection accents from `lib/collections.ts`). **The Monday top-sales image is the exception (Trevor, 11-09):** each card shows the sold asset's own image (its `thumbnail_url`; a Pinnacle pin through `/api/public/pinnacle-image/<render_id>?v=thumb`), embedded as a data URI. An image that cannot be fetched leaves the card's tile with the name only, and a warning.
- Layout: **balanced, centred rows of equal cards for every count** (Trevor, 11-15: "more visually appealing and balanced and symmetrical"): 4 = 2+2, 5 = 3+2, 6 = 3+3, 7 = 4+3, 8 = 4+4, 9 = 3+3+3; 1–3 in one row. Every card has the collection's colour glow, name, a one-line detail when there are ≤ 2 rows, the price, then the status pill. A drop with no dollar price may pass its unit as the price ("10 tickets"). Earlier (11-08) only 1–3 drops got the centred treatment ("center and make the graphic a little more visually appealing"). The image lists the same NEW drops as the post (`x-image.mjs` applies the same 36 h rule).
- Templates: **Sun — drops this week** (live 11-08); **Mon — top sales this week** (live 11-09: 10 cards, 5×2, each with rank, collection, asset image, name, set · serial, price and buyer); **Big sale** (live 11-14, `--slot big --sale <breaking[].sale.sale_id> [--headline "line one|line two"] [--video]`). Other slots post with their link card until they get one.
- **Big sale (Trevor, 11-14).** One sale, large: the asset on the left, and on the right the headline, player, set · team, the edition's badges and special serials, the price, when it sold (PT) and the buyer. `--video` also renders an MP4 with the moment's own Top Shot video in the art box (needs ffmpeg; muted, because the moment's audio is NBA game sound) — post the video when there is one. **Badges are icons only, never named** ("We don't need to name out each badge there"); **Three-Star Rookie replaces its three rookie badges** ("the point of the triple badge is that we don't need to then show each of those three badges individually"); **Autographed is left off** ("users can see that"). Badges come from `/api/entity/edition-badges` and only Top Shot's official icons are drawn; special serials (#1, perfect #N/N, jersey match via `/api/entity/edition?part=bio`) use Top Shot's own glyphs on Top Shot and RPC's elsewhere. The text column sits a clear gap right of the art ("a little bit more of a spacing gap between the video and the text").
- The daily task sends the image as a file with the draft. Trevor saves it and attaches it to post 1 (the one-tap post link cannot carry an image).

## Quote post: supply breakdown ("Where every Moment sits") — template, 11-15

When a reply asks where a player's or a list's supply sits, quote it with this graphic and text. First posted: https://x.com/rippackscity/status/2122082396774547650 (quoting a reply to the 11-14 rookie top-10 post). Archive: `docs/social/posts/2026-11-15/`. Second, for the 2025 class (11-16, Trevor asked for it): https://x.com/rippackscity/status/2122407037539922412, archive `docs/social/posts/2026-11-16/`.

**A rookie class counts its ROOKIE-SEASON Moments only** (Trevor, 11-16: "These should only be for their rookie season"). Set `season` in the SQL to the class's rookie season (`2025-26` for the 2025 class, `2026-27` for 2026). A 2025 rookie's 2026-27 Season Tip-Off Moments are left out; that season's 2026 Playoff Premieres and 2026 NBA Finals sets are Series 2025-26 and stay in. Every edition and parallel of the season counts (Ultimates and Signature Series 1/1s included).

1. Run `docs/social/supply-breakdown.sql` (edit `players` and `season`; read-only) and turn its rows into `[[player, team, unlocked, locked, in_packs, minted_not_in_packs, burned], …]` in the order of the post being quoted. For a class top 10, rank with the "top 10 by sales" query at the bottom of the same file (rookie-season editions, all-time sales) and look at #11 too.
2. **Re-read it live before posting:** run the file's "Inputs" query, paste its strings into `scripts/social/supply-breakdown-live-check.js`, run that in an nbatopshot.com tab through Claude in Chrome, and poll `window.__supply` (~350 calls, ~2 min). Use its numbers. The SQL's in-packs / minted-not-in-packs split is an estimate from pack reads that can be weeks old (11-16: 960 / 98 from SQL, 954 / 104 live); minted, locked, burned and unlocked matched Atlas exactly on all 197 editions.
3. `node scripts/social/x-supply-breakdown.mjs --data rows.json --asof "<Day M/D, h:mm AM/PM PT of the live read>" --label "<class> rookie class top 10 · rookie-season" --out supply.png` — one stacked bar per player, legend, totals row. Keep `--label` short: a longer one wraps the subtitle onto two lines.
4. Text (numbers only — Trevor cut a "Most locked: …" line):

```
Where all 6,543 Moments of the 2026 rookie top 10 sit today 👇

In packs: 3,041
Unlocked: 2,818
Locked: 330
Minted, not in packs: 352
Burned: 2
```

Definitions (per edition, `badge_editions` = Top Shot's counts, hourly): **locked**, **burned** as given; **in packs + minted, not in packs** = `hidden_in_packs` (everything Top Shot still holds); **unlocked** = circulation − locked − burned − hidden (includes Moments listed for sale). The split of hidden is the method in the SQL file: ⚠ never subtract a stale pack count from a fresh hidden count (11-15: understated "minted, not in packs" by ~30). Check every row sums to the player's circulation before posting. The public Top Shot GraphQL (`public-api.nbatopshot.com`) returned Cloudflare 1033 on 11-15, so RPC's tables are the source. Atlas itself (`api.production.atlas.dapperlabs.com/public/atlas.v1.*`) answers from an nbatopshot.com browser tab, which is how the live check reads it. ⚠ Atlas `SearchEditions` filters `setId` by **set name**: 241 and 260 (both "Signature Series") each return all 30 editions of both. Summing a per-set walk double-counts unless you de-duplicate by edition id; the live check reads editions one by one (`GetEdition {editionId}`) for that reason.

2025 class, posted 11-16 (https://x.com/rippackscity/status/2122407037539922412; rookie-season; every number re-read live at 11:21 AM PT):

```
Where all 16,994 @NBATopShot rookie-season Moments of the top 10 2025 Rookies sit today 📊

Locked: 8,459
Unlocked: 5,339
Burned: 2,386
In packs: 747
Minted, not in packs: 63
```

## When the data isn't there

If the script sets `skip_reason`, the task says so and offers the "week in numbers" post (`--slot sat`) as a fallback. If an API fails, nothing is drafted from a guess.

## Revert

Delete the scheduled task "RPC daily X draft", then `docs/social/` and `scripts/social/`. Nothing in the site depends on either.
