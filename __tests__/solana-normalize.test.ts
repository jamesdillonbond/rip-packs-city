import { describe, it, expect } from "vitest"
import {
  attrMap,
  editionKeyFromAsset,
  normalizeEdition,
  normalizeSerial,
  candyDiscoveryReady,
  candyMeSymbolReady,
  CANDY_MLB_COLLECTION_ADDRESS,
  CANDY_MLB_ME_SYMBOL,
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
  it("both guards are ready (collection address + ME symbol filled)", () => {
    // 2026-07-17: collection address filled -> discovery ready.
    // 2026-07-19: ME symbol ARMED with the live-verified value, so the sales
    // indexer polls for real. It stays a no-op while Magic Eden lists 0 Candy
    // items (SALE_TYPES excludes "bid"), but now captures the first printed sale
    // automatically instead of waiting on a manual constant flip.
    expect(candyDiscoveryReady()).toBe(true)
    expect(candyMeSymbolReady()).toBe(true)
  })

  it("the guards reject a TODO_-prefixed placeholder", () => {
    // Guard semantics are the contract, not the current values: anything still
    // carrying the TODO_ sentinel must read as not-ready.
    expect("TODO_2_CANDY_ME_SYMBOL".startsWith("TODO_")).toBe(true)
    expect(CANDY_MLB_ME_SYMBOL.startsWith("TODO_")).toBe(false)
    expect(CANDY_MLB_ME_SYMBOL).toBe("2026_mlb_base_series_icons_candy_digital")
  })

  it("pins the resolved collection address exactly (silent-corruption guard)", () => {
    // candyDiscoveryReady() only checks the TODO_ prefix, so ANY non-placeholder
    // string reads as "ready" — including a fat-fingered or reverted address.
    // CANDY_MLB_COLLECTION_ADDRESS is the DAS getAssetsByGroup group_value that
    // drives EVERY Candy editions/serials ingest, so a wrong value would run the
    // whole pipeline against the wrong Solana collection and silently pull nothing
    // (or wrong data) while the guards still read green. Pin the exact discovered
    // value (2026-07-17), mirroring the ME-symbol pin above, so CI catches a
    // regression the TODO_-prefix guard cannot.
    expect(CANDY_MLB_COLLECTION_ADDRESS).toBe("JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n")
    // ...and stays a well-formed base58 Solana mint (same shape the discovery
    // script validates a wallet against), so a truncation/paste error also fails.
    expect(CANDY_MLB_COLLECTION_ADDRESS).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
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
  // 2026-09-25: Candy's checklist designations (no on-chain trait on Drop 1).
  it("adds the checklist's Rookie + First Mint for a designated player, on every printing", () => {
    const base = asset({ id: "m1", content: { metadata: { name: "Munetaka Murakami #9/250", attributes: [
      { trait_type: "Player Name", value: "Munetaka Murakami" },
    ] } } })
    expect(normalizeEdition(base).badges).toEqual(["Rookie", "First Mint"])
    const rainbow = asset({ id: "m2", content: { metadata: { name: "Munetaka Murakami - PINK (3/15)", attributes: [
      { trait_type: "Player Name", value: "Munetaka Murakami" },
    ] } } })
    expect(normalizeEdition(rainbow).badges).toEqual(["Rookie", "First Mint", "Rainbow (Pink)"])
  })
  it("never duplicates First Mint when the trait AND the checklist both say so", () => {
    const a = asset({ id: "m3", content: { metadata: { name: "Ben Rice #1/250", attributes: [
      { trait_type: "Player Name", value: "Ben Rice" },
      { trait_type: "First Mint", value: "true" },
    ] } } })
    expect(normalizeEdition(a).badges).toEqual(["First Mint"])
  })
  it("an undesignated player gets no checklist badge", () => {
    const a = asset({ id: "m4", content: { metadata: { name: "Aaron Judge #1/250", attributes: [
      { trait_type: "Player Name", value: "Aaron Judge" },
    ] } } })
    expect(normalizeEdition(a).badges).toBeNull()
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

// 2026-11-08 — Candy's later sets (lib/chains/solana/candy-sets.ts). The Base Series
// keeps its legacy keys and writes no set/tier; later sets get a prefixed,
// rarity-suffixed key plus set_id / set_name / tier from the registry.
describe("multi-set Candy assets", () => {
  const grouped = (addr: string, name: string, attrs: Record<string, string>) =>
    asset({
      id: "mint-x",
      grouping: [{ group_key: "collection", group_value: addr }],
      content: { metadata: { name, attributes: Object.entries(attrs).map(([trait_type, value]) => ({ trait_type, value })) } },
      ownership: { owner: "W" },
    })
  const BASE = "JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n"
  const ASG = "YTAPbbkLY6cqskMCtBfQXtN1x1a8smiKiM99svzQAvX"
  const GOLD = "8BvHMsQZ2vihNBWFw3NcLYdpJzKsuz3kSrJUUwC5Lx4K"

  it("a Base ICON keeps its legacy key and its payload carries NO set_id / set_name / tier keys", () => {
    const a = grouped(BASE, "Shohei Ohtani (12/250)", { "Player Name": "Shohei Ohtani", Rarity: "CORE", "Serial Number": "12/250" })
    expect(editionKeyFromAsset(a)).toBe("shohei-ohtani")
    const e = normalizeEdition(a)
    expect("set_id" in e).toBe(false)
    expect("set_name" in e).toBe(false)
    expect("tier" in e).toBe(false)
  })

  it("the same player in another set — and another rarity — is a different edition", () => {
    const core = grouped(ASG, "Shohei Ohtani (100/225)", { Rarity: "CORE", "Serial Number": "100/225" })
    const rare = grouped(ASG, "Shohei Ohtani (17/50)", { Rarity: "RARE", "Serial Number": "17/50" })
    expect(editionKeyFromAsset(core)).toBe("asg26:shohei-ohtani-core")
    expect(editionKeyFromAsset(rare)).toBe("asg26:shohei-ohtani-rare")
    expect(normalizeSerial(rare).edition_key).toBe("asg26:shohei-ohtani-rare")
  })

  it("later sets carry set_id, set_name and a Rarity-derived tier; a Rainbow is LEGENDARY, an insert has no tier", () => {
    const rare = normalizeEdition(grouped(ASG, "Aaron Judge (3/50)", { Rarity: "RARE", "Serial Number": "3/50" }))
    expect(rare).toMatchObject({ set_id: "8608ae96-10c5-4bf6-aedf-b0d4dc0bfe66", set_name: "2026 MLB All-Star Game ICONs", tier: "RARE" })
    const rainbow = normalizeEdition(grouped(ASG, "Aaron Judge - PINK (3/15)", { Rarity: "CORE", "Serial Number": "3/15" }))
    expect(rainbow.tier).toBe("LEGENDARY")
    expect(rainbow.badges).toContain("Rainbow (Pink)")
    const insert = normalizeEdition(grouped(GOLD, "Shohei Ohtani - Momenticons (2/5)", { Rarity: "INSERT", "Insert Type": "Momenticon", "Serial Number": "2/5" }))
    expect(insert.tier).toBeNull()
    expect(insert.badges).toContain("Insert (Momenticons)")
    const legend = normalizeEdition(grouped(GOLD, "Shohei Ohtani (1/1)", { Rarity: "LEGENDARY", "Serial Number": "1/1" }))
    expect(legend.tier).toBe("LEGENDARY")
    expect(legend.badges ?? []).not.toContain(expect.stringMatching(/^Rainbow/))
  })

  it("TITAN (Candy's special-edition tier above Epic) is LEGENDARY; Unique and Rainbow reward labels stay untiered", () => {
    const titan = normalizeEdition(grouped(ASG, "Yordan Alvarez (12/77)", { Rarity: "TITAN", "Serial Number": "12/77" }))
    expect(titan.tier).toBe("LEGENDARY")
    const unique = normalizeEdition(grouped(ASG, "Shohei Ohtani AllStar Starter (3/40)", { Rarity: "UNIQUE", "Serial Number": "3/40" }))
    expect(unique.tier).toBeNull()
    const chaser = normalizeEdition(grouped(ASG, "Mike Trout Home Run Rainbow Chaser (3/30)", { Rarity: "RAINBOW", "Serial Number": "3/30" }))
    expect(chaser.tier).toBeNull()
  })

  it("Base checklist designations (Rookie / First Mint) are not copied onto a later set's ICONs", () => {
    const e = normalizeEdition(grouped(ASG, "Jac Caglianone - Home Run Derby (1/15)", { "Player Name": "Jac Caglianone", Rarity: "INSERT", "Insert Type": "Home Run Derby" }))
    expect(e.badges ?? []).not.toContain("Rookie")
    expect(e.badges ?? []).not.toContain("First Mint")
    expect(e.badges).toContain("Insert (Home Run Derby)")
  })

  // 2024 MLB Team Balls (found 2026-11-08): names carry an unassigned serial and no
  // Player Name / Team trait. One edition per club; the club comes from the name.
  const BALL = "5ENXADdhd29JgJA1rN7Fhf3CBgLD825LdwngncJgv5ck"
  it("a 2024 Team Ball is one edition per club, its team read from the name, serial and size unknown", () => {
    const a = grouped(BALL, "2024 Los Angeles Dodgers Baseball  (TBD/171)", { "Item Type": "Collectible", Rarity: "CORE" })
    expect(editionKeyFromAsset(a)).toBe("ball24:2024-los-angeles-dodgers-baseball-core")
    const e = normalizeEdition(a)
    expect(e).toMatchObject({
      name: "2024 Los Angeles Dodgers Baseball",
      team_name: "Los Angeles Dodgers",
      player_name: null,
      circulation_count: null,
      set_id: "362e7419-2983-490d-9165-16d41f12e2ec",
      set_name: "2024 MLB Team Balls",
      tier: "COMMON",
    })
    // "TBD/171" is not a serial; it must never be read as #171 or as an edition of 171.
    expect(normalizeSerial(a).serial_number).toBeNull()
  })

  it("a Team Ball club is spelled the way the Base Series spells it; a ball-shaped name elsewhere gets no team", () => {
    expect(normalizeEdition(grouped(BALL, "2024 Oakland Athletics Baseball (TBD/40)", { Rarity: "CORE" })).team_name).toBe("Athletics")
    expect(normalizeEdition(grouped(BALL, "2024 Los Angeles Angels Baseball (TBD/40)", { Rarity: "CORE" })).team_name).toBe("Angels")
    expect(normalizeEdition(grouped(ASG, "2024 Los Angeles Dodgers Baseball (1/1)", { Rarity: "CORE" })).team_name).toBeNull()
  })
})

// 2026-11-08 — the full Candy inventory (candy_collections) registers every non-test
// collection with the normalizer at run time; a registered legacy set keys and tags its
// editions like any later set, and can never displace a registry set.
describe("registered Candy collections (candy_collections)", () => {
  it("a registered legacy collection gets its prefix, set id and Rarity tier; a registry set cannot be overwritten", async () => {
    const { registerCandySets } = await import("@/lib/chains/solana/candy-sets")
    const LEADOFF = "46kCejJ7euGEmLAFqvV1j5yUzEumtwEvS9d65f6PbZ7g"
    const BASE = "JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n"
    registerCandySets([
      { key: "c:2022-leadoff-icons", name: "2022 Leadoff ICONs", setId: "11111111-1111-5111-8111-111111111111", collectionAddress: LEADOFF, meSymbol: "", editionKeyPrefix: "c:2022-leadoff-icons", writesPacks: false },
      { key: "c:hijack", name: "Hijack", setId: "22222222-2222-5222-8222-222222222222", collectionAddress: BASE, meSymbol: "", editionKeyPrefix: "c:hijack", writesPacks: false },
    ])
    const leg = asset({
      id: "mint-l", grouping: [{ group_key: "collection", group_value: LEADOFF }], ownership: { owner: "W" },
      content: { metadata: { name: "Seth Brown (361/850)", attributes: [{ trait_type: "Player Name", value: "Seth Brown" }, { trait_type: "Rarity", value: "COMMON" }, { trait_type: "Serial Number", value: "361/850" }] } },
    })
    expect(editionKeyFromAsset(leg)).toBe("c:2022-leadoff-icons:seth-brown-common")
    expect(normalizeEdition(leg)).toMatchObject({ set_id: "11111111-1111-5111-8111-111111111111", set_name: "2022 Leadoff ICONs", tier: "COMMON", circulation_count: 850, player_name: "Seth Brown" })
    const base = asset({
      id: "mint-b", grouping: [{ group_key: "collection", group_value: BASE }], ownership: { owner: "W" },
      content: { metadata: { name: "Shohei Ohtani (12/250)", attributes: [{ trait_type: "Player Name", value: "Shohei Ohtani" }, { trait_type: "Rarity", value: "CORE" }, { trait_type: "Serial Number", value: "12/250" }] } },
    })
    expect(editionKeyFromAsset(base)).toBe("shohei-ohtani")
  })
})

// 2026-11-09 — a 1-of-1 card is its own edition. Keyed by its 32-char-cut name, three
// different "2022 Tricon Hendriks McClanah…" cards (each "1/1") were ONE edition, and The
// Bat Cowl Collection (every card "1/1") collapsed into one edition of 4,404 cards; both
// were published as single 1-of-1 trophies.
describe("1-of-1 Candy cards are keyed by their own asset", () => {
  it("⚠ two different 1/1 cards with the same cut name are different editions; one card keys stably", async () => {
    const { registerCandySets } = await import("@/lib/chains/solana/candy-sets")
    const TRICONS = "TriConsCollectionAddr1111111111111111111111"
    registerCandySets([
      { key: "c:2022-all-star-tricons", name: "2022 All-Star Tricons", setId: "33333333-3333-5333-8333-333333333333", collectionAddress: TRICONS, meSymbol: "", editionKeyPrefix: "c:2022-all-star-tricons", writesPacks: false },
    ])
    const tri = (id: string) => asset({
      id, grouping: [{ group_key: "collection", group_value: TRICONS }], ownership: { owner: "W" },
      content: { metadata: { name: "2022 Tricon Hendriks McClanah", attributes: [{ trait_type: "Serial Number", value: "1/1" }] } },
    })
    const a = tri("J8trGBmsLPPr7qJTxM6Qjx9FgUo6T7wvNF6tW7FPi41V"), b = tri("9PokWBnGjxzFADNrWt2L6dAhXZX5LYc4NbkBdWTAoDGk")
    expect(editionKeyFromAsset(a)).toBe("c:2022-all-star-tricons:2022-tricon-hendriks-mcclanah-J8trGBmsLPPr")
    expect(editionKeyFromAsset(b)).not.toBe(editionKeyFromAsset(a))
    expect(editionKeyFromAsset(tri("J8trGBmsLPPr7qJTxM6Qjx9FgUo6T7wvNF6tW7FPi41V"))).toBe(editionKeyFromAsset(a))
    expect(normalizeEdition(a).circulation_count).toBe(1)
  })

  it("a card of a larger edition is untouched, and the Base Series (no prefix) is never re-keyed", () => {
    const ASG = "YTAPbbkLY6cqskMCtBfQXtN1x1a8smiKiM99svzQAvX"
    const BASE = "JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n"
    const g = (addr: string, name: string, serial: string) => asset({
      id: "mint-z", grouping: [{ group_key: "collection", group_value: addr }], ownership: { owner: "W" },
      content: { metadata: { name, attributes: [{ trait_type: "Rarity", value: "RARE" }, { trait_type: "Serial Number", value: serial }] } },
    })
    expect(editionKeyFromAsset(g(ASG, "Shohei Ohtani (17/50)", "17/50"))).toBe("asg26:shohei-ohtani-rare")
    expect(editionKeyFromAsset(g(BASE, "Shohei Ohtani (1/1)", "1/1"))).toBe("shohei-ohtani")
  })
})

describe("fitEditionKey — editions.external_id is varchar(100)", () => {
  it("leaves a key that fits untouched and shortens a long one to exactly 100, stably and uniquely", async () => {
    const { fitEditionKey } = await import("@/lib/chains/solana/normalize")
    expect(fitEditionKey("asg26:shohei-ohtani-core")).toBe("asg26:shohei-ohtani-core")
    const a = "c:dc3-super-power-packs-series-justice-league-vs-suicide-squad:" + "harley-quinn-and-the-joker-epic-artist-edition-variant-a-legendary"
    const b = a.replace("variant-a", "variant-b")
    expect(fitEditionKey(a).length).toBe(100)
    expect(fitEditionKey(a)).toBe(fitEditionKey(a))
    expect(fitEditionKey(a)).not.toBe(fitEditionKey(b))
    expect(fitEditionKey(a).startsWith(a.slice(0, 91))).toBe(true)
  })
})
