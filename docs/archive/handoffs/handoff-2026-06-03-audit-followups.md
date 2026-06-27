# Handoff — 2026-06-03 full-platform-audit follow-ups (code)

Plain text, iPhone-pasteable. Companion to docs/audits/full-platform-audit-2026-06-03.md.

CONTEXT
Cowork ran a full-platform health check + audit on 2026-06-03. Platform is green (security 0/0/0, 20/20 deploys READY, detect_stalled_pipelines() empty, FMV fresh). The one explicit build ask — highest edition offer displayed on moment pages — is ALREADY working (verified live: /moment/4999f947... Cooper Flagg 243:8274 shows "Best offer $5,500 · today"); no change needed there. Cowork shipped only reversible Sentry housekeeping (12 stale smoke-test issues resolved). NO DB migration was needed. Everything below is route/.tsx-only, so it needs Claude Code. Current prod HEAD at handoff time: f3011d9 (FMV mis-key sweep). All items are independent; ship in priority order, each can be its own commit. Items 1-4 are the worthwhile ones; 5-7 are low-value polish.

GUARDRAILS (repeat every handoff)
- Direct to main. No branches, no PRs. If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify the push with: git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s — anything higher sends the deploy to ERROR invisibly.
- CRLF: don't string-replace-patch on Windows; use full-file writes or findIndex on split lines.
- Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape. The line numbers below were read on 2026-06-03; if they've drifted, match on the surrounding code, not the number.

ITEM 1 (P2) — concierge "+ Cart" silent dead-end
File: components/SupportChatConnected.tsx (line 99).
What: the component passes onAddToCart={handleAddToCart} into the live concierge chat, so every deal card the concierge renders shows a "+ Cart" button (MomentCardUI in SupportChat.tsx). But Cart is shelved, and sniper-feed deals are source "topshot" which cartEligibilityReason maps to dapper_only, so handleAddToCart (SupportChatConnected.tsx ~L70-77) silently returns — a user clicks "+ Cart" and nothing happens (and when a listing IS eligible it writes a misleading "Added X to your cart" system message in SupportChat.tsx ~L281 for a cart that cannot check out).
Why: a no-op CTA on a live surface is a CX dead-end; Cart is deliberately shelved (CLAUDE.md Open #1).
Change: stop passing onAddToCart from SupportChatConnected (remove the onAddToCart={handleAddToCart} prop on L99) so the button stops rendering. If MomentCardUI requires the prop, pass undefined; verify the card hides the button when the handler is absent (it should — grep SupportChat.tsx for onAddToCart to confirm the button is gated on the prop). handleAddToCart itself can stay (dead but harmless) or be removed if tsc complains about an unused symbol.
Verify: npx tsc --noEmit clean; load the concierge on a deal-bearing page and confirm no "+ Cart" button.
Revert: git revert <sha>.

ITEM 2 (P2/P3) — best-offer parity on the shared MomentDetailModal
File: components/MomentDetailModal.tsx (props interface ~L28-47; render blocks ~L295-311). Caller with data already in hand: app/(collections)/[collection]/collection/page.tsx (builds an offerMap from /api/best-offers ~L839-853, renders the modal).
What: the moment + edition PAGES already show Best Offer; the hover/click MODAL (used by collection/page.tsx and sniper/page.tsx) does not — its props have no offer field.
Why: parity so the offer is visible on the grid/sniper modal too, not only the full pages.
Change: (a) add bestOffer?: number | null to MomentDetailModalProps.moment; (b) render a "BEST OFFER" block modeled on the existing FMV block, gated on bestOffer != null && bestOffer > 0, placed after the LIST PRICE block (~after L311), using var(--font-mono) for the number; (c) feed it from collection/page.tsx by passing the offerMap row's bestOffer into the <MomentDetailModal moment={{ ..., bestOffer }} />. The sniper page (app/(collections)/[collection]/sniper/page.tsx) can be left for a follow-up (it would need to call /api/best-offers or get_edition_high_offer for the selected moment's edition) — low priority. No DB/RPC change: get_edition_high_offer and the edition_offers-backed /api/best-offers already exist and are correct.
Verify: npx tsc --noEmit clean; open the collection grid, click a moment with a known offer (e.g. a Cooper Flagg 243:8274 moment), confirm the modal shows BEST OFFER.
Revert: git revert <sha>.

