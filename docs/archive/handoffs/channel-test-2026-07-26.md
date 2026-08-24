# Channel test — prep pack, 2026-07-26

Nothing in here gets published until Trevor says so. This is the loaded gun, not the trigger.

## Why this and not another feature

Registered users 20, flat for six weeks. Signups in the last 45 days: 0. WAU 0, MAU 1. Every conversion counter has read zero at every date ever measured. Meanwhile the thing the platform is: 26,921 editions, 4.57M sales, 916k FMV snapshots, 508 wallets indexed, five live collections. The build is not the constraint. The only untested hypothesis left is whether anybody who would want this has ever seen it.

The wedge is now instrumented across five surfaces with session attribution, so for the first time a visit can be traced to a source. That instrument is useless without traffic pointed at it. This is the traffic.

## The rule that makes or breaks it

Every venue below is a community, not a distribution list. The post has to be **useful standing alone** — someone who never clicks the link should still be glad they read it. The link is a footnote, not the point. Posts that fail this get removed, and worse, they burn the venue permanently. There is one shot per community.

Practical form: lead with a number nobody else has published, show the working, and close with "I pull this from a tracker I run; wallet lookup is free and doesn't need an account" — which is now true, and is exactly the wedge.

## Venues, ranked

**1. r/nbatopshot.** Largest concentration of the 100–2,000-moment cohort in one searchable place. Data posts do well; self-promo gets removed. Read the sidebar rules the day of posting — they change. Post as a data post, put the link in a comment rather than the body if the rules are ambiguous.

**2. The Top Shot Discord data/analytics channels.** Smaller but higher intent, and the people who reply are the ones who would actually use a squeeze board. Lurk for a day first and answer somebody else's question before posting anything of your own.

**3. X / Twitter, replying rather than posting.** The collector accounts that post floor screenshots are asking questions the data answers. A reply with the actual number outperforms an original post at zero followers.

Pick **two**. Three is not more signal, it is less attention per venue and a worse read on which one worked.

## Three posts, ready to go

All numbers below were queried live on 2026-07-26 and are true as of that date. Re-run the queries in the appendix before posting — a stale number is worse than no post.

---

### Post 1 — Fees (strongest, and it is news)

The three Dapper marketplaces do not charge the same fee, and almost nobody prices for it.

- NBA Top Shot: **5%**, paid by the seller.
- NFL ALL DAY: **5%**, paid by the seller.
- Disney Pinnacle: **7.5%**, plus a **$0.50 listing fee** that you pay up front and lose if the listing expires.

That $0.50 is credited against the marketplace fee if the pin sells, so on a completed sale you pay whichever is larger — 7.5% or fifty cents. On a $1 pin that is a **50% haircut**. Pinnacle's floor asks currently start at $1.00.

What it does to "discounts": on my below-FMV board today, at a 10%-or-better gross discount, **4 of 24 Disney Pinnacle listings have a negative margin once the fee is applied**. They look like deals and they are not. Average gross discount on the Pinnacle rows is 20.1%; average margin on the money you'd actually put in is 10.1%. The fee eats half the apparent edge.

Top Shot and All Day rows all survive their 5% — but the gap narrows more than people expect: Top Shot's board averages an 18.0% gross discount and a 16.6% net return on the ask.

Sources: Top Shot and All Day both publish "a 5% fee is applied" in their marketplace-fees help articles; Pinnacle publishes the 7.5% as *reduced until further notice* in Marketplace 101, so it can move.

*(Closing line: I track this on a board that now shows the net-of-fees number next to the gross one. Free, no account.)*

---

### Post 2 — Serial premiums, with the actual fitted numbers

Everyone knows a low serial is worth more. Nobody publishes how much. I fit it against completed sales.

Disney Pinnacle, refit weekly, current fit:

- **serial #1 — 15.8×** the typical serial (n=81)
- **top 5% of the mint — 2.19×** (n=649)
- **top 20% — 1.18×** (n=2,297)
- everything else — 1.0× (n=14,859)

Two honest caveats. The #1 band is fit off 81 sales, which is thin — treat it as a direction, not a price. And it only holds where a #1 stands out from hundreds of serials; on a 5-mint chase pin the whole edition is scarce and serial position stops being the price driver, so I don't apply it below a 25 mint at all.

