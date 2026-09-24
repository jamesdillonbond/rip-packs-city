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

  // #33 (2026-09-24): the orchestrator scored drops one at a time, so a cold read of
  // 6 drops took 13.7 s against the page's 8 s budget and every cold ISR
  // regeneration baked a failure into 15 minutes of HTML. Drops must be in flight
  // TOGETHER, and every upstream call must carry an abort signal.
  it("scores drops concurrently, and every upstream call carries a timeout signal", async () => {
    let inFlight = 0
    let maxInFlight = 0
    const signals: unknown[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: { signal?: unknown }) => {
        const url = String(input)
        signals.push(init?.signal)
        const reply = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as unknown as Response
        if (url.includes("coingecko")) return reply({ flow: { usd: 0.5 } })
        if (url === BASE) return reply({ drops: [{ dropId: 1 }, { dropId: 2 }, { dropId: 3 }] })
        if (url.includes("/composition")) {
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise((r) => setTimeout(r, 20))
          inFlight--
          const id = Number(url.match(/drops\/(\d+)\//)?.[1])
          return reply(composition(id, [asset()]))
        }
        return reply({})
      }),
    )
    const scored = await fetchScoredDrops(sb)
    expect(scored.map((d) => d.drop_id).sort()).toEqual([1, 2, 3])
    expect(maxInFlight, "drops were fetched one at a time").toBe(3)
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((sig) => sig instanceof AbortSignal), "an upstream fetch has no timeout").toBe(true)
  })
})

// A FAILED read is not a MISSING drop (2026-09-24). After #33 added a 5 s upstream
// timeout, a slow composition read became indistinguishable from a drop with no
// Top Shot assets: the drop vanished from a board that still reported success, and
// an all-timeout world published `[]` — rendered as "No live re-pack drops to score
// right now". A failed read must now REJECT, so both callers show their honest
// degraded state. The 404 cases above are the no-change controls.
describe("fetchScoredDrops / discoverDropIds — a failed read is not a missing drop", () => {
  const sb = { rpc: vi.fn(async () => ({ data: [], error: null })) } as never
  const comp = (dropId: number) => ({
    dropId, name: `Drop ${dropId}`, displayName: `Drop ${dropId}`, description: "",
    packCount: 10, nftsPerPack: 5, totalNfts: 50, openedCount: 0, status: "live",
    assets: { TopShot: [{ nftId: 1, valueTier: "Common", playerName: "Dame", setName: "Base Set",
      serialNumber: 1, momentCount: 1, series: 4, tier: "common", estimatedValue: 10, floorPrice: null }] },
  })

  it("rejects — never returns a shorter board — when one drop's composition answers 5xx", async () => {
    installFetch([
      { match: (u) => u === BASE, respond: () => ({ json: { drops: [{ dropId: 1 }, { dropId: 2 }] } }) },
      { match: (u) => u.includes("/1/composition"), respond: () => ({ status: 503 }) },
      { match: (u) => u.includes("/2/composition"), respond: () => ({ json: comp(2) }) },
    ])
    await expect(fetchScoredDrops(sb)).rejects.toThrow(/composition for drop 1 failed: HTTP 503/)
  })

  it("rejects when a composition read times out (the fetch throws)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input)
        if (url === BASE) return { ok: true, status: 200, json: async () => ({ drops: [{ dropId: 7 }] }) } as unknown as Response
        if (url.includes("/composition")) {
          const e = new Error("The operation was aborted due to timeout")
          e.name = "TimeoutError"
          throw e
        }
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response
      }),
    )
    await expect(fetchScoredDrops(sb)).rejects.toThrow(/composition for drop 7 failed: TimeoutError/)
  })

  it("discovery rejects when the list fails AND the fallback probe fails — it does not answer []", async () => {
    installFetch([
      { match: (u) => u === BASE, respond: () => ({ status: 500 }) },
      { match: (u) => u.includes("/composition"), respond: () => ({ status: 502 }) },
    ])
    await expect(discoverDropIds()).rejects.toThrow(/drop discovery failed: list HTTP 500, probe of drop 1 HTTP 502/)
  })
})
