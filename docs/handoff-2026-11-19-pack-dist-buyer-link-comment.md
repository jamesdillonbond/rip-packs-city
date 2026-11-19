# Handoff — pack `/dist/` buyer-link comment is stale (`/analytics/wallets` → `/share`)

**Date:** 2026-11-19 (PT) · **Source:** weekly surface QA (Cowork cloud)
**Priority:** trivial (non-user-facing code comment; zero behavior change)

## Context

Everything in this week's surface QA is green; nothing else needs a code change. This handoff
covers a single stale **code comment** found while verifying the pack `/dist/` Sales-History
buyer links. The docs-only checklist correction already shipped on `main` as `ed7f989e8`
(surface-checklist + ledger). This `.tsx` edit is packaged as a handoff only because the weekly
surface-QA pass does not touch route/`.tsx`/`workers/*` code itself — it is comment-only and needs
no render/test loop.

## Item 1 — correct the stale buyer-link comment

**File:** `app/(collections)/[collection]/pack/dist/[distId]/page.tsx` (verified present; comment at
lines ~2111–2116, immediately above the `BuyerCell`/buyer `<Link href={marketWalletHref(...)}>` at
line ~2127).

**What changes and why.** The comment claims the buyer "renders as a short wallet linking to
`/analytics/wallets/<addr>`". That is no longer true: the buyer link is built by
`marketWalletHref()` (`lib/analytics/wallet-href.ts`), which returns **`/share/<addr>`** (the public
anon-200 Collection Card = the buyer's holdings). `/analytics/wallets/<addr>` is now produced by the
separate `loanWalletHref()` and is the Flowty **loans** view — a different surface. The code is
correct and intentional; only the comment is stale and misleading to the next reader. Verified live
2026-11-19: `/nba-top-shot/pack/dist/4184` buyer links resolve to `/share/0x…` (HTTP 200 anon).

**Exact edit.** Replace the comment block:

```tsx
// ── Pack Sales History (Item 2) ─────────────────────────────────────────────
// Top Purchases (highest price) + Recent Purchases (newest). Buyer renders as a
// short wallet linking to /analytics/wallets/<addr> — the differentiator over
// Top Shot's own drop page, where the buyer is a dead-end name. Coverage is
// partial (the dist bridge only links sales whose pack was later opened), so
// the module carries an explicit caption and an honest empty state.
```

with:

```tsx
// ── Pack Sales History (Item 2) ─────────────────────────────────────────────
// Top Purchases (highest price) + Recent Purchases (newest). Buyer renders as a
// short wallet linking to /share/<addr> via marketWalletHref() — the buyer's
// public Collection Card (holdings), the differentiator over Top Shot's own
// drop page where the buyer is a dead-end name. (/analytics/wallets/<addr> is a
// different surface — the Flowty loans view, loanWalletHref().) Coverage is
// partial (the dist bridge only links sales whose pack was later opened), so
// the module carries an explicit caption and an honest empty state.
```

No other change. `marketWalletHref` and the `<Link>` at ~2127 are already correct — do not touch them.

**Revert:** `git revert` the commit titled "docs(comment): pack /dist/ buyer link goes to /share, not /analytics/wallets".

**Expected verification:** `npx tsc --noEmit` clean (a comment edit cannot change types, but run it per convention); Vercel deploy reaches READY; no smoke behavior change (comment-only). Confirm `git rev-list --count origin/main..HEAD` is 0 after pushing.

## Guardrails

- Commit **direct to `main`**, no branches, no PRs (CLAUDE.md non-negotiable). If a `claude/*` branch
  is pre-checked-out, `git switch main` first.
- On Windows commit via **PowerShell `git`** (Git Bash `git commit` can silently no-op); re-verify
  the push with `git rev-list --count origin/main..HEAD` (expect 0).
- This is comment-only — no `maxDuration`, `curl`, or CRLF hazards apply, but use a full-file write
  or exact-block replace rather than a fragile string patch.
- Expect a ledger conflict only if you add a ledger entry; this handoff does not require one (the fix
  is cosmetic). If you do, re-splice above upstream's newest `^### `, never hand-edit markers.

Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any
disagreement — adapt to the actual file shape.

**End state:** one comment-only commit on `main`, deploy READY, the buyer-link comment matches the
code (`/share/<addr>` via `marketWalletHref`).
