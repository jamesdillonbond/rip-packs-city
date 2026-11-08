// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import { render, cleanup, screen } from "@testing-library/react"

import PlayerBio from "@/components/entity/PlayerBio"
import { buildPlayerBio, formatBirthDate, formatOnchainBirthplace, type PlayerBioResult } from "@/lib/player-bio"

// The player page's Bio section (2026-11-08). Pins: ESPN only when exactly ONE ESPN id is linked
// (two athletes behind a key are never merged); field-by-field fallback to Top Shot on-chain and
// nflverse; a failed read is unavailable, nothing stated renders nothing; a missing college is
// never printed as "none"; citizenship is never shown as a birthplace.

afterEach(cleanup)

const TATUM: PlayerBioResult = {
  linked: 1,
  espn: { espn_id: "4065648", date_of_birth: "1998-03-03", birth_city: "Saint Louis", birth_state: "MO", birth_country: "USA",
          citizenship: "USA", college: "Duke", college_id: "150", fetched_at: "2026-11-08T21:00:00Z" },
  onchain: { date_of_birth: "1998-03-03", birthplace: "St. Louis, MO, USA" },
  nflverse_date_of_birth: null,
}

describe("buildPlayerBio", () => {
  it("ESPN first, every stated field", () => {
    const v = buildPlayerBio(TATUM)!
    expect(v.dateOfBirth).toBe("March 3, 1998")
    expect(v.birthplace).toBe("Saint Louis, MO, USA")
    expect(v.college).toBe("Duke")
    expect(v.sources).toEqual(["ESPN"])
  })

  it("two ESPN athletes behind one key: no ESPN field is used — the on-chain fallback may still speak", () => {
    const v = buildPlayerBio({ ...TATUM, linked: 2 })!
    expect(v.college).toBeNull()
    expect(v.citizenship).toBeNull()
    expect(v.birthplace).toBe("St. Louis, MO, USA")
    expect(v.sources).toEqual(["Top Shot on-chain"])
  })

  it("falls back field by field: on-chain birthplace, nflverse DOB", () => {
    const v = buildPlayerBio({ linked: 0, espn: null, onchain: { date_of_birth: null, birthplace: "Zurich,, CHE" }, nflverse_date_of_birth: "1995-09-17" })!
    expect(v.birthplace).toBe("Zurich, CHE")
    expect(v.dateOfBirth).toBe("September 17, 1995")
    expect([...v.sources].sort()).toEqual(["Top Shot on-chain", "nflverse"].sort())
  })

  it("citizenship is never a birthplace (ESPN soccer records carry citizenship, not birthplace)", () => {
    const v = buildPlayerBio({ linked: 1, espn: { ...TATUM.espn!, birth_city: null, birth_state: null, birth_country: null, citizenship: "Croatia", college: null }, onchain: null, nflverse_date_of_birth: null })!
    expect(v.birthplace).toBeNull()
    expect(v.citizenship).toBe("Croatia")
  })

  it("a disagreeing source is named beside the date, never hidden", () => {
    const v = buildPlayerBio({ linked: 1, espn: { ...TATUM.espn!, date_of_birth: "1993-10-29" }, onchain: null, nflverse_date_of_birth: "1996-10-29" })!
    expect(v.dateOfBirth).toBe("October 29, 1993")
    expect(v.dateOfBirthConflict).toBe("nflverse says October 29, 1996")
    expect(buildPlayerBio(TATUM)!.dateOfBirthConflict).toBeNull()
  })

  it("nothing stated → null", () => {
    expect(buildPlayerBio({ linked: 0, espn: null, onchain: null, nflverse_date_of_birth: null })).toBeNull()
    expect(buildPlayerBio(null)).toBeNull()
  })

  it("dates are calendar dates, never shifted by zone; junk is not a date", () => {
    expect(formatBirthDate("1984-12-30")).toBe("December 30, 1984")
    expect(formatBirthDate("not-a-date")).toBeNull()
    expect(formatOnchainBirthplace(",,")).toBeNull()
  })
})

describe("PlayerBio — states", () => {
  it("rows for each stated field, with the source", () => {
    render(<PlayerBio result={TATUM} ok playerName="Jayson Tatum" />)
    const rows = screen.getAllByTestId("player-bio-row").map((r) => r.textContent)
    expect(rows).toEqual(["BornMarch 3, 1998", "BirthplaceSaint Louis, MO, USA", "CitizenshipUSA", "CollegeDuke"])
    expect(screen.getByTestId("player-bio-source").textContent).toBe("ESPN")
  })

  it("a failed read is unavailable, not an empty bio", () => {
    render(<PlayerBio result={null} ok={false} playerName="X" />)
    expect(screen.getByText("Bio")).toBeTruthy()
    expect(screen.queryByTestId("player-bio")).toBeNull()
  })

  it("no college is never printed as a claim", () => {
    const { container } = render(<PlayerBio result={{ ...TATUM, espn: { ...TATUM.espn!, college: null } }} ok playerName="LeBron James" />)
    expect(container.textContent).not.toMatch(/College/)
    expect(container.textContent).not.toMatch(/none|did not attend/i)
  })

  it("nothing stated renders nothing", () => {
    const { container } = render(<PlayerBio result={{ linked: 0, espn: null, onchain: null, nflverse_date_of_birth: null }} ok playerName="X" />)
    expect(container.innerHTML).toBe("")
  })
})

describe("PlayerBio — which collections", () => {
  it("every athlete collection, UFC included; never Pinnacle characters", async () => {
    const { PLAYER_BIO_COLLECTIONS } = await import("@/lib/player-bio")
    for (const c of ["nba_top_shot", "nfl_all_day", "candy_mlb", "laliga_golazos", "panini_blockchain", "ufc_strike"]) expect(PLAYER_BIO_COLLECTIONS.has(c)).toBe(true)
    expect(PLAYER_BIO_COLLECTIONS.has("disney_pinnacle")).toBe(false)
  })
})

describe("PlayerBio — wired into the player page", () => {
  const SRC = readFileSync("app/(collections)/[collection]/player/[slug]/page.tsx", "utf8")
  it("reads get_player_bio by the PERSON for person collections, in its own Suspense", () => {
    expect(SRC).toMatch(/"get_player_bio"/)
    const fn = SRC.slice(SRC.indexOf("async function BioSection"))
    expect(fn.slice(0, 900)).toMatch(/p_player_id: RECENT_GAMES_PERSON_COLLECTIONS\.has\(collectionSlug\) \? playerId : null/)
    expect(SRC).toMatch(/<Suspense fallback=\{null\}>\s*<BioSection /)
  })
})
