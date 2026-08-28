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

import { readFileSync, readdirSync } from "node:fs";

// Files cleaned in Phase 1 — these MUST stay token-only (minus annotated
// brand-exception lines). Add files here as Phase 2 cleans them.
const PROTECTED = [
  "app/(collections)/[collection]/overview/page.tsx",
  "app/(collections)/[collection]/collection/page.tsx",
  "app/(collections)/[collection]/sniper/SniperClient.tsx",
  "app/(collections)/[collection]/profile/[username]/page.tsx",
  "app/(collections)/[collection]/analytics/page.tsx",
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
  // Phase 2 — Batch 2 (onboarding / paywall / pro / profile modals)
  "components/onboarding/FirstRunTour.tsx",
  "components/PaywallModal.tsx",
  "components/UpgradePrompt.tsx",
  "components/auth/ProBadge.tsx",
  "components/pricing/StripeSubscribeButton.tsx",
  "components/ExplainButton.tsx",
  "components/profile/TrophyPickerModal.tsx",
  "components/profile/PublicAchievements.tsx",
  "components/profile/_shared.ts",
  // Phase 2 — Batch 3 (dashboard, auth-gated)
  "app/dashboard/page.tsx",
  "app/dashboard/packs/page.tsx",
  "app/dashboard/notifications/page.tsx",
  "app/dashboard/alerts/page.tsx",
  "app/dashboard/api-keys/page.tsx",
  // Phase 2 — Batch 4 (shared components + layouts + game features)
  "components/SupportChat.tsx",
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
  // Phase 2 — Batch 6 (the auth funnel, 2026-08-16). These three were invisible
  // to the client-page ratchets until the directive detector was fixed, and the
  // sweep that followed found the email accent leaking into two of them.
  //
  // ⚠ Repointed `page.tsx` -> `*Client.tsx` when the three were converted for
  // the component coverage gate. This list is CURATED, so it cannot self-heal —
  // but it does fail LOUDLY (a missing entry counts a violation, see the
  // readFileSync catch below) rather than silently dropping the file, which is
  // what makes repointing a forced step instead of an easily-forgotten one.
  "app/login/LoginClient.tsx",
  "app/early-access/EarlyAccessClient.tsx",
  "app/auth/confirm/AuthConfirmClient.tsx",
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
  "app/(collections)/[collection]/sniper/SniperClient.tsx",
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
  "components/analytics/KpiCard.tsx",
  "components/analytics/AnalyticsBreadcrumb.tsx",
  "components/analytics/WalletIdenticon.tsx",
  // The /packs feature + scattered modals/chrome:
  "components/packs/PackPageClient.tsx",
  "components/packs/PackTable.tsx",
  "components/profile/TrophyPickerModal.tsx",
  "app/early-access/EarlyAccessClient.tsx",
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

// ── Email accent must not leak into web UI (2026-08-16) ────────────────────
// #E55A4C is the RPC *email* accent. It is hardcoded on purpose in email HTML
// (lib/emails/**, lib/alerts/format.ts, the alert/subscribe API routes) because
// email clients do not support CSS custom properties at all — var(--rpc-red)
// would render as nothing. `__tests__/welcome-email.test.ts` pins it there.
//
// On a RENDERED WEB SURFACE it is simply the wrong red: the web brand red is
// #E03A2F (var(--rpc-red) / var(--por-red)), so the two differ visibly. Found
// on `app/auth/confirm/page.tsx` (the magic-link landing — 3 sites, including
// the spinner) and `app/login/page.tsx`, while `login` used var(--por-red) for
// the SAME role a few lines away.
//
// ⚠ Scoped by FILE KIND, not by a list, and that is deliberate. Measured
// 2026-08-16 the web population is ZERO repo-wide, so this is a ban with no
// allowlist — and it WALKS THE TREE rather than iterating PROTECTED, because a
// guard that derives its inputs from a curated list is silent about every file
// outside it by construction. That is the exact failure this repo keeps paying
// for; the first draft of this very check had it. A blanket ban on the literal
// would instead fire on all seven legitimate email uses, hence the kind filter.
const EMAIL_ACCENT = /#e55a4c|rgba?\(\s*229\s*,\s*90\s*,\s*76\b/i;
const WEB_SURFACE = /^components\/.*\.tsx$|(?:^|\/)(?:page|layout)\.tsx$|Client\.tsx$/;
// ⚠ ALL of components/** counts, not just *Client.tsx — an ordinary component
// renders the same pixels. Narrowing this to page/layout/*Client was a real
// gap, and the first version of the test PINNED it by asserting false.

/**
 * Blank out // line comments, preserving line numbers.
 *
 * ⚠ Deliberately does NOT strip block comments with a regex. On this repo a
 * "//" comment mentioning a glob path opens a fake block that a naive
 * block-comment regex closes hundreds of lines later, blanking real code —
 * measured at 109k characters hidden across 55 files (register R42). Line
 * comments are all this guard needs and cannot have that failure mode.
 */
function stripLineComments(src) {
  return src
    .split("\n")
    .map((line) => {
      const i = line.indexOf("//");
      if (i < 0) return line;
      if (i > 0 && line[i - 1] === ":") return line; // don't cut inside https://
      return line.slice(0, i);
    })
    .join("\n");
}


/** Every rendered web file under app/ and components/ (email HTML lives in lib/ and app/api/). */
function webSurfaceFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (dir === "app" && e.name === "api") continue; // route tree: email HTML lives here
      webSurfaceFiles(full, out);
    } else if (e.name.endsWith(".tsx") && WEB_SURFACE.test(full)) {
      out.push(full);
    }
  }
  return out;
}

