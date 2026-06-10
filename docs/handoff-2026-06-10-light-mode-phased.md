# Handoff 2026-06-10 — light mode (user-requested): phased build, dark stays default

## Context

User feedback: add an optional LIGHT mode toggle; DARK remains the default (Trevor decision 2026-06-09, phased-build approach approved). Measured starting point (Cowork, 2026-06-09): the token layer in app/rpc-tokens.css is solid (surface/text/border/shadow tokens centralized) but 106 files carry hardcoded rgba(255,255,255,...) literals and 43 carry hardcoded dark-bg literals — so a token flip alone looks broken on un-tokenized surfaces. This build therefore rides on, and retires, the tracked brand-token Phase-2 debt, surface by surface. The CI guard scripts/check-brand-tokens.mjs already exists with a PROTECTED list designed for exactly this incremental expansion (verified: 6 surfaces protected today).

No DB work anywhere in this handoff. Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shapes.

## Phase 0 (one commit) — theme infrastructure, invisible by default

1. app/rpc-tokens.css — add a [data-theme="light"] override block AFTER the existing :root block, overriding ONLY the neutral tokens (keep --rpc-red and the fonts untouched). Starting palette (tune by eye):
   --rpc-surface: #F7F7F5; --rpc-surface-raised: rgba(0,0,0,0.04); --rpc-surface-hover: rgba(0,0,0,0.07);
   --rpc-text-primary: #141414; --rpc-text-secondary: rgba(0,0,0,0.62); --rpc-text-muted: rgba(0,0,0,0.45); --rpc-text-ghost: rgba(0,0,0,0.28);
   borders/shadows: flip white-alpha borders to black-alpha; soften shadows (the current ones assume dark).
   Also add color-scheme: dark on :root and color-scheme: light in the light block (fixes native scrollbars/inputs).
2. No-flash boot: inline <script> in the ROOT app/layout.tsx <head> (before paint) that reads localStorage 'rpc_theme' and sets document.documentElement.dataset.theme ONLY if it equals 'light'. Default (unset/anything else) = dark = no attribute. Do NOT consult prefers-color-scheme — dark is the product default regardless of OS.
3. ThemeToggle client component (sun/moon icon button, brand-tokened): toggles the attribute + persists 'rpc_theme'. Mount it in TopNav (compact icon next to the existing right-side controls) — verify TopNav's actual shape first; if it's crowded on mobile, the SiteFooter bottom strip is the fallback placement.
4. generateMetadata/themeColor: if a <meta name="theme-color"> exists anywhere, make it theme-aware or leave dark — check, don't assume.

Ship Phase 0 with the toggle VISIBLE — early adopters see correct light rendering on tokenized surfaces and rough edges on un-tokenized ones, which is acceptable for a beta with ~2 WAU and creates the punch list for Phase 1. (If it looks too rough on the dashboard, gate the toggle behind a ?theme=light query param until Phase 1 covers it — CC judgment call after eyeballing.)

## Phase 1+ (one commit per surface batch) — tokenize in priority order

For each surface: replace rgba(255,255,255,X) literals with the matching --rpc-text-*/--rpc-surface-* token (map by alpha: 0.03→surface-raised, 0.06→surface-hover, ~0.1→--rpc-border (verify the border token name in the file), 0.2→text-ghost, 0.42→text-muted, 0.55→text-secondary, ≥0.9→text-primary), replace dark-bg literals (#0a0a0a/#0D0D0D/#111/#000) with --rpc-surface (or a new --rpc-surface-deep token if a distinct deeper layer is genuinely used), verify in BOTH themes, then add the file to PROTECTED in scripts/check-brand-tokens.mjs and extend that script to also flag rgba(255,255,255 + the dark-bg literal set in protected files (today it only guards red/fonts — verify before extending).

Priority order (public/SEO first, admin last-or-never):
1. The already-PROTECTED 6 (overview, collection, sniper, profile, analytics, +1 — read the list) — they're red/font-clean but may still hold neutral literals; finish them.
2. Entity pages (edition/set/player/team/series/pack + components/entity/*), moment page, /share, /insights/* boards, login/early-access.
3. Dashboard (the 1,750-line monolith — biggest single chunk), packs/simulator, market.
4. Sets, badges, fast-break/RTR.
5. Admin + email HTML: explicitly OUT of scope — dark-only forever is fine; document that in the file header of check-brand-tokens.mjs.

Known per-theme special cases (annotate brand-exception where a var() genuinely can't resolve):
- The documented SVG exceptions: Sparkline polyline stroke, analytics MARKETPLACE_COLOR recharts Cell fills, FmvHistoryChart stroke — recharts presentation attrs can't read CSS vars; give them a tiny JS theme lookup (read documentElement.dataset.theme) or leave dark-tuned + acceptable in light.
- rpc-holo-* shimmer overlays + the CRT scanline overlay use white-alpha gradients tuned for dark — in the light block either re-tune alphas or disable (display:none) the scanlines; eyeball.
- OG images (/api/og/*) and email HTML stay dark-branded — out of scope, they're not theme-bound.

## Acceptance

- Fresh visitor: dark, byte-identical to today, zero flash.
- Toggle → light: persists across reloads + navigations, no flash either direction.
- Each Phase-1 surface renders correct contrast in both themes; CI guard prevents literal regrowth on cleaned surfaces.
- npx tsc --noEmit clean per commit; smoke green; deploys READY.

## Revert

Phase 0: git revert the commit (toggle + tokens are additive; no behavior change for default users). Phase 1 commits: independent per-surface reverts.

## Guardrails (repeat every handoff)

- Direct-to-main, no branches, no PRs. PowerShell git; verify push with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — PowerShell Invoke-WebRequest.
- maxDuration cap 800s. CRLF: full-file writes or findIndex on split lines.
- Never hardcode #E03A2F / font literals — this whole handoff is the enforcement of that rule's neutral-color sibling.
- Ledger each phase with revert path. Smoke test after each deploy.

## End state

Dark-default unchanged for everyone; a persistent, flash-free light toggle; the brand-token Phase-2 debt retired on every user-facing surface as a side effect, with CI holding the line behind each cleaned file.
