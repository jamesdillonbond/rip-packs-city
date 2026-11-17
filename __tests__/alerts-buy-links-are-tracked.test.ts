import { describe, it, expect } from "vitest"
import { buildTelegramMessage, buildDiscordEmbeds, buildEmailMessage, trackedHref } from "@/lib/alerts/format"
import type { Delivery, DealPayload } from "@/lib/alerts"

// audit_20260930 — every marketplace link in a deal alert goes through the
// tracked redirect /go/a/<delivery id>, so an alert-driven purchase can be
// matched to the sale that followed (click_attributed_purchases). Before this,
// alert buy links went straight to the marketplace and NOTHING was recorded.
//
// The negative claim in the title is asserted as an ABSENCE: no raw marketplace
// URL survives in any channel's rendering of a production-shaped (UUID) delivery.

const ID = "3f1c2b9a-6d4e-4f8a-9b7c-1a2b3c4d5e6f"
const GO = `https://www.rippackscity.com/go/a/${ID}`

function delivery(deal: Partial<DealPayload["deal"]> = {}): Delivery {
  return {
    id: ID, owner_key: "u1", channel: "telegram" as Delivery["channel"], channel_user_id: "123",
    alert_kind: "deal", subject_key: null, dedup_bucket: null, status: "pending", attempts: 0,
    payload: {
      subscription_id: "s1", label: null,
      deal: {
        external_id: "51:1878", player_name: "Greg Brown III", set_name: "Hustle and Show", tier: "COMMON",
        parallel: null, collection_slug: "nba_top_shot", circulation_count: 18000, confidence: null,
        discount_pct: null, discount_usd: null, thumbnail_url: null, low_ask: 0.25,
        detail_url: "/nba-top-shot/edition/51%3A1878", nft_id: "16818",
        listing_url: "https://dapper.market/nba/moment/16818",
        ...deal,
      },
    },
  } as Delivery
}

const RAW = [/nbatopshot\.com/, /dapper\.market/]

describe("alert buy links are tracked redirects, never raw marketplace URLs", () => {
  it("trackedHref routes a UUID delivery through /go/a and keeps the direct link otherwise", () => {
    expect(trackedHref(delivery(), "buy", "https://nbatopshot.com/moment/16818")).toBe(`${GO}?l=buy`)
    expect(trackedHref(delivery(), "dapper", "https://dapper.market/x")).toBe(`${GO}?l=dapper`)
    expect(trackedHref({ ...delivery(), id: "not-a-uuid" }, "buy", "https://nbatopshot.com/moment/1")).toBe("https://nbatopshot.com/moment/1")
  })

  it("Telegram: both buy links are tracked; no raw marketplace URL remains; the RPC detail link stays direct", () => {
    const t = buildTelegramMessage([delivery()])
    expect(t).toContain(`<a href="${GO}?l=buy">Buy on Top Shot ↗</a>`)
    expect(t).toContain(`<a href="${GO}?l=dapper">Dapper ↗</a>`)
    for (const r of RAW) expect(t).not.toMatch(r)
    // first link = the RPC page, which the link-preview bot fetches — not the redirect
    expect(t.indexOf("https://www.rippackscity.com/nba-top-shot/edition/51%3A1878")).toBeLessThan(t.indexOf("/go/a/"))
  })

  it("Discord: the Buy field is tracked", () => {
    const e = buildDiscordEmbeds([delivery()])
    const json = JSON.stringify(e)
    expect(json).toContain(`[Top Shot ↗](${GO}?l=buy)`)
    expect(json).toContain(`[Dapper ↗](${GO}?l=dapper)`)
    for (const r of RAW) expect(json).not.toMatch(r)
  })

  it("Email: HTML and plain text are tracked", () => {
    const { html, text } = buildEmailMessage([delivery()])
    expect(html).toContain(`href="${GO}?l=buy"`)
    expect(html).toContain(`href="${GO}?l=dapper"`)
    expect(text).toContain(`Buy on Top Shot: ${GO}?l=buy`)
    expect(text).toContain(`Dapper: ${GO}?l=dapper`)
    for (const r of RAW) {
      expect(html).not.toMatch(r)
      expect(text).not.toMatch(r)
    }
  })

  it("a deal with no buy link renders no redirect at all (nothing to track, nothing invented)", () => {
    const t = buildTelegramMessage([delivery({ nft_id: null, listing_url: null })])
    expect(t).not.toContain("/go/a/")
  })
})
