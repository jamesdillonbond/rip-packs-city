// __tests__/panini-collector-walk.test.ts
//
// The pure parts of scripts/panini-collector-walk.mjs (2026-09-27). The walk itself needs
// a browser and Panini; what CAN be pinned here is what decides correctness:
//   - which network response is the profile's collected-cards answer,
//   - completeness (only a known total, fully collected, with no error),
//   - the holding mapper (serial/cap from url_key's own suffix; no key → dropped),
//   - the profile state (a private or missing profile is never "public with 0 cards"),
//   - targets (a typo fails loudly; the receiver's plan merges without duplicates).

import { describe, expect, it } from "vitest"
import {
  PAGE_SIZE,
  UNOPENED_PACKS_URL,
  answerIsFor,
  collectionDetailsUrl,
  profileUrlCandidates,
  readClubPacks,
  readCollectionList,
  reportedCardTotal,
  signedInNickname,
  findKey,
  isComplete,
  mergeTargets,
  operationOf,
  parseTargets,
  profileStateOf,
  profileUrl,
  readCollected,
  toHolding,
} from "../scripts/panini-collector-walk.mjs"

describe("profileUrl", () => {
  it("opens the collected tab of the public profile (the tab the page pages on scroll)", () => {
    expect(profileUrl("Jamesdillonbond")).toBe("https://nft.paniniamerica.net/public-profile/collections.html?nickname=Jamesdillonbond&tab=collected")
    expect(PAGE_SIZE).toBe(30)
  })
})

describe("operationOf", () => {
  it("names the op from operationName or the query text, on /onepanini only", () => {
    expect(operationOf("https://nft.paniniamerica.net/onepanini", JSON.stringify({ operationName: "userCollectedNftsV2" }))).toBe("userCollectedNftsV2")
    expect(operationOf("https://nft.paniniamerica.net/onepanini", JSON.stringify({ query: "query userCollectedNftsV2 {\n userCollectedNftsV2(p:2,l:30" }))).toBe("userCollectedNftsV2")
    expect(operationOf("https://example.com/graphql", JSON.stringify({ operationName: "userCollectedNftsV2" }))).toBeNull()
    expect(operationOf("https://nft.paniniamerica.net/onepanini", "not json")).toBeNull()
  })
})

describe("readCollected", () => {
  it("reads products + total_size; a missing products list is null, not []", () => {
    const ok = readCollected({ data: { userCollectedNftsV2: { status: 200, data: { products: [{ url_key: "a" }], total_size: "146" } } } })
    expect(ok).toMatchObject({ products: [{ url_key: "a" }], total: 146 })
    const bad = readCollected({ data: { userCollectedNftsV2: { status: 400, message: "No data found" } } })
    expect(bad).toMatchObject({ products: null, total: null, message: "No data found" })
  })
})

describe("toHolding", () => {
  it("takes serial and cap from url_key's own <psku>__<serial>_<cap> suffix", () => {
    expect(
      toHolding({ url_key: "packcard-2332_486902_12491256_18__22_25", start_seq: 1, end_seq: 99, athlete: "Lionel Messi", cardset: "Base", sport_name: "Soccer", image_url: "pack/1/x.png" }),
    ).toEqual({
      url_key: "packcard-2332_486902_12491256_18__22_25",
      psku: "packcard-2332_486902_12491256_18",
      serial_number: 22,
      mint_cap: 25,
      athlete: "Lionel Messi",
      cardset: "Base",
      sport: "Soccer",
      image_url: "pack/1/x.png",
    })
  })
  it("falls back to start_seq/end_seq and the given psku", () => {
    expect(toHolding({ url_key: "odd-key", psku: "packcard-9", start_seq: "4", end_seq: "99" })).toMatchObject({ psku: "packcard-9", serial_number: 4, mint_cap: 99 })
  })
  it("a product without a key is dropped — never written under a made-up key", () => {
    expect(toHolding({ athlete: "x" })).toBeNull()
    expect(toHolding(null)).toBeNull()
  })
})

