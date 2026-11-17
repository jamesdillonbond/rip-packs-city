import { describe, it, expect, vi, beforeEach } from "vitest"

// GET/HEAD /go/a/<delivery id> — the tracked redirect behind every alert buy link
// (audit_20260930). Pins: the destination comes from the DELIVERY ROW, never the
// URL (not an open redirect); a click row is written with source "alert", the
// collection, the moment and the delivery; a failed write still redirects; HEAD
// (a link-preview probe) writes nothing; an unknown id goes to /alerts.

const ID = "3f1c2b9a-6d4e-4f8a-9b7c-1a2b3c4d5e6f"
const OWNER = "bbbbbbbb-0000-4000-8000-000000000001"

const state: { row: any; readError: any; insertError: any; inserted: any[] } = {
  row: null, readError: null, insertError: null, inserted: [],
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (t: string) => {
      if (t === "alert_deliveries") {
        const q: any = {
          select: () => q,
          eq: () => q,
          maybeSingle: async () => ({ data: state.row, error: state.readError }),
        }
        return q
      }
      return {
        insert: async (r: any) => {
          state.inserted.push(r)
          return { error: state.insertError }
        },
      }
    },
  }),
}))

import { GET, HEAD } from "@/app/go/a/[id]/route"

function req(id: string, qs = "?l=buy", ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) Version/26.0 Safari") {
  const url = new URL(`https://www.rippackscity.com/go/a/${id}${qs}`)
  return [{ nextUrl: url, headers: new Headers({ "user-agent": ua }) } as any, { params: Promise.resolve({ id }) }] as const
}

function dealRow(deal: Record<string, unknown> = {}) {
  return {
    id: ID, owner_key: OWNER, channel: "telegram", alert_kind: "deal",
    payload: { deal: {
      external_id: "51:1878", collection_slug: "nba_top_shot", nft_id: "16818", low_ask: 0.25,
      player_name: "Greg Brown III", set_name: "Hustle and Show", tier: "COMMON",
      detail_url: "/nba-top-shot/edition/51%3A1878", listing_url: "https://dapper.market/nba/moment/16818", ...deal,
    } },
  }
}

beforeEach(() => {
  state.row = dealRow(); state.readError = null; state.insertError = null; state.inserted = []
})

describe("/go/a/<delivery> — tracked alert redirect", () => {
  it("buy → 302 to the moment on Top Shot, and records the click with its collection and moment", async () => {
    const res = await GET(...req(ID))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://nbatopshot.com/moment/16818")
    expect(state.inserted).toHaveLength(1)
    const r = state.inserted[0]
    expect(r).toMatchObject({
      source: "alert", surface: "alert", collection_slug: "nba_top_shot", moment_id: "16818",
      edition_key: "51:1878", ask_price_usd: 0.25, alert_delivery_id: ID, channel: "telegram",
      user_id: OWNER, bot_ua: false, buy_url: "https://nbatopshot.com/moment/16818",
    })
  })

  it("dapper → 302 to the Dapper listing", async () => {
    const res = await GET(...req(ID, "?l=dapper"))
    expect(res.headers.get("location")).toBe("https://dapper.market/nba/moment/16818")
    expect(state.inserted[0].link_kind).toBe("dapper")
  })

  it("is NOT an open redirect: a URL in the query is ignored", async () => {
    const res = await GET(...req(ID, "?l=https://evil.example/&to=https://evil.example/"))
    expect(res.headers.get("location")).toBe("https://nbatopshot.com/moment/16818")
    expect(res.headers.get("location")).not.toContain("evil")
  })

  it("an unknown or malformed id goes to /alerts and records nothing", async () => {
    state.row = null
    const a = await GET(...req(ID))
    expect(a.headers.get("location")).toBe("https://www.rippackscity.com/alerts")
    const b = await GET(...req("not-a-uuid"))
    expect(b.headers.get("location")).toBe("https://www.rippackscity.com/alerts")
    expect(state.inserted).toHaveLength(0)
  })

  it("a deal with no buy link goes to its RPC page — never a guessed marketplace URL", async () => {
    state.row = dealRow({ nft_id: null })
    const res = await GET(...req(ID))
    expect(res.headers.get("location")).toBe("https://www.rippackscity.com/nba-top-shot/edition/51%3A1878")
  })

  it("a FAILED click write still redirects (the purchase is never blocked)", async () => {
    state.insertError = { message: "boom" }
    const res = await GET(...req(ID))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://nbatopshot.com/moment/16818")
  })

  it("a link-preview bot's GET is recorded but flagged bot_ua", async () => {
    await GET(...req(ID, "?l=buy", "TelegramBot (like TwitterBot)"))
    expect(state.inserted[0].bot_ua).toBe(true)
  })

  it("HEAD (a probe) resolves the same destination and records NOTHING", async () => {
    const res = await HEAD(...req(ID))
    expect(res.headers.get("location")).toBe("https://nbatopshot.com/moment/16818")
    expect(state.inserted).toHaveLength(0)
  })
})
