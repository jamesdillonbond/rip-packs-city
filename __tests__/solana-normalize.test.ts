import { describe, it, expect } from "vitest"
import {
  attrMap,
  editionKeyFromAsset,
  normalizeEdition,
  normalizeSerial,
  candyDiscoveryReady,
  candyMeSymbolReady,
  CANDY_MLB_SLUG,
  CANDY_MLB_UUID,
} from "@/lib/chains/solana/normalize"

// Chain-two (Candy/Solana) DAS asset normalization. editionKeyFromAsset must
// strip the per-serial suffix so all serials of a card group into one edition —
// a wrong key mis-attributes the whole collection. The discovery-ready guards
// keep an accidental pre-discovery run a clean no-op.

const asset = (o: any) => o as any

describe("attrMap", () => {
  it("lower-cases trait keys and stringifies values, skipping null trait types", () => {
    const a = asset({
      content: { metadata: { attributes: [
        { trait_type: "Set", value: "2026" },
        { trait_type: "Serial", value: 12 },
        { trait_type: null, value: "x" },
      ] } },
    })
    expect(attrMap(a)).toEqual({ set: "2026", serial: "12" })
  })

  it("returns {} when there are no attributes", () => {
    expect(attrMap(asset({ id: "x" }))).toEqual({})
  })
})

describe("editionKeyFromAsset", () => {
  it("strips a '#N/M' serial suffix and slugs the name", () => {
    expect(editionKeyFromAsset(asset({ content: { metadata: { name: "Mike Trout #12/100" } } }))).toBe(
      "mike-trout"
    )
  })
  it("strips a bare 'N/M' serial suffix", () => {
    expect(editionKeyFromAsset(asset({ content: { metadata: { name: "Shohei Ohtani 5/50" } } }))).toBe(
      "shohei-ohtani"
    )
  })
  it("strips a '#N' suffix", () => {
    expect(editionKeyFromAsset(asset({ content: { metadata: { name: "Aaron Judge #7" } } }))).toBe(
      "aaron-judge"
    )
  })
  it("falls back to the asset id when the name is empty", () => {
    expect(editionKeyFromAsset(asset({ id: "mintPubkey123" }))).toBe("mintpubkey123")
  })
})

describe("normalizeEdition", () => {
  it("maps name + image/video + the Candy collection identity", () => {
    const e = normalizeEdition(
      asset({
        id: "m1",
        content: {
          metadata: { name: "Mike Trout #1/100" },
          links: { image: "https://img/x.png", animation_url: "https://vid/x.mp4" },
        },
      })
    )
    expect(e.external_id).toBe("mike-trout")
    expect(e.collection).toBe(CANDY_MLB_SLUG)
    expect(e.collection_id).toBe(CANDY_MLB_UUID)
    expect(e.name).toBe("Mike Trout #1/100")
    expect(e.thumbnail_url).toBe("https://img/x.png")
    expect(e.video_url).toBe("https://vid/x.mp4")
  })

  it("falls back to a file uri for the image", () => {
    const e = normalizeEdition(
      asset({ id: "m2", content: { metadata: { name: "X" }, files: [{ mime: "image/png", uri: "https://f/img.png" }] } })
    )
    expect(e.thumbnail_url).toBe("https://f/img.png")
  })
})

describe("normalizeSerial", () => {
  it("maps owner → wallet, id → moment_id, and derives the edition key", () => {
    const s = normalizeSerial(
      asset({
        id: "mintPub",
        ownership: { owner: "Owner111" },
        content: { metadata: { name: "Mike Trout #9/100" }, links: { image: "https://i/x.png" } },
      })
    )
    expect(s.wallet_address).toBe("Owner111")
    expect(s.moment_id).toBe("mintPub")
    expect(s.edition_key).toBe("mike-trout")
    expect(s.image_url).toBe("https://i/x.png")
    expect(s.collection_id).toBe(CANDY_MLB_UUID)
  })
})

describe("discovery-ready guards", () => {
  it("are false while the collection-address / symbol TODOs are unfilled", () => {
    // These placeholders ship as "TODO_..." until Candy discovery lands.
    expect(candyDiscoveryReady()).toBe(false)
    expect(candyMeSymbolReady()).toBe(false)
  })
})
