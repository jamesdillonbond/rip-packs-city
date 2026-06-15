#!/usr/bin/env node
// Brand-token regression guard (Item 6, 2026-06-08).
//
// The CLAUDE.md brand rule forbids hardcoding the brand red (#E03A2F) or the
// font literals ('Barlow Condensed' / 'Share Tech Mono') in UI — use the tokens
// var(--rpc-red), var(--font-display), var(--font-mono) instead.
//
// Repo-wide there is still ~70 files of pre-existing debt (admin, dashboard,
// modals, email HTML in API routes, the documented recharts FmvHistoryChart
// stroke). That is a tracked Phase-2 sweep — failing CI on all of it now would
// just block the build. So this guard hard-fails ONLY for the public surfaces
// already cleaned in Phase 1, keeping them from regrowing literals, and prints
// the repo-wide count as an informational warning to drive Phase 2.
//
// Escape hatches (do not count as violations):
//   - a line (or one of the 3 preceding lines) containing "brand-exception"
//     — for genuine SVG <fill>/<stroke> / canvas inputs that cannot resolve a
//     CSS var()
//   - the var(--rpc-red, #E03A2F) fallback form

import { readFileSync } from "node:fs";

// Files cleaned in Phase 1 — these MUST stay token-only (minus annotated
// brand-exception lines). Add files here as Phase 2 cleans them.
const PROTECTED = [
  "app/(collections)/[collection]/overview/page.tsx",
  "app/(collections)/[collection]/collection/page.tsx",
  "app/(collections)/[collection]/sniper/page.tsx",
  "app/(collections)/[collection]/profile/[username]/page.tsx",
  "app/(collections)/[collection]/analytics/page.tsx",
  "components/profile/CrossCollectionPortfolio.tsx",
  // Phase 2 — Batch 1 (public marketing/legal/share/pricing/profile)
  "app/pricing/page.tsx",
  "app/blog/page.tsx",
  "app/blog/pinnacle-star-wars-day-2026/page.tsx",
  "app/legal/fmv-methodology/page.tsx",
  "components/legal/FmvDisclaimer.tsx",
  "app/share/[wallet]/page.tsx",
  "app/share/[wallet]/ShareEmptyState.tsx",
  "app/share/[wallet]/ShareButton.tsx",
  "app/profile/[username]/page.tsx",
  "app/profile/edit/page.tsx",
  "components/SignInWithDapper.tsx",
  // Phase 2 — Batch 2 (onboarding / paywall / pro / profile modals)
  "components/onboarding/FirstRunTour.tsx",
  "components/onboarding/WelcomeModal.tsx",
  "components/PaywallModal.tsx",
  "components/UpgradePrompt.tsx",
  "components/ProGate.tsx",
  "components/PlanBadge.tsx",
  "components/auth/ProBadge.tsx",
  "components/pricing/StripeSubscribeButton.tsx",
  "components/ExplainButton.tsx",
  "components/profile/TrophyPickerModal.tsx",
  "components/profile/ViewTrophyModal.tsx",
  "components/profile/WatchlistCard.tsx",
  "components/profile/EmailDigestSubscribe.tsx",
  "components/profile/PortfolioSparkline.tsx",
  "components/profile/PublicAchievements.tsx",
  "components/profile/_shared.ts",
  // Phase 2 — Batch 3 (dashboard, auth-gated)
  "app/dashboard/page.tsx",
  "app/dashboard/packs/page.tsx",
  "app/dashboard/notifications/page.tsx",
  "app/dashboard/alerts/page.tsx",
  "app/dashboard/api-keys/page.tsx",
  "app/dashboard/trade-hub/TradeHubClient.tsx",
  "app/dashboard/trade-hub/TradeChainPanel.tsx",
  // Phase 2 — Batch 4 (shared components + layouts + game features)
  "components/SupportChat.tsx",
  "components/MarketSummary.tsx",
  "components/PortfolioChart.tsx",
  "components/marketplace-status/MarketplaceStatusBanner.tsx",
  "components/collection-tab-bar.tsx",
  "components/CollectionSwitcher.tsx",
  "app/(collections)/layout.tsx",
  "app/(analytics)/analytics/layout.tsx",
  "app/my-teams/layout.tsx",
  "app/layout.tsx",
  "app/global-error.tsx",
  "components/rtr/RTRClient.tsx",
  "app/(collections)/[collection]/road-to-the-ring/page.tsx",
  "components/fast-break/FastBreakClient.tsx",
  "components/fast-break/SlateRow.tsx",
  "app/(collections)/[collection]/fast-break/page.tsx",
  "lib/cosmetics.ts",
  "lib/hooks/useCollectionContext.ts",
  // Phase 2 — Batch 5 (admin, internal)
  "app/admin/rewards/page.tsx",
  "app/admin/flowty-analytics/page.tsx",
  "app/admin/feedback/page.tsx",
  "app/admin/beta-activity/page.tsx",
  "app/admin/allow-list/page.tsx",
];

