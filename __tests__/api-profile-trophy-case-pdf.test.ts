import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// ─────────────────────────────────────────────────────────────────────────────
// Exportable Trophy Case PDF — /api/profile/trophy-case/pdf
//
// The largest `route.tsx` in the repo (844 LOC) and, until this file, one of
// the 43 with no test at all: `route.tsx` is matched by NEITHER coverage gate
// (the primary gate's include is `app/api/**/route.ts`, which does not match
// `.tsx`), so nothing measured it and nothing exercised it.
//
// The assertions here read BYTES, not status codes — same discipline as the OG
// card sweep, and for the same reason. This route's failure mode is a
// downloadable file that is empty or truncated: a browser saves a 0-byte
// "trophy-case.pdf" and the user sees a corrupt download, while a status-only
// assertion reports a perfectly healthy 200. So the happy path asserts the
// %PDF- magic, the %%EOF trailer, and a plausible length.
//
// Also pins the three guard branches (400 / 502 / 404), because each returns a
// DIFFERENT and load-bearing answer: "you didn't give me a username", "the
// database is broken", and "this collector has no trophy case" must not
// collapse into one another — the last is an honest empty state, the middle is
// an outage, and conflating them would report an outage as an empty case.
// ─────────────────────────────────────────────────────────────────────────────

const PDF_MAGIC = "%PDF-"

/** A slab row shaped as the trophy RPC returns it. */
function slab(over: Partial<Record<string, unknown>> = {}) {
  return {
    edition_id: "1:2",
    collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
    collection: "nba_top_shot",
    player_name: "Damian Lillard",
    set_name: "Base Set",
    tier: "COMMON",
    serial_number: 38,
    circulation_count: 49,
    thumbnail_url: null, // a URL would make the renderer fetch real art
    badges: ["rookie_year"],
    ...over,
  }
}

interface StubOpts {
  rpc?: (name: string) => Promise<{ data: unknown; error: unknown }>
  editions?: unknown[]
}

function installSupabase(opts: StubOpts = {}) {
  const rpc =
    opts.rpc ??
    (async (name: string) => {
      if (name === "get_trophy_slab_data_by_username") {
        return { data: [slab()], error: null }
      }
      // Canonical badge source; [] is a legitimate answer.
      return { data: [], error: null }
    })

  const client = {
    rpc: (name: string) => rpc(name),
    from: () => ({
      select: () => ({
        in: async () => ({ data: opts.editions ?? [], error: null }),
      }),
    }),
  }
  vi.doMock("@/lib/supabase", () => ({
    supabase: client,
    supabaseAdmin: client,
    default: client,
  }))
}

async function call(query: string) {
  const { GET } = await import("@/app/api/profile/trophy-case/pdf/route")
  return GET(new NextRequest(`https://www.rippackscity.com/api/profile/trophy-case/pdf${query}`))
}

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.resetModules()
  vi.doUnmock("@/lib/supabase")
  vi.restoreAllMocks()
})

describe("/api/profile/trophy-case/pdf — guards", () => {
  it("400s with no username", async () => {
    installSupabase()
    const res = await call("")
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/username/i)
  })

  it("400s on an over-long username instead of querying with it", async () => {
    const rpc = vi.fn(async () => ({ data: [slab()], error: null }))
    installSupabase({ rpc })
    const res = await call(`?username=${"a".repeat(65)}`)
    expect(res.status).toBe(400)
    // The length cap must short-circuit BEFORE the DB call, or the cap is
    // decoration — an unbounded string still reaches the query.
    expect(rpc).not.toHaveBeenCalled()
  })

  it("502s (not 404) when the slab RPC keeps erroring — an outage is not an empty case", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "statement timeout" } }))
    installSupabase({ rpc })
    const res = await call("?username=someone")
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toBe("lookup_failed")
    // The driver message must not be published to an anon caller.
    expect(JSON.stringify(body)).not.toMatch(/statement timeout/i)
    // Retried once before giving up.
    expect(rpc.mock.calls.length).toBeGreaterThanOrEqual(2)
  }, 20000)

  it("recovers when the retry succeeds after a transient error", async () => {
    let n = 0
    installSupabase({
      rpc: async (name: string) => {
        if (name !== "get_trophy_slab_data_by_username") return { data: [], error: null }
        n += 1
        return n === 1
          ? { data: null, error: { message: "transient contention" } }
          : { data: [slab()], error: null }
      },
    })
    const res = await call("?username=someone")
    // The retry exists precisely so a transient blip does not surface as 502.
    expect(res.status).toBe(200)
  }, 60000)

  it("404s when the collector has no trophy case", async () => {
    installSupabase({ rpc: async () => ({ data: [], error: null }) })
    const res = await call("?username=nobody")
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("no_trophy_case")
  })
})

