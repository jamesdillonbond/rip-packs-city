# Rip Packs City — Monthly Strategy & Traction Review

**Date:** 2026-09-01 (covers Aug 2026 vs prior 30d) · READ-ONLY review · nothing shipped

---

## Bottom line

Real human engagement genuinely grew in August — for the first time it's a trend, not noise. Distinct **wallet-paste sessions rose ~11x (3 → 33)** over the prior 30 days, peaking at **26 pastes / 22 engaged sessions** in the week of 08-24. That's the core "someone is using the tool" signal and it's the best it's ever been. But it is **not converting**: 0 signups in 30 days (last signup 2026-07-20), outbound clicks flat at ~7, concierge use fading. We are still far from the 50-WAU gate (engaged sessions peak ~22/wk), but the direction finally points the right way. The lever is now retention/return and the SEO channel that's clearly working — not more product surface.

---

## 1. Traction (the 50-WAU gate)

Headline is the *trend*, and the trend is up on the metrics that mean a human showed intent.

| Metric (distinct, non-bot) | Last 30d | Prior 30d | Move |
|---|---|---|---|
| **Wallet-paste sessions** (core intent) | **33** | 3 | ▲ ~11x |
| Engaged sessions (paste/account/share/signin) | 49 | 6 | ▲ ~8x |
| Signups (allow_list + account) | **0** | 1 | ▼ flat/zero |
| Outbound "buy" clicks | 7 | 8 | ▬ flat, very low |
| Real concierge convos (`is_smoke_test` excl.) | 4 | 35 | ▼ down sharply |

Weekly engaged sessions / wallet-pastes (last 8 wks): `1/1 · 1/0 · 2/2 · 1/1 · 5/5 · 1/1 · 16/5 · 22/26 · 6/11`. Baseline was ~1–2/wk through July; August steps up to double digits.

- **Users total: 26** (25 early-access form, 1 manual). 22 have saved a username. No net new signup in ~6 weeks.
- **Email subscribers: 0** — the list is empty; not a live channel.
- ⚠ **Instrument caveat — raw "sessions" is meaningless right now.** Total 30d sessions read as **19,493 vs 475**, a 40x jump, but ~19,365 are direct/no-referrer single-pageview hits that `bot_ua` isn't catching. This is crawler/indexer traffic, not people. Use engaged/wallet-paste counts as the WAU proxy, not sessions or pageviews. Defining a clean engaged-WAU metric is a prerequisite for honestly reading the gate (see build #3).

**Read:** small but real growth in genuine tool use. On the honest metric (engaged sessions), we're at ~a quarter of the 50 bar at peak week, up from ~1/wk. Good trajectory, still pre-traction.

## 2. Funnel — entry and drop-off

Non-bot funnel events, 30d: `home_view 231 · collection_view 16,948 · insights_view 2,738 · share_view 50 · wallet_paste 48 · account_created 4 · signin_click 1`.

- **Entry is deep, not the front door.** Insights + collection pageviews dwarf home_view (~19,700 vs 231). People and crawlers arrive directly on collection/insights pages via search, not the homepage. Referrers on those deep pages include Google + **AI answer engines (ChatGPT 8 sessions, Copilot, Brave)** — the SEO/LLM-citation channel is starting to work.
- **The leak is after the paste.** The path narrows hard: wallet_paste (48) → account_created (4) → signup (0). The warmest users (33 distinct wallet-paste sessions) are getting value but not creating a reason to return. There is no return path and no signup pull — and that's fine per the read-only, no-login-wall stance, but it means the growth loop currently has no memory.

## 3. Shipped this month

~3,000 commits, overwhelmingly **DB performance, pipeline honesty, and reliability hardening** (LATERAL FMV rewrites cutting million-buffer reads to tens of thousands, watermark-gated pack-EV refresh, cron/timeout triage, "failed read must not render as an answer" fixes, OG-card read bounds, smoke-suite cadence + hard live concierge check). Instrumentation matured a lot: pipeline heartbeats, sentinel arms, schedule-stopped detection.

User-facing surface that actually landed:
- **Profile / public identity push** — public `/profile/[username]`, trophy case, avatar picked from an owned Moment (default RPC logo), tool-first tab instead of a login wall, honest wallet counts / no rewards-or-P&L promises.
- **New analysis surfaces** — buyback accumulation + spend board, per-collection `market` / `analytics` / `collection` pages, a dashboard page.
- **SEO** — sitemap now advertises 28 anon-public feature tabs; OG cards self-render glyphs (no CDN dependency). This correlates directly with the indexer/answer-engine surge.
- **Data coverage** — NFL All Day dapper.market edition links (DOM-verified); Pinnacle peer-to-peer TRADE tracked as a third transaction type.

## 4. Competitive notes (last ~month)

- **NFL All Day minting is halted (announced May 2026).** No new Moments; marketplace stays open, existing Moments become fixed-supply. Dapper is building a "next-gen" NFL product under a new NFL license. → RPC's All Day coverage stays useful but won't grow from new drops; a fixed-supply scarcity angle is now genuinely true and worth surfacing.
- **NBA Top Shot IPFS migration complete (2026)** — every Moment anchored to IPFS, authenticatable without an account. Provenance play, not analytics; no direct threat to RPC. Consistent with the repo's finding that Top Shot moved to the "Atlas" backend (old `public-api` dead).
- **Aug 26: 20 legends got their first rookie 1-of-1s on Top Shot**, plus 2026 Playoffs Trade Ticket packs — fresh scarcity/FMV content hooks.
- Flow continues to be positioned as the shared infra behind Dapper's NBA/NFL/Disney collectibles.

## 5. Recommended next 1–3 builds

Grounded in intelligence-first + the distribution bottleneck (entry is SEO deep-links; the leak is no return path). **No monetization — we're under 50 WAU.**

1. **Feed the working channel: more indexable intelligence pages.** The crawler + Google + ChatGPT/Copilot/Brave referrals prove the SEO/answer-engine surface is our real acquisition path. Ship timely, linkable data pages that map to live events — e.g. a Top Shot rookie 1-of-1s scarcity/FMV board (Aug 26 drop) and an **NFL All Day "fixed-supply now" board** (no new minting = the collectibles are finite; a natural, true intelligence story). Each is a new indexable entry point, not a login-gated feature.
2. **Give the wallet-paste a return path — without a login wall.** 33 warm paste sessions, 0 return mechanism. Ship a **shareable, permalinkable wallet-analysis snapshot** (share_view is already 50/mo and rising) that a collector can bookmark/share and that pulls a second visit. This turns the one strong intent signal into a loop, honoring read-only/no-wall.
3. **Define engaged-WAU as the gate metric and instrument it.** `bot_ua` misses the 19k crawler surge, so "sessions" can't be trusted to read the 50-WAU gate. Ship a clean **engaged-WAU definition** (distinct sessions with wallet_paste / account / share) and surface it in the traction snapshot so progress toward the gate is measurable and not inflated. Cheap, and it's the number every future decision keys on.

---

*Sources: RPC Supabase (`get_rpc_traction_snapshot`, funnel_events, allow_list, support_conversations, outbound_clicks); repo git log + docs/overnight/ledger.md; web — NBA Top Shot blog, Flow.com, Decrypt/Yahoo on NFL All Day minting halt.*