const LITERAL = /#E03A2F|'Barlow Condensed'|'Share Tech Mono'/i;
const FALLBACK = /var\(\s*--rpc-(red|[a-z-]+)\s*,\s*#E03A2F\s*\)/i;

// ── Light-mode neutral guard (Phase 2 — light mode Batch 1, 2026-06-10) ──────
// The files below were tokenized so light mode renders. The neutral literals
// that make light mode UNREADABLE are white-alpha surfaces/text/borders (vanish
// on a white canvas) and near-black background hexes (black-on-black). This
// guard keeps those files from regrowing the unreadable class. It runs on a
// SEPARATE list from PROTECTED on purpose: the big monolith pages in PROTECTED
// (sniper/collection/analytics) are brand-clean but NOT yet light-ready, so
// neutral-checking them would block the build on out-of-scope debt.
//
// NOT flagged (intentionally narrow): rgba(0,0,0,*) scrims/shadows (fine in
// light) and gray text hexes like #666/#888/#ccc (readable on white) — those
// are a softer later pass. Semantic color literals (tier/status greens, reds,
// golds) are never neutral and never flagged.
const NEUTRAL_PROTECTED = [
  "app/(collections)/layout.tsx",
  "app/(collections)/[collection]/layout.tsx",
  "components/collection-tab-bar.tsx",
  "app/(collections)/[collection]/overview/page.tsx",
  "app/(collections)/[collection]/set/[slug]/page.tsx",
  "app/moment/[id]/page.tsx",
  "app/share/[wallet]/page.tsx",
  "app/share/[wallet]/ShareEmptyState.tsx",
  "app/share/[wallet]/ShareButton.tsx",
  "components/MomentDetailModal.tsx",
  "components/entity/FmvHistoryChart.tsx",
  "components/entity/TeamChecklist.tsx",
  // NOTE: TeamHero.tsx + TeamLogo.tsx are intentionally NOT listed. Their
  // neutral literals (white text/overlays) sit on a TEAM-COLOR gradient/badge
  // and are driven by team-palette contrast (the `dark` prop), not the app
  // theme — tokenizing them to app-theme tokens would invert them in light
  // mode. They are theme-independent by design.
  "components/entity/EditionsGridPaginated.tsx",
  "components/entity/SalesTablePaginated.tsx",
  "components/entity/TeamActivity.tsx",
  "components/entity/TeamSets.tsx",
  "components/entity/TeamSqueeze.tsx",
  "components/entity/_shared.tsx",
  // Light-mode Batch 2 (2026-06-10) — the chrome nav/switcher; cleaned of the
  // Tailwind color-class vocabulary (see TAILWIND_NEUTRAL below).
  "components/TopNav.tsx",
  "components/CollectionSwitcher.tsx",
  // Light-mode Batch 2 (2026-06-13) — dashboard + auth-gated monolith pages
  // swept of inline-style white-alpha + near-black hexes and Tailwind color
  // classes. Theme tokens throughout; shadows (rgba(0,0,0,*)) left as-is.
  "app/dashboard/page.tsx",
  "app/(collections)/[collection]/collection/page.tsx",
  "app/(collections)/[collection]/analytics/page.tsx",
  "app/(collections)/[collection]/sniper/page.tsx",
  "components/packs/PackShareButton.tsx",
  // Light-mode Batch 2 (2026-06-14) — full close of the remaining neutral-class
  // debt: the top-level /analytics dashboard (pages + components), the /packs
  // feature internals, and scattered modals/chrome. Swept of Tailwind neutral
  // classes + inline white-alpha/near-black literals; theme tokens throughout.
  // The /analytics dashboard cluster:
  "app/(analytics)/analytics/layout.tsx",
  "app/(analytics)/analytics/page.tsx",
  "app/(analytics)/analytics/api/page.tsx",
  "app/(analytics)/analytics/wallets/page.tsx",
  "app/(analytics)/analytics/methodology/page.tsx",
  "app/(analytics)/analytics/methodology/[topic]/page.tsx",
  "app/(analytics)/analytics/sales/[collection]/page.tsx",
  "app/(analytics)/analytics/loans/[collection]/page.tsx",
  "app/(analytics)/analytics/sets/[set_id]/page.tsx",
  "app/my-teams/layout.tsx",
  "components/analytics/FmvDashboard.tsx",
  "components/analytics/SetsDashboard.tsx",
  "components/analytics/PacksDashboard.tsx",
  "components/analytics/ListingsDashboard.tsx",
  "components/analytics/WalletProfile.tsx",
  "components/analytics/PulseDashboard.tsx",
  "components/analytics/PositionTransfersCard.tsx",
  "components/analytics/WalletsHubOverview.tsx",
  "components/analytics/LoansDashboard.tsx",
  "components/analytics/EditionGrid.tsx",
  "components/analytics/NetMarketplaceLeaderboard.tsx",
  "components/analytics/InsiderSignals.tsx",
  "components/analytics/LenderPerformanceTable.tsx",
  "components/analytics/FilterBar.tsx",
  "components/analytics/BiggestSales.tsx",
  "components/analytics/MarketplaceMix.tsx",
  "components/analytics/TopBuyers.tsx",
  "components/analytics/LeaderboardTable.tsx",
  "components/analytics/PipelineHealthBadge.tsx",
  "components/analytics/CohortRetention.tsx",
  "components/analytics/RecentWhaleTrades.tsx",
  "components/analytics/SalesDashboard.tsx",
  "components/analytics/ExploreSection.tsx",
  "components/analytics/VolumeChart.tsx",
  "components/analytics/NewWalletsChart.tsx",
  "components/analytics/AnalyticsSidebar.tsx",
  "components/analytics/HealthBar.tsx",
  "components/analytics/ComingSoon.tsx",
  "components/analytics/KpiCard.tsx",
  "components/analytics/AnalyticsBreadcrumb.tsx",
  "components/analytics/WalletIdenticon.tsx",
  // The /packs feature + scattered modals/chrome:
  "components/packs/PackPageClient.tsx",
  "components/packs/PackTable.tsx",
  "components/auth/ConnectButton.tsx",
  "components/BadgeRow.tsx",
  "components/onboarding/WelcomeModal.tsx",
  "components/OnboardingModal.tsx",
  "components/profile/TrophyPickerModal.tsx",
  "app/early-access/page.tsx",
];

// white-alpha, near-black surface rgba (13,13,13 / 8,8,8), and neutral bg/text
// hexes. rgba(0,0,0,*) is deliberately absent (scrims/shadows are allowed).
const NEUTRAL =
  /rgba\(\s*255\s*,\s*255\s*,\s*255\s*,|rgba\(\s*(?:13\s*,\s*13\s*,\s*13|8\s*,\s*8\s*,\s*8)\s*,|#(?:fff(?:fff)?|000(?:000)?|080808|0a0a0a|0d0d0d|111(?:111)?|1a1a1a|1f1f1f|222(?:222)?)\b/i;
// strips `var(--token, <fallback>)` (one level of nested parens for rgba())
const VAR_FALLBACK = /var\(\s*--[a-z0-9-]+\s*,\s*(?:[^()]|\([^()]*\))*\)/gi;

// ── Third literal vocabulary: TAILWIND color classes ─────────────────────────
// Batch 1 swept inline-style and CSS-file neutral literals, but the Tailwind
// color CLASSES (text-white / bg-white/N / border-white / bg-black / text-black)
// are a separate vocabulary that wash out (white) or go black-on-black (black)
// in light mode. Flagged only inside NEUTRAL_PROTECTED so cleaned chrome can't
// regrow them. Semantic class colors (text-emerald-400, bg-red-500/10, etc.)
// are never neutral and never flagged.
//
// Batch 2b (2026-06-13) adds the raw `zinc` palette scale: dark zinc
// backgrounds (bg-zinc-950/900/800) stay dark on a light canvas (dark
// islands) and light zinc text (text-zinc-100..400) washes out on white.
// A fully-tokenized surface carries no raw zinc palette class, so any
// (bg|text|border|divide|ring)-zinc-N in a protected file is a regression.
const TAILWIND_NEUTRAL = /\b(?:text-white|bg-white|border-white|bg-black|text-black|(?:bg|text|border|divide|ring)-zinc-\d+)\b/;

let violations = 0;

for (const file of PROTECTED) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.error(`  ! protected file missing (rename?): ${file}`);
    violations++;
    continue;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!LITERAL.test(line)) continue;
    if (FALLBACK.test(line)) continue;
    // brand-exception on this line or within the 3 preceding lines
    const window = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
    if (/brand-exception/.test(window)) continue;
    console.error(`  ✗ ${file}:${i + 1}  ${line.trim().slice(0, 100)}`);
    violations++;
  }
}

