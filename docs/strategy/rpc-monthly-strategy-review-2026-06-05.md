# RPC Monthly Strategy Review — 2026-06-05

*Automated monthly review. Read-only — nothing shipped. Window compared: ~last 30d (May 6 – Jun 5) vs the prior 30d.*

## Bottom line

Still pre-traction, and that's by design. Output this month was enormous — **611 commits**, and the work hit the right target: the public `/insights` surface, the SEO front door, and the rewards/referral loop all landed. But the user base is **flat at 13**, signups have been **zero for 27 days**, and the brand-new funnel can't yet attribute a single session to a real acquisition channel. The product is now broad and well-instrumented; the gap is entirely **distribution**. With promo intentionally held, the one compounding lever in motion is SEO — and the surfaces that traffic lands on currently capture **nothing** (email subs 0, outbound clicks 0). Fix the leak, let SEO compound, ride the playoff window.

## Traction (vs ~last month)

| Metric | Now (30d) | Prior 30d | Read |
|---|---|---|---|
| Allow-list users | 13 total / 13 active | 13 | **Flat.** All 13 from one early-access batch May 6–9; **0 new signups in 27 days** (last May 9). |
| Real concierge (non-smoke) | **50** convos / 45 sessions | 32 | **+56% MoM** — the only up-and-to-the-right metric. But quiet last 7d (1 convo; last real May 30). |
| Funnel sessions (new instrument) | 50 sessions / 64 events (~5d) | n/a | Live and recording — but referrer-less (see Funnel). |
| Outbound clicks | 0 | 0 (last click Apr 25) | No click-through recorded on the new surfaces — capture likely not wired or not firing. |
| Email subscribers | 0 | 0 | No list being built. |
| WAU vs 50-gate | a handful | — | Far from the gate; signups flat is the headline, not the absolute level. |

**Honest read:** the 50-WAU gate is not close, and signups have been flat-to-zero for four weeks — expected, since acquisition isn't being pushed. The one encouraging number is real concierge volume (32 → 50). Treat it as a *weak* positive: with 13 known users and all-direct traffic, some of those sessions are plausibly founder/beta testing rather than external demand.

## Funnel (entry → drop-off)

Instrumentation went live ~May 31, so this is ~5 days of data — no month-over-month baseline yet.

- 44 sessions → `home_view` (46 events)
- 7 sessions → `insights_view` (13)
- 3 sessions → `share_view` (4)
- 1 session → `wallet_paste` (1)
- **0** → signup · **0** → outbound click · **0** → email

Two findings:

1. **Every session is referrer-less** (50/50 direct/none). I cannot attribute one session to organic search, social, or any channel — so this is most likely a mix of crawlers and your own testing, **not yet evidence of external collector demand**. (Referrer capture may also simply be incomplete.)
2. **100% of anon traffic evaporates.** Of ~44 home-landing sessions, ~16% reach an insights page, ~2% paste a wallet, and **nothing** converts to email, click, or signup. The surfaces now have visitors and zero capture.

## Shipped this month

611 commits, overwhelmingly aimed at the right bottleneck (public surface + discoverability):

- **~12 public `/insights` surfaces** — squeeze board, pack-reality, rookies / first-mint trophies, cross-collection whales, set-squeeze, Pinnacle scarcity, TC Report, **the RPC Index**, offer-spread (Bid vs Floor), below-FMV deals, squeeze-check tool.
- **SEO front door** — opened entity/home/insights to anon, ~24K-URL sitemap, JSON-LD + breadcrumbs + branded OG cards, and the **internal-linking pass** (footer hubs + insights↔entity links) that landed Jun 5.
- **Funnel + share** — `funnel_events` instrumentation, `/share` wallet-intel overlay, OG image fixes.
- **Team Hub / My Teams** — Phases 1–5; public team checklist with cost-to-complete + wallet-paste tracking.
- **Rewards program** — off-chain points economy (Status + Credits, shop, referral capture, admin console), Jun 4–5. An acquisition/retention lever, not the tabled paywall.
- **On-chain offers intelligence** — TS + AllDay offer-book indexers (depth / identity / fill).
- Plus: **FMV accuracy cluster**, **Flowty teardown complete**, **chain-abstraction Phases C–F complete**, and ops hardening (autonomous overnight pass, sentinel, FLOW payer-drain killed).

## Competitive notes

- **Top Shot shipped native offers** (bid on unlisted Moments) and is mid-playoffs (Apr 17 – Jun 26; drops May 20 + Jun 24; Road to the Ring campaign). Peak engagement window is live *right now*. RPC's edge isn't the offer feature itself — it's the offer-*book intelligence* (bid-vs-floor spread, depth) that the native site doesn't surface, which RPC just shipped.
- **The analytics field is crowded** — LiveToken, MomentRanks (subscription + fantasy game), TopShot Tools, Rayvin, RookShot, TopMoment. None of them own the **squeeze / effective-supply** story or go **cross-collection** across all 5 Flow collections — still RPC's clearest wedge.

## Recommended next 1–3 builds

Grounded in intelligence-first + the distribution bottleneck (not promo, not paywall):

1. **Plug the conversion leak — make anon traffic leave a trace.** Email subs 0 and outbound clicks 0 while the funnel shows real sessions is the highest-leverage problem on the board. First *verify* the email/click instrumentation actually fires on the surfaces that have traffic (home, `/insights`, `/share`); then add one low-friction hook — "email me when this wallet/set moves," "save this squeeze board" — so SEO visitors convert into a re-engageable list instead of evaporating. Without this, every visitor SEO earns is lost.
2. **Make SEO actually compound — verify indexing, then add high-intent landing surfaces.** The corpus + internal links are now in place; confirm Google is crawling/indexing the entity + insights pages (Search Console), repair anything still orphaned, and add the landing pages that match real collector queries (per-player / per-set "is this squeezed?", "floor-vs-bid gap"). This is the only acquisition channel that grows without spending promo.
3. **Ship a playoff-timed squeeze + offer-spread surface while the window is open (through Jun 26).** Top Shot engagement peaks during the playoffs and the native site doesn't show offer-book intelligence. A genuinely-better "what's squeezed / where's the bid-floor gap this playoff run" view is exactly the differentiated, shareable intelligence that earns organic word-of-mouth. Build it now; whether/when to promote stays your call.

*Housekeeping: add referrer/UA capture to `funnel_events` so next month I can separate crawlers from collectors.*
