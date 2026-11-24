// Pins lib/candy/opensea-chain-listings.ts (2026-11-23): the key-free OpenSea Solana listings lane.
//
// The property that matters most is the ESCROW rule: a ListState account is not a live listing. On 11-23 a 40-listing
// control found only 26 of 40 Candy assets owned by their ListState (10 back in a plain wallet, 2 in Magic Eden's
// escrow, 2 burned). A lane that wrote every ListState would publish ~1 in 3 dead asks as live.

import { describe, expect, it } from "vitest"
import {
  CANDY_COLLECTION_UUID,
  LIST_STATE_DISCRIMINATOR_B58,
  MIN_PLAUSIBLE_ACCOUNTS,
  OPENSEA_SOLANA_PROGRAM,
  decodeListState,
  encodeBase58,
  fetchAssetOwners,
  fetchOpenSeaListStates,
  gmaBatchSize,
  runOpenSeaChainListings,
} from "@/lib/candy/opensea-chain-listings"

// ── fixtures ──────────────────────────────────────────────────────────────────────
const key = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : (i * 7 + n) % 256))
const b58 = (n: number) => encodeBase58(key(n))

function listState(opts: { owner: number; asset: number; lamports: bigint; currency?: number; expiry?: bigint; privateTaker?: boolean }): Uint8Array {
  const out = new Uint8Array(200)
  const v = new DataView(out.buffer)
  out.set([0x4e, 0xf2, 0x59, 0x8a, 0xa1, 0xdd, 0xb0, 0x4b], 0) // ListState discriminator (base64 TvJZiqHdsEs=)
  out[8] = 1; out[9] = 255
  out.set(key(opts.owner), 10)
  out.set(key(opts.asset), 42)
  v.setBigUint64(74, opts.lamports, true)
  let o = 82
  if (opts.currency !== undefined) { out[o] = 1; out.set(key(opts.currency), o + 1); o += 33 } else { out[o] = 0; o += 1 }
  v.setBigInt64(o, opts.expiry ?? BigInt(0), true); o += 8
  out[o] = opts.privateTaker ? 1 : 0
  return out
}
const coreAsset = (owner: number) => { const a = new Uint8Array(33); a[0] = 1; a.set(key(owner), 1); return a }
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64")

// A fake RPC: getProgramAccounts returns `accounts`; getMultipleAccounts answers from `assetOwners`.
function fakeRpc(accounts: Array<{ pda: number; data: Uint8Array }>, assetOwners: Map<string, number | null>, opts: { failGma?: boolean; gma429On?: string } = {}) {
  const calls: string[] = []
  const f = async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    calls.push(`${body.method}@${url}`)
    if (body.method === "getProgramAccounts") {
      expect(body.params[0]).toBe(OPENSEA_SOLANA_PROGRAM)
      expect(body.params[1].filters[0].memcmp.bytes).toBe(LIST_STATE_DISCRIMINATOR_B58)
      return new Response(JSON.stringify({ result: accounts.map((a) => ({ pubkey: b58(a.pda), account: { data: [b64(a.data), "base64"] } })) }))
    }
    if (body.method === "getMultipleAccounts") {
      if (opts.failGma || url === opts.gma429On) return new Response("rate limited", { status: opts.failGma ? 503 : 429 })
      const value = (body.params[0] as string[]).map((asset) => {
        const o = assetOwners.get(asset)
        return o == null ? null : { data: [b64(coreAsset(o)), "base64"] }
      })
      return new Response(JSON.stringify({ result: { value } }))
    }
    throw new Error(`unexpected ${body.method}`)
  }
  return { f, calls }
}

