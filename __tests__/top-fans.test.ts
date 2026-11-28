import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { hasFullCollectorCensus, normalizeTopFans, rankingIsCensus, rankTopFans, topFanHref, topFansUpdatedLabel, type TopFanRow } from "@/lib/entity/top-fans-format"
import { franchiseHubTopFansTargets, paniniFranchiseKey, playerHubTopFansTargets, PANINI_COLLECTION_ID } from "@/lib/entity/top-fans-targets"
import { getCollectionByUrlSlug, getCollectionByUuid } from "@/lib/collection-slug"
import { stripSqlComments } from "../scripts/lib/strip-sql-comments.mjs"

// Top Fans (Trevor, 2026-11-27): top collectors per team / player by count, FMV and special serials,
// "only count each Moment/pin/card once, if they have multiple special serials on it".

const row = (owner: string, items: number, fmv: number | null, special: number | null): TopFanRow => ({
  owner, username: null, items, fmv_usd: fmv, special_items: special, fmv_items: items,
})

describe("rankTopFans", () => {
  const rows = [row("a", 5, 100, 0), row("b", 50, 20, 3), row("c", 10, 300, 1), row("d", 10, null, 0)]
  it("ranks by the chosen metric", () => {
    expect(rankTopFans(rows, "items").map((r) => r.owner)).toEqual(["b", "c", "d", "a"])
    expect(rankTopFans(rows, "fmv").map((r) => r.owner)).toEqual(["c", "a", "b", "d"])
    expect(rankTopFans(rows, "special").map((r) => r.owner)).toEqual(["b", "c"])
  })
  it("the special ranking is not a list of zeros", () => {
    expect(rankTopFans([row("a", 1, 1, 0)], "special")).toEqual([])
  })
  it("caps at the limit", () => {
    expect(rankTopFans(rows, "items", 2)).toHaveLength(2)
  })
})

describe("normalizeTopFans — three states", () => {
  it("a NULL read (never refreshed) is null, not an empty table", () => {
    expect(normalizeTopFans(null)).toBeNull()
  })
  it("keeps a measured empty as rows: []", () => {
    expect(normalizeTopFans({ refreshed_at: "2026-11-28T00:00:00Z", rows: [], items: 0, holders: 0 })?.rows).toEqual([])
  })
  it("Pinnacle's untracked specials stay untracked", () => {
    expect(normalizeTopFans({ refreshed_at: "x", rows: [], special_tracked: false })?.special_tracked).toBe(false)
  })
})

describe("links and labels", () => {
  it("Panini owners are usernames; Candy keys keep their case", () => {
    expect(topFanHref("panini-blockchain", "Jascar")).toBe("/panini-blockchain/collection?username=Jascar")
    expect(topFanHref("candy-mlb", "AbC9xYz")).toBe("/candy-mlb/collection?wallet=AbC9xYz")
  })
  it("the updated day is Pacific time", () => {
    expect(topFansUpdatedLabel("2026-11-28T03:00:00Z")).toBe("Nov 27")
  })
})

describe("hub targets", () => {
  const ts = getCollectionByUrlSlug("nba-top-shot")!
  const ad = getCollectionByUrlSlug("nfl-all-day")!
  it("franchise hub: ok panels by route_slug, plus Panini by its team-map key", () => {
    const t = franchiseHubTopFansTargets(
      { league: "nba", team_slug: "blazers", route_slug: "portland-trail-blazers" },
      [{ state: "ok", collection: ts }, { state: "failed", collection: ad }],
      { state: "ok" },
    )
    expect(t.map((x) => [x.collection.id, x.kind, x.key])).toEqual([
      [ts.id, "team", "portland-trail-blazers"],
      [PANINI_COLLECTION_ID, "franchise", "NBA:blazers"],
    ])
    expect(getCollectionByUuid(PANINI_COLLECTION_ID)).not.toBeNull()
  })
  it("no Panini read when its panel is absent", () => {
    expect(franchiseHubTopFansTargets({ league: "nba", team_slug: "x", route_slug: "x" }, [], { state: "absent" })).toEqual([])
  })
  it("paniniFranchiseKey matches get_panini_franchise_panel's upper(league):lower(slug)", () => {
    expect(paniniFranchiseKey(" nwsl ", "Thorns")).toBe("NWSL:thorns")
  })
  it("player hub: keyed by THAT collection's players.id; a panel without an id gets no read", () => {
    const t = playerHubTopFansTargets([
      { state: "ok", collection: ts, entry: { name: "Steph Curry" }, detail: { id: "11111111-1111-1111-1111-111111111111", name: "Stephen Curry" } },
      { state: "ok", collection: ad, entry: { name: "X" }, detail: {} },
      { state: "empty", collection: ad, entry: { name: "X" } },
    ])
    expect(t).toEqual([{ collection: ts, kind: "player", key: "11111111-1111-1111-1111-111111111111", name: "Stephen Curry" }])
  })
})