for (const file of NEUTRAL_PROTECTED) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.error(`  ! neutral-protected file missing (rename?): ${file}`);
    violations++;
    continue;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // remove token fallbacks first so var(--x, rgba(255,255,255,…)) is allowed
    const stripped = lines[i].replace(VAR_FALLBACK, "");
    if (!NEUTRAL.test(stripped) && !TAILWIND_NEUTRAL.test(lines[i])) continue;
    const window = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
    if (/brand-exception/.test(window)) continue;
    console.error(`  ✗ ${file}:${i + 1}  ${lines[i].trim().slice(0, 100)}`);
    violations++;
  }
}

if (violations > 0) {
  console.error(
    `\nBrand-token guard FAILED: ${violations} hardcoded literal(s) in a ` +
      `protected surface.\nBrand: use var(--rpc-red) / var(--font-display) / ` +
      `var(--font-mono). Light-mode neutrals: use the surface/text/border ` +
      `tokens, or annotate a genuine theme-independent case (text on a colored ` +
      `hero, SVG/canvas input) with a "brand-exception" comment.`
  );
  process.exit(1);
}

console.log(
  `Brand-token guard: ${PROTECTED.length} brand-protected + ` +
    `${NEUTRAL_PROTECTED.length} light-mode surface(s) clean.`
);
console.log(
  "(Phase-2 debt across the rest of the repo is tracked separately — not gated here.)"
);