describe("isComplete", () => {
  it("needs a known total, every card of it, and no error", () => {
    expect(isComplete(146, 146, null)).toBe(true)
    expect(isComplete(120, 146, null)).toBe(false)
    expect(isComplete(146, null, null)).toBe(false)
    expect(isComplete(146, 146, "stopped")).toBe(false)
    expect(isComplete(0, 0, null)).toBe(true)
  })
})

describe("profileStateOf", () => {
  it("a redirect to /usernotfound, or userExists:false, is not_found", () => {
    expect(profileStateOf({ url: "https://nft.paniniamerica.net/usernotfound?nickname=x", profileInfo: null, collectedSeen: false })).toBe("not_found")
    expect(profileStateOf({ url: "", profileInfo: { data: { bcProfileInfo: { data: { userExists: false } } } }, collectedSeen: true })).toBe("not_found")
  })
  it("a private visibility is private, even with an (empty) collected answer", () => {
    expect(profileStateOf({ url: "", profileInfo: { data: { x: { profile_visibility: "Private" } } }, collectedSeen: true })).toBe("private")
  })
  it("public only when the collected answer arrived; otherwise unknown", () => {
    expect(profileStateOf({ url: "", profileInfo: null, collectedSeen: true })).toBe("public")
    expect(profileStateOf({ url: "", profileInfo: null, collectedSeen: false })).toBe("unknown")
  })
})

describe("findKey", () => {
  it("finds a key at any depth", () => {
    expect(findKey({ data: { UnopenedPacksStats: { data: { unopenedpacks_total_count: 12 } } } }, "unopenedpacks_total_count")).toBe(12)
    expect(findKey({ a: [1, { b: 2 }] }, "b")).toBe(2)
    expect(findKey({ a: 1 }, "zzz")).toBeUndefined()
  })
})

describe("targets", () => {
  it("parses a comma/semicolon list and fails loudly on a bad name", () => {
    expect(parseTargets("Jamesdillonbond, adlcards;@x_y")).toEqual(["Jamesdillonbond", "adlcards", "x_y"])
    expect(parseTargets("")).toEqual([])
    expect(() => parseTargets("0x1234567890abcdef1234")).toThrow(/bad PANINI_COLLECTOR_TARGETS/)
  })
  it("merges the receiver's plan without walking a folded name twice", () => {
    expect(mergeTargets(["Jamesdillonbond"], [{ nickname: "jamesdillonbond" }, { nickname: "AdlCards" }, { nickname: "bad name!" }, null])).toEqual(["Jamesdillonbond", "AdlCards"])
  })
})

describe("profileUrlCandidates", () => {
  it("tries Panini's own /@<u>/profile/collections.html first, then the public-profile form", () => {
    expect(profileUrlCandidates("jamesdillonbond")).toEqual([
      "https://nft.paniniamerica.net/@jamesdillonbond/profile/collections.html?tab=collected",
      "https://nft.paniniamerica.net/public-profile/collections.html?nickname=jamesdillonbond&tab=collected",
      "https://nft.paniniamerica.net/@jamesdillonbond/profile/collections.html",
    ])
    expect(UNOPENED_PACKS_URL("jamesdillonbond")).toBe("https://nft.paniniamerica.net/@jamesdillonbond/profile/unopened-packs.html")
  })
})

