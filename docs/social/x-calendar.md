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
| Sun | Drops this week | `pack-calendar` | the lead drop's RPC pack page, or `/<collection>/packs` while that page 404s | Every Top Shot / All Day drop open now or starting in the next 7 days: price, and when it drops or its RSVP closes, in PT. Leads with the priciest |

Friday rotation: squeeze → serial-premiums → market-cap → offer-spread → underpriced-serials → autographs → first-mint → set-completers → trade-in.

The trade-in finder (Top Shot This pack credits) moved into the rotation on 11-08 to make room for the drops post. Thursday still falls back to it when no deal qualifies.

**Big-sale extra (any day):** a sale in the last 24 h that cleared $1,000 and ranks in the week's top 5 gets its own short draft. It is offered alongside the slot post, never instead of it. Two big-sale posts a day at most.

**Drop reminder (Mon–Sat):** a drop starting, or an RSVP closing, in the next 24 h gets an optional short reminder (≤ 2). Sunday's post already lists them.

**Where drops come from:** `/api/public/insights/pack-calendar` reads the Atlas pack book (`atlas_pack_market`, refreshed every 15 min) from its last complete pass only. If the book has no complete pass the API says `complete: false` and the slot skips — it never posts "no drops". For an RSVP drop, Dapper's window is the RSVP, so the copy says "RSVP closes", never "sale ends". The calendar reads every product the book walks (one `atlas_pack_market_state` row each): Top Shot (`nba`) and All Day (`nfl`) today; Golazos (`laliga`) and Pinnacle (`disney`) answer the same Atlas endpoint and join as soon as their state rows exist (migration `audit_20261108_atlas_pack_book_adds_golazos_and_pinnacle`). A walked product with no complete pass is reported as unread in `warnings`, never as a week without drops. **Not covered, and never described as "no drops":** Panini (`panini_products.first_seen_at` is when our runner discovered a product, not a release date), Candy MLB (no drop schedule is ingested) and UFC Strike (market closed). The script lists all three in `facts.collections_not_covered`.

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
- **Under 280 characters by X's count** (every link counts as 23). The script measures it.
- **Plain voice**: the number first, one line of context, the link. One emoji at most.

## When the data isn't there

If the script sets `skip_reason`, the task says so and offers the "week in numbers" post (`--slot sat`) as a fallback. If an API fails, nothing is drafted from a guess.

## Revert

Delete the scheduled task "RPC daily X draft", then `docs/social/` and `scripts/social/`. Nothing in the site depends on either.
