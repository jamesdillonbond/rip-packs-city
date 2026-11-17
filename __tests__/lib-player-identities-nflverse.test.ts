import { describe, it, expect } from "vitest"
import { parseCsv, nflverseToIdentityRows, chunk } from "@/lib/player-identities/nflverse"

// The pure half of the league-id crosswalk's NFL feed (2026-09-25, #139
// follow-up). The property that matters: a broken source is a FAILED read
// (throws), never an empty one; blanks become null, not "" (the RPC casts
// birth_date to date and "" would fail the whole chunk); numbers are numbers.

const HEADER =
  "gsis_id,display_name,common_first_name,first_name,last_name,short_name,football_name,suffix,esb_id,nfl_id,pfr_id,pff_id,otc_id,espn_id,smart_id,birth_date,position_group,position,ngs_position_group,ngs_position,height,weight,headshot,college_name,college_conference,jersey_number,rookie_season,last_season,latest_team,status"

function line(over: Record<string, string>): string {
  const cols = HEADER.split(",")
  return cols.map((c) => over[c] ?? "").join(",")
}

describe("parseCsv", () => {
  it("handles quoted fields, doubled quotes and CRLF", () => {
    const rows = parseCsv('a,b,c\r\n1,"x, y","he said ""hi"""\r\n')
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "x, y", 'he said "hi"'],
    ])
  })

  it("keeps an empty trailing field", () => {
    expect(parseCsv("a,b\n1,\n")).toEqual([
      ["a", "b"],
      ["1", ""],
    ])
  })
})

describe("nflverseToIdentityRows", () => {
  it("shapes a row: the NFL.com spelling, the GSIS id, nulls for blanks, ints for seasons", () => {
    const csv = [
      HEADER,
      line({
        gsis_id: "00-0039849",
        display_name: "Marvin Harrison Jr.",
        first_name: "Marvin",
        last_name: "Harrison",
        espn_id: "4432708",
        pfr_id: "HarrMa02",
        birth_date: "2002-08-11",
        position: "WR",
        headshot: "https://static.www.nfl.com/x.png",
        rookie_season: "2024",
        last_season: "2026",
        latest_team: "ARI",
        status: "ACT",
      }),
    ].join("\n")
    const { rows, source_rows, skipped } = nflverseToIdentityRows(csv)
    expect(source_rows).toBe(1)
    expect(skipped).toBe(0)
    expect(rows).toEqual([
      {
        league_player_id: "00-0039849",
        display_name: "Marvin Harrison Jr.",
        first_name: "Marvin",
        last_name: "Harrison",
        birth_date: "2002-08-11",
        position: "WR",
        latest_team: "ARI",
        rookie_season: 2024,
        last_season: 2026,
        status: "ACT",
        espn_id: "4432708",
        pfr_id: "HarrMa02",
        nfl_id: null,
        headshot_url: "https://static.www.nfl.com/x.png",
      },
    ])
  })

  it("blanks and NA become null — never an empty string the date cast would choke on", () => {
    const csv = [HEADER, line({ gsis_id: "00-0000001", display_name: "A B", birth_date: "NA", rookie_season: "" })].join("\n")
    const { rows } = nflverseToIdentityRows(csv)
    expect(rows[0].birth_date).toBeNull()
    expect(rows[0].rookie_season).toBeNull()
    expect(rows[0].espn_id).toBeNull()
  })

  it("a malformed date is dropped to null rather than sent", () => {
    const csv = [HEADER, line({ gsis_id: "00-0000001", display_name: "A B", birth_date: "8/11/2002" })].join("\n")
    expect(nflverseToIdentityRows(csv).rows[0].birth_date).toBeNull()
  })

  it("a line without a GSIS id or a name is SKIPPED and COUNTED, not shipped", () => {
    const csv = [
      HEADER,
      line({ gsis_id: "", display_name: "No Id" }),
      line({ gsis_id: "00-0000002", display_name: "" }),
      line({ gsis_id: "00-0000003", display_name: "Kept Player" }),
      "",
    ].join("\n")
    const { rows, source_rows, skipped } = nflverseToIdentityRows(csv)
    expect(source_rows).toBe(3)
    expect(skipped).toBe(2)
    expect(rows.map((r) => r.league_player_id)).toEqual(["00-0000003"])
  })

  it("THROWS when the header lacks gsis_id or display_name — a changed upstream is a failed read, not zero rows", () => {
    expect(() => nflverseToIdentityRows("player_id,name\n1,x\n")).toThrow(/header lacks "gsis_id"/)
    expect(() => nflverseToIdentityRows("gsis_id,name\n1,x\n")).toThrow(/header lacks "display_name"/)
    expect(() => nflverseToIdentityRows("")).toThrow(/empty/)
  })
})

describe("chunk", () => {
  it("splits evenly and keeps the tail", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 3)).toEqual([])
    expect(() => chunk([1], 0)).toThrow()
  })
})