describe("per-collection walk (the profile page stopped paging cards, 2026-09-27)", () => {
  const list = (collections: unknown[], total_size: unknown) => ({ data: { collectionList: { status: 200, data: { collections, total_size } } } })
  const row = (cname: string, year: number, sport_name: string, collected_count: string) => ({ cname, year, sport_name, collected_count, c_image: "x" })

  it("builds the collection-details URL Panini's own Collection View links to", () => {
    expect(collectionDetailsUrl("jamesdillonbond", { sport: "BASKETBALL", year: 2022, cname: "2022 Panini NFT Hoops Basketball", count: 42 })).toBe(
      "https://nft.paniniamerica.net/collection-details?sport=BASKETBALL&year=2022&cname=2022%20Panini%20NFT%20Hoops%20Basketball&tab=collected&nickname=jamesdillonbond&show_collected=true&sortBy=new",
    )
  })

  it("reads collectionList rows; total is the number of COLLECTIONS, not cards", () => {
    expect(readCollectionList(list([row("A", 2024, "BASKETBALL", "5"), row("B", 2025, "FOOTBALL", "141")], 2))).toEqual({
      collections: [
        { cname: "A", year: 2024, sport: "BASKETBALL", count: 5 },
        { cname: "B", year: 2025, sport: "FOOTBALL", count: 141 },
      ],
      total: 2,
    })
  })

  it("one unreadable row makes the whole list unreadable — never a total summed around a gap", () => {
    expect(readCollectionList(list([row("A", 2024, "BASKETBALL", "5"), row("B", 2025, "FOOTBALL", "")], 2))).toEqual({ collections: null, total: null })
    expect(readCollectionList({ data: { collectionList: { status: 400 } } })).toEqual({ collections: null, total: null })
  })

  it("the card total is known only once every collection row was read", () => {
    const cols = [
      { cname: "A", year: 2024, sport: "BASKETBALL", count: 5 },
      { cname: "B", year: 2025, sport: "FOOTBALL", count: 141 },
    ]
    expect(reportedCardTotal(cols, 2)).toBe(146)
    expect(reportedCardTotal(cols, 3)).toBeNull()
    expect(reportedCardTotal(cols, null)).toBeNull()
    expect(reportedCardTotal(null, 2)).toBeNull()
    expect(reportedCardTotal([], 0)).toBe(0)
  })
})

describe("unopened packs — answered for the SIGNED-IN viewer, so attributed only to that account", () => {
  it("reads the signed-in nickname from profileInfo's blockchain_name attribute", () => {
    const pi = (attrs: unknown) => ({ data: { profileInfo: { email: "x", custom_attributes: attrs } } })
    expect(signedInNickname(pi([{ attribute_code: "kyc_status", value: "DONE" }, { attribute_code: "blockchain_name", value: "jamesdillonbond" }]))).toBe("jamesdillonbond")
    expect(signedInNickname(pi([{ attribute_code: "kyc_status", value: "DONE" }]))).toBeNull()
    expect(signedInNickname({ data: {} })).toBeNull()
  })

  it("sums pack_count only when every row arrived", () => {
    const club = (data: unknown, total_count: unknown) => ({ data: { clubSimilarPacks: { data, total_count } } })
    const rows = [1, 2, 1, 1, 7].map((pack_count, i) => ({ pack_count, pack_id: i }))
    expect(readClubPacks(club(rows, 5))).toBe(12)
    expect(readClubPacks(club(rows.slice(0, 3), 5))).toBeNull()
    expect(readClubPacks(club(rows, null))).toBeNull()
    expect(readClubPacks(club([{ pack_count: null }], 1))).toBeNull()
    expect(readClubPacks(club([], 0))).toBe(0)
  })
})

describe("answerIsFor — never file one account's cards under another username", () => {
  const body = (query: string) => JSON.stringify({ query })
  it("accepts a request naming the username (argument or forwarded filters), any case", () => {
    expect(answerIsFor(body('query userCollectedNftsV2 { userCollectedNftsV2(p:1,l:30,applied_filters:"",nickname:"JamesDillonBond") {'), "jamesdillonbond")).toBe(true)
    expect(answerIsFor(body('query userCollectedNftsV2 { userCollectedNftsV2(p:2,l:30,applied_filters:"?tab=collected&nickname=jamesdillonbond&full_name=jamesdillonbond&reqFrom=x",nickname:"") {'), "Jamesdillonbond")).toBe(true)
  })
  it("rejects the signed-in fallback (no username named) and a different or longer username", () => {
    expect(answerIsFor(body('query userCollectedNftsV2 { userCollectedNftsV2(p:1,l:30,applied_filters:"?tab=collected&reqFrom=x",nickname:"") {'), "jamesdillonbond")).toBe(false)
    expect(answerIsFor(body('userCollectedNftsV2(p:1,l:30,applied_filters:"",nickname:"adlcards")'), "jamesdillonbond")).toBe(false)
    expect(answerIsFor(body('userCollectedNftsV2(p:1,l:30,applied_filters:"",nickname:"jamesdillonbond2")'), "jamesdillonbond")).toBe(false)
    expect(answerIsFor("not json", "jamesdillonbond")).toBe(false)
  })
})