ITEM 3 (P3) — delete dead code
Files: app/api/moment-offers/route.ts and lib/pro/gate.tsx.
What: moment-offers has zero callers (grep app + components: only the route file matches) and is broken-by-design anyway (direct public-api.nbatopshot.com egress is Cloudflare-blocked from Vercel, and it scrapes the dead Flowty api2.flowty.io). lib/pro/gate.tsx has zero importers (grep "pro/gate": only docs) — the real gate is components/ProGate.tsx; gate.tsx carries a stale "TODO: wire Stripe" comment.
Why: dead routes/files mislead future work and (for moment-offers) imply an offer path that can't work.
Change: git rm app/api/moment-offers/route.ts lib/pro/gate.tsx.
Verify: npx tsc --noEmit clean; grep confirms no remaining imports; deploy READY.
Revert: git revert <sha> (or git checkout the files from the prior commit).

ITEM 4 (P3) — stale /signup public proxy rule
File: proxy.ts (line ~149, the isPublicPath allowlist).
What: /signup is whitelisted as public but app/signup/ does not exist; it's unlinked so it only 404s if typed directly. /about and /pricing (also whitelisted) DO exist — leave them.
Change: remove "/signup" from the public-path list (or, if a signup page is intended, create app/signup/page.tsx instead). Removing the rule is the lower-risk option given the funnel routes beta signups through /early-access.
Verify: npx tsc --noEmit clean; confirm /early-access still loads anon; deploy READY.
Revert: git revert <sha>.

ITEM 5 (P3) — RTR LivePickCard mobile overflow
File: components/rtr/RTRClient.tsx (line ~226).
What: a flex child uses minWidth: 200 inside a tight row (44px emoji circle + this + gaps) that can overflow a ~380px viewport.
Change: relax to minWidth: "min(200px, 100%)" or add a <=480px media-query reduction (e.g. 140). Spot-check the RTR Live Breakpoint section at mobile width.
Verify: npx tsc --noEmit clean; deploy READY.
Revert: git revert <sha>.

ITEM 6 (P3) — CSV export native alert() + hardcoded allowlist
File: app/(collections)/[collection]/collection/page.tsx (line ~1891).
What: Export uses a raw alert("Export is a Pro feature...") gated to PRO_ALLOWLIST = ["0xbd94cade097e50ac"] (Trevor). Off-brand and premature (CLAUDE.md: no paywall until 50+ WAU).
Change (optional): replace the alert() with the existing on-brand UpgradePrompt/PaywallModal pattern, OR simply hide the Export button for non-allowlisted users instead of prompting. Lowest priority.
Verify: npx tsc --noEmit clean; deploy READY.
Revert: git revert <sha>.

ITEM 7 (P3, optional) — scoped brand-token pass + doc reconciliations
What: a long tail of hardcoded #E03A2F / 'Barlow Condensed' / 'Share Tech Mono' literals exists, but MOST are acceptable contexts and should be LEFT ALONE: OG/opengraph-image routes (edge/satori can't read CSS vars), email HTML bodies (app/out/flowty), app/global-error.tsx (renders without app CSS), the recharts stroke SVG attr (documented exception), lib/collections.ts accent DATA, and the var(--rpc-red, #E03A2F) fallback pattern. Only convert plain component style-props that hardcode the literal with NO fallback — e.g. app/terms, app/privacy, app/early-access, app/profile/[username], components/auth/SignOutButton, components/OnboardingModal, overview/sniper accent fallbacks — to var(--rpc-red) / var(--font-display) / var(--font-mono). No user-visible defect; do this only when touching those files.
Doc reconciliations (same commit or a docs commit): CLAUDE.md known-issue #15 (livetoken fixtures) is resolved — mark it closed. Replace lingering "topshot_rookies_board" references with the live view name "topshot_2025_rookie_index" where they appear in active docs. cron-schedule.md is already current (lists offers-sweep + evm) — no change.
Verify: npx tsc --noEmit clean; deploy READY.
Revert: git revert <sha>.

ITEM 8 (P3, verify not fix) — pack-dist Server-Component render errors
Sentry NEXTJS-18 ("Attempted to call tierChip() from the server but tierChip is on the client...") + NEXTJS-17 (generic SC render error), both on GET /[collection]/pack/dist/[distId], 15d old / last seen ~8d, 23+8 events. Already CLAUDE.md known-issue #17. The 06-03 pack-page work (64e3f4a7) touched these pages.
Action: check whether these have fired since 64e3f4a7. If quiet 8d+, just mark the two Sentry issues resolved. If still firing, fix the client/server boundary on app/(collections)/[collection]/pack/dist/[distId]/page.tsx — tierChip is a 'use client' export being CALLED (not rendered) from a server component; either move tierChip to a server-safe util or render it as a component (this is the RSC client-function-call-crash class). My live checks confirmed the SECURITY/health smoke alarms in Sentry (NEXTJS-1C/1D/1E) are FALSE positives (RLS 0 holes, no destructive SECDEF anon-executable, detect_stalled=[]) — do not chase those as regressions.
Verify: Sentry NEXTJS-18/17 quiet after deploy.
Revert: git revert <sha> if a code fix was 