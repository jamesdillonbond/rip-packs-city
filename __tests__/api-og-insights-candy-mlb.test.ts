import { describe, it, expect, vi, afterEach } from "vitest"

// ─────────────────────────────────────────────────────────────────────────────
// Candy MLB OG card — proves it renders REAL PNG BYTES, not a 0-byte response.
//
// Why this test exists rather than a smoke check: /api/og/insights/candy-mlb is
// launch-gated in proxy.ts, so it CANNOT be verified anonymously over HTTP until
// Trevor flips CANDY_MLB_PUBLIC. Rendering the handler in-process is the only
// way to prove the card works BEFORE it goes public — which matters because this
// app has a known 0-byte OG failure mode: the `opengraph-image.tsx` file
// convention returns HTTP 200 image/png with an EMPTY body here, silently
// blanking every social unfurl (memory: share-og-image-zero-bytes, resolved by
// moving to /api/og/* route handlers). A test asserting only status 200 would
// have passed straight through that bug, so this asserts the byte length and
// reads the real width/height out of the PNG IHDR chunk.
//
// Also pins the deliberate design choice that this card reads the backing view
// directly instead of self-fetching its own public API: a self-fetch would go
// back through proxy.ts and get 302'd to /login while the surface is staged, so
// the card would render the fallback headline for the whole staging period and
// only start working at go-live — untestable exactly when testing matters.
// ─────────────────────────────────────────────────────────────────────────────

const PNG_MAGIC = "89504e470d0a1a0a"

function mockBoard(rows: Array<{ fmv_usd: number | null }>) {
  vi.doMock("@/lib/supabase", () => ({
    supabaseAdmin: {
      from: () => ({
        select: () => ({ limit: async () => ({ data: rows, error: null }) }),
      }),
    },
  }))
}

async function render() {
  const { GET } = await import("@/app/api/og/insights/candy-mlb/route")
  const res = await GET()
  const buf = Buffer.from(await res.arrayBuffer())
  return { res, buf }
}

afterEach(() => {
  vi.resetModules()
  vi.doUnmock("@/lib/supabase")
})

describe("/api/og/insights/candy-mlb", () => {
  it("renders a real non-empty 1200x630 PNG", async () => {
    // Mirrors live coverage at time of writing: 125 editions, 91 priced.
    mockBoard([
      ...Array.from({ length: 91 }, () => ({ fmv_usd: 4.22 })),
      ...Array.from({ length: 34 }, () => ({ fmv_usd: null })),
    ])
    const { res, buf } = await render()

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("image/png")
    // The 0-byte trap: a status-only assertion would not catch it.
    expect(buf.length).toBeGreaterThan(1000)
    expect(buf.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC)
    // Dimensions read from the IHDR chunk, not from the config we passed in.
    expect(buf.readUInt32BE(16)).toBe(1200)
    expect(buf.readUInt32BE(20)).toBe(630)
  }, 60000)

  // ⚠ BOTH failure shapes, and the distinction cost a real defect.
  //
  // This file used to carry ONLY the throwing case below, described as "when the
  // view read fails". supabase-js does not throw — it RESOLVES with
  // `{ data: null, error }` — so the one case here proved the card survives a
  // failure mode that cannot occur while being blind to the one that does. The
  // route meanwhile destructured only `data`, so a real failure skipped its
  // `catch` entirely and published "Live secondary FMV" on a read that never
  // happened (fixed 2026-08-27).
  //
  // These two assert only that a real PNG comes back. What the PNG SAYS is a
  // different property and no byte-level assertion can express it — that lives
  // in __tests__/api-og-insights-candy-mlb-honesty.test.ts, which drives the
  // same states through the next/og capture harness and asserts rendered text.
  it("still renders a valid PNG when the view read RESOLVES with an error (the real supabase-js shape)", async () => {
    vi.doMock("@/lib/supabase", () => ({
      supabaseAdmin: {
        from: () => ({
          select: () => ({
            limit: async () => ({
              data: null,
              error: { message: "canceling statement due to statement timeout" },
            }),
          }),
        }),
      },
    }))
    const { res, buf } = await render()
    expect(res.status).toBe(200)
    expect(buf.length).toBeGreaterThan(1000)
    expect(buf.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC)
  }, 60000)

  it("still renders a valid PNG when the client THROWS (transport-level failure)", async () => {
    vi.doMock("@/lib/supabase", () => ({
      supabaseAdmin: {
        from: () => ({
          select: () => ({
            limit: async () => {
              throw new Error("view unavailable")
            },
          }),
        }),
      },
    }))
    const { res, buf } = await render()
    // A dead backing view must degrade to the generic card, never to a 500 —
    // a broken unfurl is worse than a generic one.
    expect(res.status).toBe(200)
    expect(buf.length).toBeGreaterThan(1000)
    expect(buf.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC)
  }, 60000)

  it("renders when the board is empty", async () => {
    mockBoard([])
    const { buf } = await render()
    expect(buf.length).toBeGreaterThan(1000)
    expect(buf.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC)
  }, 60000)
})
