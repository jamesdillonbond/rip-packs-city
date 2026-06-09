# Decision — don't build the Dapper/Atlas ingest yet; preserve it — 2026-06-08

## Decision

Ship nothing further on the dapper.market integration right now. The dual "View on Dapper" link is live (`f9210cf`) and the one issue verification surfaced — a Dapper link that 404s when dapper hasn't indexed a moment — is **accepted as-is**: the native "View on Top Shot" link is the always-works fallback, and a Dapper 404 lands on Dapper's own branded page, not a broken RPC page. No code change.

The tempting next step — ingesting Dapper's Atlas API to coverage-gate the link and pull a second marketplace's pricing — is **deferred, not dropped.** It's scoped below with explicit triggers to revisit.

## Why defer (the honest version)

RPC is pre-traction: ~2 WAU, 13 allow-listed, 0 email subscribers. The binding constraint on RPC's long-term success is **the funnel — getting and keeping users — not data depth.** The FMV/squeeze/pack-EV engine is already strong and largely unconsumed.

Against that backdrop, building an Atlas ingest now is the classic solo-founder trap:

- **Wrong sequencing.** A second pricing source improves FMV, but FMV improvements are realized *by users*. With ~2 WAU the value is latent. The marginal user comes from the funnel, not from FMV being a few percent better.
- **Thin payoff today.** Dapper's non-TS volume is ~0 (NFL All Day $8.7K/7d, LaLiga $0). The only liquid collection is Top Shot, where RPC's FMV coverage is already honestly complete. So the cross-market data we'd ingest is thin everywhere except the one place we're already good.
- **It's a fragile dependency.** Atlas (`api.production.atlas.dapperlabs.com`) is Dapper's undocumented, private Connect/gRPC backend. Building RPC's pricing on a reverse-engineered private API is ongoing toil and a new thing that silently breaks — a real cost for a one-person team already babysitting a large pipeline estate.
- **The problem it solves is cosmetic.** The 404 is rare-ish, gracefully handled by the dual-link design, and shrinks on its own as Dapper fills its index. Building a whole ingest pipeline to hide some links is poor ROI.

"Best for the long term" here is the discipline to **not** build the impressive thing while the actual bottleneck is elsewhere. The dual-link already does its job. Energy is better spent on traction (de-walling the funnel, the wallet-paste landing, the insights wedge, SEO) — the work that turns the strong-but-unconsumed engine into a used product.

## The opportunity, preserved (so the discovery isn't lost)

When the triggers below flip, this becomes worth building. Everything needed to start is captured here and in memory (`dapper-market-post-flowty-marketplace`).

**What it is:** ingest dapper.market's listings + sales as a second live marketplace data source.

**What it unlocks:**
- Cross-market FMV validation (two independent price sources beat one).
- A "real FMV vs Dapper's Avg Sale" wedge — Dapper shows a naive average; RPC shows confidence-tiered, serial-adjusted FMV plus a discount score. Concrete reason to check RPC before buying on Dapper.
- A "cheapest across Top Shot + Dapper" deal signal.
- Coverage-gating the "View on Dapper" link (kills the 404) falls out for free.

**Technical scope (discovery already done):**
- Backend: `https://api.production.atlas.dapperlabs.com`, Connect/gRPC-style POST. Services seen on a moment page: `atlas.v1.NFTService/SearchNftsByOwner`, `atlas.v1.SetService/GetSet`. Reverse-engineer the moment-by-id and listings/sales calls from the browser network tab.
- Almost certainly blocks Vercel/Supabase egress (like the Top Shot GQL) → front it with a **Cloudflare Worker proxy** with its own auth surface — RPC's established pattern (`topshot-proxy` et al.; never share an existing proxy's secret).
- Storage: a `dapper_market_*` listings/sales table (or fold into the existing cross-market plumbing) + a coverage flag keyed by moment/edition. Likely cheaper to flag coverage at the *edition* level than per serial.
- ID mapping is confirmed: RPC's `moments.nft_id` == Dapper's moment id (`dapper.market/<league>/moment/<nft_id>`), leagues `nba | nfl | laliga`.
- Caveat to settle first: confirm rate limits and that consuming Atlas is acceptable before depending on it.

## Triggers to revisit

Build it when **any** of these is true:
1. RPC is at ~50+ WAU and is deliberately investing in FMV depth as a headline differentiator (this also lines up with the existing no-paywall-until-traction bar).
2. Dapper.market volume grows materially **beyond Top Shot** (NFL All Day / LaLiga become liquid), so cross-market data is broadly valuable rather than TS-only.
3. Real users report dead "View on Dapper" links often enough to matter (i.e., the 404 stops being cosmetic).
4. A strategic decision to make "cross-market pricing / cheapest-across-marketplaces" a flagship feature.

## State as of this decision

- Dual-link shipped and verified live (`f9210cf`): native + Dapper on the TS moment page, correct URLs, correct id namespace. Native is the reliable fallback for un-indexed moments.
- Discovery captured: recon (`docs/research/dapper-market-recon-2026-06-08.md`), this decision, and the memory entry (incl. the Atlas API, the coverage-gap evidence, and the id-namespace confirmation).
- No code, no pipeline, no new dependency added. Nothing to revert.
