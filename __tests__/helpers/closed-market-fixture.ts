// __tests__/helpers/closed-market-fixture.ts
//
// 2026-11-26 — CLOSED_MARKETS is EMPTY in production since UFC Strike reopened on
// Aptos. The closed-market MACHINERY (seo copy, sniper subtitle, ticker/tool-card
// chrome, sentinel arm) still has to be exercised, so the guards that walk "every
// closed market" install this record first. It is UFC's real 2026-08-02 record,
// keyed on a slug no collection uses, so no test can mistake it for a live fact.
//
// ⚠ Call installClosedMarketFixture() at MODULE TOP LEVEL, before any describe():
// those guards read Object.keys(CLOSED_MARKETS) during collection, which runs
// before every beforeAll. vitest isolates modules per file, so the record never
// leaks into another file; removeClosedMarketFixture() exists for an afterAll.
import { CLOSED_MARKETS, type ClosedMarket } from "@/lib/market-closed"

export const FIXTURE_CLOSED_SLUG = "closed-market-fixture"

export const FIXTURE_CLOSED_MARKET: ClosedMarket = {
  closedOn: "2026-05-13",
  venue: "Flow",
  note:
    "This collection's Flow marketplace is closed - the last Flow sale was on 13 May 2026. " +
    "Prices below are the last values we observed before it closed, kept for reference. " +
    "They are historical, not current, and nothing here can be bought or sold on Flow.",
}

/**
 * Install the fixture record. The default key is a slug no collection uses; a
 * test that must drive a REAL route (one that resolves the slug through the
 * collection registry first) may key it on a real collection — the record then
 * means "pretend this collection's market closed", never a production fact.
 */
export function installClosedMarketFixture(slug: string = FIXTURE_CLOSED_SLUG): string {
  CLOSED_MARKETS[slug] = FIXTURE_CLOSED_MARKET
  return slug
}

export function removeClosedMarketFixture(slug: string = FIXTURE_CLOSED_SLUG): void {
  delete CLOSED_MARKETS[slug]
}
