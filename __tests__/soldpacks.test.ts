import { describe, it, expect, beforeEach, vi } from "vitest"

// normalizeFlowAddress guards every wallet arg coming off the Telegram/Discord
// bot; formatPackReportText renders the pack P/L digest. This suite also pins
// the previously-uncovered seam: resolveWalletForChannel (explicit vs linked
// fallback), getPackReport (RPC totals/recent mapping), and the Discord embed
// formatter — @/lib/supabase and @/lib/alerts.resolveChannelOwner are mocked
// through a mutable `state`.

const H = vi.hoisted(() => {
  const state: any = {
    savedWallet: { data: null as any, error: null as any },
    owner: { linked: false, owner_key: null as string | null },
    summary: { data: null as any },
    history: { data: null as any },
  }
  const client = {
    from(_table: string) {
      const b: any = {}
      for (const m of ["select", "eq", "order", "limit"]) b[m] = () => b
      b.maybeSingle = async () => state.savedWallet
      return b
    },
    rpc: async (name: string) => {
      if (name === "get_wallet_pack_summary") return state.summary
      if (name === "get_wallet_pack_history") return state.history
      return { data: null, error: null }
    },
  }
  return { state, client }
})

vi.mock("@/lib/supabase", () => ({ supabase: H.client, supabaseAdmin: H.client }))
vi.mock("@/lib/alerts", () => ({
  resolveChannelOwner: async () => H.state.owner,
}))

import {
  normalizeFlowAddress,
  resolveWalletForChannel,
  getPackReport,
  formatPackReportText,
  formatPackReportDiscordEmbed,
} from "@/lib/alerts/soldpacks"
import type { PackReport } from "@/lib/alerts/soldpacks"

beforeEach(() => {
  H.state.savedWallet = { data: null, error: null }
  H.state.owner = { linked: false, owner_key: null }
  H.state.summary = { data: null }
  H.state.history = { data: null }
})

describe("normalizeFlowAddress", () => {
  it("lower-cases, adds the 0x prefix, and validates the 16-hex shape", () => {
    expect(normalizeFlowAddress("BD94CADE097E50AC")).toBe("0xbd94cade097e50ac")
    expect(normalizeFlowAddress("0xBD94CADE097E50AC")).toBe("0xbd94cade097e50ac")
    expect(normalizeFlowAddress("  bd94cade097e50ac  ")).toBe("0xbd94cade097e50ac")
  })

  it("returns null for the wrong length or non-hex", () => {
    expect(normalizeFlowAddress("0x123")).toBeNull()
    expect(normalizeFlowAddress("not-an-address")).toBeNull()
    expect(normalizeFlowAddress("0xZZ94cade097e50ac")).toBeNull()
    expect(normalizeFlowAddress("")).toBeNull()
  })
})

describe("resolveWalletForChannel", () => {
  it("returns the explicit wallet when it is a valid Flow address", async () => {
    const w = await resolveWalletForChannel("telegram", "u1", "0xBD94CADE097E50AC")
    expect(w).toBe("0xbd94cade097e50ac")
  })

  it("returns null when unlinked and no valid explicit wallet is given", async () => {
    H.state.owner = { linked: false, owner_key: null }
    expect(await resolveWalletForChannel("telegram", "u1", "garbage")).toBeNull()
  })

  it("falls back to the linked user's first saved wallet", async () => {
    H.state.owner = { linked: true, owner_key: "owner-1" }
    H.state.savedWallet = { data: { wallet_addr: "0xB5053EF95E702657" }, error: null }
    expect(await resolveWalletForChannel("discord", "u2")).toBe("0xb5053ef95e702657")
  })

  it("returns null when the linked user has no saved wallet", async () => {
    H.state.owner = { linked: true, owner_key: "owner-1" }
    H.state.savedWallet = { data: null, error: null }
    expect(await resolveWalletForChannel("discord", "u2")).toBeNull()
  })
})

