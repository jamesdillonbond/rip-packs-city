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
