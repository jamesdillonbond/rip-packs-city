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
    expect(e.name).toBe("Mike Trout")
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
  it("candyDiscoveryReady true post-fill; candyMeSymbolReady stays false (ME symbol TODO)", () => {
    // 2026-07-17: collection address filled -> discovery ready; ME symbol left TODO.
    expect(candyDiscoveryReady()).toBe(true)
    expect(candyMeSymbolReady()).toBe(false)
  })
})

// ── 2026-07-16 recon hardening: burns + confirmed on-asset traits ──────────

import { isBurnt, rainbowColorFromAsset, isFirstMint } from "@/lib/chains/solana/normalize"

describe("isBurnt", () => {
  it("is true only for burnt: true", () => {
    expect(isBurnt(asset({ id: "x", burnt: true }))).toBe(true)
    expect(isBurnt(asset({ id: "x", burnt: false }))).toBe(false)
    expect(isBurnt(asset({ id: "x" }))).toBe(false)
  })
})

describe("rainbowColorFromAsset", () => {
  const withTrait = (k: string, v: string) =>
    asset({ content: { metadata: { attributes: [{ trait_type: k, value: v }] } } })
  it("reads the confirmed 'Rainbow Insert' trait, case-insensitive", () => {
    expect(rainbowColorFromAsset(withTrait("Rainbow Insert", "Pink"))).toBe("pink")
    expect(rainbowColorFromAsset(withTrait("rainbow insert", "ORANGE"))).toBe("orange")
  })
  it("falls back through candidate keys and passes through unseen colors", () => {
    expect(rainbowColorFromAsset(withTrait("Variant", "Blue"))).toBe("blue")
    expect(rainbowColorFromAsset(withTrait("Rainbow", "Chrome"))).toBe("chrome")
  })
  it("nulls on none/false/absent", () => {
    expect(rainbowColorFromAsset(withTrait("Rainbow Insert", "None"))).toBeNull()
    expect(rainbowColorFromAsset(withTrait("Rainbow Insert", "false"))).toBeNull()
    expect(rainbowColorFromAsset(asset({ id: "x" }))).toBeNull()
  })
})

describe("isFirstMint", () => {
  const withTrait = (k: string, v: string) =>
    asset({ content: { metadata: { attributes: [{ trait_type: k, value: v }] } } })
  it("truthy variants", () => {
    expect(isFirstMint(withTrait("First Mint", "true"))).toBe(true)
    expect(isFirstMint(withTrait("First Mint", "Yes"))).toBe(true)
    expect(isFirstMint(withTrait("first_mint", "1"))).toBe(true)
  })
  it("false when absent or falsy", () => {
    expect(isFirstMint(withTrait("First Mint", "false"))).toBe(false)
    expect(isFirstMint(asset({ id: "x" }))).toBe(false)
  })
})

describe("normalizeEdition badges", () => {
  it("folds First Mint + Rainbow into editions.badges", () => {
    const a = asset({
      id: "mint1",
      content: { metadata: { name: "Paul Skenes #3/15", attributes: [
        { trait_type: "First Mint", value: "true" },
        { trait_type: "Rainbow Insert", value: "Green" },
      ] } },
    })
    expect(normalizeEdition(a).badges).toEqual(["First Mint", "Rainbow (Green)"])
  })
  it("badges is null (not []) when nothing matched", () => {
    const a = asset({ id: "m", content: { metadata: { name: "Mookie Betts #1/250" } } })
    expect(normalizeEdition(a).badges).toBeNull()
  })
})


import { isPack, editionSizeFromAsset, serialFromAsset } from "@/lib/chains/solana/normalize"

describe("Candy Drop-1 real formats (2026-07-17 discovery)", () => {
  const named = (name: string, attrs: any[] = []) =>
    asset({ id: "m", content: { metadata: { name, attributes: attrs } } })

  it("edition key strips the '(N/M)' suffix", () => {
    expect(editionKeyFromAsset(named("Aaron Judge (248/250)"))).toBe("aaron-judge")
    expect(editionKeyFromAsset(named("Bobby Witt Jr. - YELLOW (13/15)"))).toBe("bobby-witt-jr-yellow")
  })
  it("Core and Rainbow of one player are DIFFERENT edition keys", () => {
    expect(editionKeyFromAsset(named("Bobby Witt Jr. (250/250)"))).not.toBe(
      editionKeyFromAsset(named("Bobby Witt Jr. - YELLOW (13/15)"))
    )
  })
  it("reads the Rainbow colour from the name", () => {
    expect(rainbowColorFromAsset(named("Bobby Witt Jr. - YELLOW (13/15)"))).toBe("yellow")
    expect(rainbowColorFromAsset(named("Aaron Judge (248/250)"))).toBeNull()
  })
  it("isPack is true only for Item Type=Pack", () => {
    expect(isPack(named("2026 MLB Base Series ICONs (1444/2500)", [{ trait_type: "Item Type", value: "Pack" }]))).toBe(true)
    expect(isPack(named("Aaron Judge (248/250)", [{ trait_type: "Item Type", value: "Collectible" }]))).toBe(false)
  })
  it("edition size = denominator of the 'Serial Number' display trait", () => {
    expect(editionSizeFromAsset(named("x", [{ trait_type: "Serial Number", value: "248/250" }]))).toBe(250)
    expect(editionSizeFromAsset(named("x", [{ trait_type: "Serial Number", value: "13/15" }]))).toBe(15)
  })
})


describe("Candy normalize QA fixes (2026-07-17)", () => {
  const named = (name: string, attrs: any[] = []) =>
    asset({ id: "m", content: { metadata: { name, attributes: attrs } } })
  it("strips a bare trailing serial from the name (Rainbow variant naming)", () => {
    expect(editionKeyFromAsset(named("Munetaka Murakami - GREEN 10"))).toBe("munetaka-murakami-green")
    expect(editionKeyFromAsset(named("Munetaka Murakami - GREEN (9/15)"))).toBe("munetaka-murakami-green")
  })
  it("serial = numerator of the 'Serial Number' trait (DAS omits serial_number)", () => {
    expect(serialFromAsset(named("x", [{ trait_type: "Serial Number", value: "9/15" }]))).toBe(9)
    expect(serialFromAsset(named("x", [{ trait_type: "Serial Number", value: "248/250" }]))).toBe(248)
  })
})