describe("the precompute (source facts, newest migration)", () => {
  const sql = stripSqlComments(readFileSync("supabase/migrations/20261128000240_audit_20261127_entity_top_fans.sql", "utf8"))
  it("counts an item that is #1 AND perfect AND jersey ONCE (one FILTER with OR, never a sum of three)", () => {
    expect(sql).toMatch(/count\(\*\) FILTER \(WHERE u\.serial = 1 OR u\.serial = e\.circulation_count OR u\.serial = e\.jersey_number\)/)
    expect(sql).not.toMatch(/FILTER \(WHERE [a-z.]*serial[a-z_]* = 1\)\)?::int\s*\+/)
  })
  it("excludes system accounts through the registries, never literals", () => {
    expect(sql).toMatch(/flowty_excluded_addresses/)
    expect(sql).toMatch(/candy_treasury_wallet/)
    expect(sql).toMatch(/candy_holder_board_exclusions/)
    expect(sql).toMatch(/NOT m\.is_system/)
    expect(sql).not.toMatch(/0xb6f2481eba4df97b/i)
  })
  it("Top Shot ownership index rows only when the walk still confirms them", () => {
    expect(sql).toMatch(/o\.walk_missed_at IS NULL/)
  })
  it("never lower()s a Candy (Solana) key", () => {
    const candy = sql.slice(sql.indexOf("v_slug = 'candy_mlb' THEN"), sql.indexOf("v_slug = 'panini_blockchain' THEN"))
    expect(candy).not.toMatch(/lower\(w\.wallet_address\)/)
  })
  it("the reader is not anon-executable", () => {
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.get_entity_top_fans\(uuid, text, text, text, integer\) FROM PUBLIC, anon, authenticated/)
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.refresh_entity_top_fans\(uuid\) FROM PUBLIC, anon, authenticated/)
  })
})

describe("a ranking is shown only from a FULL holder census (Trevor 11-27: every wallet, not the ones we captured)", () => {
  it("Panini and Candy rank; the walked-wallet and partial owner-map collections do not", () => {
    expect(hasFullCollectorCensus("panini-blockchain")).toBe(true)
    expect(hasFullCollectorCensus("candy-mlb")).toBe(true)
    for (const s of ["nba-top-shot", "nfl-all-day", "laliga-golazos", "ufc-strike", "disney-pinnacle"]) {
      expect(hasFullCollectorCensus(s)).toBe(false)
    }
  })
  it("the reader's census_complete decides; without the flag the static set does", () => {
    expect(rankingIsCensus("nba-top-shot", { census_complete: true })).toBe(true)
    expect(rankingIsCensus("panini-blockchain", { census_complete: false })).toBe(false)
    expect(rankingIsCensus("nba-top-shot", { census_complete: null })).toBe(false)
    expect(rankingIsCensus("panini-blockchain", { census_complete: null })).toBe(true)
    expect(rankingIsCensus("panini-blockchain", null)).toBe(false)
  })
  it("a non-census read is turned into 'pending' server-side, before any row reaches the client", () => {
    const src = readFileSync("components/entity/TopFansSection.tsx", "utf8")
    expect(src).toMatch(/if \(ok && data && !rankingIsCensus\(t\.collection\.urlSlug, data\)\) return \{ \.\.\.base, ok: true, data: null, pending: true \}/)
  })
})

