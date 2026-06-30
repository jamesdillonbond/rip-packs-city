# Handoff 2026-06-16 — New public /insights surface: Serial Premiums (#1 Watch)

Context. A new differentiated insights surface — the most extreme real #1-mint premiums on Top Shot ("a $7.50 Jokić common's #1 sold for $9,000 = 1,200×"), the kind of intelligence nbatopshot.com has no equivalent of. It pairs with today's serial-FMV layer. The backing view is BUILT, live, and verified by Cowork; this handoff is the route + page + OG + sitemap (Claude Code). Run the `rpc-insights-qa` checklist before deploy.

HEAD at write: origin/main = (latest). DB already shipped by Cowork.

---

What's already live (Cowork — migration `audit_20260616_topshot_serial_premiums_board`)

`public.topshot_serial_premiums_board` — VIEW, `security_invoker=on`, `GRANT SELECT TO anon, authenticated, service_role` (matches `topshot_squeeze_board` / `v_insights_top_sales`). `check_public_security_invariants()` = 0 (verified). 270 rows.

Per row (one per canonical TS edition with a recent #1 sale): the multiple the #1 mint commanded over the edition's median price.
Columns: `edition_id` (uuid), `external_id` (the `setID:playID` edition key for the edition-page link), `player_name`, `set_name`, `tier`, `circulation_count`, `thumbnail_url`, `moment_id` + `nft_id` (the #1 sale's moment, for the moment-page drill-down), `edition_median_usd`, `no1_last_sale_usd`, `premium_multiple`, `no1_sold_at`, `edition_sales_180d`.

Definition (so you can reason about freshness): edition median = p50 of the edition's 180d sales (>$0.50, ≥15 sales); #1 = the most-recent #1-serial sale in the last 90d (>$0.50); kept when premium ≥ 5×, median ≥ $0.75, thumbnail present, canonical int-keyed. Ordered by premium desc. It reads `sales`+`editions` live (no materialization), so it's always current; no cron needed.

Revert (DB): `DROP VIEW public.topshot_serial_premiums_board;`

---

Item 1 — API route `/api/public/insights/serial-premiums`

Mirror `/api/public/insights/top-sales`. Reads the view; supports `tier` (COMMON/RARE/FANDOM/LEGENDARY/ULTIMATE, 400 on invalid), `min_premium` (default 5), `window` (filter on `no1_sold_at`, default 90d), `sort` (premium | no1_price | recent, default premium), `limit` (clamp ≤ 100). Add it to the `/api/public/*` proxy allowlist (it's already covered if `/api/public/*` is a blanket bypass — confirm). `Cache-Control: s-maxage=900` (15 min; the view is live so this just bounds load).

Item 2 — Page `/insights/serial-premiums`

Anon-public via the existing `/insights/*` carve-out in `proxy.ts`. Brand tokens only (`var(--rpc-red)`, `var(--font-display)`, `var(--font-mono)`) — no hardcoded `#E03A2F` except the OG route (the universal Satori exception). Render the board as a ranked table/cards: thumbnail, player · set · tier · #/circ, edition median → #1 last sale, the big `premium_multiple` (e.g. "1,200×"), and the date. Honest framing — every row is a REAL sale, not an estimate: header copy like "What collectors actually paid for the #1 mint vs the edition's typical price." Empty state: "No qualifying #1 sales in this window." (the filters can empty it).

Drill-downs (the rpc-insights-qa requirement): each row links to (a) the #1 moment page `/moment/{moment_id}` (where today's serial-FMV "estimated #1 premium" line now renders — nice tie-in), and (b) the edition page `/{collection}/edition/{external_id}` (URL-encode the colon). Both are anon-public already.

Item 3 — OG + JSON-LD

New `/api/og/insights-serial-premiums` (1200×630, the shared Satori card style; the hardcoded `#E03A2F` there is the documented universal exception all insights OG routes share). Point the page's OG/twitter image at it. Add `WebApplication` JSON-LD (match the sibling boards; a `Dataset` block is optional — the trophies/top-sales boards ship WebApplication-only).

Item 4 — Sitemap + canonical

Add `/insights/serial-premiums` to `app/sitemap.ts`. Param-stripped self-canonical in the route's `layout.tsx` (so `?tier=…&sort=…` variants don't fragment SEO) — mirror the other insights layouts.

Item 5 — Wire into health

Add a `serial_premiums` count leg to the insights-counts payload in the `rpc-live-health` artifact / the monitor's insights-board liveness check (LIMIT 501 → "500+"), so the new board is liveness-monitored like the other 11.

---

Guardrails
- Run `rpc-insights-qa` (backing-view security ✓ done; smoke, sitemap, canonical, drill-downs, freshness, brand, OG) before deploy.
- Direct-to-main, PowerShell git, full-file writes, Vercel maxDuration ≤ 800s. `npx tsc --noEmit` clean; deploy READY; smoke green.
- Claude Code's direct inspection wins over this doc — match the actual `/insights/top-sales` route+page+OG+layout shapes (they're the closest sibling).

Expected end state: `/insights/serial-premiums` live and anon-public — a sortable #1-premium leaderboard with moment/edition drill-downs, OG card, sitemap entry, self-canonical, brand-clean, liveness-monitored — a new SEO/shareable discovery surface unique to RPC.
