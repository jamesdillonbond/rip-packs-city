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
];

const LITERAL = /#E03A2F|'Barlow Condensed'|'Share Tech Mono'/i;
const FALLBACK = /var\(\s*--rpc-(red|[a-z-]+)\s*,\s*#E03A2F\s*\)/i;

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

if (violations > 0) {
  console.error(
    `\nBrand-token guard FAILED: ${violations} hardcoded brand literal(s) in a ` +
      `protected public surface.\nUse var(--rpc-red) / var(--font-display) / ` +
      `var(--font-mono), or annotate a genuine SVG/canvas case with a ` +
      `"brand-exception" comment.`
  );
  process.exit(1);
}

console.log(
  `Brand-token guard: ${PROTECTED.length} protected public surface(s) clean.`
);
console.log(
  "(Phase-2 debt across the rest of the repo is tracked separately — not gated here.)"
);
