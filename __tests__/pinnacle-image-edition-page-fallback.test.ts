import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// /api/public/pinnacle-image/<renderId> falls back to Pinnacle's own edition page when
// Dapper's edition search has no record of the render (2026-11-15: 55 renders, 843 held
// pins, every one a 404 → placeholder art). The page also embeds OTHER pins' assets, so the
// one property that matters most is: a URL is taken only when its path names THIS render.

const db = vi.hoisted(() => ({
  row: { edition_id: "2917" } as Record<string, unknown> | null,
  error: null as { message: string } | null,
  calls: [] as string[],
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (t: string) => {
      db.calls.push(t)
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: db.row, error: db.error }),
      }
      return q
    },
  },
}))

// 2026-11-25: the signed-url store sits in front of every upstream. Default: empty (a miss), so the
// fallback tests below exercise the upstream legs exactly as before.
const store = vi.hoisted(() => ({
  row: null as { url: string; exp: number } | null,
  writes: [] as Array<{ renderId: string; variant: string; url: string; exp: number; source: string }>,
}))
vi.mock("@/lib/pinnacle/signed-media-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/pinnacle/signed-media-store")>()),
  readSignedMedia: async () => store.row,
  writeSignedMedia: async (renderId: string, variant: string, url: string, exp: number, source: string) => {
    store.writes.push({ renderId, variant, url, exp, source })
    return true
  },
}))

import { signedMediaFromEditionPage } from "@/lib/pinnacle/edition-page-media"
import { expOfSignedUrl } from "@/lib/pinnacle/signed-media-store"
import { GET } from "@/app/api/public/pinnacle-image/[renderId]/route"

const RID = "LGEV2-DVHA-MALE-S9"
const OTHER = "SEV1-TRIV-MICK-S1"
const FUTURE = Math.floor(Date.now() / 1000) + 86_400
// The page embeds JSON inside a string, so `&` arrives as a literal `&`.
const asset = (rid: string, file: string, exp = FUTURE, sig = "ab".repeat(32)) =>
  `"file":"https://assets.disneypinnacle.com/render/${rid}/${file}?exp=${exp}\\u0026sig=${sig}"`

describe("signedMediaFromEditionPage", () => {
  it("returns this render's front.png for the default variant, with & decoded", () => {
    const html = asset(OTHER, "front.png") + asset(RID, "main.png") + asset(RID, "front.png")
    const m = signedMediaFromEditionPage(html, RID, "front")
    expect(m?.url).toBe(`https://assets.disneypinnacle.com/render/${RID}/front.png?exp=${FUTURE}&sig=${"ab".repeat(32)}`)
    expect(m?.exp).toBe(FUTURE)
  })

  it("never returns another pin's asset, even when it is the only one on the page", () => {
    const html = asset(OTHER, "front.png") + asset(OTHER, "front_cropped.png")
    expect(signedMediaFromEditionPage(html, RID, "front")).toBeNull()
    expect(signedMediaFromEditionPage(html, RID, "thumb")).toBeNull()
  })

  it("does not match a render whose id merely starts with this one", () => {
    const html = asset(`${RID}0`, "front.png")
    expect(signedMediaFromEditionPage(html, RID, "front")).toBeNull()
  })

  it("follows the variant preference order", () => {
    const html = asset(RID, "front.png") + asset(RID, "main.png") + asset(RID, "front_cropped.png")
    expect(signedMediaFromEditionPage(html, RID, "quarter")?.url).toContain("/main.png?")
    expect(signedMediaFromEditionPage(html, RID, "thumb")?.url).toContain("/front_cropped.png?")
    // thumb falls back to front.png when there is no cropped render
    expect(signedMediaFromEditionPage(asset(RID, "front.png"), RID, "thumb")?.url).toContain("/front.png?")
  })

  it("ignores animations and stills it does not serve", () => {
    const html = asset(RID, "idle_cropped.png") + `"https://assets.disneypinnacle.com/render/${RID}/front_anim.webp?exp=${FUTURE}\\u0026sig=abcdabcdabcdabcd"`
    expect(signedMediaFromEditionPage(html, RID, "front")).toBeNull()
  })

  it("accepts &amp; and a plain & separator too", () => {
    const amp = `https://assets.disneypinnacle.com/render/${RID}/front.png?exp=${FUTURE}&amp;sig=${"cd".repeat(16)}`
    const plain = `https://assets.disneypinnacle.com/render/${RID}/front.png?exp=${FUTURE}&sig=${"cd".repeat(16)}`
    expect(signedMediaFromEditionPage(amp, RID, "front")?.url).toBe(plain)
    expect(signedMediaFromEditionPage(plain, RID, "front")?.url).toBe(plain)
  })

  it("rejects a render id outside the allowlist", () => {
    expect(signedMediaFromEditionPage(asset(RID, "front.png"), "a.b(c)", "front")).toBeNull()
  })
})

