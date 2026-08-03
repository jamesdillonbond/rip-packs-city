import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "fs"
import path from "path"
import { COLLECTIONS } from "@/lib/collections"

// ARCHITECTURE GUARD — closed-market disclosure on every priced UFC tab.
//
// WHY THIS EXISTS
//   UFC Strike's Flow market is CLOSED (last Flow sale 2026-05-13), but the FMV
//   pipeline keeps carrying the last computed value forward and re-stamping
//   `computed_at`, so every freshness signal on the site reads green on evidence
//   over a year old. A per-row "is this snapshot stale?" heuristic cannot catch
//   that -- the snapshot timestamp itself lies. The honest signal is the
//   collection-level fact that the market closed, which is what
//   `lib/market-closed.ts` (SEO/JSON-LD) and `MarketplaceStatusBanner` (rendered
//   UI, via v_collection_marketplace_status) each encode.
//
//   The 2026-08-02 honesty pass shipped the SEO half only: `lib/market-closed.ts`
//   is imported by `lib/seo.ts` and NOTHING else, so titles and JSON-LD disclosed
//   the closure while the rendered tabs did not. The banner covered
//   overview/collection/sniper/edition but NOT `sets` or `analytics` -- the two
//   densest priced surfaces UFC actually exposes:
//     * analytics renders total_fmv, per-tier FMV, per-series FMV and a
//       locked/unlocked split -- an entire portfolio valuation.
//     * sets renders `lowestAsk` + `fmv` per missing piece -- a cost-to-complete,
//       i.e. a price nobody can transact at.
//   Both were mounted 2026-08-03. This guard stops either from being dropped.
//
// SCOPE: only the tabs UFC actually registers, because UFC is the collection with
// a dated closed market. Tabs UFC does not expose (market, packs, ...) are out of
// scope on purpose -- see KNOWN_UNMOUNTED below.

const REPO = process.cwd()
const COLLECTION_ROOT = path.join(REPO, "app", "(collections)", "[collection]")

/** Per-collection tabs UFC registers, all of which render FMV or ask prices. */
const UFC_PRICED_TABS = ["overview", "collection", "sniper", "sets", "analytics"] as const

/**
 * Priced tabs deliberately NOT guarded, with the reason. UFC does not register
 * either, so neither can render a dead UFC price. Revisit only if a closed market
 * ever exposes them.
 */
const KNOWN_UNMOUNTED: Record<string, string> = {
  market: "UFC does not register `market` (pages: all except UFC)",
  packs: "UFC does not register `packs` (pages: all except UFC)",
}

function sourceOf(tab: string): string {
  const p = path.join(COLLECTION_ROOT, tab, "page.tsx")
  if (!existsSync(p)) throw new Error(`missing page source for tab "${tab}" at ${p}`)
  return readFileSync(p, "utf8")
}

describe("invariant: closed-market disclosure reaches every priced UFC tab", () => {
  it("UFC still registers exactly the tabs this guard covers", () => {
    const ufc = COLLECTIONS.find((c) => c.id === "ufc")
    expect(ufc, "UFC collection missing from the registry").toBeTruthy()
    // If UFC gains a priced tab, it must be added to UFC_PRICED_TABS (and the
    // banner mounted) or this guard silently stops covering it.
    expect([...(ufc!.pages as readonly string[])].sort()).toEqual([...UFC_PRICED_TABS].sort())
  })

  for (const tab of UFC_PRICED_TABS) {
    it(`/[collection]/${tab} mounts MarketplaceStatusBanner`, () => {
      const src = sourceOf(tab)
      expect(
        src,
        `${tab}/page.tsx does not import MarketplaceStatusBanner. UFC's market ` +
          `closed 2026-05-13 and its snapshots still re-stamp computed_at, so ` +
          `without this banner the tab renders dead prices that look live.`,
      ).toMatch(/from\s+["']@\/components\/marketplace-status["']/)
      expect(
        src,
        `${tab}/page.tsx imports MarketplaceStatusBanner but never renders it.`,
      ).toMatch(/<MarketplaceStatusBanner\b/)
    })
  }

  it("documents the priced tabs left unguarded, with a reason", () => {
    for (const [tab, reason] of Object.entries(KNOWN_UNMOUNTED)) {
      expect(reason.length, `${tab} needs a real reason, not a placeholder`).toBeGreaterThan(20)
      expect(
        (UFC_PRICED_TABS as readonly string[]).includes(tab),
        `${tab} is in KNOWN_UNMOUNTED but UFC now registers it — mount the banner instead`,
      ).toBe(false)
    }
  })

  it("market-closed resolves UFC under BOTH the canonical slug and the alias", async () => {
    // getCollectionByUrlSlug resolves "ufc-strike" as well as "ufc", so alias URLs
    // render real pages; covering only one form skips the disclosure on the other.
    // Asserted behaviourally, not by regex: the alias is registered by assignment
    // (`CLOSED_MARKETS["ufc-strike"] = CLOSED_MARKETS.ufc`), not as a literal key,
    // so a source match would pin the syntax rather than the guarantee.
    const { isMarketClosed, closedMarket } = await import("@/lib/market-closed")
    for (const slug of ["ufc", "ufc-strike"]) {
      expect(isMarketClosed(slug), `${slug} must be recognised as a closed market`).toBe(true)
      expect(closedMarket(slug)?.closedOn).toBe("2026-05-13")
    }
    // The live Flow collections must NOT be flagged closed.
    for (const slug of ["nba-top-shot", "nfl-all-day", "laliga-golazos", "disney-pinnacle"]) {
      expect(isMarketClosed(slug), `${slug} is live and must not be flagged closed`).toBe(false)
    }
  })
})
