import { describe, it, expect, afterEach, vi } from "vitest"
import { fetchFlowUsd, discoverDropIds, fetchScoredDrops } from "@/lib/pack-drops-board"

// The I/O half of the Vaultopolis pack-drops board — everything around scoreDrop
// (which its own suite covers). All three functions are best-effort by design:
// the board is public and read-only, so an upstream blip must degrade the page,
// never fail it. Concretely:
//
//   fetchFlowUsd  — a missing/garbage FLOW rate must return null, which is what
//     turns every USD figure on the board into "—". Returning 0 or NaN instead
//     would render $0.00 pack prices as if they were real.
//   discoverDropIds — primary path is the /api/drops list; the FALLBACK probes
//     ids 1..N until a composition 404s. That fallback had no test at all, and
//     it is the path that runs whenever the list endpoint changes shape.
//   fetchScoredDrops — the orchestrator's skip rules (cancelled drops, drops
//     with no Top Shot assets) and its live-first ordering.

const BASE = "https://data.vaultopolis.com/api/drops"

interface Stub {
  match: (url: string) => boolean
  respond: (url: string) => { ok?: boolean; status?: number; json?: unknown }
}

function installFetch(stubs: Stub[]) {
  const calls: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input)
      calls.push(url)
      const stub = stubs.find((s) => s.match(url))
      if (!stub) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
      const r = stub.respond(url)
      const status = r.status ?? 200
      return {
        ok: r.ok ?? (status >= 200 && status < 300),
        status,
        json: async () => r.json ?? {},
      } as unknown as Response
    }),
  )
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe("fetchFlowUsd", () => {
  it("returns the live rate", async () => {
    installFetch([{ match: (u) => u.includes("coingecko"), respond: () => ({ json: { flow: { usd: 0.42 } } }) }])
    expect(await fetchFlowUsd()).toBe(0.42)
  })

  it("returns null — never 0 or NaN — for every bad rate shape", async () => {
    for (const payload of [{}, { flow: {} }, { flow: { usd: 0 } }, { flow: { usd: -1 } }, { flow: { usd: "0.4" } }, { flow: { usd: Number.NaN } }]) {
      installFetch([{ match: (u) => u.includes("coingecko"), respond: () => ({ json: payload }) }])
      expect(await fetchFlowUsd(), JSON.stringify(payload)).toBeNull()
      vi.unstubAllGlobals()
    }
  })

  it("returns null on a non-2xx and on a thrown fetch", async () => {
    installFetch([{ match: (u) => u.includes("coingecko"), respond: () => ({ status: 502 }) }])
    expect(await fetchFlowUsd()).toBeNull()
    vi.unstubAllGlobals()

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("dns") }))
    expect(await fetchFlowUsd()).toBeNull()
  })
})

describe("discoverDropIds", () => {
  it("uses the list endpoint when it returns drops", async () => {
    const calls = installFetch([
      { match: (u) => u === BASE, respond: () => ({ json: { drops: [{ dropId: 4 }, { dropId: 5 }] } }) },
    ])
    const { ids, list } = await discoverDropIds()
    expect(ids).toEqual([4, 5])
    expect(list).toHaveLength(2)
    // The list path must not probe individual compositions.
    expect(calls.filter((c) => c.includes("/composition"))).toHaveLength(0)
  })

  it("drops a non-numeric dropId out of the id list while keeping the raw list intact", async () => {
    installFetch([
      { match: (u) => u === BASE, respond: () => ({ json: { drops: [{ dropId: 4 }, { dropId: "bad" }] } }) },
    ])
    const { ids, list } = await discoverDropIds()
    expect(ids).toEqual([4])
    expect(list).toHaveLength(2)
  })

  it("falls back to probing compositions until the first miss", async () => {
    const calls = installFetch([
      { match: (u) => u === BASE, respond: () => ({ json: { drops: [] } }) },
      {
        match: (u) => u.includes("/composition"),
        // ids 1 and 2 exist; 3 has no assets -> stop.
        respond: (u) => (u.includes("/3/") ? { json: {} } : { json: { assets: { TopShot: [] } } }),
      },
    ])
    const { ids, list } = await discoverDropIds()
    expect(ids).toEqual([1, 2])
    expect(list).toEqual([])
    expect(calls.filter((c) => c.includes("/composition"))).toHaveLength(3)
  })

  it("falls back the same way when the list endpoint itself fails", async () => {
    installFetch([
      { match: (u) => u === BASE, respond: () => ({ status: 500 }) },
      { match: (u) => u.includes("/composition"), respond: (u) => (u.includes("/1/") ? { json: { assets: {} } } : { json: {} }) },
    ])
    expect((await discoverDropIds()).ids).toEqual([1])
  })
})

