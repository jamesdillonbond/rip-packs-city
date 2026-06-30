# Handoff 2026-06-13 — Load timing: edge-cache the read routes + widen the warm set

Trevor's complaint: site load-up, sniper, and the collection page feel slow even though the data is already in the DB / should be pre-warmed. This is a focused perf pass. Mostly route-code + a client-context change → Claude Code.

## What's actually happening (analysis)

There IS a client warm cache — lib/warmup/WarmupContext.tsx — and on login it `prefetch`es the sniper feed, pack listings, saved wallets, and per-wallet wallet-search into an in-memory map, so *repeat* in-app navigations read instantly. Good. But three gaps make the parts Trevor feels slow stay slow:

1. **It does nothing for the cold first load.** The warmer runs in a `useEffect` after the app mounts, gated behind `requestIdleCallback` and an owner-key. So the very first page paint — the "site load up" — gets zero benefit; it waits on the route's own (uncached) fetch + a possible lambda cold start.
2. **The sniper prewarm is hardcoded to Top Shot + default sort** (`/api/sniper-feed?collection=nba-top-shot&sortBy=discount`, ~line 213). Any other collection or sort is a cold fetch.
3. **The collection page isn't explicitly warmed** — only wallet-search is, which feeds the portfolio view but not the collection page's own data.

The single biggest first-load lever is **server-side / edge caching on the read routes**, so *every* visitor's first hit is fast — not just the warm-cache hits a returning signed-in user gets.

## Item 1 (biggest win) — edge-cache the hot read GET routes

Add `Cache-Control: s-maxage=<ttl>, stale-while-revalidate=<2x>` to the response headers of the read-only GET routes the pages depend on, so Vercel's edge serves a cached payload while revalidating in the background. Suggested TTLs (match data volatility):

- `/api/sniper-feed` — live listings, keep it short: `s-maxage=20, stale-while-revalidate=40`. (The route currently is fetched client-side with `cache:"no-store"`; that's the client bypassing — the *route* can still set edge cache for direct/SSR hits. Confirm there's no per-user data in the payload before caching; if there is, vary or skip.)
- `/api/packs` (pack table) — `s-maxage=120, stale-while-revalidate=300`.
- the collection / overview data route(s) (CC: identify what `(collections)/[collection]/collection/page.tsx` + `overview/page.tsx` fetch) — `s-maxage=60, stale-while-revalidate=120`.
- FMV / edition-stats / overview-stats style read routes — `s-maxage=120+`.

Guard: only cache routes whose payload is NOT user-specific (FMV, listings, pack tables, collection stats are global). Anything keyed to the signed-in user (saved-wallets, portfolio) must NOT get a shared `s-maxage` — leave those private. CC verifies per route before adding the header.

## Item 2 — widen the warm set (WarmupContext.tsx)

- Key the sniper + pack prewarm to the **active collection** (from the URL / `getLastCollection()`), not the hardcoded `nba-top-shot`, so non-TS collections warm too.
- Add the **collection page's** data route to the warm sequence (whatever `collection/page.tsx` fetches on load), so navigating to it reads from cache.
- Keep the existing TTLs (sniper 30s, packs 120s).

## Item 3 (bigger, optional follow-up) — server-render the first paint

The collection + sniper pages are client components that fetch after mount → blank-then-fill on first load. Converting the initial data fetch to a server component / streaming SSR (or passing server-fetched initial data as props) would make the first paint show content instead of a spinner. Larger change; do Items 1-2 first (they're low-risk and capture most of the win), measure, then decide if SSR is worth it.

## Verify

- `npx tsc --noEmit` clean; deploy READY.
- DevTools Network on a fresh (incognito) load of /nba-top-shot/sniper: the read routes return `cache-control: s-maxage=...` and a repeat load is served `x-vercel-cache: HIT`.
- No private/user-specific route accidentally gained a shared cache header (spot-check saved-wallets / portfolio still `no-store`/private).

## Guardrails

- Commit directly to main, no branches/PRs; PowerShell git; re-verify push count 0.
- Don't cache anything user-specific. Short TTLs on volatile data (listings) — better slightly-stale-fast than fresh-slow, but keep listings ≤30s.
- Claude Code's direct inspection wins — confirm each route's payload + current headers before adding cache.

End state: cold first loads of the site / sniper / collection page are edge-cached and fast for everyone; the warm cache covers the active collection, not just Top Shot.
