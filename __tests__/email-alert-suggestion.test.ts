// The Day-1 / weekly email's "alert on the player you own most of" (2026-11-20).
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => {
      throw new Error("db down")
    },
  },
}))

import {
  alertSuggestionLine,
  alertSuggestionUrl,
  buildWeeklyAlertBlock,
  loadAlertSuggestion,
  pickTopPlayer,
  type AlertSuggestion,
} from "@/lib/emails/alert-suggestion"
import { readAlertPrefill } from "@/lib/sniper/saved-filters"
import { buildDay1Html, buildDay1Text } from "@/lib/emails/day1-onboarding-email"

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const AD = "dee28451-5d62-409e-a1ad-a83f763ac070"
const PIN = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
const SITE = "https://www.rippackscity.com"
const S: AlertSuggestion = { player: "Cooper Flagg", collectionId: TS, collectionLabel: "Top Shot" }

describe("pickTopPlayer", () => {
  it("picks the player with the highest SUMMED value, not the single priciest moment", () => {
    const pick = pickTopPlayer([
      { player_name: "LeBron James", fmv_usd: 50, collection_id: TS },
      { player_name: "Cooper Flagg", fmv_usd: "30", collection_id: TS },
      { player_name: "Cooper Flagg", fmv_usd: 30, collection_id: TS },
    ])
    expect(pick).toEqual({ player: "Cooper Flagg", collectionId: TS, collectionLabel: "Top Shot" })
  })
  it("ignores collections the suggestion does not cover, missing names and unpriced rows", () => {
    expect(pickTopPlayer([
      { player_name: "Mickey Mouse", fmv_usd: 999, collection_id: PIN },
      { player_name: null, fmv_usd: 999, collection_id: TS },
      { player_name: "Josh Allen", fmv_usd: null, collection_id: AD },
      { player_name: "Josh Allen", fmv_usd: 0, collection_id: AD },
    ])).toBeNull()
  })
  it("keeps the same name in two collections apart", () => {
    const pick = pickTopPlayer([
      { player_name: "Same Name", fmv_usd: 10, collection_id: TS },
      { player_name: "Same Name", fmv_usd: 12, collection_id: AD },
    ])
    expect(pick?.collectionId).toBe(AD)
    expect(pick?.collectionLabel).toBe("All Day")
  })
  it("returns null for no rows (zero population)", () => {
    expect(pickTopPlayer([])).toBeNull()
  })
})

describe("the link lands on /alerts prefilled for that player", () => {
  it("round-trips through readAlertPrefill and is campaign-tagged", () => {
    const url = new URL(alertSuggestionUrl(SITE, S, "day1"))
    expect(url.pathname).toBe("/alerts")
    expect(url.searchParams.get("utm_source")).toBe("email")
    expect(url.searchParams.get("utm_medium")).toBe("day1")
    expect(url.searchParams.get("utm_campaign")).toBe("alert_player")
    const pre = readAlertPrefill(url.search)!
    expect(pre).not.toBeNull()
    expect(pre.from).toBe("email")
    expect(pre.collectionId).toBe(TS)
    expect(pre.player).toBe("Cooper Flagg")
  })
  it("CONTROL: an unknown `from` is still refused", () => {
    expect(readAlertPrefill(`?from=elsewhere&collection=${TS}&player=X`)).toBeNull()
  })
})

describe("Day-1 email", () => {
  process.env.RPC_SENDER_POSTAL_ADDRESS = process.env.RPC_SENDER_POSTAL_ADDRESS || "PO Box 123, Portland, OR 97201"
  const base = { segment: "wallet" as const, username: "cmnkb8", fmvUsd: 1000, momentCount: 10, unsubscribeUrl: "https://u" }
  it("carries the suggestion on the wallet version and drops the generic watch bullet", () => {
    const html = buildDay1Html({ ...base, alertSuggestion: S })
    const text = buildDay1Text({ ...base, alertSuggestion: S })
    expect(html).toContain("Cooper Flagg Top Shot moment")
    expect(html).toContain("/alerts?from=email")
    expect(text).toContain(alertSuggestionLine(S))
    expect(text).not.toContain("Watch an edition you want")
  })
  it("without a suggestion the wallet email is unchanged (generic bullet, no /alerts link)", () => {
    const text = buildDay1Text({ ...base, alertSuggestion: null })
    expect(text).toContain("Watch an edition you want")
    expect(text).not.toContain("/alerts?")
  })
  it("the no_wallet version never carries one", () => {
    const html = buildDay1Html({ ...base, segment: "no_wallet", alertSuggestion: S })
    expect(html).not.toContain("Cooper Flagg")
  })
})

describe("weekly email block", () => {
  it("is empty for no suggestion", () => {
    expect(buildWeeklyAlertBlock(SITE, null)).toEqual({ html: "", text: [] })
  })
  it("links with utm_medium=weekly_digest", () => {
    const b = buildWeeklyAlertBlock(SITE, S)
    expect(b.html).toContain("utm_medium=weekly_digest")
    expect(b.text.join("\n")).toContain("Cooper Flagg")
  })
})

describe("loadAlertSuggestion fails to NO suggestion, never to a claim", () => {
  it("returns null (does not throw) when the database read throws", async () => {
    await expect(loadAlertSuggestion("00000000-0000-0000-0000-000000000000")).resolves.toBeNull()
  })
})
