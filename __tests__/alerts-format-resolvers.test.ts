import { describe, it, expect } from "vitest"
import { buildTelegramMessage, buildDiscordEmbeds, buildEmailMessage } from "@/lib/alerts/format"
import type { Delivery, DealPayload } from "@/lib/alerts"

// The per-source FIELD RESOLVERS underneath the three channel formatters. The
// `deal` payload arrives from TWO boards with different column names — the
// per-serial board sends ask_usd / serial_fmv_usd / moment_url, the
// edition-level board sends low_ask / fmv_usd / detail_url — so every headline
// value is a fallback chain. If one arm breaks, the alert still SENDS; it just
// quietly says "—" where a price belongs, or links to the site root instead of
// the moment. That is the failure mode these pin.
//
// Also pinned: the two display rules that exist because two collections
// disagree about what "tier" means. NBA/UFC tiers arrive as upper-case enums and
// must render title-cased; Pinnacle's tier column already holds its proper-cased
// VARIANT, so it must be left alone (or "Colored Enamel" becomes "Colored
// enamel") and must not be double-printed as both tier and parallel.

function deal(over: Partial<DealPayload["deal"]> = {}): Delivery {
  return {
    id: "d1",
    owner_key: "u1",
    channel: "telegram" as Delivery["channel"],
    channel_user_id: "123",
    alert_kind: "deal",
    subject_key: null,
    dedup_bucket: null,
    status: "pending",
    attempts: 0,
    payload: {
      subscription_id: "s1",
      label: null,
      deal: {
        external_id: "73:2785",
        player_name: "Damian Lillard",
        set_name: "Base Set",
        tier: null,
        parallel: null,
        collection_slug: "nba_top_shot",
        circulation_count: null,
        confidence: "HIGH",
        discount_pct: 25,
        discount_usd: 10,
        thumbnail_url: null,
        ...over,
      },
    } as DealPayload,
  }
}

const tg = (d: Delivery) => buildTelegramMessage([d])

describe("alerts/format — the two-board price fallback", () => {
  it("prefers the per-serial fields and falls back to the edition-level ones", () => {
    // Per-serial board shape.
    expect(tg(deal({ ask_usd: 12.5, serial_fmv_usd: 20 }))).toContain("$12.50")
    expect(tg(deal({ ask_usd: 12.5, serial_fmv_usd: 20 }))).toContain("$20.00")
    // Edition-level board shape.
    expect(tg(deal({ low_ask: 8, fmv_usd: 11 }))).toContain("$8.00")
    expect(tg(deal({ low_ask: 8, fmv_usd: 11 }))).toContain("$11.00")
    // Per-serial wins when BOTH are present — the serial price is the one the
    // subscriber was alerted on.
    const both = tg(deal({ ask_usd: 12.5, low_ask: 8, serial_fmv_usd: 20, fmv_usd: 11 }))
    expect(both).toContain("$12.50")
    expect(both).not.toContain("$8.00")
  })

  it("renders an em-dash rather than NaN/$null when a price is missing or non-finite", () => {
    const msg = tg(deal({ ask_usd: null, low_ask: null, serial_fmv_usd: null, fmv_usd: null, discount_pct: null }))
    expect(msg).toContain("—")
    expect(msg).not.toMatch(/NaN|\$null|\$undefined/)

    // ⚠ THE FMV IS LOAD-BEARING IN THIS FIXTURE, not decoration. Since
    // audit_20260816 the "N% below FMV $X" clause is OMITTED when there is no
    // FMV to state (price-only alerts carry none by design), so without an FMV
    // here the NaN guard on `pct` would never be reached and this assertion
    // would pass vacuously — it would be asserting that a string we never
    // render contains no NaN.
    expect(
      tg(deal({ ask_usd: Number.POSITIVE_INFINITY, serial_fmv_usd: 20, discount_pct: Number.NaN }))
    ).not.toMatch(/NaN|Infinity/)
  })

  it("rounds the discount percent rather than printing a float", () => {
    // Same reason as above: a discount percent is DERIVED from an FMV, so a
    // fixture carrying one without the other is a shape production cannot
    // produce, and the clause that prints it is now correctly withheld.
    expect(tg(deal({ discount_pct: 24.6, fmv_usd: 11, low_ask: 8 }))).toContain("25%")
  })
})