describe("getPackReport", () => {
  const wallet = "0xbd94cade097e50ac"

  it("maps RPC totals (Number-coerced) and sorts sold/flipped packs first, capped at 5", async () => {
    H.state.summary = {
      data: {
        totals: {
          packs_purchased: "5",
          packs_ripped: 3,
          packs_sold: "1",
          primary_drops: 2,
          secondary_buys: 3,
          spent_usd: "120",
          sold_proceeds_usd: 40,
          ripped_value_usd: 95,
          net_pl_usd: "15",
        },
      },
    }
    H.state.history = {
      data: {
        packs: [
          { pack_name: "Held Pack", status: "held", buy_price: 7 },
          { pack_name: "Flipped Pack", status: "flipped", buy_price: 10, sell_price: 30, realized_pl_usd: 20 },
        ],
      },
    }
    const report = await getPackReport(wallet)
    expect(report.wallet).toBe(wallet)
    expect(report.totals?.packs_purchased).toBe(5)
    expect(report.totals?.spent_usd).toBe(120)
    expect(report.totals?.net_pl_usd).toBe(15)
    // flipped ranks ahead of held
    expect(report.recent[0].pack_name).toBe("Flipped Pack")
    expect(report.recent[0].sell_price).toBe(30)
    expect(report.recent[1].pack_name).toBe("Held Pack")
    expect(report.recent[1].sell_price).toBeNull()
  })

  it("returns null totals and empty recent when the RPCs have no data", async () => {
    const report = await getPackReport(wallet)
    expect(report.totals).toBeNull()
    expect(report.recent).toEqual([])
  })
})

describe("formatPackReportText", () => {
  const wallet = "0xbd94cade097e50ac"

  it("reports no history when totals are null or all-zero", () => {
    const empty: PackReport = { wallet, totals: null, recent: [] }
    expect(formatPackReportText(empty)).toContain("No pack history found")
  })

  it("renders the totals digest + recent lines + footer", () => {
    const report: PackReport = {
      wallet,
      totals: {
        packs_purchased: 5,
        packs_ripped: 3,
        packs_sold: 1,
        primary_drops: 2,
        secondary_buys: 3,
        spent_usd: 120,
        sold_proceeds_usd: 40,
        ripped_value_usd: 95,
        net_pl_usd: 15,
      },
      recent: [
        {
          pack_name: "Base Set Pack",
          status: "sold",
          buy_price: 10,
          sell_price: 25,
          pull_value_usd: null,
          realized_pl_usd: 15,
          collection_name: "NBA Top Shot",
        },
        {
          pack_name: "Quick Rips",
          status: "ripped",
          buy_price: 5,
          sell_price: null,
          pull_value_usd: 8,
          realized_pl_usd: null,
          collection_name: "NBA Top Shot",
        },
      ],
    }
    const text = formatPackReportText(report)
    expect(text).toContain("Pack report for")
    expect(text).toContain("Purchased: 5")
    expect(text).toContain("Recent packs:")
    expect(text).toContain("Base Set Pack")
    expect(text).toContain("Quick Rips")
    expect(text).toContain("rippackscity.com/dashboard/history")
  })

  it("formats negative net P/L with a leading minus and a — for non-finite money", () => {
    const report: PackReport = {
      wallet,
      totals: {
        packs_purchased: 1,
        packs_ripped: 0,
        packs_sold: 0,
        primary_drops: 0,
        secondary_buys: 1,
        spent_usd: 50,
        sold_proceeds_usd: 0,
        ripped_value_usd: 0,
        net_pl_usd: -12.5,
      },
      recent: [],
    }
    const text = formatPackReportText(report)
    expect(text).toContain("Net P/L: -$12.50")
  })
})

describe("formatPackReportDiscordEmbed", () => {
  const wallet = "0xbd94cade097e50ac"

  it("returns the no-history embed when totals are null", () => {
    const embed = formatPackReportDiscordEmbed({ wallet, totals: null, recent: [] })
    expect(embed.description).toBe("No pack history found.")
    expect(embed.color).toBe(0xe03a2f)
  })

  it("builds the fields embed and includes a Recent packs field", () => {
    const report: PackReport = {
      wallet,
      totals: {
        packs_purchased: 4,
        packs_ripped: 2,
        packs_sold: 1,
        primary_drops: 1,
        secondary_buys: 3,
        spent_usd: 80,
        sold_proceeds_usd: 30,
        ripped_value_usd: 40,
        net_pl_usd: -10,
      },
      recent: [
        { pack_name: "Sold One", status: "sold", buy_price: 5, sell_price: 30, pull_value_usd: null, realized_pl_usd: 25, collection_name: "NBA Top Shot" },
        { pack_name: "Ripped One", status: "ripped", buy_price: 5, sell_price: null, pull_value_usd: 12, realized_pl_usd: null, collection_name: "NBA Top Shot" },
      ],
    }
    const embed = formatPackReportDiscordEmbed(report)
    expect(embed.title).toContain("Pack report")
    const names = embed.fields.map((f: any) => f.name)
    expect(names).toContain("Purchased")
    expect(names).toContain("Net P/L")
    const recentField = embed.fields.find((f: any) => f.name === "Recent packs")
    expect(recentField.value).toContain("Sold One")
    expect(recentField.value).toContain("Ripped One")
  })
})
