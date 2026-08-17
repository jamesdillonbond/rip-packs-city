import { describe, it, expect, beforeEach, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Deep drive of GET /api/profile/market-pulse (the sibling only spot-checks). Per-
// collection floor + index health: an exact-count snapshotsToday, indexedEditions,
// and tier floors from cached_listings, cached 60s. Legs pinned: the known-uuid vs
// unknown-collection count paths, the tier-floor grouping with FANDOM/UNCOMMON/
// ULTIMATE fallbacks, the empty-listings case, a count-query failure (both a THROW
// and the returned-error shape supabase-js really produces) reporting UNKNOWN rather
// than 0, and the fresh-cache short-circuit. Module cache reset per test.

const st = vi.hoisted(() => ({
  snapCount: 0, edCount: 0, listings: [] as any[], snapThrow: false,
  // ⚠ supabase-js RETURNS errors rather than throwing, so the throw path below
  // does not exercise the realistic failure (a 57014 statement timeout) at all.
  countError: null as { message: string } | null,
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(table: string) {
      const b: any = {
        select: () => b, eq: () => b, gte: () => b, gt: () => b, order: () => b, limit: () => b,
        then: (resolve: any) => {
          if (table === "fmv_snapshots") {
            if (st.snapThrow) throw new Error("count down")
            if (st.countError) return resolve({ count: null, error: st.countError })
            return resolve({ count: st.snapCount })
          }
          if (table === "editions") {
            if (st.countError) return resolve({ count: null, error: st.countError })
            return resolve({ count: st.edCount })
          }
          if (table === "cached_listings") return resolve({ data: st.listings })
          return resolve({ data: null, count: 0 })
        },
      }
      return b
    },
  },
}))

async function loadGET() {
  vi.resetModules()
  return (await import("@/app/api/profile/market-pulse/route")).GET
}
const get = (qs = "?collectionId=nba-top-shot") => ({ nextUrl: new URL(`https://t/api/profile/market-pulse${qs}`) }) as any

beforeEach(() => {
  st.snapCount = 0; st.edCount = 0; st.listings = []; st.snapThrow = false; st.countError = null
})