describe("/api/profile/trophy-case/pdf — renders a real PDF", () => {
  it("emits real, non-truncated PDF bytes with download headers", async () => {
    installSupabase()
    const res = await call("?username=jamesdillonbond")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/pdf")

    const buf = Buffer.from(await res.arrayBuffer())
    // The 0-byte / truncated-download trap: a status-only assertion sails past
    // a corrupt file, which is exactly what the user would open.
    expect(buf.length).toBeGreaterThan(2000)
    expect(buf.subarray(0, 5).toString("latin1")).toBe(PDF_MAGIC)
    // A PDF without its trailer is truncated — the reader shows "damaged".
    expect(buf.subarray(-1024).toString("latin1")).toContain("%%EOF")
  }, 120000)

  it("renders a full six-slot case, and a partial one, without erroring", async () => {
    installSupabase({
      rpc: async (name: string) =>
        name === "get_trophy_slab_data_by_username"
          ? {
              data: [
                slab({ serial_number: 1, circulation_count: 1 }), // true 1-of-1 (gold slab)
                slab({ serial_number: 38, tier: "LEGENDARY" }),
                slab({ serial_number: 7, tier: "RARE", collection: "nfl_all_day" }),
                slab({ serial_number: 99, tier: "FANDOM" }),
                slab({ serial_number: 12, tier: "ULTIMATE" }),
                slab({ serial_number: 4, tier: "COMMON" }),
              ],
              error: null,
            }
          : { data: [], error: null },
    })
    const full = await call("?username=full")
    expect(full.status).toBe(200)
    expect(Buffer.from(await full.arrayBuffer()).subarray(0, 5).toString("latin1")).toBe(PDF_MAGIC)
  }, 120000)

  it("still renders when the catalog read for jersey glyphs fails", async () => {
    // Documented as a soft-fail path ("glyphs degrade silently"); a broken
    // decoration must never cost the user their export.
    const client = {
      rpc: async (name: string) =>
        name === "get_trophy_slab_data_by_username"
          ? { data: [slab()], error: null }
          : { data: [], error: null },
      from: () => ({
        select: () => ({
          in: async () => {
            throw new Error("editions unavailable")
          },
        }),
      }),
    }
    vi.doMock("@/lib/supabase", () => ({ supabase: client, supabaseAdmin: client, default: client }))

    const res = await call("?username=someone")
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString("latin1")).toBe(PDF_MAGIC)
  }, 120000)
})

// ── The moment-art pipeline ─────────────────────────────────────────────────
//
// fetchMomentArt is the densest branch cluster in this route (49 uncovered
// branches before these tests) and it is module-private, so it is driven
// through GET. The assertions that carry weight are not "a PDF came out" — they
// are about WHICH network calls happen, because the two rules here are network
// rules:
//
//   1. A Pinnacle render must NEVER be fetched directly. The asset CDN 403s all
//      datacenter egress, so the only server-usable source is the
//      browser-harvested pinnacle_render_cache. A direct attempt burns the
//      6s timeout budget per slab for a response that cannot succeed.
//   2. Everything else IS fetched, with a browser User-Agent — some Dapper CDNs
//      bot-block requests without one, and the failure is a silently art-less
//      export rather than an error.

/** A real, decodable PNG of the given size (pngjs, same encoder the route uses). */
function realPng(w = 8, h = 8, alpha = 255): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PNG } = require("pngjs") as typeof import("pngjs")
  const png = new PNG({ width: w, height: h })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 200
    png.data[i + 1] = 30
    png.data[i + 2] = 40
    png.data[i + 3] = alpha
  }
  return PNG.sync.write(png)
}

/** Minimal JPEG SOI magic — enough for the route's format sniff. */
const JPG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])

function installArtSupabase(opts: { renderCache?: unknown; slabThumb?: string | null } = {}) {
  const client = {
    rpc: async (name: string) =>
      name === "get_trophy_slab_data_by_username"
        ? { data: [slab({ thumbnail_url: opts.slabThumb ?? null })], error: null }
        : { data: [], error: null },
    from: (table: string) => {
      if (table === "pinnacle_render_cache") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: opts.renderCache ?? null, error: null }) }),
          }),
        }
      }
      return { select: () => ({ in: async () => ({ data: [], error: null }) }) }
    },
  }
  vi.doMock("@/lib/supabase", () => ({ supabase: client, supabaseAdmin: client, default: client }))
}

/** Stub fetch, recording every request the route makes. */
function recordFetch(respond: (url: string) => Promise<Response> | Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
    calls.push({ url, init })
    return respond(url)
  }) as unknown as typeof globalThis.fetch
  return calls
}