import { CENSUS_CONFIGS, censusSql, normalizeCensusRow, mapTableName, censusConfigBySlug } from "@/lib/dune/top-collector-census"

describe("the Dune census (every holder, not the wallets RPC walked)", () => {
  it("each collection reads its own map table, its mint event, and BOTH deposit forms", () => {
    for (const cfg of Object.values(CENSUS_CONFIGS)) {
      const sql = censusSql(cfg)
      expect(sql).toContain(`dataset_${mapTableName(cfg)}`)
      expect(sql).toContain(`'A.${cfg.address}.${cfg.contract}.${cfg.mintEvent}'`)
      expect(sql).toContain(`'A.${cfg.address}.${cfg.contract}.Deposit'`)
      expect(sql).toContain("'A.1d7e57aa55817448.NonFungibleToken.Deposited'")
      expect(sql).toContain(`json_extract_scalar(data, '$.type') = 'A.${cfg.address}.${cfg.contract}.NFT'`)
      expect(sql).toContain(`'A.${cfg.address}.${cfg.contract}.NFT.ResourceDestroyed'`)
      expect(sql).toContain("WHERE c.owner NOT IN (SELECT addr FROM excl)")
      expect(cfg.queryId).toMatch(/^\d+$/)
    }
  })
  it("a withdraw, burn or destroy as the LAST event leaves the NFT in nobody's collection", () => {
    const sql = censusSql(CENSUS_CONFIGS.topshot)
    expect(sql).toMatch(/CAST\(NULL AS varchar\), block_height, log_index\s+FROM raw WHERE topic IN \('A\.0b2a3299cc857e29\.TopShot\.Withdraw', 'A\.0b2a3299cc857e29\.TopShot\.MomentDestroyed'/)
    expect(sql).toContain("WHERE rn = 1 AND owner IS NOT NULL")
  })
  it("a special serial is counted once per NFT (one count_if with OR)", () => {
    expect(censusSql(CENSUS_CONFIGS.allday)).toContain("count_if(h.serial = 1 OR h.serial = i.circ OR h.serial = i.jersey) AS special_items")
  })
  it("Top Shot keys parallels by subedition, 0 = Standard", () => {
    expect(censusSql(CENSUS_CONFIGS.topshot)).toContain("concat(m.ek, ':', CAST(coalesce(m.sub, s.sub, 0) AS varchar))")
  })
  it("rows that cannot be keyed are rejected, never written", () => {
    const ok = { entity_kind: "team", entity_key: "portland-trail-blazers", owner: "0xBD94CADE097E50AC", items: 3, special_items: 1, fmv_usd: 5, fmv_items: 3, holders: 9, entity_items: 40, entity_special: 2 }
    expect(normalizeCensusRow(ok)?.owner).toBe("0xbd94cade097e50ac")
    expect(normalizeCensusRow({ ...ok, owner: "not-an-address" })).toBeNull()
    expect(normalizeCensusRow({ ...ok, entity_kind: "franchise" })).toBeNull()
    expect(normalizeCensusRow({ ...ok, items: null })).toBeNull()
  })
  it("the route refuses an unknown collection rather than defaulting (no substitution)", () => {
    expect(censusConfigBySlug("candy-mlb")).toBeNull()
    expect(censusConfigBySlug("")).toBeNull()
    const src = readFileSync("app/api/cron/top-collector-census-dune/route.ts", "utf8")
    expect(src).toMatch(/if \(!cfg\) return NextResponse\.json\(\{ error:/)
  })
  it("the worker may only upload the four census map tables", () => {
    const w = readFileSync("workers/dune-proxy/index.ts", "utf8")
    expect(w).toContain("const UPLOAD_TABLE_RE = /^rpc_census_map_(topshot|allday|golazos|pinnacle)$/;")
    for (const cfg of Object.values(CENSUS_CONFIGS)) expect(w).toContain(`"${cfg.queryId}"`)
  })
})