describe("GET /api/profile/market-pulse", () => {
  it("known collection: exact snapshot count + edition count + tier floors", async () => {
    st.snapCount = 4243; st.edCount = 19000
    st.listings = [
      { tier: "COMMON", ask_price: "5" }, { tier: "COMMON", ask_price: "9" },
      { tier: "RARE", ask_price: "50" }, { tier: "LEGENDARY", ask_price: "500" },
    ]
    const GET = await loadGET()
    const body = await (await GET(get())).json()
    expect(body.snapshotsToday).toBe(4243) // exact count, not clamped
    expect(body.indexedEditions).toBe(19000)
    expect(body.commonFloor).toBe(5) // lowest of the COMMON asks (sorted asc in-query)
    expect(body.rareFloor).toBe(50)
    expect(body.legendaryFloor).toBe(500)
  })

  it("tier fallbacks: FANDOM→common, UNCOMMON→rare, ULTIMATE→legendary", async () => {
    st.snapCount = 1; st.edCount = 1
    st.listings = [{ tier: "FANDOM", ask_price: "3" }, { tier: "UNCOMMON", ask_price: "30" }, { tier: "ULTIMATE", ask_price: "3000" }]
    const GET = await loadGET()
    const body = await (await GET(get())).json()
    expect(body.commonFloor).toBe(3)
    expect(body.rareFloor).toBe(30)
    expect(body.legendaryFloor).toBe(3000)
  })

  it("empty listings → all floors null", async () => {
    st.snapCount = 10; st.edCount = 5; st.listings = []
    const GET = await loadGET()
    const body = await (await GET(get())).json()
    expect(body.commonFloor).toBeNull()
    expect(body.rareFloor).toBeNull()
    expect(body.legendaryFloor).toBeNull()
  })

  it("unknown collection → global count path (no crash)", async () => {
    st.snapCount = 999; st.edCount = 42
    const GET = await loadGET()
    const body = await (await GET(get("?collectionId=bogus-collection"))).json()
    expect(body.collectionId).toBe("bogus-collection")
    // unknown uuid ⇒ both snapshotsToday and indexedEditions read the fmv_snapshots count
    expect(body.snapshotsToday).toBe(999)
    expect(body.indexedEditions).toBe(999)
  })

  // ⚠ INVERTED, NOT DELETED. This asserted `snapshotsToday` "stays 0" on a failed
  // count. "Non-fatal" was the right intent — the route must not 500 over an index
  // -health number — but 0 is a CLAIM that nothing was snapshotted today, made from
  // our own outage, and this is a count of OUR OWN index. The tell was already in
  // the route: its failure object returns `commonFloor: null` beside
  // `snapshotsToday: 0`, so it knew how to say "unknown" and used it for the floors
  // only. What survives from the original is the non-fatal property, asserted below
  // as a 200 with the other fields intact.
  it("a snapshot count-query throw is non-fatal, and reports UNKNOWN rather than 0", async () => {
    st.snapThrow = true; st.edCount = 5
    const GET = await loadGET()
    const res = await GET(get())
    const body = await res.json()
    expect(body.snapshotsToday).toBeNull()
    // Non-fatal is still the contract: a 200, and the OTHER count still measured —
    // one failed leg must not null a leg that succeeded.
    expect(res.status).toBe(200)
    expect(body.indexedEditions).toBe(5)
  })

  it("a RETURNED count error also reports unknown — supabase-js does not throw", async () => {
    // ⚠ The realistic failure here is a 57014 statement timeout, which arrives as
    // `{ count: null, error }` and RESOLVES. A try/catch never fires for it, so the
    // throw case above does not cover this path at all — the error has to be read
    // off the result, which is exactly what `?? 0` was hiding.
    st.countError = { message: "canceling statement due to statement timeout" }
    const res = await (await loadGET())(get())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.snapshotsToday).toBeNull()
    expect(body.indexedEditions).toBeNull()
  })

  it("the whole-route failure object reports unknown counts, not zeros (SOURCE)", () => {
    // ⚠ A SOURCE assertion, deliberately, and the reason is worth recording: the
    // outer catch is UNREACHABLE from a fixture. Every call that can throw sits in
    // one of the three inner try/catch blocks, so nothing a mock can do reaches it —
    // a mutation restoring `indexedEditions: 0` there survives the behavioural suite.
    // Rather than contrive a fixture for a state the route cannot produce, pin the
    // property where it lives. It matters because that object is the ONE place the
    // route answers with no data at all, and it already returns `commonFloor: null`
    // beside the counts — the inconsistency that made the zeros look deliberate.
    const src = readFileSync(
      join(process.cwd(), "app", "api", "profile", "market-pulse", "route.ts"),
      "utf8",
    )
    const tail = src.slice(src.lastIndexOf("} catch (err)"))
    expect(tail).toMatch(/indexedEditions:\s*null/)
    expect(tail).toMatch(/snapshotsToday:\s*null/)
    expect(tail).not.toMatch(/indexedEditions:\s*0/)
    expect(tail).not.toMatch(/snapshotsToday:\s*0/)
  })

  it("a fresh cache short-circuits the second call", async () => {
    st.snapCount = 100; st.edCount = 100; st.listings = [{ tier: "COMMON", ask_price: "7" }]
    const GET = await loadGET()
    const first = await (await GET(get())).json()
    // mutate the source; a cached second call must ignore it
    st.listings = [{ tier: "COMMON", ask_price: "1" }]
    const second = await (await GET(get())).json()
    expect(second.commonFloor).toBe(first.commonFloor) // served from cache (7, not 1)
    expect(second.commonFloor).toBe(7)
  })
})