describe("/api/profile/trophy-case/pdf — moment art", () => {
  it("NEVER fetches a Pinnacle render directly — cache or nothing", async () => {
    installArtSupabase({
      slabThumb: "https://www.rippackscity.com/api/public/pinnacle-image/abc123",
      renderCache: null, // cache MISS
    })
    const calls = recordFetch(async () => new Response("", { status: 200 }))

    const res = await call("?username=someone")
    expect(res.status).toBe(200)
    // The whole point: a cache miss must fall through to the placeholder, not
    // to a request that is guaranteed to 403 and cost 6s of the budget.
    expect(calls.filter((c) => c.url.includes("pinnacle-image"))).toEqual([])
  }, 120000)

  it("uses the cached render when pinnacle_render_cache has real PNG bytes", async () => {
    installArtSupabase({
      slabThumb: "https://www.rippackscity.com/api/public/pinnacle-image/abc123",
      renderCache: { mime: "image/png", b64: realPng(16, 16).toString("base64") },
    })
    const calls = recordFetch(async () => new Response("", { status: 200 }))
    const res = await call("?username=someone")
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString("latin1")).toBe(PDF_MAGIC)
    expect(calls.filter((c) => c.url.includes("pinnacle-image"))).toEqual([])
  }, 120000)

  it("ignores a cached blob that is not actually an image", async () => {
    // A corrupt cache row must degrade to the placeholder, not be handed to the
    // decoder as if it were art.
    installArtSupabase({
      slabThumb: "https://www.rippackscity.com/api/public/pinnacle-image/abc123",
      renderCache: { mime: "image/png", b64: Buffer.from("not an image at all").toString("base64") },
    })
    recordFetch(async () => new Response("", { status: 200 }))
    const res = await call("?username=someone")
    expect(res.status).toBe(200)
  }, 120000)

  it("fetches non-Pinnacle art WITH a browser User-Agent", async () => {
    installArtSupabase({ slabThumb: "https://assets.nbatopshot.com/moment.png" })
    const png = realPng(32, 32)
    const calls = recordFetch(
      async () => new Response(new Uint8Array(png), { status: 200, headers: { "content-type": "image/png" } })
    )
    const res = await call("?username=someone")
    expect(res.status).toBe(200)

    const artCall = calls.find((c) => c.url.includes("moment.png"))
    expect(artCall, "the route should have fetched the art").toBeTruthy()
    // Some Dapper CDNs bot-block a UA-less request, and the failure mode is a
    // silently art-less export rather than an error.
    const ua = (artCall!.init?.headers as Record<string, string> | undefined)?.["User-Agent"] ?? ""
    expect(ua).toMatch(/Mozilla/)
  }, 120000)

  it("still renders when the art fetch 404s, times out, or returns junk", async () => {
    // Each of these must degrade to the placeholder — a missing thumbnail can
    // never cost the user their whole export.
    const cases: Array<[string, () => Response | Promise<Response>]> = [
      ["404", () => new Response("", { status: 404 })],
      ["empty body", () => new Response(new Uint8Array(0), { status: 200 })],
      ["not an image", () => new Response(new Uint8Array(Buffer.from("<html>nope</html>")), { status: 200 })],
      ["thrown", () => { throw new Error("socket hang up") }],
    ]
    for (const [label, respond] of cases) {
      vi.resetModules()
      installArtSupabase({ slabThumb: "https://assets.nbatopshot.com/moment.png" })
      recordFetch(async () => respond())
      const res = await call("?username=someone")
      expect(res.status, `${label} should still produce a PDF`).toBe(200)
      expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString("latin1")).toBe(PDF_MAGIC)
    }
  }, 180000)

  it("accepts a JPEG as well as a PNG", async () => {
    installArtSupabase({ slabThumb: "https://assets.nbatopshot.com/moment.jpg" })
    recordFetch(async () => new Response(new Uint8Array(JPG_MAGIC), { status: 200 }))
    const res = await call("?username=someone")
    expect(res.status).toBe(200)
  }, 120000)

  it("rejects an oversized image rather than embedding megabytes per slab", async () => {
    // The 10MB cap exists so one pathological asset cannot blow up the export.
    installArtSupabase({ slabThumb: "https://assets.nbatopshot.com/huge.png" })
    const huge = Buffer.concat([realPng(8, 8), Buffer.alloc(11 * 1024 * 1024)])
    recordFetch(async () => new Response(new Uint8Array(huge), { status: 200 }))
    const res = await call("?username=someone")
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString("latin1")).toBe(PDF_MAGIC)
  }, 180000)
})
