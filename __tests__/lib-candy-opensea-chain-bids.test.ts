// Pins lib/candy/opensea-chain-bids.ts (2026-11-24): Candy offers on OpenSea, read key-free from the Solana chain.
//
// What must hold: only SINGLE-CARD bids on Candy cards are written; a bid whose account does not hold its SOL is not
// confirmable and is skipped; collection-wide bids are counted, never written; every OpenSea offer the sweep did not
// confirm is retired — and nothing is retired behind an implausible census.

import { describe, expect, it } from "vitest"
import {
  BID_STATE_DISCRIMINATOR_B58,
  MIN_PLAUSIBLE_BID_ACCOUNTS,
  decodeBidState,
  runOpenSeaChainBids,
} from "@/lib/candy/opensea-chain-bids"
import { OPENSEA_SOLANA_PROGRAM, encodeBase58 } from "@/lib/candy/opensea-chain-listings"

const key = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : (i * 11 + n) % 256))
const b58 = (n: number) => encodeBase58(key(n))
const SOL = BigInt(1_000_000_000)

function bidState(o: { owner: number; target?: 0 | 1; targetId: number; qty?: number; filled?: number; amount: bigint; currency?: number; expiry?: bigint; field?: boolean }): Uint8Array {
  const out = new Uint8Array(200)
  const v = new DataView(out.buffer)
  out.set([0x9b, 0xc5, 0x05, 0x61, 0xbd, 0x3c, 0x08, 0xb7], 0) // BidState discriminator (base64 m8UFYb08CLc=)
  out[8] = 2; out[9] = 254
  out.set(key(o.owner), 10)
  out.set(key(o.targetId), 42)
  out[74] = o.target ?? 0
  out.set(key(o.targetId), 75)
  let p = 107
  if (o.field) { out[p] = 1; out[p + 1] = 0; p += 2 } else { out[p] = 0; p += 1 }
  out[p] = 0; p += 1 // field id None
  v.setUint32(p, o.qty ?? 1, true); p += 4
  v.setUint32(p, o.filled ?? 0, true); p += 4
  v.setBigUint64(p, o.amount, true); p += 8
  if (o.currency !== undefined) { out[p] = 1; out.set(key(o.currency), p + 1); p += 33 } else { out[p] = 0; p += 1 }
  v.setBigInt64(p, o.expiry ?? BigInt(0), true)
  return out
}
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64")

function fakeRpc(accounts: Array<{ pda: number; data: Uint8Array; lamports: bigint }>) {
  return async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    expect(body.method).toBe("getProgramAccounts")
    expect(body.params[0]).toBe(OPENSEA_SOLANA_PROGRAM)
    expect(body.params[1].filters[0].memcmp.bytes).toBe(BID_STATE_DISCRIMINATOR_B58)
    return new Response(JSON.stringify({
      result: accounts.map((a) => ({ pubkey: b58(a.pda), account: { data: [b64(a.data), "base64"], lamports: Number(a.lamports) } })),
    }))
  }
}

function fakeDb(opts: { wmc: Array<{ moment_id: string; edition_key: string | null }>; active?: Array<{ pda_address: string; last_seen_at: string }> }) {
  const upserts: Record<string, unknown>[] = []
  const active = new Map((opts.active ?? []).map((r) => [r.pda_address, r.last_seen_at]))
  const editions = [{ id: "ed-1", external_id: "key-1" }]
  let retireVenue: unknown = null
  const db = {
    from(table: string) {
      const st: Record<string, unknown> = {}
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => { st[`eq:${c}`] = v; return q },
        in: (c: string, v: unknown[]) => { st[`in:${c}`] = v; return q },
        lt: (c: string, v: unknown) => { st[`lt:${c}`] = v; return q },
        upsert: (rows: Record<string, unknown>[]) => {
          expect(table).toBe("candy_offers")
          upserts.push(...rows)
          for (const r of rows) active.set(String(r.pda_address), String(r.last_seen_at))
          return Promise.resolve({ error: null })
        },
        update: () => { st.update = true; return q },
        then: (res: (v: unknown) => unknown) => {
          if (table === "wallet_moments_cache") return Promise.resolve({ data: opts.wmc.filter((r) => (st["in:moment_id"] as string[]).includes(r.moment_id)), error: null }).then(res)
          if (table === "editions") return Promise.resolve({ data: editions.filter((r) => (st["in:external_id"] as string[]).includes(r.external_id)), error: null }).then(res)
          if (table === "candy_offers" && st.update) {
            retireVenue = st["eq:venue"]
            let n = 0
            for (const [pda, seen] of active) if (seen < (st["lt:last_seen_at"] as string)) { active.delete(pda); n++ }
            return Promise.resolve({ count: n, error: null }).then(res)
          }
          throw new Error(`unexpected ${table}`)
        },
      }
      return q
    },
  }
  return { db, upserts, active, retireVenue: () => retireVenue }
}

const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ pda: 100 + (i % 100), data: bidState({ owner: 9, targetId: 200 + (i % 40), amount: BigInt(1) }), lamports: SOL }))
const NOW = Date.UTC(2026, 10, 24, 14, 0, 0)
const wmc = [11, 12, 13, 14, 15, 16, 17].map((n) => ({ moment_id: b58(n), edition_key: "key-1" }))

