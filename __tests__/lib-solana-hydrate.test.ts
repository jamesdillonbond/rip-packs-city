import { describe, it, expect } from "vitest"
import { failureClass, gatewayAlternates, hydrateFromJsonUri, isUnhydrated, mergeOffChainJson } from "@/lib/chains/solana/hydrate"
import { editionKeyFromAsset, normalizeEdition } from "@/lib/chains/solana/normalize"
import { registerCandySets } from "@/lib/chains/solana/candy-sets"
import type { DasAsset } from "@/lib/chains/solana/das"

// lib/chains/solana/hydrate.ts — DAS sometimes returns a Candy asset with its on-chain name only
// (no traits, no image). Normalized as-is it fabricated a name-only edition (2026-11-09: 4,844
// editions, 328,317 cards). The off-chain JSON at content.json_uri carries the real fields.

const LEADOFF = "46kCejJ7euGEmLAFqvV1j5yUzEumtwEvS9d65f6PbZ7g"
const bare: DasAsset = {
  id: "2bGFwMGe4JcCWpYM5sVDo4uNFFzi9F8zEpsF5euhRAiH",
  grouping: [{ group_key: "collection", group_value: LEADOFF }],
  content: { json_uri: "https://permaweb.candy.io/4J8W5OW1SwBqKrUgHvKYp5vdpZ6DIhu6mKpNZ1_Wwio", metadata: { name: "Phil Bickford (376/850)" } },
  ownership: { owner: "GaykGEAY5hmYKe9zhbEuvq56jbH6B1WMYE3uD6x73RWo" },
}
const offChain = {
  name: "Phil Bickford (376/850)",
  image: "https://arweave.net/qPwTGHlLNINM30wdCyznHT_DmU6eed4j7e-oBC2OM7g",
  animation_url: "https://arweave.net/BASomk5yD-mCI9qwIzc5F-w6fHOPdvK-VFXawHXqLOc",
  attributes: [
    { trait_type: "Type", value: "Icon" },
    { trait_type: "Player Name", value: "Phil Bickford" },
    { trait_type: "Team", value: "Los Angeles Dodgers" },
    { trait_type: "Rarity", value: "Core" },
  ],
  properties: { files: [{ uri: "https://arweave.net/qPwTGHlLNINM30wdCyznHT_DmU6eed4j7e-oBC2OM7g", type: "image/png" }] },
}
// registered the way loadCandyCollections() registers the census catalog
registerCandySets([{ key: "c:2022-leadoff-icons", name: "2022 Leadoff ICONs", collectionAddress: LEADOFF, setId: "s-leadoff", editionKeyPrefix: "c:2022-leadoff-icons" } as never])

const r0 = (r: { failed: Array<{ reason: string }> }) => r.failed[0].reason
const okFetch = (async () => new Response(JSON.stringify(offChain), { status: 200 })) as unknown as typeof fetch

describe("unhydrated Candy assets", () => {
  it("an asset with a name but no traits and no image is unhydrated; a full one is not", () => {
    expect(isUnhydrated(bare)).toBe(true)
    expect(isUnhydrated(mergeOffChainJson(bare, offChain)!)).toBe(false)
  })

  it("the merged asset normalizes to the REAL edition, not the name-only key", () => {
    const merged = mergeOffChainJson(bare, offChain)!
    const ed = normalizeEdition(merged)
    expect(ed.player_name).toBe("Phil Bickford")
    expect(ed.thumbnail_url).toBe(offChain.image)
    // the fabricated key had no player and no image; the hydrated one carries both
    expect(normalizeEdition(bare).player_name).toBeNull()
    expect(normalizeEdition(bare).thumbnail_url).toBeNull()
    // the exact keys seen in production on 2026-11-09
    expect(editionKeyFromAsset(bare)).toBe("c:2022-leadoff-icons:phil-bickford")
    expect(ed.external_id).toBe("c:2022-leadoff-icons:phil-bickford-core")
  })

  it("JSON with neither traits nor an image is refused, not merged", () => {
    expect(mergeOffChainJson(bare, { name: "x" })).toBeNull()
    expect(mergeOffChainJson(bare, [])).toBeNull()
    expect(mergeOffChainJson(bare, null)).toBeNull()
  })

  it("fetches json_uri and returns the merged asset", async () => {
    const r = await hydrateFromJsonUri([bare], { fetchImpl: okFetch })
    expect(r.failed).toEqual([])
    expect(r.hydrated).toHaveLength(1)
    expect(r.hydrated[0].content?.links?.image).toBe(offChain.image)
  })

  it("a failed, non-200, unusable or non-https fetch is reported as FAILED, never hydrated", async () => {
    const throws = (async () => { throw new Error("timeout") }) as unknown as typeof fetch
    const notFound = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch
    const empty = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch
    for (const f of [throws, notFound, empty]) {
      const r = await hydrateFromJsonUri([bare], { fetchImpl: f })
      expect(r.hydrated).toEqual([])
      expect(r.failed).toHaveLength(1)
    }
    expect(failureClass(r0(await hydrateFromJsonUri([bare], { fetchImpl: notFound })))).toBe("HTTP 404")
    expect(failureClass(r0(await hydrateFromJsonUri([bare], { fetchImpl: throws })))).toBe("timeout")
    const http = { ...bare, content: { ...bare.content, json_uri: "http://example.com/x" } }
    let called = false
    const spy = (async () => { called = true; return new Response("{}") }) as unknown as typeof fetch
    const r = await hydrateFromJsonUri([http], { fetchImpl: spy })
    expect(r.failed[0].reason).toMatch(/https/)
    expect(called).toBe(false)
  })

  it("a failure on Candy's gateway is retried on arweave.net (same transaction)", async () => {
    expect(gatewayAlternates("https://permaweb.candy.io/TX")).toEqual(["https://permaweb.candy.io/TX", "https://arweave.net/TX"])
    expect(gatewayAlternates("https://arweave.net/TX")).toEqual(["https://arweave.net/TX", "https://permaweb.candy.io/TX"])
    expect(gatewayAlternates("https://other.host/TX")).toEqual(["https://other.host/TX"])
    const seen: string[] = []
    const flaky = (async (u: string) => {
      seen.push(u)
      return u.includes("permaweb") ? new Response("busy", { status: 429 }) : new Response(JSON.stringify(offChain), { status: 200 })
    }) as unknown as typeof fetch
    const r = await hydrateFromJsonUri([bare], { fetchImpl: flaky })
    expect(r.hydrated).toHaveLength(1)
    expect(seen).toEqual([bare.content!.json_uri, "https://arweave.net/4J8W5OW1SwBqKrUgHvKYp5vdpZ6DIhu6mKpNZ1_Wwio"])
  })
})
