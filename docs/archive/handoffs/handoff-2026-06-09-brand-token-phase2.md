# Handoff 2026-06-09 — brand-token Phase-2 sweep (CC, batched)

Mechanical, low-risk, do in batches. Phase-1 (`de01542`) cleaned the 6 highest-traffic public surfaces + shipped the CI guard `scripts/check-brand-tokens.mjs` (hard-fails only on the `PROTECTED` list). Phase-2 = the remaining repo. Inventory below is from a 2026-06-09 grep: **79 files** with `#E03A2F` (case-insensitive) + **42 files** with `'Barlow Condensed'`/`'Share Tech Mono'` (heavy overlap). Net real targets after removing exceptions ≈ 45 files.

## The replacement (only three tokens)
- `#E03A2F` (any case) → `var(--rpc-red)`
- `'Barlow Condensed', ...` → `var(--font-display)`
- `'Share Tech Mono', ...` → `var(--font-mono)`

## SKIP — these are NOT violations (do not tokenize)
- `app/rpc-tokens.css` — defines the tokens.
- `app/api/og/**/route.tsx` (~20 files) + `lib/og/entity-card.tsx` — Satori OG image gen; **cannot** resolve CSS vars. Leave hardcoded.
- Email/Telegram-HTML API routes — string HTML, no CSS vars: `app/api/check-alerts`, `app/api/subscribe/unsubscribe`, `app/api/send-digest`, `app/api/support-report`, `app/api/sentinel`, `app/api/public/profile/[username]`, and the `app/api/profile/*` routes (bio, collection-breakdown, follows, hero-moment, saved-wallets, teams). **Verify each is an HTML-string/notification context before skipping** — if any is an actual React style object, tokenize it.
- `components/visual/ConsoleGreeting.tsx` — console `%c` styling.
- `components/entity/FmvHistoryChart.tsx` — recharts `stroke` (SVG presentation attr can't take a var); already annotated `brand-exception` — leave.
- `lib/collections.ts` — the per-collection `accent` hex is DATA (the registry), not a UI literal. Leave.
- `workers/rpc-mcp-proxy/index.ts`, `app/out/flowty/[momentId]/route.ts` — worker / redirect-HTML, not Next UI.
- The 6 `PROTECTED` files: any remaining `#E03A2F` in them is an annotated `brand-exception` (recharts Cell fill / sparkline stroke) — leave.

## Batches (priority order: user-facing first → internal last)

For each file: grep the 3 literals, replace per the table, keep any genuine SVG `<fill>`/`<stroke>`/canvas case by annotating it with a `brand-exception` comment (the guard skips a line with that comment on it or within the 3 preceding lines). After a batch is clean, **add those files to the `PROTECTED` array in scripts/check-brand-tokens.mjs** so they can't regress, and confirm the guard passes. `tsc --noEmit` after each batch.

**Batch 1 — public marketing/legal/share/pricing/profile (highest brand visibility):**
app/pricing/page.tsx · app/blog/page.tsx · app/blog/pinnacle-star-wars-day-2026/page.tsx · app/legal/fmv-methodology/page.tsx · components/legal/FmvDisclaimer.tsx · app/share/[wallet]/page.tsx · app/share/[wallet]/ShareEmptyState.tsx · app/share/[wallet]/ShareButton.tsx · app/profile/[username]/page.tsx · app/profile/edit/page.tsx · components/SignInWithDapper.tsx

**Batch 2 — onboarding / paywall / pro / profile modals:**
components/onboarding/FirstRunTour.tsx · components/onboarding/WelcomeModal.tsx · components/PaywallModal.tsx · components/UpgradePrompt.tsx · components/ProGate.tsx · components/PlanBadge.tsx · components/auth/ProBadge.tsx · components/pricing/StripeSubscribeButton.tsx · components/ExplainButton.tsx · components/profile/TrophyPickerModal.tsx · components/profile/ViewTrophyModal.tsx · components/profile/WatchlistCard.tsx · components/profile/EmailDigestSubscribe.tsx · components/profile/PortfolioSparkline.tsx · components/profile/PublicAchievements.tsx · components/profile/_shared.ts

**Batch 3 — dashboard (auth-gated, user-facing):**
app/dashboard/page.tsx · app/dashboard/packs/page.tsx · app/dashboard/notifications/page.tsx · app/dashboard/alerts/page.tsx · app/dashboard/api-keys/page.tsx · app/dashboard/trade-hub/TradeHubClient.tsx · app/dashboard/trade-hub/TradeChainPanel.tsx (Trade Hub is `notFound()`-gated/shelved — tokenize anyway for when/if revived, it's cheap)

**Batch 4 — shared components + layouts + game features:**
components/SupportChat.tsx · components/MarketSummary.tsx · components/PortfolioChart.tsx · components/marketplace-status/MarketplaceStatusBanner.tsx · components/collection-tab-bar.tsx · components/CollectionSwitcher.tsx · app/(collections)/layout.tsx · app/(analytics)/analytics/layout.tsx · app/my-teams/layout.tsx · app/layout.tsx · app/global-error.tsx · components/rtr/RTRClient.tsx · app/(collections)/[collection]/road-to-the-ring/page.tsx · components/fast-break/FastBreakClient.tsx · components/fast-break/SlateRow.tsx · app/(collections)/[collection]/fast-break/page.tsx · lib/cosmetics.ts (verify: cosmetic-color DATA vs UI literal) · lib/hooks/useCollectionContext.ts (verify: default value vs UI)

**Batch 5 — admin (internal, RPC_ADMIN_TOKEN-gated, lowest priority):**
app/admin/rewards/page.tsx · app/admin/flowty-analytics/page.tsx · app/admin/feedback/page.tsx · app/admin/beta-activity/page.tsx · app/admin/allow-list/page.tsx

## Notes
- Several admin files already use the `var(--rpc-red, #E03A2F)` fallback form — the guard treats that as OK, but Phase-2 can drop the `, #E03A2F` fallback for cleanliness.
- This is ~5 small PRs (or one per batch direct-to-main). None of it is urgent; it's brand-consistency hygiene + regression-proofing via the growing `PROTECTED` list.
- Don't gate the whole repo in CI at once — keep extending `PROTECTED` per cleaned batch (the guard's current design), so a half-done sweep never blocks the build.

GUARDRAILS: direct-to-main, no branches/PRs; `tsc --noEmit` + the brand guard per batch; pages render visually identical (tokens resolve to the same values). CC's file inspection wins — if a flagged literal is an email-HTML/Satori/data context, skip it.