let violations = 0;

// PROTECTED is still read, but ONLY as a rename detector — a curated list is a
// fine tripwire for "did one of these files move?" and a terrible input set for
// a ban.
for (const file of PROTECTED) {
  try {
    readFileSync(file, "utf8");
  } catch {
    console.error(`  ! protected file missing (rename?): ${file}`);
    violations++;
  }
}

// ── LITERAL check: WALKS THE TREE (deep-audit R37) ──────────────────────────
// This loop used to iterate PROTECTED — 54 curated paths — while the email-accent
// check below it walked the tree and carried a comment explaining exactly why a
// curated list is wrong. The guard argued against its own first half.
//
// A curated list is silent BY CONSTRUCTION about every file outside it, so a new
// page hardcoding the brand red stayed invisible until someone remembered to add
// it. Measured 2026-08-22: the walk covers 399 web surfaces against 54 listed,
// and the real violation count OUTSIDE the list was 3 — small, which is exactly
// why it could sit there indefinitely with nobody noticing the scope gap.
//
// ⚠ COMMENTS ARE STRIPPED FIRST. One of those 3 was ConsoleGreeting's own comment
// DESCRIBING the sanctioned hardcode. At least six guards here have fired on the
// comment documenting the thing they check, and a guard that reddens on its own
// documentation teaches people to delete the documentation.
const LITERAL_SURFACES = [...webSurfaceFiles("app"), ...webSurfaceFiles("components")];
if (LITERAL_SURFACES.length === 0) {
  console.error("  ! brand-literal guard found no web surfaces to scan (walk broken?)");
  violations++;
}
for (const file of LITERAL_SURFACES) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const scan = stripLineComments(text).split(/\r?\n/);
  const raw = text.split(/\r?\n/);
  for (let i = 0; i < scan.length; i++) {
    if (!LITERAL.test(scan[i])) continue;
    if (FALLBACK.test(scan[i])) continue;
    // brand-exception on this line or within the 6 preceding lines — read from
    // the RAW text, because the marker itself lives in a comment.
    //
    // ⚠ Widened 3 → 6 (R37). Three lines is too tight for a real annotation: a
    // multi-argument console.log or a JSX prop block routinely puts the literal
    // 4+ lines below the comment that justifies it, so the guard fired on a
    // correctly-annotated exception and the only ways out were to contort the
    // comment or delete it. A guard whose escape hatch is impractical gets
    // worked around, not obeyed.
    const window = raw.slice(Math.max(0, i - 6), i + 1).join("\n");
    if (/brand-exception/.test(window)) continue;
    console.error(`  \u2717 ${file}:${i + 1}  ${(raw[i] || "").trim().slice(0, 100)}`);
    violations++;
  }
}

const webSurfaces = [...webSurfaceFiles("app"), ...webSurfaceFiles("components")];
if (webSurfaces.length === 0) {
  console.error("  ! email-accent guard found no web surfaces to scan (walk broken?)");
  violations++;
}
for (const file of webSurfaces) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  // ⚠ Comments stripped here for the same reason as the LITERAL check above
  // (R37): a comment EXPLAINING why the email accent differs from the web red
  // is not a use of it. This guard fired on exactly such a comment while that
  // comment was being written — the documented failure, reproduced live.
  const lines = stripLineComments(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!EMAIL_ACCENT.test(lines[i])) continue;
    console.error(
      `  \u2717 ${file}:${i + 1}  email accent #E55A4C in web UI — use var(--rpc-red)`
    );
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
  `Brand-token guard: ${LITERAL_SURFACES.length} web surface(s) scanned for brand literals ` +
    `(${PROTECTED.length} tracked for renames) + ` +
    `${NEUTRAL_PROTECTED.length} light-mode surface(s) clean.`
);
console.log(
  "(Phase-2 debt across the rest of the repo is tracked separately — not gated here.)"
);
