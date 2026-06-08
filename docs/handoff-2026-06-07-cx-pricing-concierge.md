# Handoff 2026-06-07 — CX wave: pricing page truth, concierge knowledge refresh, outbound-click sensor

CONTEXT

Three small, independent items from the 2026-06-07 evening Cowork CX sweep. None touch anything in the other in-flight handoffs (pin waves, AllDay video, DUPE1, Tier-B). Claude Code's direct file inspection wins over this doc on any disagreement.

ITEM 1 (P0, product-positioning — DEFAULT DECIDED, Trevor can override in one line) — /pricing advertises a paywall that policy says doesn't exist yet, with a LIVE Stripe checkout

Facts, verified: app/pricing/page.tsx renders StripeSubscribeButton (3 mounts) which POSTs /api/stripe/checkout and redirects to a real Stripe URL — an approved beta user can genuinely pay $9.99/mo today. The page promises Pro features that are currently shelved, removed, or fictional: Insider Signals / Whale Watch / Hot Editions (unmounted in the dashboard declutter), 25 custom alerts (alerts path partially decommissioned per CLAUDE.md architecture notes), API access 100/10,000 req/day (no public API product), custom Discord roles (no Discord), 30-sec real-time sniper tier, Pinnacle triple-key joins (superseded by per-render FMV). Policy: no paywall/monetization until 50+ WAU (measured WAU proxy right now: ~2). And a Dapper/Flow employee is actively evaluating the product.

DEFAULT ACTION (matches the no-paywall rule): convert /pricing into an honest beta page — keep the route + SEO shell, replace both Subscribe CTAs with the existing "Phase 1 Beta: everything unlocked free for invitees" framing + a request-invite/login CTA, delete or future-tense the feature claims that aren't live, and gate StripeSubscribeButton behind an env flag (NEXT_PUBLIC_PRO_CHECKOUT_ENABLED, default off) rather than deleting it — the Stripe plumbing stays dormant for the day the WAU gate clears. ALTERNATIVE (only if Trevor says so): keep the paywall page but correct the feature list to what Pro would actually ship today. Verify: /pricing renders the beta framing anon; POST /api/stripe/checkout path unreachable from UI; tsc clean; deploy READY. Revert: git revert.

ITEM 2 (P1) — concierge doesn't know the 2026-06 product

app/api/support-chat/route.ts system prompt: grep confirms it knows squeeze (check_wallet_squeeze tool), pack EV, collections toolset, magic-link/profile — but has ZERO knowledge of: the rewards program (Status/Credits, earn rules, shop, /rewards), wallet verification (the listing-challenge flow — users WILL ask "how do I verify my wallet"; it pays 500 credits), the public /insights surfaces (squeeze board, Below FMV deals, first-mint, rookies, RPC index, pack reality, pinnacle scarcity — shareable URLs the concierge should hand out), the per-render Pinnacle pin pages (/pinnacle/moment/<render_id>), and Team Hub / /my-teams. Add a compact knowledge block to the system prompt covering those five (URLs + one-line each + the two FAQ answers: "how do I earn credits" and "how do I verify my wallet" with the exact flow). Do NOT add new tools in this pass — prompt knowledge only, keep token cost small. Verify: ask the live concierge both FAQs and confirm sane answers; rate-limit and escalation behavior unchanged.

ITEM 3 (P1, funnel sensor) — outbound-click tracking has recorded ZERO rows since 2026-04-25

outbound_clicks: 25 rows ever, last 2026-04-25 — five-plus weeks of silence that spans the May-23 View-Listing reframe and the May-30 "instrumentation live" note. The plumbing exists (components/TrackedOutboundLink.tsx, lib/track-click.ts, /api/track-click, imported by sniper + market pages) but either the reframed CTAs render plain anchors that bypass it (the pack page "Buy on secondary market" hero CTA is a plain link, verified in page source), the component's fire-and-forget POST is failing silently, or /api/track-click is rejecting (check its auth + proxy.ts handling). Diagnose in 2 minutes: click one View Listing in prod, then SELECT count(*), max(created_at) FROM outbound_clicks. Fix accordingly and ALSO wrap the pack-page Buy CTA + edition-page outbound links in TrackedOutboundLink — outbound clicks are the single best funnel signal RPC has and it's currently blind. Verify: a test click writes a row with the right surface; no double-fire.

GUARDRAILS (standard)
Direct-to-main, no branches/PRs; PowerShell git; verify push with git rev-list --count origin/main..HEAD (expect 0); tsc + smoke after deploy; full-file replacements.

END STATE: /pricing tells the truth and can't charge anyone while the product is pre-traction; the concierge can answer this week's two most likely questions and route users to the insights surfaces; outbound-click telemetry actually fires so the funnel has eyes.
