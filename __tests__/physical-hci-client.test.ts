import { describe, it, expect, vi } from "vitest"
import { HciClient } from "@/lib/physical/hci-client"

// Every HCI failure comes back as { ok:false } — never a throw, never an empty
// success a caller would read as "no cards" / "no sales".

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("HciClient failures", () => {
  it("a network throw is NETWORK, not an exception", async () => {
    const r = await new HciClient("k", vi.fn(async () => { throw new Error("down") }) as unknown as typeof fetch).cert({ grader: "psa", certNumber: "1" })
    expect(r).toEqual({ ok: false, status: 0, code: "NETWORK" })
  })

  it("reads the error code from either body shape, and tolerates a non-JSON error body", async () => {
    const c = (res: Response) => new HciClient("k", vi.fn(async () => res) as unknown as typeof fetch)
    expect(await c(json({ error: { code: "RATE" } }, 429)).searchCards("x")).toEqual({ ok: false, status: 429, code: "RATE" })
    expect(await c(json({ error: "NOPE" }, 403)).sales("1")).toEqual({ ok: false, status: 403, code: "NOPE" })
    expect(await c(json({ code: "C" }, 500)).sales("1")).toEqual({ ok: false, status: 500, code: "C" })
    expect(await c(new Response("<html>", { status: 502 })).sales("1")).toEqual({ ok: false, status: 502, code: null })
  })

  it("a 200 whose body is not JSON is a failure, not a throw (review finding 9)", async () => {
    const impl = vi.fn(async () => new Response("<html>gateway</html>", { status: 200 }))
    const r = await new HciClient("k", impl as unknown as typeof fetch).cert({ grader: "psa", certNumber: "1" })
    expect(r).toEqual({ ok: false, status: 200, code: "BAD_JSON" })
  })
})

describe("HciClient.searchCards", () => {
  it("sends the key as a header, drops empty params, and maps both result shapes", async () => {
    const urls: string[] = []
    let headers: Record<string, string> = {}
    const impl = vi.fn(async (u: string, init: RequestInit) => {
      urls.push(u)
      headers = init.headers as Record<string, string>
      return json({ cards: [{ id: 1, name: "A", year: "2025", setName: "S", playerName: "P", category: "basketball" }, { id: null, name: "x" }, { id: 2, name: 3 }] })
    })
    const r = await new HciClient("secret", impl as unknown as typeof fetch, "https://h.test").searchCards("flagg", "")
    expect(urls[0]).toBe("https://h.test/prices/search?q=flagg")
    expect(urls[0]).not.toContain("secret")
    expect(headers["X-API-Key"]).toBe("secret")
    expect(r).toEqual({ ok: true, data: [{ id: "1", name: "A", year: 2025, setName: "S", playerName: "P", category: "basketball" }] })
    const r2 = await new HciClient("k", vi.fn(async () => json({ results: [{ id: 3, name: "B", year: "n/a" }] })) as unknown as typeof fetch).searchCards("b", "football")
    expect(r2).toEqual({ ok: true, data: [{ id: "3", name: "B", year: null, setName: null, playerName: null, category: null }] })
  })

  it("encodes the cert path", async () => {
    const urls: string[] = []
    const impl = vi.fn(async (u: string) => (urls.push(u), json({})))
    await new HciClient("k", impl as unknown as typeof fetch, "https://h.test").cert({ grader: "bgs", certNumber: "1/2" })
    expect(urls[0]).toBe("https://h.test/certs/bgs/1%2F2")
  })
})