// A fake supabase-js: the four reads/writes the lane makes.
function fakeDb(opts: { wmc: Array<{ moment_id: string; edition_key: string | null }>; editions: Array<{ id: string; external_id: string }>; active?: Array<{ pda_address: string; last_seen_at: string }> }) {
  const upserts: Record<string, unknown>[] = []
  const active = new Map((opts.active ?? []).map((r) => [r.pda_address, r.last_seen_at]))
  let retireFilter: { lt?: string; venue?: string } | null = null
  const db = {
    from(table: string) {
      const state: Record<string, unknown> = { table }
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => { state[`eq:${c}`] = v; return q },
        in: (c: string, v: unknown[]) => { state[`in:${c}`] = v; return q },
        lt: (c: string, v: string) => { state[`lt:${c}`] = v; return q },
        upsert: (rows: Record<string, unknown>[]) => {
          upserts.push(...rows)
          for (const r of rows) active.set(String(r.pda_address), String(r.last_seen_at))
          return Promise.resolve({ error: null })
        },
        update: (_v: unknown) => { state.update = true; return q },
        then: (res: (v: unknown) => unknown) => {
          if (table === "wallet_moments_cache") {
            const ids = state["in:moment_id"] as string[]
            return Promise.resolve({ data: opts.wmc.filter((r) => ids.includes(r.moment_id)), error: null }).then(res)
          }
          if (table === "editions") {
            const ks = state["in:external_id"] as string[]
            return Promise.resolve({ data: opts.editions.filter((r) => ks.includes(r.external_id)), error: null }).then(res)
          }
          if (table === "candy_listings" && state.update) {
            retireFilter = { lt: state["lt:last_seen_at"] as string, venue: state["eq:venue"] as string }
            let n = 0
            for (const [pda, seen] of active) if (seen < retireFilter.lt!) { active.delete(pda); n++ }
            return Promise.resolve({ count: n, error: null }).then(res)
          }
          throw new Error(`unexpected read ${table}`)
        },
      }
      return q
    },
  }
  return { db, upserts, active, retireFilter: () => retireFilter }
}

// Enough filler ListStates (non-Candy assets) to clear the plausibility floor.
const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ pda: 100 + (i % 150), data: listState({ owner: 7, asset: 200 + (i % 50), lamports: BigInt(1) }) }))

const NOW = Date.UTC(2026, 10, 24, 5, 0, 0)

describe("decodeListState", () => {
  it("reads owner, asset, SOL price, expiry and the private-taker flag", () => {
    const d = decodeListState("PDA", listState({ owner: 1, asset: 2, lamports: BigInt(1_500_000_000), expiry: BigInt(1_900_000_000) }))
    expect(typeof d).toBe("object")
    if (typeof d === "string") return
    expect(d.owner).toBe(b58(1))
    expect(d.asset).toBe(b58(2))
    expect(d.lamports).toBe(BigInt(1_500_000_000))
    expect(d.sol).toBe(true)
    expect(d.expirySec).toBe(1_900_000_000)
    expect(d.privateTaker).toBe(false)
  })
  it("shifts past a Some(currency) and flags a non-SOL listing", () => {
    const d = decodeListState("PDA", listState({ owner: 1, asset: 2, lamports: BigInt(5), currency: 9, privateTaker: true }))
    if (typeof d === "string") throw new Error(d)
    expect(d.sol).toBe(false)
    expect(d.privateTaker).toBe(true)
    expect(d.expirySec).toBeNull()
  })
  it("refuses bytes whose option tags are not 0/1", () => {
    const bad = listState({ owner: 1, asset: 2, lamports: BigInt(5) }); bad[82] = 7
    expect(decodeListState("PDA", bad)).toBe("bad_currency_tag")
    expect(decodeListState("PDA", new Uint8Array(40))).toBe("short")
  })
  it("base58 keeps leading zero bytes as '1's", () => {
    expect(encodeBase58(new Uint8Array(32))).toBe("1".repeat(32))
    expect(encodeBase58(Uint8Array.from([0, 0, 1]))).toBe("112")
  })
})

