import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/admin/discover-moment-descriptors — the read-only probe that asks
// whether the upstream exposes the descriptive text the Top Shot moment page
// renders (headline, prose, box score).
//
// V1 OF THIS PROBE PRODUCED A FALSE NEGATIVE IN PRODUCTION, and these tests
// exist mostly to make that unrepeatable. V1 reported `exists: false` for every
// field on both leagues — including `classification` and `dateOfMoment`, which
// our live ingest queries every day. Two transport failures (wrong AllDay
// endpoint → 404; null setID/playID → Top Shot 422) had been rendered as schema
// facts. It was the same "a failed read served as data" class this codebase has
// been burned by repeatedly, committed by the diagnostic itself.
//
// V2's contract, pinned below:
//   · status is "yes" | "no" | "unknown"; a transport failure is NEVER "no"
//   · each arm probes CONTROL fields we already query in production, and an arm
//     whose controls fail is INCONCLUSIVE with its results disclaimed
//   · error BODIES are captured, because Top Shot's 422 body names the field

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
  process.env.RPC_ADMIN_TOKEN = "admin-tok"
  process.env.TS_PROXY_URL = "https://proxy.test"
  process.env.ALLDAY_PROXY_URL = "https://allday.test/graphql"
  process.env.TS_PROXY_SECRET = "sekrit"
  delete process.env.INGEST_SECRET_TOKEN
})

import { POST } from "@/app/api/admin/discover-moment-descriptors/route"

const req = (auth?: string, qs = "") =>
  ({
    nextUrl: new URL("http://localhost/api/admin/discover-moment-descriptors" + qs),
    headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? auth ?? null : null) },
  }) as any

const okBody = (body: any) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as any
const httpErr = (status: number, body = "") => ({ ok: false, status, text: async () => body }) as any

function fieldOf(q: string): string {
  return q.match(/\{\s*([A-Za-z]+)\s*\}/)?.[1] ?? "x"
}

/**
 * Answer every field with a value — controls included. Top Shot replies in the
 * real schema shape: searchSummary.data.data[] behind two inline fragments.
 */
function tsOk(field: string, inStats: boolean, val: unknown = `val:${field}`) {
  return okBody({
    data: {
      searchEditions: {
        searchSummary: {
          data: { data: [{ play: inStats ? { stats: { [field]: val } } : { [field]: val } }] },
        },
      },
    },
  })
}
function adOk(field: string, val: unknown = `val:${field}`) {
  return okBody({ data: { allEditions: { edges: [{ node: { play: { [field]: val } } }] } } })
}
function allFieldsResolve() {
  fetchMock.mockImplementation(async (_url: string, init: any) => {
    const q = JSON.parse(init.body).query as string
    const field = fieldOf(q)
    if (q.includes("allEditions")) return adOk(field)
    return tsOk(field, q.includes("stats {"))
  })
}

