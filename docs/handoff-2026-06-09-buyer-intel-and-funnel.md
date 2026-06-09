# Roadmap + handoff — buyer-side intelligence (A), market-structure (B), funnel (C) — 2026-06-09

Follow-through on "do all of it" after the buyer/execution-account fix landed. Two parallel audits (buyer-side analytics, funnel) drove this. **Cowork shipped the safe DB piece; the rest is clean CC route/UI work + two product calls for Trevor.**

## Status at a glance

- **A — Buyer-side intelligence:** the buyer fix already lights up the generic sales leaderboard + BiggestSales (buyer cells populate); the `flowty_top_*` RPCs stay correctly blind (Flowty historical hub). **Shipped from Cowork:** a new `get_top_accumulators` RPC (service_role-only, verified) with a "sweep" signal. **CC:** a `/api/analytics/top-buyers` route + `TopBuyers` component + mount + partial-data guard. Compounds with the username resolver (→ @handles).
- **B — Market-structure monitoring:** already covered — `v_sale_execution_accounts` (live) + the weekly `rpc-flow-ecosystem-watch` task profiles execution accounts for new venues. Finding: ~100% of buyer-resolved TS sales route through Dapper's custodial pair (`0x18eb`/`0xead`), so a "venue mix" product surface is **deferred** until a non-Dapper venue appears. No new build — it's an early-warning asset, working.
- **C — Funnel:** the wallet-paste funnel is **already largely built** (homepage public + wallet-search → `/share/<wallet>`; `/insights/tc-report?wallet=` and `/squeeze-check` public). The gap is refinements, biggest = unindexed wallets dead-end. **CC:** a public indexing trigger + a couple of cross-links. **Two product calls for Trevor below.**

---

## A — Buyer-side intelligence

### Shipped from Cowork (live, verified)
`get_top_accumulators(p_collection_slug text='nba_top_shot', p_days int=7, p_limit int=25)` — migrations `audit_20260609_get_top_accumulators_rpc` + `_revoke_public`. Returns `rank, buyer_address, buy_count, spend_usd, avg_price_usd, distinct_editions, top_edition_id, top_edition_buys`. SECDEF/STABLE, **service_role-only** (PUBLIC revoked — verified grantees = postgres+service_role). `top_edition_buys` is the accumulation/sweep tell (how many of one edition a buyer swept). Verified live: real accumulators surface (a $4,555/14-edition buyer; an 84-buy/59-edition sweeper).

### What already lights up (no work)
- `analytics_sales_leaderboard('buyer', …, ['topshot'], …)` → returns TS buyers now (no marketplace filter). Powers the per-collection `WhaleLeaderboard` (`/nba-top-shot/analytics`) + `SalesDashboard`.
- `BiggestSales` (`components/analytics/BiggestSales.tsx` ← `analytics_sales_top_moves`) — buyer cells populate for resolved rows (were always "—").
- `get_whale_watch_7d` works for TS — but `components/WhaleWatch7d.tsx` is **built and unmounted**.

### Still correctly blind (leave alone)
`flowty_top_buyers/_sellers/_net_marketplace` are hard-filtered `marketplace='flowty'` — the Flowty loan-book historical hub (`/analytics/wallets`). Do NOT repoint these at TS.

### CC handoff (route + UI, read-only)
1. **`app/api/analytics/top-buyers/route.ts`** — thin wrapper over `get_top_accumulators` (params `collection`, `days` 7/30, `limit`), mirroring `app/api/analytics/sales/leaderboard/route.ts`: `supabaseAdmin.rpc` via `rpcWithRetry`, then `resolveUsernames(rows.map(r=>r.buyer_address))` + `displayName` so it ships **@handles**. Resolve `top_edition_id` → player/set via a small `editions` join for display. `s-maxage=600`.
2. **`components/analytics/TopBuyers.tsx`** — table: rank, wallet (`UserLabel`/`useResolveUsernames`, link `/analytics/wallets/[addr]`), buys, spend, avg, distinct editions, and a "Sweeping: {player} ×{n}" cell when `top_edition_buys ≥ 3`. Wire through `useResolveUsernames` exactly like `WhaleWatch7d`/`BiggestSales`.
3. **Mount** on `/nba-top-shot/analytics` (beside `WhaleLeaderboard`); optionally finally mount the orphaned `WhaleWatch7d`.
4. **Partial-data guard (required):** buyer coverage is ~6.6% of 30d (last ~48h, backfill draining), so default the window to **7d** (where the data lives), show a "buyer coverage is filling in — last ~48h" caption, and **suppress any "new vs returning buyer" badge on TS** (the prior-window is too short → false "all first-time" artifact).

