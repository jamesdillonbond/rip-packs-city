import { describe, it, expect } from "vitest"
import { editionJsonLd } from "@/lib/seo"
import { ASK_STALE_HOURS } from "@/lib/market/ask-freshness"
import { MAX_ASK_AGE_HOURS_CORROBORATION } from "@/lib/fmv-confidence"

// ── A price we have not confirmed in a day must not be asserted to Google as InStock
//
// 🚨 WHY THIS EXISTS (2026-08-29). `editionJsonLd` publishes a schema.org `Offer` with
// `availability: InStock` and no expiry, and its signature had NO timestamp at all —
// so a stale ask was structurally unqualifiable. The function was already careful
// about OTHER staleness (it refuses a STALE-confidence FMV as a price source, and
// emits no Offer at all on a closed market), and its own comment stated the premise
// outright: *"a live low ask is still a real, reliable price even on STALE."* That
// sentence was true of a feed re-checking hourly and false of one that had stopped.
// On the day this landed `offers-sweep` had not confirmed an ask in 31 hours, and
// every one of them was being published to search engines as buyable now.
//
// ⭐ THE FIX IS GRADUATED, AND THE MIDDLE RUNG IS THE INTERESTING ONE. Dropping the
// Offer at 12 h was the obvious move and is worse for readers: it deletes the Product
// rich-result from thousands of NO_DATA edition pages during any upstream outage — an
// SEO cost with no honesty gain over `priceValidUntil`, which is schema.org's own
// field for "we vouch for this price until X" and which Google reads, when elapsed, as
// a reason to distrust the price. Only past the corroboration bound — where an ask has
// stopped being evidence at all — is the Offer withheld.

const NO_FMV = { route_slug: "8:133", player_name: "Dame" }
const HOUR = 3_600_000
const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR).toISOString()
const offerOf = (ld: unknown) =>
  ((ld as { "@graph": Array<Record<string, unknown>> })["@graph"][0].offers ?? undefined) as
    | Record<string, unknown>
    | undefined

describe("editionJsonLd — an ask-sourced price carries its own expiry", () => {
  it("is not vacuous: a dated, fresh ask still emits a priced Offer", () => {
    const offer = offerOf(editionJsonLd(NO_FMV, "nba-top-shot", 45, iso(1)))
    expect(offer).toMatchObject({ price: 45, availability: "https://schema.org/InStock" })
  })

  it("a FRESH ask gets a priceValidUntil in the FUTURE", () => {
    const offer = offerOf(editionJsonLd(NO_FMV, "nba-top-shot", 45, iso(1)))
    expect(offer!.priceValidUntil, "no expiry was published at all").toBeTruthy()
    expect(Date.parse(String(offer!.priceValidUntil))).toBeGreaterThan(Date.now())
  })

  it("🚨 a 31-HOUR-OLD ask still publishes, but its expiry has already ELAPSED", () => {
    // The live condition on the day this shipped. The price is still shown — an old
    // ask is a real observation — but the document no longer claims we stand behind
    // it today.
    const offer = offerOf(editionJsonLd(NO_FMV, "nba-top-shot", 45, iso(31)))
    expect(offer, "the Offer was dropped; a stale price should expire, not vanish").toBeTruthy()
    expect(offer!.price).toBe(45)
    expect(
      Date.parse(String(offer!.priceValidUntil)),
      "a day-old ask was published to Google with a live, unexpired price",
    ).toBeLessThan(Date.now())
  })

  it("the expiry is measured from when we CONFIRMED the ask, not from now", () => {
    const confirmedAt = iso(5)
    const offer = offerOf(editionJsonLd(NO_FMV, "nba-top-shot", 45, confirmedAt))
    const expected = new Date(Date.parse(confirmedAt) + ASK_STALE_HOURS * HOUR)
      .toISOString()
      .slice(0, 10)
    expect(offer!.priceValidUntil).toBe(expected)
  })

  it("⛔ past the corroboration bound the Offer is WITHHELD, not merely expired", () => {
    const offer = offerOf(
      editionJsonLd(NO_FMV, "nba-top-shot", 45, iso(MAX_ASK_AGE_HOURS_CORROBORATION + 1)),
    )
    expect(offer, "an ask months old was published as a transactable price").toBeUndefined()
    // The population that motivated it: an 87-day-old row.
    expect(offerOf(editionJsonLd(NO_FMV, "nba-top-shot", 45, iso(87 * 24)))).toBeUndefined()
  })

  it("🚨 an UNDATABLE ask is treated as ancient — 'I could not tell' is not 'recent'", () => {
    expect(offerOf(editionJsonLd(NO_FMV, "nba-top-shot", 45, null))).toBeUndefined()
    expect(offerOf(editionJsonLd(NO_FMV, "nba-top-shot", 45, "not-a-date"))).toBeUndefined()
  })

  it("CONTROL — an age-unaware caller (timestamp omitted) keeps the prior behaviour", () => {
    const offer = offerOf(editionJsonLd(NO_FMV, "nba-top-shot", 45))
    expect(offer).toMatchObject({ price: 45 })
    // ...and invents no expiry it cannot substantiate.
    expect(offer!.priceValidUntil).toBeUndefined()
  })

  it("🚨 CONTROL — an FMV-priced Offer is NOT gated by the ask's age", () => {
    // The ask is not the price here, so its age says nothing about the number being
    // published. Gating this branch would delete Offers for no reason — and this is
    // the case that covers most priced editions.
    const withFmv = { ...NO_FMV, fmv: { fmv_usd: 100, confidence: "HIGH" } }
    const offer = offerOf(editionJsonLd(withFmv, "nba-top-shot", 45, iso(99 * 24)))
    expect(offer, "a modelled FMV price was suppressed because an unrelated ask was old").toBeTruthy()
    expect(offer!.price).toBe(100)
    expect(offer!.priceValidUntil, "an FMV price must not borrow the ask's expiry").toBeUndefined()
  })

  it("CONTROL — a closed market still emits NO Offer, however fresh the ask", () => {
    // The pre-existing, stronger guard must survive this change.
    expect(offerOf(editionJsonLd(NO_FMV, "ufc", 45, iso(1)))).toBeUndefined()
  })

  it("CONTROL — no price at all still means no Offer", () => {
    expect(offerOf(editionJsonLd(NO_FMV, "nba-top-shot", null, iso(1)))).toBeUndefined()
    expect(offerOf(editionJsonLd(NO_FMV, "nba-top-shot", 0, iso(1)))).toBeUndefined()
  })
})
