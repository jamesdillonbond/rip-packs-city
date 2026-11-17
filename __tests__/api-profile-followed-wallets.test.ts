import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// /api/profile/followed-wallets (2026-11-16) — follow a wallet WITHOUT saving it
// as your own. Properties: anon probe answers authed:false (never 401); a
// failed read is an error, never "not following"/"not yours"; your OWN saved
// wallet cannot be followed (409 own_wallet) and probes as own:true; a
// non-address is a 400; the cap is enforced from a read count, never `?? 0`.

const state: { user: any; tables: Record<string, any>; writes: Array<{ table: string; op: string; arg: unknown }> } = {
  user: null,
  tables: {},
  writes: [],
}

function chain(table: string, getResult: () => any): any {
  const b: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (res: any, rej: any) => Promise.resolve(getResult()).then(res, rej)
        if (prop === "upsert" || prop === "delete" || prop === "insert") {
          return (arg: unknown) => {
            state.writes.push({ table, op: String(prop), arg })
            return chain(table, () => state.tables[table + ":" + String(prop)] ?? { data: null, error: null })
          }
        }
        return () => b
      },
    },
  )
  return b
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: (t: string) => chain(t, () => state.tables[t] ?? { data: [], error: null }) },
}))
vi.mock("@/lib/flowty-username", () => ({ resolveUsernames: async () => new Map(), nameKey: (a: string) => a }))
vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user) throw new Response(JSON.stringify({ error: "Authentication required" }), { status: 401 })
    return state.user
  },
  getCurrentUser: async () => state.user,
}))

import { GET, POST, DELETE } from "@/app/api/profile/followed-wallets/route"

const FRIEND = "0xBBBBBBBBBBBBBBBB"
const req = (url: string, method = "GET", body?: unknown) =>
  new NextRequest("http://x" + url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } })

beforeEach(() => {
  state.user = null
  state.tables = {}
  state.writes = []
})

describe("GET ?wallet= probe", () => {
  it("anon → authed:false, 200 (the button renders a sign-in link)", async () => {
    const res = await GET(req("/api/profile/followed-wallets?wallet=" + FRIEND))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ authed: false, following: false, own: false })
  })
  it("non-address → 400", async () => {
    const res = await GET(req("/api/profile/followed-wallets?wallet=not_a_wallet"))
    expect(res.status).toBe(400)
  })
  it("own saved wallet → own:true", async () => {
    state.user = { id: "u1" }
    state.tables.saved_wallets = { data: [{ wallet_addr: "bbbbbbbbbbbbbbbb" }], error: null }
    state.tables.followed_wallets = { data: null, error: null }
    const j = await (await GET(req("/api/profile/followed-wallets?wallet=" + FRIEND))).json()
    expect(j).toEqual({ authed: true, following: false, own: true })
  })
  it("a FAILED own-wallet read is an error, never own:false", async () => {
    state.user = { id: "u1" }
    state.tables.saved_wallets = { data: null, error: { message: "timeout" } }
    const res = await GET(req("/api/profile/followed-wallets?wallet=" + FRIEND))
    expect(res.status).not.toBe(200)
    expect(await res.json()).not.toHaveProperty("own")
  })
})

describe("POST follow", () => {
  it("401 when signed out", async () => {
    expect((await POST(req("/api/profile/followed-wallets", "POST", { wallet: FRIEND }))).status).toBe(401)
  })
  it("refuses to follow your OWN saved wallet (409 own_wallet), writes nothing", async () => {
    state.user = { id: "u1" }
    state.tables.saved_wallets = { data: [{ wallet_addr: "0xbbbbbbbbbbbbbbbb" }], error: null }
    const res = await POST(req("/api/profile/followed-wallets", "POST", { wallet: FRIEND }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("own_wallet")
    expect(state.writes).toEqual([])
  })
  it("enforces the cap; an unreadable count is an error, never 0", async () => {
    state.user = { id: "u1" }
    state.tables.saved_wallets = { data: [], error: null }
    state.tables.followed_wallets = { data: null, error: null, count: null }
    expect((await POST(req("/api/profile/followed-wallets", "POST", { wallet: FRIEND }))).status).toBe(500)
    state.tables.followed_wallets = { data: null, error: null, count: 50 }
    const res = await POST(req("/api/profile/followed-wallets", "POST", { wallet: FRIEND }))
    expect(res.status).toBe(409)
    expect(state.writes).toEqual([])
  })
  it("follows a friend's wallet stored NORMALISED, never touching saved_wallets", async () => {
    state.user = { id: "u1" }
    state.tables.saved_wallets = { data: [], error: null }
    state.tables.followed_wallets = { data: null, error: null, count: 0 }
    const res = await POST(req("/api/profile/followed-wallets", "POST", { wallet: FRIEND }))
    expect(res.status).toBe(200)
    expect(state.writes).toEqual([
      { table: "followed_wallets", op: "upsert", arg: { follower_user_id: "u1", wallet_addr: "0xbbbbbbbbbbbbbbbb" } },
    ])
  })
  it("keeps a base58 (Candy) wallet's case", async () => {
    state.user = { id: "u1" }
    state.tables.saved_wallets = { data: [], error: null }
    state.tables.followed_wallets = { data: null, error: null, count: 0 }
    const CANDY = "12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK"
    await POST(req("/api/profile/followed-wallets", "POST", { wallet: CANDY }))
    expect((state.writes[0].arg as { wallet_addr: string }).wallet_addr).toBe(CANDY)
  })
})

describe("DELETE unfollow", () => {
  it("deletes the edge for a valid wallet; 400 for junk", async () => {
    state.user = { id: "u1" }
    expect((await DELETE(req("/api/profile/followed-wallets", "DELETE", { wallet: "x),y" }))).status).toBe(400)
    const res = await DELETE(req("/api/profile/followed-wallets", "DELETE", { wallet: FRIEND }))
    expect(res.status).toBe(200)
    expect(state.writes.map((w) => w.op)).toEqual(["delete"])
  })
})
