# Handoff — React #418 hydration mismatch on the insights "Updated" freshness chip (systemic, 16 boards) (CC)

**Finding (verified live 2026-06-30, prod dpl_8Gu4AmpmEtP4YQMioQPAjCeZmwkw):** every public `/insights` board client throws **React error #418** (hydration text mismatch) on load for any visitor whose browser timezone ≠ UTC. Reproduced on a fresh reload of `/insights/squeeze` (console: `EXCEPTION Minified React error #418 … args[]=text`). Boards render fully — **non-fatal** — but the freshness-chip subtree fails hydration and re-renders client-side, and it logs a client error on every such pageview (likely Sentry noise on RPC's most public surface).

**Root cause:** the "Updated {date}" chip formats the server-stamped timestamp with `new Date(fetchedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })`, which renders in the **runtime timezone**. Server (Vercel = UTC) emits e.g. "Jun 30, 2026, 10:15 AM"; the browser (local TZ) formats the same instant differently → server HTML text ≠ client text → #418. `fetchedAt` / `initialFetchedAt` is server-stamped (e.g. `app/insights/squeeze/page.tsx:50` → `new Date().toISOString()`).

**Scope — 16 identical call sites** (`grep -rn "toLocaleString.*timeStyle" app/insights`):
- squeeze/SqueezeBoardClient.tsx:246 · deals/DealsBoardClient.tsx:225 · pack-sniper/PackSniperClient.tsx:376 · new-collectors/NewCollectorsBoardClient.tsx:136 & :138 · rookie-board/RookieBoardClient.tsx:362 · pinnacle-scarcity/PinnacleScarcityBoardClient.tsx:134 · pack-drops/PackDropsBoardClient.tsx:343 · allday-scarcity/AllDayScarcityBoardClient.tsx:131 · underpriced-serials/UnderpricedSerialsBoardClient.tsx:374 · trophies/TrophiesBoardClient.tsx:283 · set-squeeze/SetSqueezeBoardClient.tsx:151 · top-sales/TopSalesBoardClient.tsx:417 · offer-spread/OfferSpreadBoardClient.tsx:213 · serial-premiums/SerialPremiumsBoardClient.tsx:376 · market/MarketIndexClient.tsx:369
- NOT affected: `/insights/allday-pack-market` + `/insights/topshot-pack-market` use a relative "Nd ago" chip — confirmed clean live.

**Fix (apply to the shared pattern):**
- **(a) Best / centralized:** extract a tiny shared client component (`<FreshnessStamp iso={fetchedAt} />`) or `useMountedDate()` hook that renders the formatted date **only after mount** (server renders a stable placeholder — the ISO date or "—"); swap all 16 call sites to it. No mismatch, still shows local time, one place to own.
- **(b) Minimal / fast:** add `suppressHydrationWarning` to the element wrapping the formatted timestamp at each of the 16 sites — the React-sanctioned way to allow an intentional server/client text diff for timestamps (client local-time value wins).
- **(c) Deterministic:** add `timeZone: "UTC"` (or a fixed TZ) to the `toLocaleString` options at all 16 sites so server + client emit identical text (trade-off: everyone sees that fixed TZ, not their local time).
Recommend (a) for maintainability, or (b) for a fast safe patch.

**Note:** long-standing (not a today regression) — has affected every non-UTC visitor since these boards shipped. **Revert:** `git revert`. **Verify:** reload `/insights/squeeze` + one other board in a non-UTC browser TZ → console clean of React #418.