describe("GET /api/public/pinnacle-image/[renderId] — edition-page fallback", () => {
  const req = (q = "") => new NextRequest(`https://t/api/public/pinnacle-image/${RID}${q}`)
  const params = (renderId = RID) => ({ params: Promise.resolve({ renderId }) })
  const searchMiss = () =>
    new Response(JSON.stringify({ data: { searchPinnacleEditions: null } }), { status: 200 })

  let fetched: string[]
  beforeEach(() => {
    db.row = { edition_id: "2917" }
    db.error = null
    db.calls = []
    fetched = []
    store.row = null
    store.writes = []
  })
  afterEach(() => vi.unstubAllGlobals())

  const stub = (page: Response | (() => Response)) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(String(url))
        if (String(url).includes("studio-platform")) return searchMiss()
        return typeof page === "function" ? page() : page
      }),
    )

  it("302s to this render's signed asset from the edition page when the search has no record", async () => {
    stub(new Response(asset(OTHER, "front.png") + asset(RID, "front.png"), { status: 200 }))
    const res = await GET(req(), params())
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toContain(`/render/${RID}/front.png?exp=`)
    expect(fetched[1]).toBe("https://disneypinnacle.com/edition/2917")
    // a ~24 h signature still caches for the normal 30 min
    expect(res.headers.get("cache-control")).toContain("s-maxage=1800")
  })

  it("does not touch the catalog or the page when the search resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ data: { searchPinnacleEditions: { edges: [{ node: { medias: [{ name: "Front_Transparent", url: "https://signed/front" }] } }] } } }),
          { status: 200 },
        ),
      ),
    )
    const res = await GET(req(), params())
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://signed/front")
    expect(db.calls).toEqual([])
  })

  // 2026-11-25: the response names the leg that served it, and a miss or a slow request logs its
  // legs — three OG renders died ~7.05 s in on 11-25 (the image optimizer's give-up) with no trace
  // of which upstream was slow.
  it("names its source: gql, edition-page, or none on a 404 — and a miss logs every leg", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      stub(new Response(asset(RID, "front.png"), { status: 200 }))
      const viaPage = await GET(req(), params())
      expect(viaPage.headers.get("x-pinnacle-image-source")).toBe("edition-page")

      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { searchPinnacleEditions: { edges: [{ node: { medias: [{ name: "Front_Transparent", url: "https://signed/front" }] } }] } } }), { status: 200 })))
      const viaGql = await GET(req(), params())
      expect(viaGql.headers.get("x-pinnacle-image-source")).toBe("gql")

      warn.mockClear()
      stub(new Response("nope", { status: 403 }))
      const miss = await GET(req(), params())
      expect(miss.status).toBe(404)
      expect(miss.headers.get("x-pinnacle-image-source")).toBe("none")
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toMatch(new RegExp(`\\[pinnacle-image\\] ${RID} front source=none total=\\d+ms gql:miss:\\d+ms edition-page:miss:\\d+ms`))
    } finally {
      warn.mockRestore()
    }
  })

  it("⚠ serves a stored signature WITHOUT touching any upstream (the slow page is off the path)", async () => {
    store.row = { url: "https://assets.disneypinnacle.com/render/X/front.png?exp=1&sig=s", exp: FUTURE }
    stub(() => {
      throw new Error("no upstream may be called")
    })
    const res = await GET(req(), params())
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(store.row.url)
    expect(res.headers.get("x-pinnacle-image-source")).toBe("store")
    expect(fetched).toEqual([])
    expect(store.writes).toEqual([])
  })

  it("re-resolves a stored signature with under 30 min left, and stores the fresh one", async () => {
    store.row = { url: "https://old", exp: Math.floor(Date.now() / 1000) + 600 }
    stub(new Response(asset(RID, "front.png"), { status: 200 }))
    const res = await GET(req(), params())
    expect(res.headers.get("x-pinnacle-image-source")).toBe("edition-page")
    expect(res.headers.get("location")).toContain(`/render/${RID}/front.png?exp=${FUTURE}`)
    expect(store.writes).toHaveLength(1)
    expect(store.writes[0]).toMatchObject({ renderId: RID, variant: "front", exp: FUTURE, source: "edition-page" })
  })

  it("stores a GraphQL signature with the exp from its url, and the variant asked for", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { searchPinnacleEditions: { edges: [{ node: { medias: [{ name: "Front_Cropped", url: `https://signed/c.png?exp=${FUTURE}&sig=z` }] } }] } } }), { status: 200 })))
    await GET(req("?v=thumb"), params())
    expect(store.writes).toEqual([{ renderId: RID, variant: "thumb", url: `https://signed/c.png?exp=${FUTURE}&sig=z`, exp: FUTURE, source: "gql" }])
  })

  it("when every upstream fails, a stored signature with time left still beats a placeholder — and is not re-written", async () => {
    store.row = { url: "https://still-valid/x.png", exp: Math.floor(Date.now() / 1000) + 1200 }
    stub(new Response("nope", { status: 403 }))
    const res = await GET(req(), params())
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://still-valid/x.png")
    expect(res.headers.get("x-pinnacle-image-source")).toBe("store-stale")
    expect(store.writes).toEqual([])
  })

  it("a stored signature about to expire is never served, even as a last resort", async () => {
    store.row = { url: "https://dying", exp: Math.floor(Date.now() / 1000) + 120 }
    stub(new Response("nope", { status: 403 }))
    expect((await GET(req(), params())).status).toBe(404)
  })

  it("expOfSignedUrl reads the exp parameter and refuses anything that is not a unix time", () => {
    expect(expOfSignedUrl(`https://a/b.png?exp=${FUTURE}&sig=x`)).toBe(FUTURE)
    expect(expOfSignedUrl("https://a/b.png?sig=x")).toBeNull()
    expect(expOfSignedUrl("https://a/b.png?exp=12abc")).toBeNull()
    expect(expOfSignedUrl("not a url")).toBeNull()
  })

  it("404s when the page carries only another pin's asset", async () => {
    stub(new Response(asset(OTHER, "front.png"), { status: 200 }))
    expect((await GET(req(), params())).status).toBe(404)
  })

  it("404s without fetching a page when the catalog has no numeric edition id", async () => {
    db.row = { edition_id: "../x" }
    stub(new Response(asset(RID, "front.png"), { status: 200 }))
    expect((await GET(req(), params())).status).toBe(404)
    expect(fetched.some((u) => u.includes("disneypinnacle.com/edition"))).toBe(false)
  })

  it("404s when the catalog read fails (no page fetch)", async () => {
    db.error = { message: "boom" }
    stub(new Response(asset(RID, "front.png"), { status: 200 }))
    expect((await GET(req(), params())).status).toBe(404)
    expect(fetched.some((u) => u.includes("disneypinnacle.com/edition"))).toBe(false)
  })

  it("404s on a non-ok edition page", async () => {
    stub(new Response("nope", { status: 403 }))
    expect((await GET(req(), params())).status).toBe(404)
  })

  it("refuses a signature about to expire, and caches a short-lived one only until near expiry", async () => {
    const soon = Math.floor(Date.now() / 1000) + 200 // under the 5 min spare
    stub(new Response(asset(RID, "front.png", soon), { status: 200 }))
    expect((await GET(req(), params())).status).toBe(404)

    const tenMin = Math.floor(Date.now() / 1000) + 600
    stub(new Response(asset(RID, "front.png", tenMin), { status: 200 }))
    const res = await GET(req(), params())
    expect(res.status).toBe(302)
    const maxAge = Number(/s-maxage=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1])
    expect(maxAge).toBeGreaterThan(60)
    expect(maxAge).toBeLessThanOrEqual(300)
  })
})
