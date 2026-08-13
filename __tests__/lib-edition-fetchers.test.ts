import { describe, it, expect, vi, afterEach } from "vitest"
import { fetchPackProvenance, fetchOwnerUsernames } from "@/lib/edition/fetchers"

// The edition page's two PostgREST TABLE reads, extracted so they can be bounded
// and tested. Both were live production error sources ("Timed out acquiring
// connection from connection pool" — 19 events for provenance, 5 for usernames)
// and, unlike every `.rpc()` on that page, neither had a wall-clock bound:
// `rpcWithRetry` is RPC-shaped and cannot take a `.from()` builder.
//
// What matters here is the BOUND and the ok/empty distinction — not the row
// shaping, which is trivial.

/**
 * A `.from()` builder stub. `settle` decides how the terminal await resolves;
 * `neverSettles` models the actual production failure — a request that never
 * comes back because the pool never hands it a connection.
 */
function builderStub(opts: {
  settle?: { data: unknown; error: unknown }
  neverSettles?: boolean
  withAbortSignal?: boolean
}) {
  const calls: string[] = []
  let abortedWith: AbortSignal | null = null
  const b: Record<string, unknown> = {}
  for (const m of ["select", "eq", "in", "not", "maybeSingle"]) {
    b[m] = (...a: unknown[]) => {
      calls.push(`${m}(${a.map(String).join(",")})`)
      return b
    }
  }
  if (opts.withAbortSignal) {
    b.abortSignal = (s: AbortSignal) => {
      abortedWith = s
      return b
    }
  }
  const settled = opts.neverSettles
    ? new Promise<never>(() => {})
    : Promise.resolve(opts.settle ?? { data: null, error: null })
  b.then = (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    settled.then(onF, onR)
  b.catch = (onR?: (e: unknown) => unknown) => settled.catch(onR)
  b.finally = (cb?: () => void) => settled.finally(cb)
  return {
    client: { from: (_t: string) => b },
    calls,
    get abortedWith() {
      return abortedWith
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("fetchPackProvenance", () => {
  it("returns the row with ok:true on a successful read", async () => {
    const s = builderStub({
      settle: { data: { pack_pulls_observed: 12, distinct_packs: 3 }, error: null },
    })
    const res = await fetchPackProvenance("ed-1", false, s.client)
    expect(res.ok).toBe(true)
    expect(res.data?.pack_pulls_observed).toBe(12)
  })

  it("distinguishes 'no provenance' from 'the read failed'", async () => {
    // The whole reason the module returns { data, ok } rather than a bare null.
    const empty = builderStub({ settle: { data: null, error: null } })
    const failed = builderStub({ settle: { data: null, error: { message: "pool timeout" } } })
    vi.spyOn(console, "error").mockImplementation(() => {})

    const a = await fetchPackProvenance("ed-1", false, empty.client)
    const b = await fetchPackProvenance("ed-1", false, failed.client)

    expect(a.data).toBeNull()
    expect(b.data).toBeNull()
    // Same data, opposite meaning.
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(false)
  })

  it("reads the All Day view only when isAllDay", async () => {
    // Reading the wrong view returns rows for the wrong collection, which would
    // be a silent correctness bug rather than a visible failure.
    const seen: string[] = []
    const s = builderStub({ settle: { data: null, error: null } })
    const spyClient = { from: (t: string) => { seen.push(t); return (s.client.from(t) as object) } }
    await fetchPackProvenance("ed-1", true, spyClient)
    await fetchPackProvenance("ed-1", false, spyClient)
    expect(seen).toEqual([
      "v_allday_edition_pull_provenance",
      "v_topshot_edition_pull_provenance",
    ])
  })

  it("⚠ SETTLES on a read that never comes back, instead of hanging forever", async () => {
    // This is the defect. Unbounded, this parked the render until Vercel's 300s
    // kill and left a streamed section spinning. The stub deliberately has NO
    // .abortSignal, mirroring how this repo's mocks shape builders — which is
    // exactly why withDeadline races as well as aborting.
    vi.useFakeTimers()
    vi.spyOn(console, "error").mockImplementation(() => {})
    const s = builderStub({ neverSettles: true })
    const p = fetchPackProvenance("ed-1", false, s.client)
    await vi.advanceTimersByTimeAsync(46_000)
    const res = await p
    expect(res.ok).toBe(false)
    expect(res.data).toBeNull()
  })

  it("passes an AbortSignal when the builder supports one, to release the pool slot", async () => {
    // Racing alone settles US; only the abort releases the CONNECTION, which is
    // the half that matters while the pool is the thing saturating.
    const s = builderStub({ settle: { data: null, error: null }, withAbortSignal: true })
    await fetchPackProvenance("ed-1", false, s.client)
    expect(s.abortedWith).toBeInstanceOf(AbortSignal)
  })
})

describe("fetchOwnerUsernames", () => {
  it("maps addresses to usernames, lower-cased, and dedupes the input", async () => {
    const s = builderStub({
      settle: {
        data: [
          { wallet_addr: "0xAbC", username: "alice" },
          { wallet_addr: "0xdef", username: null },
        ],
        error: null,
      },
    })
    const res = await fetchOwnerUsernames(["0xABC", "0xabc", "0xDEF"], s.client)
    expect(res.ok).toBe(true)
    expect(res.data.get("0xabc")).toBe("alice")
    // A null username is not a mapping.
    expect(res.data.has("0xdef")).toBe(false)
    // Deduped + lower-cased before the query.
    const inCall = s.calls.find((c) => c.startsWith("in("))
    expect(inCall).toContain("0xabc")
    expect(inCall).not.toContain("0xABC")
  })

  it("issues NO query for an empty address list, and calls that ok", async () => {
    // An empty list is a legitimate empty answer, not a failed read — and a
    // round trip here would pressure the very pool this change protects.
    let queried = false
    const client = { from: (_t: string) => { queried = true; return {} } }
    const res = await fetchOwnerUsernames([], client)
    expect(queried).toBe(false)
    expect(res.ok).toBe(true)
    expect(res.data.size).toBe(0)
  })

  it("returns an EMPTY map with ok:false on a failed read", async () => {
    // The page falls back to raw addresses, which is still true — an omission,
    // not a false claim. `ok` is what makes the two distinguishable.
    vi.spyOn(console, "error").mockImplementation(() => {})
    const s = builderStub({ settle: { data: null, error: { message: "pool timeout" } } })
    const res = await fetchOwnerUsernames(["0xabc"], s.client)
    expect(res.ok).toBe(false)
    expect(res.data.size).toBe(0)
  })

  it("⚠ SETTLES on a read that never comes back", async () => {
    vi.useFakeTimers()
    vi.spyOn(console, "error").mockImplementation(() => {})
    const s = builderStub({ neverSettles: true })
    const p = fetchOwnerUsernames(["0xabc"], s.client)
    await vi.advanceTimersByTimeAsync(46_000)
    const res = await p
    expect(res.ok).toBe(false)
    expect(res.data.size).toBe(0)
  })
})
