import { describe, it, expect } from "vitest"
import { CHAIN_MINTED_BATCH, CHAIN_MINTED_SCRIPT, fetchChainMintedCounts } from "@/lib/pinnacle/chain-catalog"

// 2026-11-25: the catalog run raises pinnacle_catalog.total_minted to the contract's own Edition.numberMinted, because
// Atlas's numMinted ran below it (edition 2932: chain 707, Atlas 699).

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")

/** A Flow REST script response: base64 of a JSON-Cadence {Int: UInt64} dictionary. */
function okDict(entries: Array<[number, number]>) {
  const cdc = {
    type: "Dictionary",
    value: entries.map(([k, v]) => ({ key: { type: "Int", value: String(k) }, value: { type: "UInt64", value: String(v) } })),
  }
  return new Response(JSON.stringify(b64(JSON.stringify(cdc))), { status: 200 })
}

describe("fetchChainMintedCounts", () => {
  it("reads numberMinted as a plain UInt64 (the contract field is not optional)", () => {
    expect(CHAIN_MINTED_SCRIPT).toContain("out[id] = e.numberMinted")
    expect(CHAIN_MINTED_SCRIPT).not.toMatch(/if let n = e\.numberMinted/)
  })

  it("decodes the dictionary into edition id → count", async () => {
    const r = await fetchChainMintedCounts([2932, 2964], (async () => okDict([[2932, 707], [2964, 599]])) as typeof fetch)
    expect(r.errors).toEqual([])
    expect([...r.counts.entries()]).toEqual([[2932, 707], [2964, 599]])
  })

  it("a failed batch is absent from counts (never 0) and reported; other batches still land", async () => {
    let call = 0
    const ids = Array.from({ length: CHAIN_MINTED_BATCH + 1 }, (_, i) => i + 1)
    const r = await fetchChainMintedCounts(ids, (async () => {
      call++
      return call === 1 ? new Response("boom", { status: 400 }) : okDict([[CHAIN_MINTED_BATCH + 1, 12]])
    }) as typeof fetch)
    expect(call).toBe(2)
    expect(r.errors).toHaveLength(1)
    expect(r.counts.has(1)).toBe(false)
    expect(r.counts.get(CHAIN_MINTED_BATCH + 1)).toBe(12)
  })

  it("a thrown fetch is an error, not an empty success", async () => {
    const r = await fetchChainMintedCounts([1], (async () => { throw new Error("network") }) as typeof fetch)
    expect(r.counts.size).toBe(0)
    expect(r.errors[0]).toMatch(/network/)
  })

  it("drops non-positive and duplicate ids before calling the chain", async () => {
    const seen: string[] = []
    await fetchChainMintedCounts([0, -3, 5, 5], (async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      seen.push(Buffer.from(body.arguments[0], "base64").toString())
      return okDict([[5, 1]])
    }) as typeof fetch)
    expect(seen).toHaveLength(1)
    expect(JSON.parse(seen[0]).value).toEqual([{ type: "Int", value: "5" }])
  })
})
