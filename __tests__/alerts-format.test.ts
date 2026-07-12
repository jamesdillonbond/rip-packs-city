import { describe, it, expect } from "vitest"
import {
  buildTelegramMessage,
  buildDiscordEmbeds,
  buildEmailMessage,
} from "@/lib/alerts/format"
import type { Delivery, DealPayload, FmvPayload } from "@/lib/alerts"

// Pins the per-channel alert digest formatters (Telegram HTML / Discord embeds /
// Resend email). These render dollar/percent values, escape user-derived
// strings, and resolve native-marketplace buy links (with the '_'→'-' slug
// normalization + Pinnacle-has-no-nft_id rule). A regression sends collectors
// broken links or malformed money into their notifications.

function dealDelivery(deal: Partial<DealPayload["deal"]> = {}): Delivery {
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
        tier: "RARE",
        parallel: null,
        collection_slug: "nba_top_shot",
        circulation_count: 222,
        confidence: "HIGH",
        discount_pct: 25,
        discount_usd: 10,
        thumbnail_url: null,
        ...deal,
      },
    } as DealPayload,
  }
}

function fmvDelivery(p: Partial<FmvPayload> = {}): Delivery {
  return {
    id: "f1",
    owner_key: "u1",
    channel: "telegram" as Delivery["channel"],
    channel_user_id: "123",
    alert_kind: "fmv",
    subject_key: null,
    dedup_bucket: null,
    status: "pending",
    attempts: 0,
    payload: {
      alert_id: 1,
      edition_key: "73:2785",
      player_name: "Damian Lillard",
      set_name: "Base Set",
      alert_type: "below",
      threshold: 50,
      current_fmv: 42,
      lowest_ask: 39.5,
      confidence: "HIGH",
      ...p,
    } as FmvPayload,
  }
}

describe("buildTelegramMessage", () => {
  it("empty deliveries → just the manage footer", () => {
    const msg = buildTelegramMessage([])
    expect(msg).toContain("Manage: https://www.rippackscity.com/alerts")
    expect(msg).not.toContain("new deal")
  })

  it("singular vs plural deal header", () => {
    expect(buildTelegramMessage([dealDelivery()])).toContain(
      "1 new deal match your alerts"
    )
    expect(
      buildTelegramMessage([dealDelivery(), dealDelivery()])
    ).toContain("2 new deals match your alerts")
  })

  it("formats money + percent and renders a native buy link for a TS deal", () => {
    const msg = buildTelegramMessage([
      dealDelivery({ nft_id: "999", ask_usd: 1234.5, discount_pct: 25, fmv_usd: 1646 }),
    ])
    expect(msg).toContain("$1,234.50 ask")
    expect(msg).toContain("25% below FMV")
    expect(msg).toContain(
      '<a href="https://nbatopshot.com/moment/999">Buy on Top Shot ↗</a>'
    )
  })

  it("normalizes DB slug '_'→'-' and renders no native link for a Pinnacle deal (no nft_id)", () => {
    const msg = buildTelegramMessage([
      dealDelivery({
        collection_slug: "disney_pinnacle",
        nft_id: null,
        player_name: "Mickey",
      }),
    ])
    expect(msg).not.toContain("Buy on")
  })

  it("HTML-escapes user-derived titles", () => {
    const msg = buildTelegramMessage([
      dealDelivery({ player_name: "A & B <script>" }),
    ])
    expect(msg).toContain("A &amp; B &lt;script&gt;")
    expect(msg).not.toContain("<script>")
  })

  it("renders FMV alerts with their own header", () => {
    const msg = buildTelegramMessage([fmvDelivery()])
    expect(msg).toContain("1 FMV alert triggered")
    expect(msg).toContain("Ask $39.50")
    expect(msg).toContain("FMV $42.00")
  })
})

describe("buildDiscordEmbeds", () => {
  it("caps at 10 embeds", () => {
    const many = Array.from({ length: 15 }, () => dealDelivery())
    expect(buildDiscordEmbeds(many)).toHaveLength(10)
  })

  it("title-cases an upper-case tier in the subline and includes ask/fmv/discount fields", () => {
    const [embed] = buildDiscordEmbeds([
      dealDelivery({ tier: "LEGENDARY", ask_usd: 100, fmv_usd: 200, discount_pct: 50 }),
    ])
    expect(embed.description).toContain("Legendary")
    const fieldNames = embed.fields.map((f: any) => f.name)
    expect(fieldNames).toEqual(expect.arrayContaining(["Ask", "FMV", "Discount"]))
  })

  it("renders a markdown buy link field when nft_id resolves", () => {
    const [embed] = buildDiscordEmbeds([dealDelivery({ nft_id: "999" })])
    const buy = embed.fields.find((f: any) => f.name === "Buy")
    expect(buy.value).toContain("[Top Shot ↗](https://nbatopshot.com/moment/999)")
  })
})

describe("buildEmailMessage", () => {
  it("deal-only subject is deal-specific and singular/plural aware", () => {
    expect(buildEmailMessage([dealDelivery()]).subject).toBe(
      "1 new deal match your Rip Packs City alert"
    )
    expect(
      buildEmailMessage([dealDelivery(), dealDelivery()]).subject
    ).toBe("2 new deals match your Rip Packs City alert")
  })

  it("mixed deal + fmv subject counts the total", () => {
    const { subject } = buildEmailMessage([dealDelivery(), fmvDelivery()])
    expect(subject).toBe("2 Rip Packs City alerts")
  })

  it("returns html + text bodies with the manage link", () => {
    const { html, text } = buildEmailMessage([dealDelivery({ nft_id: "999" })])
    expect(html).toContain("<!doctype html>")
    expect(html).toContain("Manage your alerts")
    expect(text).toContain("Buy on Top Shot: https://nbatopshot.com/moment/999")
    expect(text).toContain("Manage: https://www.rippackscity.com/alerts")
  })
})
