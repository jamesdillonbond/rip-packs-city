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
// ⚠ priceValidUntil is a schema.org DATE, not a datetime: "the price is no longer available AFTER
// this date". So it must be compared as a calendar day, never by Date.parse() — which reads
// "2026-08-30" as 00:00Z on the 30th, i.e. the START of the day it still covers. The first
// version of this file did exactly that and reddened CI on every run between 00:00Z and ~13:00Z
// (2026-08-30 00:16Z, expected 1788048000000 > 1788048977148). Two consequences, both encoded
// below: a FRESH ask is asserted as "valid through today or later" (a string compare on
// YYYY-MM-DD), and the "already elapsed" fixture sits BEYOND the ~36 h date-granularity fog the
// shipping commit named, not at 31 h — at 31 h the elapsed-date claim is true only after ~19:00Z.
const todayUtc = () => new Date().toISOString().slice(0, 10)
const offerOf = (ld: unknown) =>
  ((ld as { "@graph": Array<Record<string, unknown>> })["@graph"][0].offers ?? undefined) as
    | Record<string, unknown>
    | undefined

describe("editionJsonLd — an ask-sourced price carries its own expiry", () => {
  it("is not vacuous: a dated, fresh ask still emits a priced Offer", () => {
    const offer = offerOf(editionJsonLd(NO_FMV, "nba-top-shot", 45, iso(1)))
    expect(offer).toMatchObject({ price: 45, availability: "https://schema.org/InStock" })
  })

  it("a FRESH ask gets a priceValidUntil that is TODAY or LATER (a date, compared as a date)", () => {
    const offer = offerOf(editionJsonLd(NO_FMV, "nba-top-shot", 45, iso(1)))
    expect(offer!.priceValidUntil, "no expiry was published at all").toBeTruthy()
    expect(String(offer!.priceValidUntil)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // ISO dates sort lexically; >= today means "still vouched for at some point today".
    expect(String(offer!.priceValidUntil) >= todayUtc()).toBe(true)
  })

  it("🚨 a DAYS-OLD ask still publishes, but its expiry date has already PASSED", () => {
    // The live condition on the day this shipped was a 31 h outage. The price is still
    // shown — an old ask is a real observation — but the document no longer claims we
    // stand behind it today. The fixture is 48 h, not 31: with a date-granular field the
    // "already elapsed" claim is unambiguous only beyond ~36 h (ASK_STALE_HOURS + one
    // calendar day), and a 31 h fixture is true or false depending on the hour CI runs.
    const offer = offerOf(editionJsonLd(NO_FMV, "nba-top-shot", 45, iso(48)))
    expect(offer, "the Offer was dropped; a stale price should expire, not vanish").toBeTruthy()
    expect(offer!.price).toBe(45)
    expect(
      String(offer!.priceValidUntil) < todayUtc(),
      "a two-day-old ask was published to Google with a live, unexpired price",
    ).toBe(true)
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