The practical read: if you hold low serials of high-mint pins, the flat "FMV" figures you see everywhere are understating you, and if you're buying a #1 at a small premium over typical, you're probably getting the better end.

*(Closing line: your own holdings, with the premium applied per serial, are a wallet paste away — no account.)*

---

### Post 3 — Coverage, for the venue where the complaint is fragmentation

Fewest fireworks, best fit for a thread where someone is complaining that their collection is scattered across five apps.

Currently indexed in one place: NBA Top Shot, NFL ALL DAY, Golazos, UFC Strike, Disney Pinnacle — 26,921 editions, 4.57M recorded sales. UFC's Flow market has been dead since 2026-05-13 and All Day stopped issuing new Moments, which is *why* they matter: a finite catalogue with a complete sales history is the easiest thing in the world to value properly, and the hardest thing to reconstruct later.

*(Closing line: paste a wallet, it values everything across all five at once.)*

## What to measure, and when to stop

The wedge writes `funnel_events` with a `surface` value and a session id, so attribution exists now. Baseline as of 2026-07-26, to beat:

| metric | baseline |
|---|---|
| `wallet_paste` lifetime | 24 |
| `wallet_paste` last 7d | 2 (all `home`) |
| funnel events last 7d | 194 |
| page views 7d | collection 130 · insights 40 · home 20 |
| signups 45d | 0 |
| WAU | 0 |

Read it at **T+48h** and **T+7d** with the appendix query. Do not read it at T+2h and conclude anything; a Reddit post's tail is longer than its spike.

**The decision rule, set now so it isn't rationalised later:**

- **≥ 10 wallet pastes attributable to the post inside 7 days** → the channel works. Do it again in the same venue with post 2, and only then think about a second venue.
- **1–9 pastes** → the channel is alive but the post was wrong. Same venue, different angle, once. Not twice.
- **0 pastes with the post visible and not removed** → placement was never the constraint. That is a real finding and it is worth more than another feature. It means the product needs a different audience or a different promise, and the next move is conversation with the people who *did* sign up, not more publishing.

The failure mode to avoid is publishing three posts in three venues in one week and learning nothing from any of them.

## Appendix — the read-back query

```sql
-- Wedge activity by surface, before/after. Run at T+48h and T+7d.
select
  surface,
  count(*)                                             as pastes,
  count(distinct session_id)                           as sessions,
  min(created_at)                                      as first_seen,
  max(created_at)                                      as last_seen
from funnel_events
where event_type = 'wallet_paste'
  and created_at > timestamptz '<POST_TIMESTAMP>'
group by surface
order by pastes desc;

-- Did any of it convert?
select count(*) as signups_since
from auth.users
where created_at > timestamptz '<POST_TIMESTAMP>';
```

Numbers in the posts, re-verify before publishing:

```sql
-- Post 1: fee-flip counts on the live board.
with f(slug, pct, minfee) as (values
  ('nba_top_shot', 0.05, 0.00), ('nfl_all_day', 0.05, 0.00), ('disney_pinnacle', 0.075, 0.50))
select b.collection_slug,
       count(*) as board_rows,
       count(*) filter (where (b.fmv_usd - greatest(b.fmv_usd*f.pct, f.minfee)) - b.low_ask <= 0) as flip_negative,
       round(avg(b.discount_pct)::numeric, 1) as avg_gross_pct,
       round(avg(((b.fmv_usd - greatest(b.fmv_usd*f.pct, f.minfee)) - b.low_ask) / b.low_ask * 100)::numeric, 1) as avg_net_pct_of_ask
from cross_collection_deals_board b
join f on f.slug = b.collection_slug
where b.low_ask > 0 and b.fmv_usd > 0 and b.discount_pct >= 10
group by 1 order by board_rows desc;

-- Post 2: the current Pinnacle serial fit.
select band, sample_size, round(multiplier, 2) as mult, is_reliable, computed_at
from pinnacle_serial_fmv_multipliers order by multiplier desc;

-- Post 3: coverage.
select (select count(*) from editions) as editions,
       (select count(*) from sales)    as sales,
       (select count(*) from collections where is_active) as collections;
```