describe("runOpenSeaChainListings", () => {
  const editions = [{ id: "ed-1", external_id: "key-1" }]
  const wmc = [1, 2, 3, 4, 5, 6].map((n) => ({ moment_id: b58(10 + n), edition_key: "key-1" }))

  it("writes only asks whose asset sits in its own ListState's escrow, and retires every OpenSea ask it did not confirm", async () => {
    const accounts = [
      { pda: 51, data: listState({ owner: 1, asset: 11, lamports: BigInt(2_000_000_000) }) }, // escrowed → WRITTEN
      { pda: 52, data: listState({ owner: 1, asset: 12, lamports: BigInt(1) }) },              // asset back in a wallet → orphan
      { pda: 53, data: listState({ owner: 1, asset: 13, lamports: BigInt(1) }) },              // asset burned → unreadable
      { pda: 54, data: listState({ owner: 1, asset: 14, lamports: BigInt(1), currency: 9 }) }, // non-SOL
      { pda: 55, data: listState({ owner: 1, asset: 15, lamports: BigInt(1), privateTaker: true }) }, // private
      { pda: 56, data: listState({ owner: 1, asset: 16, lamports: BigInt(1), expiry: BigInt(1_000) }) },     // expired
      ...filler(MIN_PLAUSIBLE_ACCOUNTS),
    ]
    const owners = new Map<string, number | null>([[b58(11), 51], [b58(12), 1], [b58(13), null], [b58(14), 54], [b58(15), 55], [b58(16), 56]])
    const { f } = fakeRpc(accounts, owners)
    const stale = new Date(NOW - 3600_000).toISOString()
    const { db, upserts, active, retireFilter } = fakeDb({ wmc, editions, active: [{ pda_address: b58(52), last_seen_at: stale }, { pda_address: "GONE", last_seen_at: stale }] })
    const rep = await runOpenSeaChainListings(db, { fetchImpl: f, now: () => NOW, solUsd: async () => 200 })

    expect(rep.ok).toBe(true)
    expect(rep.candy_matched).toBe(6)
    expect(upserts.map((r) => r.pda_address)).toEqual([b58(51)])
    expect(upserts[0]).toMatchObject({ token_mint: b58(11), edition_id: "ed-1", venue: "opensea", price_sol: 2, price_usd: 400, seller: b58(1), is_active: true })
    expect(upserts[0].venue_url).toBeUndefined()
    expect(rep).toMatchObject({ skipped_not_escrowed: 1, skipped_asset_unreadable: 1, skipped_not_sol: 1, skipped_private: 1, skipped_expired: 1, written: 1 })
    // ⚠ the orphan's existing row (52) and a vanished account are retired; the confirmed ask survives.
    expect(rep.retired).toBe(2)
    expect(retireFilter()).toEqual({ lt: new Date(NOW).toISOString(), venue: "opensea" })
    expect([...active.keys()]).toEqual([b58(51)])
  })

  it("a failed asset read fails the run: nothing written, nothing retired", async () => {
    const accounts = [{ pda: 51, data: listState({ owner: 1, asset: 11, lamports: BigInt(1) }) }, ...filler(MIN_PLAUSIBLE_ACCOUNTS)]
    const { f } = fakeRpc(accounts, new Map([[b58(11), 51]]), { failGma: true })
    const { db, upserts, active } = fakeDb({ wmc, editions, active: [{ pda_address: "OLD", last_seen_at: new Date(NOW - 1).toISOString() }] })
    await expect(runOpenSeaChainListings(db, { fetchImpl: f, now: () => NOW, sleep: async () => {} })).rejects.toThrow(/getMultipleAccounts HTTP 503/)
    expect(upserts).toEqual([])
    expect([...active.keys()]).toEqual(["OLD"])
  })

  it("a 429 from the census RPC falls through to the next RPC for the asset reads (the 11-23 first-run failure)", async () => {
    const accounts = [{ pda: 51, data: listState({ owner: 1, asset: 11, lamports: BigInt(1) }) }, ...filler(MIN_PLAUSIBLE_ACCOUNTS)]
    const { f, calls } = fakeRpc(accounts, new Map([[b58(11), 51]]), { gma429On: "https://a" })
    const { db, upserts } = fakeDb({ wmc, editions })
    const rep = await runOpenSeaChainListings(db, { fetchImpl: f, now: () => NOW, urls: ["https://a", "https://b"], sleep: async () => {} })
    expect(rep.written).toBe(1)
    expect(upserts.map((r) => r.pda_address)).toEqual([b58(51)])
    expect(calls).toEqual(["getProgramAccounts@https://a", "getMultipleAccounts@https://a", "getMultipleAccounts@https://b"])
  })

  it("reads publicnode in its 10-account batches", async () => {
    const owners = new Map<string, number | null>(Array.from({ length: 25 }, (_, i) => [b58(20 + i), 30] as [string, number]))
    const { f, calls } = fakeRpc([], owners)
    const got = await fetchAssetOwners(f, [...owners.keys()], ["https://solana-rpc.publicnode.com"], { sleep: async () => {} })
    expect(got.size).toBe(25)
    expect(calls.filter((c) => c.startsWith("getMultipleAccounts")).length).toBe(3)
    expect(gmaBatchSize("https://api.mainnet-beta.solana.com")).toBe(100)
  })

  it("an implausibly small census retires nothing and says why", async () => {
    const accounts = [{ pda: 51, data: listState({ owner: 1, asset: 11, lamports: BigInt(1) }) }]
    const { f } = fakeRpc(accounts, new Map([[b58(11), 51]]))
    const { db, active } = fakeDb({ wmc, editions, active: [{ pda_address: "OLD", last_seen_at: new Date(NOW - 1).toISOString() }] })
    const rep = await runOpenSeaChainListings(db, { fetchImpl: f, now: () => NOW })
    expect(rep.retired).toBeNull()
    expect(rep.retire_skipped).toMatch(/only 1 accounts/)
    expect(active.has("OLD")).toBe(true)
  })

  it("a census under half the last run's retires nothing", async () => {
    const accounts = [{ pda: 51, data: listState({ owner: 1, asset: 11, lamports: BigInt(1) }) }, ...filler(MIN_PLAUSIBLE_ACCOUNTS)]
    const { f } = fakeRpc(accounts, new Map([[b58(11), 51]]))
    const { db } = fakeDb({ wmc, editions })
    const rep = await runOpenSeaChainListings(db, { fetchImpl: f, now: () => NOW, previousAccounts: 13_400 })
    expect(rep.retired).toBeNull()
    expect(rep.retire_skipped).toMatch(/< half/)
  })

  it("no SOL rate → price_usd NULL, never a guessed dollar figure", async () => {
    const accounts = [{ pda: 51, data: listState({ owner: 1, asset: 11, lamports: BigInt(3_000_000_000) }) }, ...filler(MIN_PLAUSIBLE_ACCOUNTS)]
    const { f } = fakeRpc(accounts, new Map([[b58(11), 51]]))
    const { db, upserts } = fakeDb({ wmc, editions })
    const rep = await runOpenSeaChainListings(db, { fetchImpl: f, now: () => NOW, solUsd: async () => null })
    expect(rep.sol_usd).toBeNull()
    expect(upserts[0].price_usd).toBeNull()
    expect(upserts[0].price_sol).toBe(3)
  })

  it("a Candy card with no known edition is counted, not written", async () => {
    const accounts = [{ pda: 51, data: listState({ owner: 1, asset: 11, lamports: BigInt(1) }) }, ...filler(MIN_PLAUSIBLE_ACCOUNTS)]
    const { f } = fakeRpc(accounts, new Map([[b58(11), 51]]))
    const { db, upserts } = fakeDb({ wmc: [{ moment_id: b58(11), edition_key: null }], editions })
    const rep = await runOpenSeaChainListings(db, { fetchImpl: f, now: () => NOW })
    expect(rep.skipped_no_edition).toBe(1)
    expect(upserts).toEqual([])
  })

  it("reads the census scoped to the Candy collection", () => {
    expect(CANDY_COLLECTION_UUID).toBe("209ade70-32c5-4470-bc7c-4793d660f713")
  })
})

