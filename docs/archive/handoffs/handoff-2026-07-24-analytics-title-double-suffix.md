# Handoff — analytics detail pages render a doubled `Rip Packs City` in `<title>` (LOW / Trevor's call)

> **LANDED 2026-07-25 (Claude Code).** The four **Core** edits above are shipped
> to `main` (see the `docs/overnight/ledger.md` 2026-07-25 entry for the sha +
> revert path). The **Optional** `notFound`-fallback edits were deliberately NOT
> applied — the prior ledger decision accepting those still stands.
>
> **"Also verify" resolved — no change needed.** `lib/seo.ts:163-198`
> (`COLLECTION_LAYOUT_META`) does bake `— Rip Packs City` into a plain-string
> title consumed by `collectionLayoutMetadata`, but every collection tab page
> supplies its own `generateMetadata`, which shadows the layout title. Verified
> live: `/nba-top-shot/overview` → "NBA Top Shot Value — FMV, Floor Prices &
> Market Pulse", `/nba-top-shot/sniper` → "Sniper — NBA Top Shot Deals Below
> FMV", `/nba-top-shot/collection` → "Wallet Analytics — Track Your NBA Top Shot
> Collection Value" — one brand suffix each, no doubling. So the baked brand in
> those constants never reaches a rendered `<title>` and stripping it would be
> churn. Left as-is.
>
> **Also observed (not part of this handoff):** `/analytics/*` returns **307** to
> anonymous requests, so these pages are not actually crawlable today — the fix
> is still correct, just lower-impact than "indexable" implies.

**Date:** 2026-07-24 · **Source:** weekly `rpc-surface-qa` (Part 2/4, live-page + SEO QA) · **HEAD seen:** `4b15a332` (main)

## Context

Cowork shipped nothing live for this item (no migration / edge fn) — it is pure route/`.tsx` metadata, so it needs Claude Code. This handoff covers **one LOW-severity SEO defect**: several **indexable** `/analytics/*` detail pages emit a `<title>` with the brand name twice — `… — Rip Packs City | Rip Packs City`.

**Read the ledger note first (line ~2626):** a prior session already **accepted** the doubled title *for `notFound` pages* — *"notFound doubled-title cosmetic = accepted (pages already noindex; fix has whole-site title-template blast radius for 0 SEO gain)."* **This handoff is deliberately NOT that.** It targets the **200-status, sitemap'd, index,follow success pages** (sales / loans / methodology / wallets analytics), which that decision did not cover — and it proposes a **surgical per-page fix that does NOT touch the site-wide title template**, so the "whole-site blast radius" concern that drove the prior accept does not apply here. The `notFound` fallbacks stay accepted (left as-is) per that ledger entry.

## Root cause (verified)

- `lib/seo.ts:19` sets the site-wide `title.template: '%s | Rip Packs City'`. Next.js appends it to any child page that returns a **plain string** `title`.
- Entity pages (`edition`/`set`/`player`/`team`) and `profile`/pin pages render a single suffix because they return `title: { absolute: … }` (see the "2026-06-07 pin-page fix" comment in `app/profile/[username]/layout.tsx:60`).
- Insights boards render a single suffix because their title string does **not** contain the brand (template adds it once).
- The `/analytics/*` parameterized pages do **both wrong**: they bake `— Rip Packs City` / `· Rip Packs City` into a plain string title **and** inherit the template → the brand prints twice. There is no `(analytics)/layout.tsx` overriding this (verified: none exists).

**Confirmed live 2026-07-24 (each `<title>` contains "Rip Packs City" ×2):**

```
/analytics/sales/topshot        → NBA Top Shot Sales Analytics — Rip Packs City | Rip Packs City
/analytics/loans/topshot        → NBA Top Shot Loan Analytics — Rip Packs City | Rip Packs City
/analytics/methodology/fmv      → FMV Methodology — Rip Packs City | Rip Packs City
/analytics/wallets/0xbd94…50ac  → jamesdillonbond — Flowty Loan Profile (Historical) · Rip Packs City | Rip Packs City
```

All return HTTP 200 and render correctly — this is a `<title>`-tag / SERP quality issue only, not a functional break.