describe("decodeBidState", () => {
  it("reads bidder, single-card target, quantity, amount and expiry; skips a Some(field)", () => {
    const d = decodeBidState("P", bidState({ owner: 1, targetId: 11, qty: 3, filled: 1, amount: SOL / BigInt(2), expiry: BigInt(1_900_000_000), field: true }))
    if (typeof d === "string") throw new Error(d)
    expect(d).toMatchObject({ owner: b58(1), target: 0, targetId: b58(11), quantity: 3, filled: 1, sol: true, expirySec: 1_900_000_000 })
    expect(d.amount).toBe(SOL / BigInt(2))
  })
  it("refuses bytes whose tags are not 0/1", () => {
    const bad = bidState({ owner: 1, targetId: 11, amount: SOL }); bad[74] = 5
    expect(decodeBidState("P", bad)).toBe("bad_target")
    expect(decodeBidState("P", new Uint8Array(50))).toBe("short")
  })
})

describe("runOpenSeaChainBids", () => {
  it("writes funded single-card Candy bids only and retires every OpenSea offer it did not confirm", async () => {
    const accounts = [
      { pda: 51, data: bidState({ owner: 1, targetId: 11, amount: SOL / BigInt(4) }), lamports: SOL / BigInt(4) + BigInt(2_000_000) }, // funded → WRITTEN
      { pda: 52, data: bidState({ owner: 1, targetId: 12, amount: SOL }), lamports: BigInt(2_000_000) },                                  // margin-funded → skipped
      { pda: 53, data: bidState({ owner: 1, targetId: 13, amount: SOL, expiry: BigInt(1_000) }), lamports: SOL * BigInt(2) },              // expired
      { pda: 54, data: bidState({ owner: 1, targetId: 14, amount: SOL, qty: 2, filled: 2 }), lamports: SOL * BigInt(2) },                  // filled
      { pda: 55, data: bidState({ owner: 1, targetId: 15, amount: SOL, currency: 7 }), lamports: SOL * BigInt(2) },                        // non-SOL
      { pda: 56, data: bidState({ owner: 1, target: 1, targetId: 16, amount: SOL }), lamports: SOL * BigInt(2) },                          // collection bid
      { pda: 57, data: bidState({ owner: 1, targetId: 17, amount: SOL, qty: 3, filled: 1 }), lamports: SOL },                             // 2 left, 1 SOL held → under-funded
      ...filler(MIN_PLAUSIBLE_BID_ACCOUNTS),
    ]
    const stale = new Date(NOW - 3600_000).toISOString()
    const { db, upserts, active, retireVenue } = fakeDb({ wmc, active: [{ pda_address: b58(52), last_seen_at: stale }, { pda_address: "GONE", last_seen_at: stale }] })
    const rep = await runOpenSeaChainBids(db, { fetchImpl: fakeRpc(accounts), now: () => NOW, solUsd: async () => 200 })

    expect(rep.ok).toBe(true)
    expect(upserts.map((r) => r.pda_address)).toEqual([b58(51)])
    expect(upserts[0]).toMatchObject({ token_mint: b58(11), edition_id: "ed-1", buyer: b58(1), venue: "opensea", price_sol: 0.25, price_usd: 50, token_size: 1, is_active: true })
    expect(rep).toMatchObject({ collection_bids: 1, candy_matched: 6, written: 1, skipped_unfunded: 2, skipped_expired: 1, skipped_filled: 1, skipped_not_sol: 1, retired: 2 })
    expect(retireVenue()).toBe("opensea")
    expect([...active.keys()]).toEqual([b58(51)])
  })

  it("an implausible census retires nothing", async () => {
    const { db, active } = fakeDb({ wmc, active: [{ pda_address: "OLD", last_seen_at: new Date(NOW - 1).toISOString() }] })
    const rep = await runOpenSeaChainBids(db, { fetchImpl: fakeRpc(filler(5)), now: () => NOW })
    expect(rep.retired).toBeNull()
    expect(rep.retire_skipped).toMatch(/only 5 accounts/)
    expect(active.has("OLD")).toBe(true)

    const r2 = await runOpenSeaChainBids(fakeDb({ wmc }).db, { fetchImpl: fakeRpc(filler(MIN_PLAUSIBLE_BID_ACCOUNTS)), now: () => NOW, previousAccounts: 1_029 })
    expect(r2.retire_skipped).toMatch(/< half/)
  })

  it("a failed census throws: nothing written, nothing retired", async () => {
    const { db, upserts, active } = fakeDb({ wmc, active: [{ pda_address: "OLD", last_seen_at: new Date(NOW - 1).toISOString() }] })
    const down = async () => new Response("rate limited", { status: 429 })
    await expect(runOpenSeaChainBids(db, { fetchImpl: down, now: () => NOW, urls: ["https://a"] })).rejects.toThrow(/HTTP 429/)
    expect(upserts).toEqual([])
    expect(active.has("OLD")).toBe(true)
  })

  it("no SOL rate → price_usd NULL", async () => {
    const accounts = [{ pda: 51, data: bidState({ owner: 1, targetId: 11, amount: SOL }), lamports: SOL * BigInt(2) }, ...filler(MIN_PLAUSIBLE_BID_ACCOUNTS)]
    const { db, upserts } = fakeDb({ wmc })
    await runOpenSeaChainBids(db, { fetchImpl: fakeRpc(accounts), now: () => NOW, solUsd: async () => null })
    expect(upserts[0].price_usd).toBeNull()
    expect(upserts[0].price_sol).toBe(1)
  })
})
