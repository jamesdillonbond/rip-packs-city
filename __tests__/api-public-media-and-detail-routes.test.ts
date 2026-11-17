import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// ─────────────────────────────────────────────────────────────────────────────
// Four PUBLIC, user-facing dynamic routes that had NO test importing their
// module — so they sat at ~0% in the primary gate with nothing guarding the
// branches that matter to visitors and to the hosting bill:
//
//   · /api/moment/[id]                     — social-share moment detail JSON
//   · /api/public/profile/[username]       — shareable public profile bundle
//   · /api/public/ipfs-media/[cid]         — IPFS media proxy (SSRF + cost gate)
//   · /api/public/pinnacle-image/[renderId]— signed-URL image resolver (SSRF gate)
//
// The two media proxies each carry a regex that is the ONLY thing standing
// between an attacker-supplied path segment and a server-side fetch (SSRF), plus
// — for ipfs-media — the 8 MB size gate that turns a 16-23 MB video from an
// un-amortised Fast-Data-Transfer charge (the 2026-07-27 alert) into a 302 to
// the gateway. A regression in either is invisible without a test.
// ─────────────────────────────────────────────────────────────────────────────

// ── /api/moment/[id] ────────────────────────────────────────────────────────
const momentState = vi.hoisted(() => ({
  rpc: { data: null as unknown, error: null as { message: string } | null },
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (_fn: string, _args: unknown) => momentState.rpc,
  },
}))

// ── /api/public/profile/[username] ──────────────────────────────────────────
const profileState = vi.hoisted(() => ({
  result: {} as Record<string, unknown>,
}))
vi.mock("@/lib/profile/public-profile", () => ({
  getPublicProfile: async () => profileState.result,
}))

import { GET as momentGET } from "@/app/api/moment/[id]/route"
import { GET as profileGET } from "@/app/api/public/profile/[username]/route"
import { GET as ipfsGET } from "@/app/api/public/ipfs-media/[cid]/route"
import { GET as pinnacleGET } from "@/app/api/public/pinnacle-image/[renderId]/route"

const p = <T,>(v: T) => Promise.resolve(v)
const nreq = (u: string) => new NextRequest(u)

