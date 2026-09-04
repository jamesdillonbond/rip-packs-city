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

// ── Price-only deals carry no FMV, and the message must not pretend otherwise ─
//
// A subscription that says only "≤ $0.60" has no FMV condition, so the scanner
// serves it from `edition_current_ask` where fmv_usd / discount_pct are NULL by
// design (audit_20260816). Every render site used to interpolate
// `${pct(discount_pct)} below FMV ${money(fmv)}` unconditionally, which on such
// a row reads "— below FMV —" — an em-dash sentence that looks like a broken
// template and implies we know an FMV we failed to show.
//
// ⚠ PINNED IN BOTH DIRECTIONS. A deal that DOES carry an FMV must keep stating
// it: a fix that blanks the clause everywhere would silently strip the single
// most useful number from every ordinary deal alert, and would still pass a
// test that only checked the price-only case.
describe("price-only deals (no FMV context)", () => {
  const priceOnly = {
    price_only: true,
    fmv_usd: null,
    serial_fmv_usd: null,
    discount_pct: null,
    discount_usd: null,
    low_ask: 0.55,
    ask_usd: null,
    detail_url: "/nba-top-shot/edition/48%3A1652",
    nft_id: null,
  } as Partial<DealPayload["deal"]>

  it("telegram states the ask alone, with no FMV clause and no em-dash", () => {
    const msg = buildTelegramMessage([dealDelivery(priceOnly)])
    expect(msg).toContain("$0.55 ask")
    expect(msg).not.toContain("below FMV")
    expect(msg).not.toContain("—")
  })

  it("telegram still states the FMV clause on a deal that has one", () => {
    const msg = buildTelegramMessage([
      dealDelivery({ low_ask: 12, fmv_usd: 16, discount_pct: 25, ask_usd: null }),
    ])
    expect(msg).toContain("$12.00 ask")
    expect(msg).toContain("25% below FMV $16.00")
  })

  it("discord OMITS the FMV + Discount fields rather than showing an em-dash", () => {
    const [embed] = buildDiscordEmbeds([dealDelivery(priceOnly)])
    const names = embed.fields.map((f: { name: string }) => f.name)
    expect(names).toContain("Ask")
    expect(names).not.toContain("FMV")
    expect(names).not.toContain("Discount")
    expect(embed.fields.find((f: { name: string }) => f.name === "Ask").value).toBe("$0.55")
  })

  it("discord keeps FMV + Discount on a deal that has them", () => {
    const [embed] = buildDiscordEmbeds([
      dealDelivery({ low_ask: 12, fmv_usd: 16, discount_pct: 25, ask_usd: null }),
    ])
    const names = embed.fields.map((f: { name: string }) => f.name)
    expect(names).toEqual(expect.arrayContaining(["Ask", "FMV", "Discount"]))
  })

  it("email html + text omit the clause without leaving a stray parenthesis", () => {
    const { html, text } = buildEmailMessage([dealDelivery(priceOnly)])
    expect(html).toContain("$0.55")
    expect(html).not.toContain("below FMV")
    expect(text).toContain("— $0.55")
    expect(text).not.toContain("below FMV")
    expect(text).not.toContain("()")
  })

  // ⚠ THE DISCRIMINATOR IS AVAILABILITY, NOT THE `price_only` FLAG. This case
  // is what makes that a real distinction rather than a comment: a legacy
  // deals-board row with a missing FMV and NO flag must also omit the clause.
  // Re-pointing `hasFmvContext` at `d.price_only === true` reds exactly here.
  it("a row with a null FMV but no price_only flag also omits the clause", () => {
    const msg = buildTelegramMessage([
      dealDelivery({ fmv_usd: null, serial_fmv_usd: null, discount_pct: null, low_ask: 3, ask_usd: null }),
    ])
    expect(msg).toContain("$3.00 ask")
    expect(msg).not.toContain("below FMV")
  })
})

// ── The ask's age is SAID (2026-09-04) ──────────────────────────────────────
//
// `ask_updated_at` rode the whole deal-alert chain and was never rendered, so
// "25% below FMV" could be mailed off an ask last seen 23 hours earlier (inbox
// 2026-08-29T1605Z). Dropping stale asks is a product threshold; saying their
// age is not. Pinned on all three channels with a fixed clock, both directions:
// a stale ask carries the warning, a fresh one does not, an unknown one says
// nothing (it must not read as fresh, and it must not invent an age).
describe("deal alerts state how old the ask is", () => {
  const NOW = new Date("2026-09-04T12:00:00Z")
  const stale = { ask_usd: 10, ask_updated_at: "2026-09-03T13:00:00Z" } // 23h
  const fresh = { ask_usd: 10, ask_updated_at: "2026-09-04T11:55:00Z" } // 5m
  const older = { ask_usd: 10, ask_updated_at: "2026-09-01T12:00:00Z" } // 3d

  it("telegram: a 23h-old ask is named and flagged as possibly gone; a 5m-old one is named without the flag", () => {
    const s = buildTelegramMessage([dealDelivery(stale)], NOW)
    expect(s).toContain("ask seen 23h ago — may be gone")
    const f = buildTelegramMessage([dealDelivery(fresh)], NOW)
    expect(f).toContain("ask seen 5m ago")
    expect(f).not.toContain("may be gone")
    expect(buildTelegramMessage([dealDelivery(older)], NOW)).toContain("ask seen 3d ago — may be gone")
  })

  it("telegram: an UNKNOWN stamp renders no age at all — not fresh, not invented", () => {
    const s = buildTelegramMessage([dealDelivery({ ask_usd: 10, ask_updated_at: null })], NOW)
    expect(s).not.toContain("ask seen")
    expect(s).not.toContain("may be gone")
  })

  it("discord: the age is its own field, stale flagged", () => {
    const embeds = buildDiscordEmbeds([dealDelivery(stale)], NOW)
    const field = embeds[0].fields.find((f: any) => f.name === "Ask seen")
    expect(field?.value).toBe("23h ago — may be gone")
    const none = buildDiscordEmbeds([dealDelivery({ ask_usd: 10, ask_updated_at: null })], NOW)
    expect(none[0].fields.some((f: any) => f.name === "Ask seen")).toBe(false)
  })

  it("email: the age line is present when known and absent when not", () => {
    const withAge = buildEmailMessage([dealDelivery(stale)], NOW)
    expect(JSON.stringify(withAge)).toContain("ask seen 23h ago — may be gone")
    const without = buildEmailMessage([dealDelivery({ ask_usd: 10, ask_updated_at: null })], NOW)
    expect(JSON.stringify(without)).not.toContain("ask seen")
  })
})