## The fix — drop the baked-in brand from the analytics title strings (template supplies it once)

This matches how the insights boards already work and leaves `lib/seo.ts:19` untouched (no blast radius). Apply as exact single-line string replacements (all are single lines → CRLF-safe; do not patch multi-line). **Grep-verified these lines exist at `4b15a332`.**

### Core (indexable success-path titles — recommended)

**`app/(analytics)/analytics/wallets/[address]/page.tsx`** L141
```
- title: `${display} — Flowty Loan Profile (Historical) · Rip Packs City`,
+ title: `${display} — Flowty Loan Profile (Historical)`,
```

**`app/(analytics)/analytics/loans/[collection]/page.tsx`** L90
```
- title: `${cfg.label} Loan Analytics — Rip Packs City`,
+ title: `${cfg.label} Loan Analytics`,
```

**`app/(analytics)/analytics/sales/[collection]/page.tsx`** L85
```
- title: `${cfg.label} Sales Analytics — Rip Packs City`,
+ title: `${cfg.label} Sales Analytics`,
```

**`app/(analytics)/analytics/methodology/[topic]/page.tsx`** L31
```
- title: `${entry.title} — Rip Packs City`,
+ title: entry.title,
```

### Optional (consistency — the invalid-param / not-found fallbacks in the same files)

The prior ledger decision accepts leaving `notFound`-class doubled titles; these are noindex/edge cases. Align only if you want consistency (same trivial edit — strip ` — Rip Packs City`):
- `wallets/[address]/page.tsx` L101 `"Wallet — Rip Packs City"` → `"Wallet"`; L105 `"Wallet not found — Rip Packs City"` → `"Wallet not found"`
- `loans/[collection]/page.tsx` L86 `"Loan analytics — Rip Packs City"` → `"Loan analytics"`
- `sales/[collection]/page.tsx` L81 `"Sales analytics — Rip Packs City"` → `"Sales analytics"`
- `methodology/[topic]/page.tsx` L25 `"Methodology — Rip Packs City"` → `"Methodology"`
- `sets/[set_id]/page.tsx` L109 & L113 `"Set not found — Rip Packs City"` → `"Set not found"` (this page's **success** title at L120 is already brand-free / correct — leave it)

### Also verify (not confirmed this run)

`lib/seo.ts:165–185` defines static collection-analytics title constants that also bake `— Rip Packs City` (e.g. `'NBA Top Shot Analytics — Rip Packs City'`). If any live surface returns one of those as a plain string title it will double too; check the consumer and, if so, strip the brand there as well. Claude Code's direct inspection wins — confirm before editing.

## Guardrails (per CLAUDE.md — repeat every handoff)

- Commit **directly to `main`** — no branches, no PRs. If a `claude/*` branch is pre-checked-out, `git switch main` first.
- Commit via **PowerShell `git`** on Windows (Git Bash `git commit` can silently no-op). Re-verify the push with `git rev-list --count origin/main..HEAD` (expect `0`).
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest` if forcing a redeploy.
- Vercel Pro `maxDuration` hard cap is **800s** (n/a here, but never raise above it).
- CRLF: these are all **single-line** string edits — safe to string-replace; do not attempt multi-line patches.
- **Log this to `docs/overnight/ledger.md`** (append-at-top, re-read from disk first) with the revert path when shipped.

## Revert

Single commit → `git revert <sha>`. No DB/migration/env involvement.

## Verification

- `npx tsc --noEmit` clean.
- Push to `main`, Vercel deploy reaches **READY** (this is a real `.tsx` change, so the build is not skipped).
- Re-check each URL's `<title>` now contains `Rip Packs City` exactly once, e.g. `NBA Top Shot Sales Analytics | Rip Packs City`. Quick check in the browser console on any of the pages:
  ```js
  (document.title.match(/Rip Packs City/g) || []).length // expect 1
  ```
- Smoke test (`smoke-tests.yml`) still green.

---

Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.

**Expected end state:** one commit on `main`, deploy READY, and the four indexable `/analytics/*` detail-page titles show a single `Rip Packs City` suffix (the doubled `notFound` fallbacks remain accepted per the ledger unless the optional edits are also applied).
