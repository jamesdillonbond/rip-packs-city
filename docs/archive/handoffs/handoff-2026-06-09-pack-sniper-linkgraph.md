# Handoff 2026-06-09 — Pack Sniper link graph: hub card, footer, cross-links, dedicated OG, pip fix

Audience: Claude Code. Direct-to-main, no branches, no PRs; if a claude/* branch is pre-checked-out, switch to main first. Follows 53c2354 / add59fa / b8233f0 (Pack Sniper, all shipped + live-verified). This is the discoverability close-out: the board is live and healthy but internally ORPHANED.

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

## Context (verified live 2026-06-09 evening by Cowork)

- /insights hub lists Surfaces A through K plus two tools — NO Pack Sniper card. The site footer's Insights column (All Insights / Squeeze / Below FMV / First-Mint / Rookie Index / RPC Index / Pack Reality) also lacks it. The board's only inbound links are the sitemap and direct URL. Internal linking is RPC's known SEO lever; this is the gap.
- OG convention check: /insights/squeeze uses a DEDICATED card at /api/og/insights/squeeze; /insights/pack-sniper currently points og:image + twitter:image at the GENERIC /api/og/insights — below convention, and it ships a Share-on-Twitter button.
- The board itself is green: 43 gated TS deals + 47 AllDay at last check, verified buy links (marketplace listing shape live since b8233f0).
- NOT needed (premise checked and disproven — do not build): an AllDay pack-title backfill. Cowork measured pack_distributions live: 0 null titles across all 3,052 AllDay / 1,960 TS / 224 Golazos dists. The nulls that crashed the feed were upstream Studio listing-node payloads only, already guarded in add59fa.

Items in priority order. All page-layer; no DB work.

## Item 1 — Pack Sniper card on the /insights hub

app/insights/page.tsx (verify filename by grep — the hub page that renders the Surface A-K cards). Add a Pack Sniper card following the exact existing card pattern (eyebrow label, live stat line, title, two-sentence pitch, "Open ... →" link to /insights/pack-sniper). Suggested placement: adjacent to Surface B (Pack Reality) since they're siblings — Pack Reality is post-rip honesty, Pack Sniper is pre-buy deals. Use the next free surface letter the file's convention implies.

Live stat line: mirror how the other cards source their stat (most show a server-fetched number). The cheapest correct stat is the gated deal count from getPackDeals (lib/packs/pack-deals.ts) for nba-top-shot, e.g. "43 sealed packs below EV right now". If the hub's stats are fetched in one batched server pass and adding a live Dapper Studio call there is awkward, a static pitch line without a number is acceptable — do NOT let the hub page's render block on the Studio upstream; wrap in try/catch with a no-number fallback.

Copy direction (match the hub's voice): "Top Shot shows a sealed pack's low ask. We rank currently-listed sealed packs by that ask against expected pull value — lottery packs flagged, not promoted."

Revert: git revert.

## Item 2 — footer Insights link

Grep for the footer component (SiteFooter; the Insights column listing All Insights / Squeeze Board / Below FMV / ...). Add "Pack Sniper" → /insights/pack-sniper. Keep the existing ordering logic (it appears curated, not alphabetical — slot it after Pack Reality).

Revert: same commit.

## Item 3 — sibling cross-links (pack-reality ↔ pack-sniper)

- /insights/pack-reality page: add a one-line cross-link near its methodology/footer block: roughly "Thinking of buying a sealed pack instead of judging past rips? The Pack Sniper ranks currently-listed packs by ask vs EV →".
- /insights/pack-sniper (app/insights/pack-sniper/PackSniperClient.tsx or the server page wrapper): reciprocal line near the methodology block: "Want the honest history instead? Pack Reality audits every rip of the last 60 days →".

Match each page's existing typography/tokens; no new components.

Revert: same commit.

## Item 4 — packs page → board link (the skipped old Item 4b, lite version)

components/packs/PackPageClient.tsx: add a small link near the +EV-only / quick-toggle chip row, visible for both collections: "Pack Sniper: currently-listed packs ranked by ask vs EV →" pointing at /insights/pack-sniper. Just the link — the full DEALS preset from the original Item 4b stays skipped (the board IS the preset).

Revert: same commit.

## Item 5 — PackTable "X active listings" pip fix

components/packs/PackTable.tsx (~line 252): the pip currently renders a count from listingCount, which is structurally always 1 (searchPackNftAggregation returns one node per dist — see the comment added in b8233f0 at lib/packs/live-pack-listings.ts). Change the pip to drop the number: keep the green LIVE treatment, copy like "live ask" / "LIVE", no count. Do not remove listingCount from the internal shape (other consumers; the b8233f0 comment governs).

Revert: same commit.

## Item 6 — dedicated OG card

New route app/api/og/insights/pack-sniper/route.tsx mirroring the squeeze board's OG route (grep app/api/og/insights/squeeze for the pattern — same 1200x630, brand tokens, board-name treatment). Content direction: board title + the one-line value prop ("Sealed packs listed below expected pull value") + the RPC brand frame. Keep it static-text based like the sibling OGs unless they bake live numbers — match whatever squeeze does.

Then point the pack-sniper page metadata og:image + twitter:image at /api/og/insights/pack-sniper (currently the generic /api/og/insights). Use /api/og/* route-handler pattern, NOT opengraph-image.tsx (known 0-byte failure mode on this stack). Verify live with a curl that the route returns image/png and a non-trivial byte size.

Revert: git revert.

## Guardrails (repeat-every-handoff)

- Commit and push directly to main; no branches, no PRs.
- Commit via PowerShell git on Windows; re-verify with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — PowerShell Invoke-WebRequest.
- Brand tokens only (var(--rpc-red) / var(--font-display) / var(--font-mono)) — the CI brand guard hard-fails on regression in the cleaned surfaces.
- CRLF: full-file writes, no string-replace patching.
- After deploy: READY + smoke + no new Sentry.

## Expected end state

One or two commits on main, deploy READY: the Pack Sniper is reachable from the /insights hub, the site footer, Pack Reality, and the packs page; it has a dedicated OG card behind its share button; and the packs-page pip no longer asserts a fake listing count. Anon crawl of /insights shows the new card; the board stops being an orphan in the link graph.