describe("fetchOpenSeaListStates", () => {
  it("falls through every failure shape to the next RPC, and names the last one when all fail", async () => {
    const shapes: Record<string, () => Response> = {
      "https://http": () => new Response("x", { status: 503 }),
      "https://rpcerr": () => new Response(JSON.stringify({ error: { message: "busy" } })),
      "https://noarray": () => new Response(JSON.stringify({ result: {} })),
      "https://ok": () => new Response(JSON.stringify({ result: [] })),
    }
    const f = async (url: string) => {
      if (url === "https://throw") throw new Error("socket hang up")
      return shapes[url]()
    }
    expect(await fetchOpenSeaListStates(f, ["https://throw", "https://http", "https://rpcerr", "https://noarray", "https://ok"])).toEqual({ accounts: [], url: "https://ok" })
    await expect(fetchOpenSeaListStates(f, ["https://rpcerr"])).rejects.toThrow(/busy/)
    await expect(fetchOpenSeaListStates(f, ["https://throw"])).rejects.toThrow(/socket hang up/)
  })

  it("asset reads: a JSON-RPC error, a short answer or a thrown fetch on every RPC fails the run", async () => {
    const f = async (url: string) => {
      if (url === "https://t") throw new Error("reset")
      if (url === "https://e") return new Response(JSON.stringify({ error: { message: "nope" } }))
      return new Response(JSON.stringify({ result: { value: [] } }))
    }
    await expect(fetchAssetOwners(f, ["A1"], ["https://t", "https://e", "https://short"], { sleep: async () => {} })).rejects.toThrow(/malformed result/)
  })
})
