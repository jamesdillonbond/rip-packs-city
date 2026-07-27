import { describe, it, expect } from "vitest"
import {
  VALID_COLLECTIONS,
  VALID_TAGS,
  VALID_TAGS_BY_COLLECTION,
  VALID_TIERS,
  VALID_TIERS_ALLDAY,
  validTiersFor,
  fetchSpecialSerialOwners,
} from "@/lib/special-serial-owners-board"

// The Special Serial Owners board. The fetch fn hits a SECDEF RPC (DB), so only
// the pure whitelist constants + the collection→tier-set selector are tested:
// Both collections carry all three tags. AllDay uses a distinct tier vocabulary
// (UNCOMMON in place of Top Shot's FANDOM).
//
// This block previously asserted the OPPOSITE — that AllDay drops the jersey tag
// — and that assertion was a codified falsehood, not a guard. 5,468 of 6,190
// AllDay editions (88.3%, vs Top Shot's 65%) carry editions.jersey_number, filled
// by app/api/cron/allday-badge-ingest. The tag was missing because the AllDay
// view admitted only serial=1 and serial=circulation_count; the whitelist, the
// page copy and this test were all written to match that broken view. Fixed
// 2026-07-27 (migration audit_20260727_allday_special_serials_jersey_arm; the MV
// went 593 rows -> 804, of which 211 are jersey).
//
// Kept as a POSITIVE pin so the tag cannot be silently dropped again.

describe("collection + tag whitelists", () => {
  it("covers exactly Top Shot and AllDay", () => {
    expect(VALID_COLLECTIONS).toEqual(["nba-top-shot", "nfl-all-day"])
  })

  it("gives BOTH collections all three tags — AllDay's jersey tag is real data, not a stub", () => {
    expect(VALID_TAGS).toEqual(["#1", "perfect", "jersey"])
    expect(VALID_TAGS_BY_COLLECTION["nba-top-shot"]).toEqual(["#1", "perfect", "jersey"])
    expect(VALID_TAGS_BY_COLLECTION["nfl-all-day"]).toEqual(["#1", "perfect", "jersey"])
    // Every collection on the board must accept every tag the board renders,
    // or the UI can offer a filter the API 400s on.
    for (const coll of VALID_COLLECTIONS) {
      expect(VALID_TAGS_BY_COLLECTION[coll]).toContain("jersey")
    }
  })
})

describe("validTiersFor", () => {
  it("returns the AllDay tier set for nfl-all-day", () => {
    expect(validTiersFor("nfl-all-day")).toBe(VALID_TIERS_ALLDAY)
    expect(validTiersFor("nfl-all-day").has("UNCOMMON")).toBe(true)
    expect(validTiersFor("nfl-all-day").has("FANDOM")).toBe(false)
  })

  it("defaults to the Top Shot tier set for anything else", () => {
    expect(validTiersFor("nba-top-shot")).toBe(VALID_TIERS)
    expect(validTiersFor("bogus")).toBe(VALID_TIERS)
    expect(validTiersFor("nba-top-shot").has("FANDOM")).toBe(true)
  })

  it("the two tier vocabularies differ on FANDOM vs UNCOMMON", () => {
    expect(VALID_TIERS.has("FANDOM")).toBe(true)
    expect(VALID_TIERS.has("UNCOMMON")).toBe(false)
    expect(VALID_TIERS_ALLDAY.has("UNCOMMON")).toBe(true)
    expect(VALID_TIERS_ALLDAY.has("FANDOM")).toBe(false)
  })
})

// fetchSpecialSerialOwners calls the SECDEF RPC get_special_serial_owners_board.
// A fake client that records the rpc params fakes the seam (no vi.mock) and lets
// us assert the opts→param mapping + defaults, error propagation, and row
// normalization.
const ownersClient = (data: any, error: any = null) => {
  const calls: Array<{ name: string; params: any }> = []
  return {
    calls,
    rpc: async (name: string, params: any) => {
      calls.push({ name, params })
      return { data, error }
    },
  }
}

describe("fetchSpecialSerialOwners", () => {
  it("throws when the RPC returns an error", async () => {
    await expect(fetchSpecialSerialOwners(ownersClient(null, { message: "rpc boom" }), {})).rejects.toThrow("rpc boom")
  })

  it("returns [] for null/empty data", async () => {
    expect(await fetchSpecialSerialOwners(ownersClient(null), {})).toEqual([])
    expect(await fetchSpecialSerialOwners(ownersClient([]), {})).toEqual([])
  })

  it("passes RPC defaults when opts are omitted", async () => {
    const sb = ownersClient([])
    await fetchSpecialSerialOwners(sb, {})
    expect(sb.calls[0].name).toBe("get_special_serial_owners_board")
    expect(sb.calls[0].params).toEqual({
      p_tag: null,
      p_tier: null,
      p_player: null,
      p_holder: null,
      p_sort: "fmv",
      p_limit: 100,
      p_offset: 0,
      p_collection: "nba-top-shot",
    })
  })

  it("forwards provided opts into the RPC params", async () => {
    const sb = ownersClient([])
    await fetchSpecialSerialOwners(sb, {
      tag: "#1",
      tier: "RARE",
      player: "Flagg",
      holder: "0xabc",
      sort: "recent",
      limit: 25,
      offset: 50,
      collection: "nfl-all-day",
    })
    expect(sb.calls[0].params).toEqual({
      p_tag: "#1",
      p_tier: "RARE",
      p_player: "Flagg",
      p_holder: "0xabc",
      p_sort: "recent",
      p_limit: 25,
      p_offset: 50,
      p_collection: "nfl-all-day",
    })
  })

  it("normalizes rows: numeric coercion (empty/invalid → null) and string null-fallbacks", async () => {
    const rows = await fetchSpecialSerialOwners(
      ownersClient([
        {
          edition_id: "e1",
          edition_key: "233:8121",
          player_name: "Flagg",
          series: "8",
          circulation_count: "1000",
          serial: "1",
          tag: "#1",
          holder_address: "0xabc",
          edition_fmv: "42.5",
        },
        { serial: "", edition_fmv: "abc" }, // invalid numerics → null; missing strings → null
      ]),
      {},
    )
    expect(rows[0]).toMatchObject({
      edition_id: "e1",
      series: 8,
      circulation_count: 1000,
      serial: 1,
      tag: "#1",
      edition_fmv: 42.5,
    })
    expect(rows[1].serial).toBeNull()
    expect(rows[1].edition_fmv).toBeNull()
    expect(rows[1].player_name).toBeNull()
    expect(rows[1].holder_username).toBeNull()
  })
})