beforeEach(() => {
  momentState.rpc = { data: null, error: null }
  profileState.result = {}
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("GET /api/moment/[id]", () => {
  it("400s on a missing id", async () => {
    const res = await momentGET(nreq("https://t/api/moment/"), { params: p({ id: "" }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("missing_id")
  })

  it("500s WITHOUT the RPC message on an RPC error", async () => {
    momentState.rpc = { data: null, error: { message: "boom" } }
    const res = await momentGET(nreq("https://t/api/moment/5"), { params: p({ id: "5" }) })
    expect(res.status).toBe(500)
    // The driver message must NOT be published — lib/api-error.ts classifies it.
    expect((await res.json()).error).not.toContain("boom")
  })

  it("404s when the RPC returns a payload with ok:false", async () => {
    momentState.rpc = { data: { ok: false, error: "not_found" }, error: null }
    const res = await momentGET(nreq("https://t/api/moment/x"), { params: p({ id: "x" }) })
    expect(res.status).toBe(404)
  })

  it("404s (synthesising not_found) when the RPC returns null data", async () => {
    momentState.rpc = { data: null, error: null }
    const res = await momentGET(nreq("https://t/api/moment/x"), { params: p({ id: "x" }) })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.input).toBe("x")
  })

  it("200s with a cache header on a resolved moment", async () => {
    momentState.rpc = { data: { ok: true, edition: { id: "e1" } }, error: null }
    const res = await momentGET(nreq("https://t/api/moment/6"), { params: p({ id: "6" }) })
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toContain("max-age=60")
  })
})

describe("GET /api/public/profile/[username]", () => {
  it("returns the data payload on success", async () => {
    profileState.result = { ok: true, data: { username: "trevor", trophies: [] } }
    const res = await profileGET(nreq("https://t/api/public/profile/trevor"), {
      params: p({ username: "trevor" }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).username).toBe("trevor")
  })

  it("propagates a 400 error body", async () => {
    profileState.result = { ok: false, status: 400, error: "bad_username" }
    const res = await profileGET(nreq("https://t/api/public/profile/x"), {
      params: p({ username: "x" }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("bad_username")
  })

  it("echoes { username } on a 404", async () => {
    profileState.result = { ok: false, status: 404, error: "not_found", username: "ghost" }
    const res = await profileGET(nreq("https://t/api/public/profile/ghost"), {
      params: p({ username: "ghost" }),
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe("not_found")
    expect(body.username).toBe("ghost")
  })

  it("returns a 500 error body", async () => {
    profileState.result = { ok: false, status: 500, error: "db_down" }
    const res = await profileGET(nreq("https://t/api/public/profile/x"), {
      params: p({ username: "x" }),
    })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db_down")
  })
})

describe("GET /api/public/ipfs-media/[cid]", () => {
  const validCid = "Qm" + "a".repeat(44) // CIDv0 shape the SSRF regex accepts

  it("400s on a CID the SSRF allowlist rejects (no fetch)", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const res = await ipfsGET(nreq("https://t/api/public/ipfs-media/..%2Fetc"), {
      params: p({ cid: "../etc" }),
    })
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("502s when the upstream gateway fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("timeout") }))
    const res = await ipfsGET(nreq("https://t/x"), { params: p({ cid: validCid }) })
    expect(res.status).toBe(502)
  })

  it("propagates a non-ok upstream status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })))
    const res = await ipfsGET(nreq("https://t/x"), { params: p({ cid: validCid }) })
    expect(res.status).toBe(404)
  })

  it("302-redirects an oversize object to the gateway instead of streaming it", async () => {
    const big = new Response("x", {
      status: 200,
      headers: { "content-length": String(9 * 1024 * 1024), "content-type": "video/mp4" },
    })
    vi.stubGlobal("fetch", vi.fn(async () => big))
    const res = await ipfsGET(nreq("https://t/x"), { params: p({ cid: validCid }) })
    expect(res.status).toBe(302)
    // The gateway that ANSWERED, not a hardcoded host: since 2026-09-05 this
    // route races a gateway list and must redirect to whichever one replied.
    expect(res.headers.get("location")).toBe(`https://ipfs.dapperlabs.com/ipfs/${validCid}`)
  })

  it("streams an in-budget object with the immutable cache header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("PNGBYTES", { status: 200, headers: { "content-type": "image/png" } }))
    )
    const res = await ipfsGET(nreq("https://t/x"), { params: p({ cid: validCid }) })
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/png")
    expect(res.headers.get("Cache-Control")).toContain("immutable")
  })
})

describe("GET /api/public/pinnacle-image/[renderId]", () => {
  const rid = "OEV1-SOUL-JGAR-S2"
  const gqlOk = (medias: Array<{ name: string; url: string }>) =>
    new Response(
      JSON.stringify({ data: { searchPinnacleEditions: { edges: [{ node: { render_id: rid, medias } }] } } }),
      { status: 200, headers: { "content-type": "application/json" } }
    )

  it("400s on a render_id the SSRF allowlist rejects (no fetch)", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const res = await pinnacleGET(nreq("https://t/x"), { params: p({ renderId: "bad/slug" }) })
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("404s when the GraphQL fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net") }))
    const res = await pinnacleGET(nreq("https://t/x"), { params: p({ renderId: rid }) })
    expect(res.status).toBe(404)
  })

  it("404s on a non-ok GraphQL response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })))
    const res = await pinnacleGET(nreq("https://t/x"), { params: p({ renderId: rid }) })
    expect(res.status).toBe(404)
  })

  it("404s when the GraphQL payload carries errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "x" }] }), { status: 200 })))
    const res = await pinnacleGET(nreq("https://t/x"), { params: p({ renderId: rid }) })
    expect(res.status).toBe(404)
  })

  it("404s when no medias resolve", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => gqlOk([])))
    const res = await pinnacleGET(nreq("https://t/x"), { params: p({ renderId: rid }) })
    expect(res.status).toBe(404)
  })

  it("302-redirects to the resolved Front_Transparent signed URL by default", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => gqlOk([
        { name: "Front_Cropped", url: "https://signed/cropped.png" },
        { name: "Front_Transparent", url: "https://signed/front.png" },
      ]))
    )
    const res = await pinnacleGET(nreq("https://t/x"), { params: p({ renderId: rid }) })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://signed/front.png")
  })

  it("prefers the quarter render when ?v=quarter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => gqlOk([
        { name: "Front_Transparent", url: "https://signed/front.png" },
        { name: "Front_Quarter_Transparent", url: "https://signed/quarter.png" },
      ]))
    )
    const res = await pinnacleGET(nreq("https://t/x?v=quarter"), { params: p({ renderId: rid }) })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://signed/quarter.png")
  })

  it("falls back through the media order when the primary is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => gqlOk([{ name: "Front_Cropped", url: "https://signed/cropped.png" }]))
    )
    const res = await pinnacleGET(nreq("https://t/x"), { params: p({ renderId: rid }) })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://signed/cropped.png")
  })
})
