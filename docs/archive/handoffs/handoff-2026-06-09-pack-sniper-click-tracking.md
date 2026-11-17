# Handoff 2026-06-09 — Pack Sniper outbound-click instrumentation (tiny)

Audience: Claude Code. Direct-to-main, no branches, no PRs. One small item. Follows ba83f96 (link-graph close-out).

Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape.

## Context

The Pack Sniper's stated success metric is outbound_clicks from the board — but Cowork verified (grep, 2026-06-09) that app/insights/pack-sniper/PackSniperClient.tsx renders its View Listing / dapper.market links as plain anchors. The repo already has the instrumentation layer: components/TrackedOutboundLink.tsx + lib/track-click.ts + /api/track-click, used by the moment sniper, market, moment pages, and the pack dist page. The board is the only outbound surface not wired in, so its usage reads as zero no matter what happens.

## Item — wire the board's outbound links through TrackedOutboundLink

In PackSniperClient.tsx, replace the plain anchors for BOTH the primary View Listing link and the secondary dapper.market link with TrackedOutboundLink (read the component's props first and mirror an existing caller — the pack dist page is the closest sibling). Payload mapping onto the outbound_clicks columns (verified live schema: surface, destination, edition_key, moment_id, player_name, set_name, tier, serial, ask_price_usd, fmv_usd, discount_pct, wallet_address, session_id, buy_url):

- surface: 'pack-sniper'
- destination: 'topshot' for the marketplace-listing link, 'dapper-market' for the dapper link (match the vocabulary existing rows/callers use — check lib/track-click.ts for the destination convention before inventing one)
- ask_price_usd: the deal's lowestAsk; fmv_usd: grossEV (it is the closest value-anchor column; if that feels like column abuse, leave fmv_usd null and put grossEV in discount_pct's complement — DON'T add columns); discount_pct: the deal's discountPct
- edition_key: null (these are dists, not editions) — if the component requires it, pass the distId in whatever free-text identifier the schema/component supports rather than overloading edition_key with a non-edition value; buy_url: the href
- Simulate + Details links stay untracked (internal navigation).

Do not block navigation on the tracking call (TrackedOutboundLink already handles fire-and-forget semantics — keep its behavior).

Revert: git revert.

Verify: tsc clean; deploy READY; click one board link in a browser, then confirm a row lands: SELECT surface, destination, ask_price_usd, buy_url FROM outbound_clicks WHERE surface='pack-sniper' ORDER BY created_at DESC LIMIT 3;

## Guardrails

Direct-to-main; PowerShell git; re-verify push (git rev-list --count origin/main..HEAD = 0); full-file writes; deploy READY + smoke + no new Sentry.

## Expected end state

One commit on main: every outbound click from /insights/pack-sniper writes an outbound_clicks row with surface='pack-sniper', making the board's success metric real. (For the record, also verified this session: the weekly digest route /api/send-digest exists but has 0 runs ever and email_subscribers is 0 — correctly dormant, do not wire it up.)
