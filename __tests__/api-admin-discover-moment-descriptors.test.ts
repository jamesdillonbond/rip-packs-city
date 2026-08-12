import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/admin/discover-moment-descriptors — the read-only probe that answers
// whether the upstream exposes the descriptive text the Top Shot moment page
// renders (headline, prose, box score) and whether it is populated.
//
// The behaviours worth pinning: it is admin-gated, it NEVER writes, it degrades
// to a report rather than throwing when the proxy is unreachable, and — the
// point of the whole route — it distinguishes "field does not exist" from
// "field exists but is empty", because those imply completely different next
// steps (give up vs. ingest it).

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
  process.env.RPC_ADMIN_TOKEN = "admin-tok"
  process.env.TS_PROXY_URL = "https://proxy.test"
  process.env.TS_PROXY_SECRET = "sekrit"
  delete process.env.INGEST_SECRET_TOKEN
})

import { POST } from "@/app/api/admin/discover-moment-descriptors/route"

const req = (auth?: string, qs = "") =>
  ({
    nextUrl: new URL("http://localhost/api/admin/discover-moment-descriptors" + qs),
    headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? auth ?? null : null) },
  }) as any

const gqlOk = (body: any) =>
  ({ ok: true, status: 200, json: async () => body }) as any

describe("POST /api/admin/discover-moment-descriptors", () => {
  it("401s without the admin token", async () => {
    const res = await POST(req())
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("401s with a wrong token", async () => {
    expect((await POST(req("Bearer nope"))).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("reports introspection when the upstream allows it, and skips brute-force probing", async () => {
    fetchMock.mockResolvedValue(
      gqlOk({ data: { __type: { name: "PlayStats", fields: [{ name: "description", description: "prose", type: { name: "String" } }] } } })
    )
    const res = await POST(req("Bearer admin-tok"))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.topshot_introspection.PlayStats[0]).toMatchObject({ name: "description" })
    // Introspection is complete, so the candidate walk must not also run.
    expect(String(j.topshot_stats_probe)).toMatch(/skipped/i)
  })

  it("falls back to field probing when introspection is disabled", async () => {
    // __type returns null (introspection off), then every probe answers.
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      if (body.query.includes("__type")) return gqlOk({ data: { __type: null } })
      return gqlOk({ errors: [{ message: "Cannot query field \"zzz\" on type \"PlayStats\"." }] })
    })
    const j = await (await POST(req("Bearer admin-tok"))).json()
    expect(Array.isArray(j.topshot_stats_probe)).toBe(true)
    expect(j.topshot_stats_probe.every((p: any) => p.exists === false)).toBe(true)
  })

  it("distinguishes a MISSING field from an EMPTY one — the whole point", async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      if (body.query.includes("__type")) return gqlOk({ data: { __type: null } })
      if (body.query.includes("allEditions")) {
        // AllDay: `description` exists and is populated; `headline` does not exist.
        if (body.query.includes("description")) {
          return gqlOk({ data: { allEditions: { edges: [{ node: { play: { description: "Mahomes threads the needle." } } }] } } })
        }
        return gqlOk({ errors: [{ message: 'Cannot query field "headline" on type "Play".' }] })
      }
      return gqlOk({ errors: [{ message: 'Cannot query field "x" on type "PlayStats".' }] })
    })
    const j = await (await POST(req("Bearer admin-tok"))).json()
    const desc = j.allday_play_probe.find((p: any) => p.field === "description")
    const headline = j.allday_play_probe.find((p: any) => p.field === "headline")
    expect(desc).toMatchObject({ exists: true, sample: "Mahomes threads the needle." })
    expect(headline).toMatchObject({ exists: false })
    expect(j.verdict.allday_description_exists).toBe(true)
    expect(j.verdict.allday_description_populated).toBe(true)
  })

  it("reports exists-but-EMPTY as not populated", async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      if (body.query.includes("__type")) return gqlOk({ data: { __type: null } })
      if (body.query.includes("allEditions")) {
        return gqlOk({ data: { allEditions: { edges: [{ node: { play: { description: "" } } }] } } })
      }
      return gqlOk({ errors: [{ message: 'Cannot query field "x" on type "PlayStats".' }] })
    })
    const j = await (await POST(req("Bearer admin-tok"))).json()
    // The field is real, so we must not report it missing — but it carries no
    // text, so nothing can be built on it yet.
    expect(j.verdict.allday_description_exists).toBe(true)
    expect(j.verdict.allday_description_populated).toBe(false)
  })

  it("degrades to a report (not a throw) when the proxy is unconfigured", async () => {
    delete process.env.TS_PROXY_SECRET
    const res = await POST(req("Bearer admin-tok"))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(JSON.stringify(j)).toMatch(/missing TS_PROXY_URL or TS_PROXY_SECRET/)
  })

  it("degrades to a report when the proxy throws", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"))
    const res = await POST(req("Bearer admin-tok"))
    expect(res.status).toBe(200)
    expect(JSON.stringify(await res.json())).toMatch(/ECONNRESET/)
  })

  it("truncates a long sample so the report stays readable", async () => {
    const long = "x".repeat(900)
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      if (body.query.includes("__type")) return gqlOk({ data: { __type: null } })
      if (body.query.includes("allEditions") && body.query.includes("description")) {
        return gqlOk({ data: { allEditions: { edges: [{ node: { play: { description: long } } }] } } })
      }
      return gqlOk({ errors: [{ message: 'Cannot query field "x" on type "Play".' }] })
    })
    const j = await (await POST(req("Bearer admin-tok"))).json()
    const desc = j.allday_play_probe.find((p: any) => p.field === "description")
    expect(String(desc.sample).length).toBeLessThan(450)
    expect(String(desc.sample).endsWith("…")).toBe(true)
  })

  it("never issues a mutating request", async () => {
    fetchMock.mockResolvedValue(gqlOk({ data: { __type: null } }))
    await POST(req("Bearer admin-tok"))
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(call[1].body)
      expect(body.query).not.toMatch(/\bmutation\b/i)
    }
  })
})
