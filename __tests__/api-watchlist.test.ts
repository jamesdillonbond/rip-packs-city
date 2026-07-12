import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: [], error: null }), from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) }) },
}))
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => null }))

import { GET, POST } from "@/app/api/watchlist/route"

const get = (qs: string) => GET({ nextUrl: new URL(`https://t/api/watchlist?${qs}`) } as any)
const post = (body: any) => POST(new Request("https://t/api/watchlist", { method: "POST", body: JSON.stringify(body) }) as any)

describe("/api/watchlist guards", () => {
  it("GET 400s without owner_key", async () => {
    expect((await get("")).status).toBe(400)
  })
  it("POST 400s without owner_key", async () => {
    expect((await post({ edition_key: "73:2785" })).status).toBe(400)
  })
  it("POST 400s without edition_key", async () => {
    expect((await post({ owner_key: "trevor" })).status).toBe(400)
  })
})
