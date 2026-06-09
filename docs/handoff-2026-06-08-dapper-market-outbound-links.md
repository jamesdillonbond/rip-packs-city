# Handoff — add dapper.market as a second marketplace link (the Flowty slot) — 2026-06-08

## Context

Dapper Labs launched its own in-house secondary marketplace at **dapper.market** (NBA Top Shot, NFL All Day, LaLiga Golazos — **not** Pinnacle or UFC). The native marketplaces are **still live and separate** — `nbatopshot.com/search` is still "Marketplace | NBA Top Shot" (confirmed via web search 2026-06-08), and the same for All Day / Golazos. So dapper.market is a *second* place to buy the same moment, not a replacement for the native sites.

**Goal (Trevor's framing):** keep RPC's existing native marketplace links **and** add a dapper.market link alongside them — dapper.market takes the UI slot RPC used to give Flowty (which RPC tore out when Flowty shut down 2026-05-13). So every surface that shows a native "View Listing" link should also show a "Dapper" link.

This is **additive and low-risk**: native links are untouched; we add a second link. Full recon: `docs/research/dapper-market-recon-2026-06-08.md`.

Nothing here has shipped from Cowork (route/`.tsx` code Cowork can't push). No DB migration. No `docs/FREEZE.md`. Work from current `origin/main`; recent CC commits in the ledger (`52072be`, `d079e5b`, `…29715ed`) don't touch these files — no collision.

## Verified facts (so you don't re-derive)

dapper.market URL scheme, confirmed live by crawling Dapper's own rendered links:

- **Moment page:** `https://dapper.market/<league>/moment/<momentId>` where `<league>` ∈ `nba | nfl | laliga` and `<momentId>` is the **numeric on-chain moment NFT id**. Loaded `https://dapper.market/nba/moment/52191304` → real moment page (Listings / Offers / Activity, buy, collector leaderboard). Dapper renders `/nfl/moment/<id>` and `/laliga/moment/<id>` the same way.
- **Edition page:** `https://dapper.market/nba/edition/<id>` — `<id>` is Dapper's **own internal edition id** (e.g. `15417`), NOT `setID:playID`. RPC can't build it. Do not attempt edition deep-links.
- **Profile:** `https://dapper.market/<league>/collection/<username>` — keyed by **username**, not wallet. Not mappable from RPC. Do not attempt wallet links.

**RPC identifier match** (verified against prod DB): `wallet_moments_cache.moment_id` for TS is the numeric on-chain moment id (sample for `0xbd94cade097e50ac`: `42948291, 51437683, 49407547`). The sniper feed's `deal.momentId` / `listing.flowId` for **real listings** is this same id (`sniper-feed` 1405-1406: `flowId`/`momentId = String(l.id)`). So `dapper.market/<league>/moment/<momentId>` is directly buildable from what RPC already has — for real moment listings.

**Native marketplace is live** (`nbatopshot.com/search`, web-search-confirmed 2026-06-08) — so the existing native links stay. Could not test nbatopshot.com directly (Claude-in-Chrome blocks that domain), so didn't touch native URL construction.

## The slot we're filling

RPC used to render a Flowty link/source-chip next to the native one (sniper rows, moment modal). That infra was removed in the May 2026 Flowty teardown (`computeSniperFeed` Flowty leg deleted, `marketplaceAvailability.flowty=false`, `flowtyListingUrl=null`, dormancy chips removed). So this is a small **re-introduction** of a second-marketplace link, now pointing at Dapper.

The current outbound resolvers each return **one** link:
- `resolveViewUrl` — `app/(collections)/[collection]/sniper/page.tsx` 139-143 (native: `deal.buyUrl` if non-Flowty, else `marketplaceMomentUrl(slug, deal.momentId)`).
- `resolveListingUrl` — `app/(collections)/[collection]/market/page.tsx` 159-166 (native: `listing.buyUrl` if non-Flowty, else `momentUrl(listing.flowId)`).

**Leave both of those (and the native `MARKETPLACE_MOMENT_URL_TEMPLATES`) exactly as they are.** We're adding a parallel dapper link, not changing the native one.

---

## Item 1 — add a dapper-URL builder (HIGH confidence)

**File:** `lib/collections.ts`. Add a new builder next to `marketplaceMomentUrl` (~line 328). Do **not** edit `MARKETPLACE_MOMENT_URL_TEMPLATES` (those stay native).

```ts
// Dapper's in-house secondary marketplace (dapper.market). Second buy option
// alongside the native marketplace — fills the slot Flowty used to occupy.
// Keyed by the numeric on-chain moment id (same id used by marketplaceMomentUrl).
// Only NBA Top Shot / NFL All Day / LaLiga Golazos are on dapper.market.
const DAPPER_MARKET_LEAGUE_SEG: Record<string, string> = {
  "nba-top-shot":   "nba",
  "nfl-all-day":    "nfl",
  "laliga-golazos": "laliga",
}

export function dapperMarketMomentUrl(collectionId: string, momentId: string | null | undefined): string | null {
  const seg = DAPPER_MARKET_LEAGUE_SEG[collectionId]
  if (!seg || !momentId) return null
  return `https://dapper.market/${seg}/moment/${momentId}`
}
```

Returns `null` for Pinnacle / UFC / Candy / Panini (not on dapper.market) and when there's no moment id — so call sites can simply skip rendering the link when it's `null`.

**Revert:** delete the function + map.

## Item 2 — render the second "Dapper" link wherever the native link shows (HIGH confidence)

In each surface below, compute `dapperMarketMomentUrl(collectionId, <momentId>)` and, when non-null, render a second link next to the existing native one. Suggested label: **Dapper** (or "View on Dapper ↗"); keep the native link labeled with the collection (e.g. "Top Shot" / "All Day" / "Golazos") or its current "View Listing". Open `target="_blank" rel="noopener noreferrer"`.

Surfaces (grep-verified they render the native link today):
- `app/(collections)/[collection]/sniper/page.tsx` — the deal row (`ActionCell` ~351), the mobile/card view (~1542-1545), the edition-depth "View →" (~1962-1964), and the selected-deal modal handoff (~2064). Use `deal.momentId`.
- `app/(collections)/[collection]/market/page.tsx` — the table row (~810) and grid card (~926). Use `listing.flowId`. `collectionId` is available from `useCollectionContext()`.
- `components/MomentDetailModal.tsx` — currently takes a single `buyUrl` + `marketplaceSource`. Add an optional `dapperUrl` prop and render the Dapper link beside the native buy link. The sniper page passes it (it already builds the modal's `buyUrl`).
- `app/moment/[id]/page.tsx` and the edition page (`app/(collections)/[collection]/edition/[slug]/page.tsx`) — wherever they render a native "View"/listing link, add the Dapper link. Use the page's moment id.

**Guard (important):** only render the Dapper link when you have a **real moment id**, not an edition id. The AllDay edition-level deal path sets `momentId = editionFlowID` (`sniper-feed` line 1058) — that's an edition id, so `dapperMarketMomentUrl` would mint a wrong link. Either (a) skip the Dapper link on edition-level deals, or (b) gate it on the deal carrying a true moment id (the TS listings path `sniper-feed` 1406 and AllDay special-serial paths 1121/1135 do; the AllDay edition path 1056-1058 does not). When in doubt, skip — a missing second link is fine; a wrong one is not.

**Revert:** remove the added links / the `dapperUrl` prop. Single `git revert` of the commit is cleanest.

## Item 3 — leave native links and templates UNCHANGED

Do **not** repoint `tsBuyUrl` (`sniper-feed` 1387-1390), the AllDay buyUrls (1054, 1122, 1136), the DB-stored `r.buy_url`, or `MARKETPLACE_MOMENT_URL_TEMPLATES`. The native marketplace is live; those keep working as the native link. (Earlier draft of this handoff proposed replacing them — that was wrong; the model is native **plus** dapper, not native → dapper.)

The only existing behavior worth a glance: `resolveViewUrl`/`resolveListingUrl` already drop dead `flowty.io` URLs via `!url.includes("flowty.io")` and fall back to the native moment page — leave that intact; it's the native fallback.

## Out of scope (leave as-is)

- `MARKETPLACE_WALLET_URL_TEMPLATES` — dapper profiles are username-keyed, not wallet; not mappable.
- Disney Pinnacle, UFC Strike — not on dapper.market (`dapperMarketMomentUrl` returns null for them, so no link renders — correct).
- Candy / Panini (`magiceden` / `opensea`) — chain-two, unrelated.

## Optional polish

If you want the source chips back: reintroduce a "Dapper" tag in the spot the old "Flowty" chip lived (`MomentDetailModal` `marketplaceSource`, sniper source labels). Low priority; the second link is the substance.

## Guardrails

- Commit and push **directly to `main`** — no branch, no PR (CLAUDE.md non-negotiable). If a `claude/*` branch is pre-checked-out, switch to `main` first.
- On Windows, commit via **PowerShell `git`** (Git Bash `git commit` can silently no-op). Verify the push:

  ```powershell
  git rev-list --count origin/main..HEAD   # expect 0
  ```

- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest` for any redeploy.
- Small edits in large files — full-file writes or `findIndex`-on-split-lines, **not** string-replace patches (CRLF on this repo breaks them silently).
- Vercel Pro `maxDuration` caps at **800s** — higher sends the deploy to ERROR invisibly (not relevant here, no route timeouts change).

## Expected verification

- `npx tsc --noEmit` clean on `lib/collections.ts` + every touched page/component.
- Vercel deploy READY.
- Smoke stays green; manually open one TS, one AllDay, one LaLiga deal and confirm **two** working links: the native one (unchanged) **and** a Dapper one landing on `dapper.market/<league>/moment/<id>` (a real moment page).
- Confirm Pinnacle/UFC deals show **only** the native link (no dapper link — builder returns null).
- Confirm an AllDay edition-level deal does **not** render a broken dapper link (the edition-id guard).

## Note for Claude Code

Your direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape. Line numbers are grep/read-verified 2026-06-08 but may drift; anchor on symbol names (`marketplaceMomentUrl`, `dapperMarketMomentUrl`, `resolveViewUrl`, `resolveListingUrl`, `tsBuyUrl`, `MomentDetailModal`) not line numbers.

## Expected end state

One commit on `main`, deploy READY, `tsc` clean: every NBA Top Shot / NFL All Day / LaLiga Golazos "View Listing" surface shows **both** the native marketplace link (unchanged) **and** a new dapper.market moment link in the old Flowty slot. Native links, wallet links, and Pinnacle/UFC/Candy/Panini are untouched. Revert = `git revert <commit>`.