describe("POST /api/admin/discover-moment-descriptors (v2)", () => {
  it("401s without the admin token", async () => {
    expect((await POST(req())).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("a blanket HTTP failure is INCONCLUSIVE, never 'absent' — the V1 regression", async () => {
    // Exactly what happened in prod: every request failed and V1 called every
    // field non-existent.
    fetchMock.mockResolvedValue(httpErr(422, "unprocessable"))
    const j = await (await POST(req("Bearer admin-tok"))).json()
    expect(j.topshot.conclusive).toBe(false)
    expect(j.allday.conclusive).toBe(false)
    // The critical assertion: nothing may be reported absent.
    expect(j.topshot.absent).toEqual([])
    expect(j.allday.absent).toEqual([])
    expect(j.topshot.warning).toMatch(/INCONCLUSIVE/)
    expect(j.verdict.allday_description).toBe("inconclusive")
    expect(j.verdict.topshot_descriptive_fields_found).toBe("inconclusive")
  })

  it("a 404 on one arm does not contaminate the other", async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const q = JSON.parse(init.body).query as string
      if (q.includes("allEditions")) return httpErr(404, "not found")
      return tsOk(fieldOf(q), true, "v")
    })
    const j = await (await POST(req("Bearer admin-tok"))).json()
    expect(j.topshot.conclusive).toBe(true)
    expect(j.allday.conclusive).toBe(false)
    expect(j.allday.absent).toEqual([])
  })

  it("marks a field absent ONLY on a genuine unknown-field error", async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const q = JSON.parse(init.body).query as string
      const field = fieldOf(q)
      if (field === "headline") {
        return okBody({ errors: [{ message: 'Cannot query field "headline" on type "PlayStats".' }] })
      }
      if (q.includes("allEditions")) return adOk(field, "v")
      return tsOk(field, q.includes("stats {"), "v")
    })
    const j = await (await POST(req("Bearer admin-tok"))).json()
    expect(j.topshot.conclusive).toBe(true)
    expect(j.topshot.absent).toContain("headline")
    expect(j.topshot.found.map((f: any) => f.field)).toContain("description")
  })

  it("treats an unknown-field message inside an HTTP error body as absent", async () => {
    // Top Shot answers 422 for an invalid query and names the field in the body.
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const q = JSON.parse(init.body).query as string
      const field = fieldOf(q)
      if (field === "caption") return httpErr(422, 'Cannot query field "caption" on type "PlayStats".')
      if (q.includes("allEditions")) return adOk(field, "v")
      return tsOk(field, q.includes("stats {"), "v")
    })
    const j = await (await POST(req("Bearer admin-tok"))).json()
    expect(j.topshot.absent).toContain("caption")
  })

  it("reports found fields with their sample values when the arm is conclusive", async () => {
    allFieldsResolve()
    const j = await (await POST(req("Bearer admin-tok"))).json()
    expect(j.allday.conclusive).toBe(true)
    expect(j.allday.found.find((f: any) => f.field === "description").sample).toBe("val:description")
    expect(j.verdict.allday_description).toBe("exists and populated")
  })

  it("distinguishes exists-but-empty from populated", async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const q = JSON.parse(init.body).query as string
      const field = fieldOf(q)
      const val = field === "description" ? "" : "v"
      if (q.includes("allEditions")) return adOk(field, val)
      return tsOk(field, q.includes("stats {"), val)
    })
    const j = await (await POST(req("Bearer admin-tok"))).json()
    expect(j.verdict.allday_description).toBe("exists but empty")
  })

  it("always supplies the REQUIRED filters (the v2 422 cause)", async () => {
    // The live 422 body was: Field "SearchEditionsInput.filters" of required
    // type "EditionFilterInput!" was not provided.
    allFieldsResolve()
    await POST(req("Bearer admin-tok"))
    const tsCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("proxy.test"))
    expect(tsCalls.length).toBeGreaterThan(0)
    for (const c of tsCalls) {
      const body = JSON.parse(c[1].body)
      expect(body.variables.input.filters.bySetIDs.length).toBe(1)
      expect(body.variables.input.searchInput.pagination).toBeTruthy()
      expect(body.query).not.toMatch(/setID:\s*null/)
    }
  })

  it("reads the double-data inline-fragment response path the schema actually returns", async () => {
    allFieldsResolve()
    const j = await (await POST(req("Bearer admin-tok"))).json()
    // If the pluck used the old flat searchEditions.data[] path, every Top Shot
    // sample would be undefined and the controls would not pass.
    expect(j.topshot.conclusive).toBe(true)
    expect(j.topshot.found.find((f: any) => f.field === "description").sample).toBe("val:description")
  })

  it("posts All Day to ALLDAY_PROXY_URL, not a TS_PROXY_URL subpath (the V1 404 cause)", async () => {
    allFieldsResolve()
    await POST(req("Bearer admin-tok"))
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u === "https://allday.test/graphql")).toBe(true)
    expect(urls.some((u) => u.includes("proxy.test/allday"))).toBe(false)
  })

  it("uses a supplied UUID setID, and ignores a non-UUID one (bySetIDs rejects those)", async () => {
    allFieldsResolve()
    const uuid = "11111111-2222-3333-4444-555555555555"
    await POST(req("Bearer admin-tok", "?setID=" + uuid))
    let body = JSON.parse(fetchMock.mock.calls.find((c) => String(c[0]).includes("proxy.test"))![1].body)
    expect(body.variables.input.filters.bySetIDs).toEqual([uuid])

    fetchMock.mockClear()
    allFieldsResolve()
    await POST(req("Bearer admin-tok", "?setID=99"))
    body = JSON.parse(fetchMock.mock.calls.find((c) => String(c[0]).includes("proxy.test"))![1].body)
    expect(body.variables.input.filters.bySetIDs[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )
  })

  it("sends the production User-Agent so a WAF allowlist can't be misread as schema", async () => {
    allFieldsResolve()
    await POST(req("Bearer admin-tok"))
    for (const c of fetchMock.mock.calls) {
      expect(c[1].headers["User-Agent"]).toBe("rip-packs-city/editions-hydrate")
    }
  })

  it("surfaces missing configuration instead of reporting fields absent", async () => {
    delete process.env.TS_PROXY_URL
    fetchMock.mockImplementation(async (_u: string, init: any) => adOk(fieldOf(JSON.parse(init.body).query), "v"))
    const j = await (await POST(req("Bearer admin-tok"))).json()
    expect(j.endpoints.topshot).toMatch(/MISSING/)
    expect(j.topshot.conclusive).toBe(false)
    expect(j.topshot.absent).toEqual([])
  })

  it("degrades to a report when the network throws", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"))
    const res = await POST(req("Bearer admin-tok"))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.topshot.conclusive).toBe(false)
    expect(JSON.stringify(j)).toMatch(/ECONNRESET/)
  })

  it("never issues a mutating request", async () => {
    allFieldsResolve()
    await POST(req("Bearer admin-tok"))
    for (const call of fetchMock.mock.calls) {
      expect(JSON.parse(call[1].body).query).not.toMatch(/\bmutation\b/i)
    }
  })
})
