import { describe, it, expect, vi, afterEach } from "vitest"

// SNS name → Solana wallet for the Candy Collection tab (2026-09-25). Pins the
// three outcomes (resolved · name does not resolve · lookup failed), that the
// base58 wallet is passed through VERBATIM (case-sensitive), and that a failed
// lookup is never reported as "not found".

import { parseSnsName, resolveSnsName, SNS_PROXY_BASE } from "@/lib/chains/solana/sns"
import { GET } from "@/app/api/candy/resolve-name/route"

const WALLET = "63p1oKqkAQ9sQD55iApNRkVL2XzYtASwKjCdSSNEGEhY"
const resp = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response
const req = (q: string | null) =>
  ({ nextUrl: new URL("https://t/api/candy/resolve-name" + (q == null ? "" : "?q=" + encodeURIComponent(q))) }) as never

afterEach(() => vi.unstubAllGlobals())

describe("parseSnsName", () => {
  it("accepts .sns / .sol names, lowercases the DOMAIN, strips a leading @", () => {
    expect(parseSnsName("Alice.SNS")).toBe("alice.sns")
    expect(parseSnsName("@bob.sol")).toBe("bob.sol")
    expect(parseSnsName("sub.bob.sol")).toBe("sub.bob.sol")
  })
  it("refuses a wallet address, a bare word and other TLDs", () => {
    expect(parseSnsName(WALLET)).toBeNull()
    expect(parseSnsName("alice")).toBeNull()
    expect(parseSnsName("alice.eth")).toBeNull()
    expect(parseSnsName(42)).toBeNull()
  })
})

describe("resolveSnsName", () => {
  it("resolves and passes the base58 wallet through VERBATIM (case-sensitive)", async () => {
    const f = vi.fn<(url: string) => Promise<Response>>(async () => resp(200, { s: "ok", result: WALLET }))
    const r = await resolveSnsName("alice.sns", f as never)
    expect(r).toEqual({ kind: "resolved", wallet: WALLET })
    expect(String(f.mock.calls[0][0])).toBe(`${SNS_PROXY_BASE}/resolve/alice.sns`)
  })
  it("an 'ok' carrying a non-base58 result is a FAILURE, not a wallet", async () => {
    const r = await resolveSnsName("alice.sns", (async () => resp(200, { s: "ok", result: "0xabc" })) as never)
    expect(r.kind).toBe("failed")
  })
  it("an error envelope is not_found — except 'Unsupported TLD', which is a source limitation", async () => {
    expect((await resolveSnsName("x.sns", (async () => resp(400, { s: "error", result: "Domain not found" })) as never)).kind).toBe("not_found")
    expect((await resolveSnsName("x.sol", (async () => resp(400, { s: "error", result: "Unsupported TLD" })) as never)).kind).toBe("failed")
    expect((await resolveSnsName("x.sns", (async () => resp(502, { s: "error", result: "upstream" })) as never)).kind).toBe("failed")
  })
  it("a network error or unparseable body is failed", async () => {
    expect((await resolveSnsName("x.sns", (async () => { throw new Error("ECONNRESET") }) as never)).kind).toBe("failed")
    const bad = { ok: true, status: 200, json: async () => { throw new SyntaxError("x") } } as unknown as Response
    expect((await resolveSnsName("x.sns", (async () => bad) as never)).kind).toBe("failed")
  })
})

describe("GET /api/candy/resolve-name", () => {
  it("400s on input that is not an SNS name", async () => {
    expect((await GET(req("alice"))).status).toBe(400)
    expect((await GET(req(null))).status).toBe(400)
  })
  it("200 with the verbatim wallet when the name resolves", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resp(200, { s: "ok", result: WALLET })))
    const res = await GET(req("Alice.sns"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ wallet: WALLET, source: "sns", name: "alice.sns" })
  })
  it("404 only when the NAME does not resolve", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resp(400, { s: "error", result: "Domain not found" })))
    const res = await GET(req("ghost.sns"))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("name_not_found")
  })
  it("⭐ a failed lookup is a 503, NEVER 'not found'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("timeout") }))
    const res = await GET(req("alice.sns"))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe("lookup_unavailable")
    expect(JSON.stringify(body)).not.toMatch(/not found|doesn.t point/i)
  })
})

describe("anon reach", () => {
  it("the Collection tab is public, so its name lookup must be too", async () => {
    const { isPublicPath } = await import("@/proxy")
    expect(isPublicPath("/api/candy/resolve-name", "GET")).toBe(true)
  })
})