describe("fetchScoredDrops", () => {
  const sb = { rpc: vi.fn(async () => ({ data: [], error: null })) } as never

  const asset = (over: Record<string, unknown> = {}) => ({
    nftId: 1, valueTier: "Common", playerName: "Dame", setName: "Base Set",
    serialNumber: 1, momentCount: 1, series: 4, tier: "common",
    estimatedValue: 10, floorPrice: null, ...over,
  })
  const composition = (dropId: number, assets: unknown[] | null) => ({
    dropId, name: `Drop ${dropId}`, displayName: `Drop ${dropId}`, description: "",
    packCount: 10, nftsPerPack: 5, totalNfts: 50, openedCount: 0, status: "live",
    assets: assets === null ? {} : { TopShot: assets },
  })

  function world(opts: {
    drops: Array<{ dropId: number; status?: string }>
    compositions: Record<number, unknown>
    saleOpenIds?: number[]
  }): Stub[] {
    return [
      { match: (u) => u.includes("coingecko"), respond: () => ({ json: { flow: { usd: 0.5 } } }) },
      { match: (u) => u === BASE, respond: () => ({ json: { drops: opts.drops } }) },
      {
        match: (u) => u.includes("/composition"),
        respond: (u) => {
          const id = Number(u.match(/drops\/(\d+)\//)?.[1])
          const c = opts.compositions[id]
          return c ? { json: c } : { status: 404 }
        },
      },
      { match: (u) => u.includes("/odds"), respond: () => ({ json: { tiers: [] } }) },
      {
        match: (u) => u.includes("/sale-state"),
        respond: (u) => {
          const id = Number(u.match(/drops\/(\d+)\//)?.[1])
          return { json: { saleOpen: (opts.saleOpenIds ?? []).includes(id) } }
        },
      },
    ]
  }

  it("skips cancelled drops and drops with no Top Shot assets", async () => {
    installFetch(
      world({
        drops: [{ dropId: 1, status: "cancelled" }, { dropId: 2 }, { dropId: 3 }],
        compositions: {
          1: composition(1, [asset()]),
          2: composition(2, null), // no TopShot key at all
          3: composition(3, [asset()]),
        },
      }),
    )
    const scored = await fetchScoredDrops(sb)
    expect(scored.map((d) => d.drop_id)).toEqual([3])
  })

  it("skips a drop whose composition cannot be fetched", async () => {
    installFetch(world({ drops: [{ dropId: 1 }, { dropId: 2 }], compositions: { 2: composition(2, [asset()]) } }))
    expect((await fetchScoredDrops(sb)).map((d) => d.drop_id)).toEqual([2])
  })

  it("sorts sale-open drops first, then newest id, and attaches odds + sale state", async () => {
    installFetch(
      world({
        drops: [{ dropId: 1 }, { dropId: 2 }, { dropId: 3 }],
        compositions: { 1: composition(1, [asset()]), 2: composition(2, [asset()]), 3: composition(3, [asset()]) },
        saleOpenIds: [1],
      }),
    )
    const scored = await fetchScoredDrops(sb)
    // Drop 1 is live so it leads despite being the oldest id; 3 before 2 after.
    expect(scored.map((d) => d.drop_id)).toEqual([1, 3, 2])
    expect(scored[0].sale_state?.saleOpen).toBe(true)
    expect(scored[0].odds).not.toBeNull()
    // The FLOW rate reached the scored rows.
    expect(scored[0].flow_usd).toBe(0.5)
  })

  it("returns an empty board rather than throwing when nothing is discoverable", async () => {
    installFetch([
      { match: (u) => u.includes("coingecko"), respond: () => ({ status: 500 }) },
      { match: (u) => u === BASE, respond: () => ({ json: { drops: [] } }) },
      { match: (u) => u.includes("/composition"), respond: () => ({ status: 404 }) },
    ])
    expect(await fetchScoredDrops(sb)).toEqual([])
  })
})