describe("alerts/format — link resolution", () => {
  it("absolutizes a relative detail path and passes an absolute one through", () => {
    expect(tg(deal({ detail_url: "/nba-top-shot/edition/73:2785" }))).toContain(
      "https://www.rippackscity.com/nba-top-shot/edition/73:2785",
    )
    expect(tg(deal({ moment_url: "https://example.test/moment/9" }))).toContain("https://example.test/moment/9")
  })

  it("falls back to the site root when a deal carries no detail link at all", () => {
    const msg = tg(deal({}))
    expect(msg).toContain("https://www.rippackscity.com")
  })

  it("labels the native buy link per collection and omits it for a collection with no marketplace URL", () => {
    expect(tg(deal({ nft_id: "1", collection_slug: "nfl_all_day" }))).toContain("All Day")
    expect(tg(deal({ nft_id: "1", collection_slug: "laliga_golazos" }))).toContain("Golazos")
    // No nft_id -> no native link at all (the Pinnacle case).
    expect(tg(deal({ collection_slug: "disney_pinnacle" }))).not.toContain("Pinnacle</a>")
  })

  it("renders the Dapper listing link only when it is already absolute", () => {
    expect(tg(deal({ listing_url: "https://nbatopshot.com/listing/abc" }))).toContain("https://nbatopshot.com/listing/abc")
    // A relative/garbage listing_url must not be emitted as a link.
    expect(tg(deal({ listing_url: "/relative/listing" }))).not.toContain("/relative/listing")
  })
})

describe("alerts/format — the subline identity", () => {
  it("title-cases an upper-case enum tier but leaves an already-cased one alone", () => {
    expect(tg(deal({ tier: "LEGENDARY" }))).toContain("Legendary")
    // Pinnacle's tier column carries its proper-cased variant — mangling it to
    // "Colored enamel" is the regression this guards.
    expect(tg(deal({ tier: "Colored Enamel" }))).toContain("Colored Enamel")
  })

  it("does not double-print a parallel that is just the tier again", () => {
    const msg = tg(deal({ tier: "Golden", parallel: "golden" }))
    expect(msg.match(/Golden/gi) ?? []).toHaveLength(1)
    // A genuinely different parallel still renders alongside the tier.
    expect(tg(deal({ tier: "RARE", parallel: "Galactic" }))).toContain("Galactic")
  })

  it("shows the serial tag and mint denominator only when known", () => {
    const full = tg(deal({ serial_number: 7, circulation_count: 222 }))
    expect(full).toContain("#7")
    expect(full).toContain("/222")

    const bare = tg(deal({ serial_number: null, circulation_count: null }))
    expect(bare).not.toContain("#null")
    expect(bare).not.toContain("/null")
  })

  it("falls back through player_name -> name -> external_id -> 'Moment' for the title", () => {
    expect(tg(deal({ player_name: null, name: "Cover Art" }))).toContain("Cover Art")
    expect(tg(deal({ player_name: null, name: null }))).toContain("73:2785")
    expect(tg(deal({ player_name: null, name: null, external_id: undefined }))).toContain("Moment")
  })
})

describe("alerts/format — the resolvers reach all three channels", () => {
  const d = deal({
    ask_usd: 12.5,
    serial_fmv_usd: 20,
    serial_number: 7,
    tier: "LEGENDARY",
    circulation_count: 222,
    nft_id: "9",
    collection_slug: "nba-top-shot",
    moment_url: "/nba-top-shot/moment/9",
  })

  it("discord embeds carry the same resolved ask/fmv and buy link", () => {
    const [embed] = buildDiscordEmbeds([d]) as Array<{ url: string; description?: string; fields: Array<{ name: string; value: string }> }>
    expect(embed.url).toBe("https://www.rippackscity.com/nba-top-shot/moment/9")
    const flat = JSON.stringify(embed)
    expect(flat).toContain("$12.50")
    expect(flat).toContain("$20.00")
    expect(flat).toContain("Top Shot")
  })

  it("the email body carries them in both the html and text parts", () => {
    const { html, text, subject } = buildEmailMessage([d])
    expect(subject).toBeTruthy()
    for (const body of [html, text]) {
      expect(body).toContain("$12.50")
      expect(body).toContain("Damian Lillard")
    }
    expect(html).toContain("https://www.rippackscity.com/nba-top-shot/moment/9")
  })
})
