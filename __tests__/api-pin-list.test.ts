import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/pin-list.
// requireUser-gated (fail-closed 401), then wallet-required (400), format
// validation (400), saved_wallets ownership gate (403), then the single-row
// get_wallet_ipfs_pin_export RPC. Pins each pre-RPC guard plus a mocked
// json-format happy path.

const state: { user: any; owned: any; exp: any } = {
  user: null,
  owned: { data: [], error: null },
  exp: { data: {}, error: null },
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b,
      eq: () => b,
      limit: async () => state.owned,
    }
    return b
  }
  const client: any = { from: () => build(), rpc: async () => state.exp }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user)
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    return state.user
  },
  getCurrentUser: async () => state.user,
}))

import { GET } from "@/app/api/pin-list/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.user = null
  state.owned = { data: [], error: null }
  state.exp = { data: {}, error: null }
})

describe("GET /api/pin-list", () => {
  it("401s when unauthenticated", async () => {
    const res = (await GET(req("https://t/api/pin-list?wallet=0xabc"))) as Response
    expect(res.status).toBe(401)
  })

  it("400s without a wallet param", async () => {
    state.user = { id: "u1" }
    const res = await GET(req("https://t/api/pin-list"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet required")
  })

  it("400s on an invalid format", async () => {
    state.user = { id: "u1" }
    const res = await GET(req("https://t/api/pin-list?wallet=0xabc&format=xml"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid format: xml")
  })

  it("403s when the wallet is not saved on this account", async () => {
    state.user = { id: "u1" }
    state.owned = { data: [], error: null }
    const res = await GET(req("https://t/api/pin-list?wallet=0xabc"))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("wallet not saved on this account")
  })

  it("returns the json summary for a saved wallet", async () => {
    state.user = { id: "u1" }
    state.owned = { data: [{ wallet_addr: "0xabc" }], error: null }
    state.exp = {
      data: {
        cid_count: 3,
        total_bytes: 2048,
        video: { count: 1, bytes: 1024 },
        artwork: { count: 2, bytes: 1024 },
        by_type: { VIDEO: 1, ARTWORK: 2 },
        cids_text: "cid1\ncid2\ncid3",
      },
      error: null,
    }
    const res = await GET(req("https://t/api/pin-list?wallet=0xABC"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallet).toBe("0xabc") // lower-cased
    expect(body.cid_count).toBe(3)
    expect(body.total_bytes).toBe(2048)
    expect(body.total_human).toBe("2 KB")
    expect(body.by_type).toEqual({ VIDEO: 1, ARTWORK: 2 })
  })
})

// ── The two download formats + the byte humanizer ────────────────────────────
// This route is the "host your own collection" export: the txt/script bodies
// ARE the deliverable, and neither had a test. The script in particular is
// handed to a collector to run against their own IPFS node, so its shape (a
// bash shebang, `set -euo pipefail`, one idempotent `ipfs pin add` per CID) is
// the contract — a malformed line is a script that dies partway through a
// 27k-CID pin run.
describe("GET /api/pin-list — download formats", () => {
  beforeEach(() => {
    state.user = { id: "u1" }
    state.owned = { data: [{ wallet_addr: "0xabc" }], error: null }
  })

  it("txt returns bare newline-separated CIDs with a trailing newline and a download name", async () => {
    state.exp = { data: { cid_count: 3, total_bytes: 1024, cids_text: "cidA\ncidB\ncidC" }, error: null }
    const res = await GET(req("https://t/api/pin-list?wallet=0xabc&format=txt"))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/plain")
    expect(res.headers.get("content-disposition")).toContain('filename="0xabc-cids.txt"')
    expect(await res.text()).toBe("cidA\ncidB\ncidC\n")
  })

  it("txt emits an empty body (no stray newline) for a wallet with no CIDs", async () => {
    state.exp = { data: { cid_count: 0, cids_text: "  " }, error: null }
    expect(await (await GET(req("https://t/api/pin-list?wallet=0xabc&format=txt"))).text()).toBe("")
  })

  it("script emits a runnable bash file with one idempotent pin per CID", async () => {
    state.exp = { data: { cid_count: 2, total_bytes: 5 * 1024 ** 3, cids_text: "cid1\ncid2" }, error: null }
    const res = await GET(req("https://t/api/pin-list?wallet=0xabc&format=script"))
    const body = await res.text()

    expect(res.headers.get("content-type")).toContain("text/x-shellscript")
    expect(res.headers.get("content-disposition")).toContain('filename="pin-collection-0xabc.sh"')
    expect(body.split("\n")[0]).toBe("#!/usr/bin/env bash")
    expect(body).toContain("set -euo pipefail")
    expect(body).toContain("ipfs pin add cid1")
    expect(body).toContain("ipfs pin add cid2")
    // The header carries the humanized total so the collector knows the cost.
    expect(body).toContain("5.0 GB")
    expect(body).toContain("# Wallet:     0xabc")
  })

  it("humanizes bytes with decimals only from GB up, and 0 B for a missing total", async () => {
    const cases: Array<[number, string]> = [
      [0, "0 B"],
      [512, "512 B"],
      [2048, "2 KB"],
      [5 * 1024 ** 2, "5 MB"],
      [1.5 * 1024 ** 3, "1.5 GB"],
      [3 * 1024 ** 4, "3.0 TB"],
    ]
    for (const [bytes, human] of cases) {
      state.exp = { data: { cid_count: 1, total_bytes: bytes, cids_text: "c" }, error: null }
      const body = await (await GET(req("https://t/api/pin-list?wallet=0xabc"))).json()
      expect(body.total_human, String(bytes)).toBe(human)
    }
  })
})

describe("GET /api/pin-list — summary shape + failures", () => {
  beforeEach(() => {
    state.user = { id: "u1" }
    state.owned = { data: [{ wallet_addr: "0xabc" }], error: null }
  })

  it("splits video vs artwork and passes by_type through, zero-filling absent legs", async () => {
    state.exp = {
      data: {
        cid_count: 7, total_bytes: 100,
        video: { count: 5, bytes: 90 },
        artwork: null,
        by_type: { VIDEO_HERO: 5, ARTWORK: 2 },
        cids_text: "a\nb",
      },
      error: null,
    }
    const body = await (await GET(req("https://t/api/pin-list?wallet=0xabc"))).json()
    expect(body.split).toEqual({ video: { count: 5, bytes: 90 }, artwork: { count: 0, bytes: 0 } })
    expect(body.by_type).toEqual({ VIDEO_HERO: 5, ARTWORK: 2 })
    // The ~27k-CID list is deliberately NOT serialized into the dashboard card.
    expect(body.cids_text).toBeUndefined()
  })

  it("lowercases and trims the wallet before the ownership check and the RPC", async () => {
    state.exp = { data: { cid_count: 0 }, error: null }
    const body = await (await GET(req("https://t/api/pin-list?wallet=%20%200xABC%20"))).json()
    expect(body.wallet).toBe("0xabc")
  })

  it("returns an empty-but-valid summary when the RPC yields nothing", async () => {
    state.exp = { data: null, error: null }
    const body = await (await GET(req("https://t/api/pin-list?wallet=0xabc"))).json()
    expect(body).toMatchObject({ cid_count: 0, total_bytes: 0, total_human: "0 B", by_type: {} })
  })

  it("500s on an RPC error", async () => {
    state.exp = { data: null, error: { message: "pin export rpc down" } }
    const res = await GET(req("https://t/api/pin-list?wallet=0xabc"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("pin export rpc down")
  })

  it("sets a private cache header on every format (never public — it is per-account)", async () => {
    state.exp = { data: { cid_count: 1, cids_text: "c" }, error: null }
    for (const fmt of ["json", "txt", "script"]) {
      const res = await GET(req(`https://t/api/pin-list?wallet=0xabc&format=${fmt}`))
      expect(res.headers.get("cache-control"), fmt).toBe("private, max-age=3600")
    }
  })
})