---

## B — Market-structure monitoring (no build; documented)

`v_sale_execution_accounts` is live and the weekly `rpc-flow-ecosystem-watch` task already profiles payer/proposer accounts for new venues. Current state: one row — Dapper's custodial pair `0x18eb4ee6b3c026d2` / `0xead892083b3e2c6c`, ~all buyer-resolved TS volume. So dapper.market and the nbatopshot.com app share settlement accounts; the monitor flags a **non-Dapper** venue appearing (the early-warning that was missing), but can't split the two Dapper front-ends. A public "venue mix" insight is deferred — it's a one-liner ("it's all Dapper") until that changes. Nothing to ship.

---

## C — Funnel (mostly built; refinements + 2 product calls)

### Already live (no work)
Homepage `/` is public with a wallet-search box → `/share/<wallet>` (public portfolio: total FMV, top moments, TS squeeze/rookie/trophy intel, CTAs to sign up). `/insights/tc-report?wallet=` (deep report, `?wallet=` auto-load, sitemap'd) and `/insights/squeeze-check` are public wallet tools. The whole wallet-paste funnel exists.

### CC handoff (route + UI)
1. **`app/api/public/queue-wallet/route.ts`** (biggest leverage) — accepts a Flow address, validates it, fires the existing wallet backfill / `/api/seed-wallet-refresh` in `after()`, returns 202. Lives under `/api/public/*` so it's already anon-public (no proxy.ts change). Rely on the existing 60/min/IP proxy rate-limiter.
2. **`ShareEmptyState`** — when a pasted wallet isn't indexed (snapshot null/zero), call `/api/public/queue-wallet` and show "Analyzing your wallet… (30–60s)" + auto-retry, instead of the current dead end. **This is the main drop-off fix.**
3. **`app/share/[wallet]/page.tsx`** — add a "Run the full report →" link to `/insights/tc-report?wallet=<addr>` near the conversion CTA (the two public tools currently don't cross-link).
4. **`app/insights/page.tsx`** — add a wallet-paste input above the fold (same `WalletSearch` pattern as the homepage) → `/insights/tc-report?wallet=<addr>`.

### Decisions (Trevor delegated to Claude's judgment 2026-06-09 — build as specified)
1. **Primary wallet-paste destination = KEEP `/share` + add the cross-link.** Rationale: the `/share` OG card is the social/Twitter distribution loop RPC needs pre-traction (tc-report has no OG), and it's the lower-bounce first landing; the deeper `tc-report` is one click away via the "Run the full report →" link (CC item #3). Do **not** switch the homepage to tc-report.
2. **Trigger indexing on unindexed wallets = YES, build it** (CC items #1 + #2). It's the single biggest drop-off fix. Guard: in `/api/public/queue-wallet`, validate the address is a Flow `0x` + 16-hex string before queuing (reject junk), fire the existing backfill in `after()`, return 202, and rely on the existing 60/min/IP rate-limiter. `ShareEmptyState` shows "Analyzing your wallet… (30–60s)" + auto-retry.
- Privacy + paywall: no decisions needed — `/share/<wallet>` is already public (same trust model as Top Shot's own profiles; `robots.txt` disallows `/share/`), and this is pure acquisition, consistent with no-paywall-until-traction.

---

## Guardrails (CC)
Commit/push to `main` directly; PowerShell `git` on Windows (verify `git rev-list --count origin/main..HEAD` = 0). Full-file writes, not string-replace (CRLF). All Top Shot GQL via the topshot-proxy. The `get_top_accumulators` RPC is already live — the route just calls it. **Revert:** `git revert` per commit; DB revert = `DROP FUNCTION public.get_top_accumulators(text,int,int);`.

## End state
A: buyer-side intelligence has its data object shipped + secured, with a clean route/UI handoff that lights up @handle'd top-buyers/accumulators. B: monitored, no build. C: the funnel is mostly built; a public indexing trigger + cross-links remain, pending your two product calls.
