# Handoff 2026-06-10 — light mode: gate the toggle + Batch 1 (the cheap unlock for the whole public corpus)

## Context

Phase 0 shipped in 206818f (theme infra, dark default, toggle VISIBLE). Cowork then live-QA'd light mode in Chrome: /insights renders perfectly (token-clean), but ENTITY PAGES ARE UNREADABLE — near-black light-theme text tokens over hardcoded dark chrome (verified live on /nba-top-shot/edition/2:188: theme=light active, --rpc-text-primary #141414, body white, content invisible). Trevor decision: GATE the toggle until Batch 1 lands.

The measured surprise that re-scopes everything (Cowork grep audit, 2026-06-09): the edition/set/player/team/series PAGES, TopNav, SiteFooter, and the root layout all have ZERO color literals. The entire entity-corpus breakage comes from app/(collections)/layout.tsx — about 5 literal lines. Batch 1 is therefore roughly one session, not a week. This doc supersedes the rollout section of docs/handoff-2026-06-10-light-mode-phased.md (its Phase 0 spec is done; its priority list is replaced by this).

Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape.

## Item 1 — gate the toggle (small, ship first)

Hide the ThemeToggle UI by default; render it only when the URL carries ?theme=light (or a stored rpc_theme_preview flag you set when that param is seen, so the toggle stays available during the preview session). Critical detail: when the gate is CLOSED and localStorage rpc_theme === 'light', the boot script must CLEAR/IGNORE the stored preference (do not apply the attribute) — nobody may be stuck in broken-light from a toggle they hit before the gate (Cowork already reset its own test browser, but the toggle was live for real visitors for a few hours). Keep the boot script synchronous + pre-paint. The requesting user can be pointed at ?theme=light to preview.

Un-gate criterion (your judgment after Batch 1 deploys): entity pages + /moment + /share + /insights all pass a visual check in both themes. The dashboard will still be rough — acceptable for the 13-person beta, or keep the gate until the dashboard batch; flag the choice to Trevor in your report.

## Item 2 — Batch 1 tokenization (per-file literal counts, all verified by grep 2026-06-09)

The alpha-to-token map for rgba(255,255,255,X): 0.03 -> --rpc-surface-raised, 0.06 -> --rpc-surface-hover, ~0.1-0.12 -> the border token (verify its name in rpc-tokens.css), 0.2 -> --rpc-text-ghost, 0.42 -> --rpc-text-muted, 0.55 -> --rpc-text-secondary, >=0.9 -> --rpc-text-primary. Off-map alphas: nearest neighbor, eyeball both themes.

1. app/(collections)/layout.tsx — THE unlock (~5 literal lines, fixes every collection-scoped page at once):
   - L19 wrapper: background "#080808" + color "#fff" -> tokens. #080808 is deeper than --rpc-surface (#0D0D0D); add --rpc-surface-deep (#080808 dark / #FFFFFF or #F2F2F0 light) to BOTH theme blocks in rpc-tokens.css rather than collapsing into --rpc-surface, so the dark render stays byte-identical. color -> var(--rpc-text-primary).
   - L27 input::placeholder rgba(255,255,255,0.25) -> a token (text-ghost or a new --rpc-placeholder).
   - L29-30 scrollbar track #111 -> surface-raised-ish token; thumb stays brand-red-alpha (fine in both themes).
   - L36 .rpc-coll-tab:hover background rgba(255,255,255,0.06) + color #fff -> surface-hover + text-primary.
   - L51 header background rgba(8,8,8,0.97) + border rgba(255,255,255,0.06) -> tokenize (the 0.97-alpha sticky-header needs a light twin, e.g. rgba(247,247,245,0.97) via a --rpc-header-bg token in both blocks).
2. app/moment/[id]/page.tsx — 16 white + 4 dark literals.
3. app/share/[wallet]/page.tsx — 10 dark-bg literals.
4. components/MomentDetailModal.tsx — 14 white + 1 dark.
5. components/entity sprinkle (~26 total): FmvHistoryChart 5 (recharts stroke = documented brand-exception; give it a JS theme lookup off documentElement.dataset.theme or leave dark-tuned), TeamChecklist 5, TeamFollowButton 4, TeamHero 4, EditionsGridPaginated 2, SalesTablePaginated/TeamActivity/TeamLogo/TeamSets/TeamSqueeze/_shared 1 each.
6. Trivial: overview/page.tsx 2, set/[slug]/page.tsx 1.

After each file: verify in BOTH themes, then add it to PROTECTED in scripts/check-brand-tokens.mjs AND extend that script to flag rgba(255,255,255 + the dark-bg literal set (#0a0a/#0d0d/#111/#000/#080808) in protected files — today it only guards red/fonts; verify before extending so the 63/63 baseline doesn't break on annotated exceptions.

Explicitly DEFERRED (do not start): pack/dist page (64 literals), the dashboard monolith, sniper/collection/analytics internals, admin + email HTML (dark-only forever).

## Verification

npx tsc --noEmit clean; brand-token guard green; deploy READY. Visual pass with ?theme=light on: /nba-top-shot/edition/2:188 (the QA case — Iguodala hero + stats readable), a set/player/team/series page, /moment/<any>, /share/<wallet>, /insights/squeeze; and WITHOUT the param confirm dark renders byte-identical everywhere (especially the #080808 -> --rpc-surface-deep swap). Smoke after deploy.

## Revert

Item 1: git revert (gate is additive). Item 2: per-commit reverts; the rpc-tokens.css --rpc-surface-deep addition is inert for dark if values match exactly.

## Guardrails (repeat every handoff)

- Direct-to-main, no branches, no PRs. PowerShell git; verify push with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — PowerShell Invoke-WebRequest.
- maxDuration cap 800s. CRLF: full-file writes or findIndex on split lines.
- Never hardcode #E03A2F / fonts; that rule now extends to neutral literals on cleaned surfaces.
- Ledger the ships with revert paths; note the un-gate decision question for Trevor.

## End state

Toggle gated (no visitor can wedge into broken-light); one session of tokenization makes the entire public/SEO corpus genuinely light-capable; CI holds the line; dark default byte-identical throughout.
