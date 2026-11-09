import { describe, it, expect } from "vitest"
import { editionGroupKey, failureClass, gatewayAlternates, hydrateFromJsonUri, isUnhydrated, mergeOffChainJson } from "@/lib/chains/solana/hydrate"
import { editionKeyFromAsset, normalizeEdition, normalizeSerial } from "@/lib/chains/solana/normalize"
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
    { trait_type: "Serial Number", value: "376/850" },
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

  // ── one fetch per edition group (2026-11-09 8:57 AM PT: per-card fetching read 15 pages in 10 min) ──
  const card = (id: string, name: string, uri = `https://arweave.net/${id}`): DasAsset =>
    ({ ...bare, id, content: { json_uri: uri, metadata: { name } } })

  it("cards of one edition share ONE fetch, and each keeps its own name and serial", async () => {
    const a = card("a", "Phil Bickford (376/850)"), b = card("b", "Phil Bickford (12/850)"), c = card("c", "Phil Bickford (850/850)")
    expect(editionGroupKey(a)).toBe(editionGroupKey(b))
    const seen: string[] = []
    const f = (async (u: string) => { seen.push(u); return new Response(JSON.stringify(offChain), { status: 200 }) }) as unknown as typeof fetch
    const r = await hydrateFromJsonUri([a, b, c], { fetchImpl: f })
    expect(r.failed).toEqual([])
    expect(seen).toHaveLength(1)
    expect(r.fetches).toBe(1)
    const byId = new Map(r.hydrated.map((x) => [x.id, x]))
    expect(normalizeSerial(byId.get("a")!).serial_number).toBe(376)
    expect(normalizeSerial(byId.get("b")!).serial_number).toBe(12)
    expect(normalizeSerial(byId.get("c")!).serial_number).toBe(850)
    expect(byId.get("b")!.content?.metadata?.name).toBe("Phil Bickford (12/850)")
    // one edition for all three
    expect(new Set([...byId.values()].map((x) => normalizeEdition(x).external_id))).toEqual(new Set(["c:2022-leadoff-icons:phil-bickford-core"]))
  })

  it("a different edition size, another player, or a name without (n/m) is a separate fetch", async () => {
    const a = card("a", "Phil Bickford (376/850)"), rare = card("r", "Phil Bickford (3/50)"), other = card("o", "Josh VanMeter (1/850)"), solo = card("s", "Phil Bickford")
    expect(new Set([a, rare, other, solo].map(editionGroupKey)).size).toBe(4)
    let n = 0
    const f = (async () => { n++; return new Response(JSON.stringify(offChain), { status: 200 }) }) as unknown as typeof fetch
    const r = await hydrateFromJsonUri([a, rare, other, solo], { fetchImpl: f })
    expect(n).toBe(4)
    expect(r.groups).toBe(4)
  })

  it("if the first card's fetch fails, a second card of the group is tried; a group that fails fails every member", async () => {
    const a = card("a", "Phil Bickford (1/850)"), b = card("b", "Phil Bickford (2/850)")
    const f = (async (u: string) => u.includes("/a") ? new Response("x", { status: 404 }) : new Response(JSON.stringify(offChain), { status: 200 })) as unknown as typeof fetch
    const r = await hydrateFromJsonUri([a, b], { fetchImpl: f })
    expect(r.hydrated.map((x) => x.id).sort()).toEqual(["a", "b"])
    const dead = (async () => new Response("x", { status: 404 })) as unknown as typeof fetch
    const r2 = await hydrateFromJsonUri([a, b, card("c", "Phil Bickford (3/850)")], { fetchImpl: dead })
    expect(r2.failed.map((x) => x.id).sort()).toEqual(["a", "b", "c"])
    // only the first two members were tried, each on both gateways
    expect(r2.fetches).toBe(4)
  })

  // ── DC on-chain names: "<32-char title> <card #> <serial>", no edition size (run sample 10:57 AM PT) ──
  const dc = (id: string, serial: number) => card(id, `Justice League vs Suicid 1 ${serial}`)
  const dcJson = (rarity: string, serial: number) => ({
    ...offChain,
    attributes: [{ trait_type: "Rarity", value: rarity }, { trait_type: "Serial Number", value: `${serial}/5000` }],
  })

  it("DC names group by title + card number, VERIFIED on two members before the rest share the JSON", async () => {
    const ms = [dc("a", 2292), dc("b", 305), dc("c", 12), dc("d", 4999)]
    expect(new Set(ms.map(editionGroupKey)).size).toBe(1)
    let n = 0
    const f = (async (u: string) => { n++; const id = u.split("/").pop()!; return new Response(JSON.stringify(dcJson("Core", { a: 2292, b: 305 }[id as "a"] ?? 0)), { status: 200 }) }) as unknown as typeof fetch
    const r = await hydrateFromJsonUri(ms, { fetchImpl: f })
    expect(r.failed).toEqual([])
    expect(n).toBe(2) // representative + verifier; c and d share
    expect(r.unverified_groups).toBe(0)
    const byId = new Map(r.hydrated.map((x) => [x.id, x]))
    expect(normalizeSerial(byId.get("c")!).serial_number).toBe(12)
    expect(normalizeSerial(byId.get("d")!).serial_number).toBe(4999)
    expect(new Set([...byId.values()].map((x) => editionKeyFromAsset(x))).size).toBe(1)
  })

  it("if the two DC members DISAGREE on the edition, every member is fetched alone and keyed by its own JSON", async () => {
    const ms = [dc("a", 1), dc("b", 2), dc("c", 3)]
    const rarity: Record<string, string> = { a: "Core", b: "Rare", c: "Epic" }
    let n = 0
    const f = (async (u: string) => { n++; const id = u.split("/").pop()!; return new Response(JSON.stringify(dcJson(rarity[id], 1)), { status: 200 }) }) as unknown as typeof fetch
    const r = await hydrateFromJsonUri(ms, { fetchImpl: f })
    expect(r.unverified_groups).toBe(1)
    expect(n).toBe(3)
    const keys = new Map(r.hydrated.map((x) => [x.id, editionKeyFromAsset(x)]))
    expect(keys.get("a")).toMatch(/-core$/)
    expect(keys.get("b")).toMatch(/-rare$/)
    expect(keys.get("c")).toMatch(/-epic$/)
  })
})
