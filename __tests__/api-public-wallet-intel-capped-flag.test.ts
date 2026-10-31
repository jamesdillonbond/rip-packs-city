import { describe, it, expect, vi } from "vitest"

// #215 (2026-10-30) — the /share/<wallet> card marked a capped ASK_ONLY highlight
// "from asks". The route now adds fmv_capped per highlight via lib/fmv-capped.

const st = vi.hoisted(() => ({
  summary: null as any,
  editions: { data: [{ id: "u1", external_id: "257:8869" }], error: null } as any,
  wide: { data: [{ edition_id: "u1", fmv_usd: 40, algo_version: "ts_histcap" }], error: null } as any,
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => {
    const builder: any = {}
    for (const m of ["select", "eq", "in", "limit"]) builder[m] = () => builder
    builder.then = (resolve: any) => resolve(st.editions)
    return {
      from: () => builder,
      rpc: async (name: string) =>
        name === "get_wallet_intel_summary" ? { data: st.summary, error: null } : st.wide,
    }
  },
}))

import { GET } from "@/app/api/public/wallet-intel/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any
const URL_OK = "https://t/api/public/wallet-intel?wallet=0xbd94cade097e50ac"

describe("GET /api/public/wallet-intel — fmv_capped (#215)", () => {
  it("flags a capped ASK_ONLY highlight; leaves a sales-backed one unchecked", async () => {
    st.summary = { highlights: [
      { external_id: "257:8869", fmv_usd: 40, confidence: "ASK_ONLY" },
      { external_id: "1:2", fmv_usd: 9, confidence: "HIGH" },
    ] }
    const body = await (await GET(req(URL_OK))).json()
    expect(body.highlights[0].fmv_capped).toBe(true)
    expect(body.highlights[1].fmv_capped).toBeNull()
  })

  it("a failed lookup still answers 200 with the highlight unchecked", async () => {
    st.summary = { highlights: [{ external_id: "257:8869", fmv_usd: 40, confidence: "ASK_ONLY" }] }
    st.editions = { data: null, error: { message: "boom" } }
    const res = await GET(req(URL_OK))
    expect(res.status).toBe(200)
    expect((await res.json()).highlights[0].fmv_capped).toBeNull()
  })
})
