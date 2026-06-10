# Handoff 2026-06-10 — light mode: last two fixes, then UN-GATE the toggle

## Context

Batch 1 (4dd98ba) shipped and Cowork ran the live visual QA through the ?theme=light preview gate: /share is flawless, edition pages fully readable (the layout tokenization fixed the black-on-black class), /insights clean, even the 404 page renders right. Exactly THREE residuals remain, all found and located below — after items 1-2 deploy and pass an eyeball check, un-gate the toggle (Item 3; Trevor-endorsed direction from the QA review: the still-rough dashboard is auth-gated and acceptable for the ~13-person beta; dashboard tokenization rides a later batch).

Discovery worth keeping: the repo has THREE literal vocabularies — inline-style values, CSS-file values, and TAILWIND COLOR CLASSES (text-white/bg-white etc.). The first two were swept in Batch 1; the Tailwind class vocabulary is what slipped through (14 files repo-wide, only TopNav in the public corpus).

Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape.

## Item 1 — TopNav nav links (3 Tailwind class strings, verified at ~L62-69)

components/TopNav.tsx renders the main nav links with Tailwind color classes that wash out on a light header. Swap to arbitrary-value token classes (Tailwind 4 supports them) or, if any of these don't compile cleanly, an equivalent inline-style/className approach — the requirement is token-driven color, not a specific syntax:

- active My Teams: text-white bg-[var(--rpc-red)]/15  ->  text-[color:var(--rpc-text-primary)] bg-[var(--rpc-red)]/15
- active default: text-white bg-white/5  ->  text-[color:var(--rpc-text-primary)] bg-[color:var(--rpc-surface-hover)]
- inactive: text-white/55 hover:text-white hover:bg-white/5  ->  text-[color:var(--rpc-text-secondary)] hover:text-[color:var(--rpc-text-primary)] hover:bg-[color:var(--rpc-surface-hover)]

The Analytics text-emerald-400 is fine in both themes — leave it.

## Item 2 — CollectionSwitcher pills (3 literals, verified L67/72/73)

components/CollectionSwitcher.tsx (111 lines): the inactive collection pills are near-invisible in light. Swap:
- L67 border "1px solid rgba(255,255,255,0.08)" -> 1px solid var(--rpc-border-subtle) (token exists; verify its dark value ~matches 0.08 white-alpha so dark stays visually identical)
- L72 hover text rgba(255,255,255,0.4) -> var(--rpc-text-muted)
- L73 inactive text rgba(255,255,255,0.2) -> var(--rpc-text-ghost)
Active pills use col.accent — theme-independent, leave.

Then add BOTH files to the NEUTRAL_PROTECTED list in scripts/check-brand-tokens.mjs, and extend the guard to also flag the Tailwind class patterns (text-white, bg-white/, border-white, bg-black, text-black) in protected files — that closes the third vocabulary so it can't regrow on cleaned surfaces. Verify the guard still passes its current baseline before committing.

## Item 2b (optional polish, 1 line) — wordmark contrast

--rpc-red-muted (rgba(224,58,47,0.5)) is not overridden in the [data-theme="light"] block, so the @RIPPACKSCITY wordmark + rpc-red-muted borders read pale on white. If it bothers the eye: add --rpc-red-muted: rgba(224,58,47,0.65) to the light block only. Skip if it looks fine.

## Item 3 — UN-GATE (after 1-2 are live and eyeballed)

Restore the always-visible ThemeToggle and make the boot script honor localStorage rpc_theme === 'light' directly again (no preview flag required). Keep ?theme=light harmless (it can simply set rpc_theme). Remove or no-op the rpc_theme_preview plumbing — simplest correct shape wins, it's yours from 4dd98ba. Dark remains the default for unset values, OS preference stays ignored.

Eyeball before un-gating (with ?theme=light): /nba-top-shot/edition/2:188 header — nav links readable, pills readable; one team page; /share/0xbd94cade097e50ac. Then un-gate, deploy, and re-eyeball the same set WITHOUT the param after toggling on a fresh profile.

## Verification

npx tsc --noEmit clean; brand-token guard green (63 brand + 18+2 neutral + Tailwind patterns); deploy READY; smoke green. Ledger the un-gate with: revert path (git revert the un-gate commit re-gates instantly), the known-rough surfaces in light (dashboard, sniper/collection/analytics internals, pack-dist), and the later-batch pointer (those + the remaining ~13 Tailwind-class files).

## Guardrails (repeat every handoff)

- Direct-to-main, no branches, no PRs. PowerShell git; verify push with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — PowerShell Invoke-WebRequest.
- maxDuration cap 800s. CRLF: full-file writes or findIndex on split lines.
- Dark must render byte-identical throughout — that's the regression bar for every swap above.

## End state

One small commit (+ the un-gate commit) on main, deploy READY: the toggle is live for everyone, dark default untouched, the public corpus genuinely light-capable, the requesting user gets their feature, and the CI guard now covers all three literal vocabularies on cleaned surfaces.
