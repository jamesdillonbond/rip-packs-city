# Handoff 2026-06-13 — Light-mode batch 2b (visual-QA residuals)

Cowork ran a live visual QA of `ce3d2d3` (light-mode batch 2) on production through the owner's logged-in session (`?theme=light` preview, deploy `7PNv53d`/ce3d2d3 READY). Token-greps + the CI guard passed, but rendering the auth-gated pages surfaced two residual dark panels the greps can't see. **Dashboard ✅ and Sniper ✅ are clean.** Two surfaces need a follow-up.

## Finding 1 — `/[collection]/collection` (My Collection): wallet stat band still dark
Below the four FMV KPI cards (those are clean), the wallet-summary ribbon renders on a hardcoded near-black background — an island of dark on the white page with low-contrast labels:
- The source-count row: **"FROM PACKS 6,987 · FROM MARKET 6,643 · REWARDS 312"** (counts are colored/visible, but the labels + band bg are dark).
- The cost-basis summary row directly under it: **"Cost Basis · Current FMV · P&L −69,725.24 (−62%) · wallet-wide totals"** — text is dark-on-dark, barely legible.

Fix: tokenize that band/ribbon's background → `var(--rpc-surface)` (or `--rpc-surface-raised`) and its labels → `var(--rpc-text-secondary)`; keep the accent-colored numbers (teal/orange/red P&L) as-is. It's almost certainly one component (the wallet cost-basis / acquisition-source ribbon). Grep `collection/page.tsx` for the cost-basis / "FROM PACKS" / "wallet-wide totals" block and the dark bg literal feeding it.

## Finding 2 — `/[collection]/analytics` (Portfolio/Market): KPI hero cards + leaderboard tables dark, hero numbers invisible
The four headline cards — **ORDER BOOK DEPTH, FMV HEALTH ($194.2k), PACK EV (1,192 packs), LOANS BOOK (157 offers)** — render with dark card backgrounds in light mode, and their large hero numbers are a **dark token on the dark card → effectively invisible** (`$194.2k`, `1,192`, `157` are barely readable; the secondary rows like MEDIAN ASK / AVG RATIO / AVG APR are lighter and OK). The **TOP BUYERS (30D)** and **TOP SELLERS (30D)** tables below also render on dark backgrounds.

This looks like the "theme-independent dark data-viz chrome" the batch-2 commit deliberately left — but the **hero numbers being dark-on-dark is a genuine readability bug**. Fix options: (a) tokenize these card backgrounds to a light surface like the other KPI cards, OR (b) if the dark-panel look is intentional, force the hero numbers + labels to a LIGHT token (`var(--rpc-text-primary)` ≈ white in dark-panel context) so they're legible. The recharts SVG strokes/heatmap can stay dark; it's the card chrome + headline text + the buyers/sellers tables that need the contrast pass. Grep `analytics/page.tsx` for the Order Book Depth / FMV Health / Pack EV / Loans Book card wrappers and the Top Buyers/Sellers table containers.

## Passing (no action)
- `/dashboard` — clean: white cards, dark readable text, tier labels + FMV legible, trophy-case tiles correct (moment art is inherently dark = content, not chrome).
- `/[collection]/sniper` — clean: filters, deal table, badges, branded thumbnail placeholders all readable.

## Method note
Verified on the live deploy via `?theme=light` (sets the preview cookie; persists across nav). These are render-only contrast issues — invisible to `scripts/check-brand-tokens.mjs` because the offending values may be tokenized-but-wrong-token (dark token on a dark panel) or a dark bg on a container the guard doesn't cover. After fixing, extend the guard to the cleaned containers and re-QA both pages in light.
