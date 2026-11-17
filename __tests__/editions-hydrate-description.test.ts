import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// AllDay play `description` capture.
//
// ALLDAY_RELAY_QUERY has selected `play { description }` since it was written,
// but AllDayEditionMeta never carried the field, so every hydrate fetched the
// only descriptive prose any of our ingests receives and dropped it. This pins
// that it now reaches the upsert row — and, more importantly, that it does so
// WITHOUT clobbering: toUpsertRow spreads the row straight into the upsert, so
// a present-but-undefined `description` key would write NULL over a good value
// on every Top Shot hydrate and on every AllDay row the upstream has no prose
// for. The key must be ABSENT in those cases, not undefined.

import { hydrateAllDayEditions, resetAllDayCache, toUpsertRow } from "@/lib/editions-hydrate"

const ORIGINAL_ENV = { ...process.env }

function mockEditions(nodes: any[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: {
            allEditions: {
              edges: nodes.map((node) => ({ node })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      json: async () => ({
        data: {
          allEditions: {
            edges: nodes.map((node) => ({ node })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    })) as any
  )
}

const node = (over: any = {}) => ({
  id: "e1",
  circulationCount: 100,
  tier: "COMMON",
  series: { name: "S1", number: 1 },
  set: { name: "Base", id: "s1" },
  play: {
    id: "p1",
    playerName: "Patrick Mahomes",
    description: "Mahomes threads a 40-yard dime under pressure.",
    team: { name: "Chiefs" },
    classification: "PASS",
    gameDate: "2024-01-01",
    awayTeamName: "Raiders",
    homeTeamName: "Chiefs",
  },
  ...over,
})

beforeEach(() => {
  resetAllDayCache()
})
afterEach(() => {
  vi.unstubAllGlobals()
  process.env = { ...ORIGINAL_ENV }
  resetAllDayCache()
})

describe("hydrateAllDayEditions — description", () => {
  it("captures the prose the query already fetched", async () => {
    mockEditions([node()])
    const rows = await hydrateAllDayEditions(["e1"])
    expect(rows[0].description).toBe("Mahomes threads a 40-yard dime under pressure.")
  })

  it("carries the description through toUpsertRow to the DB row", async () => {
    mockEditions([node()])
    const rows = await hydrateAllDayEditions(["e1"])
    const upsert = toUpsertRow(rows[0])
    expect(upsert.description).toBe("Mahomes threads a 40-yard dime under pressure.")
    // The scaffolding fields must not leak into the write.
    expect(upsert.ok).toBeUndefined()
  })

  it("OMITS the key entirely when the upstream has no prose — never writes NULL over a good value", async () => {
    mockEditions([node({ play: { ...node().play, description: null } })])
    const rows = await hydrateAllDayEditions(["e1"])
    const upsert = toUpsertRow(rows[0])
    // Absent, not undefined and not null: an upsert with the key present would
    // clear a description a previous run captured.
    expect("description" in upsert).toBe(false)
  })

  it("omits the key for an empty-string description too", async () => {
    mockEditions([node({ play: { ...node().play, description: "" } })])
    const rows = await hydrateAllDayEditions(["e1"])
    expect("description" in toUpsertRow(rows[0])).toBe(false)
  })

  it("omits the key on the not-found empty row", async () => {
    mockEditions([node()])
    const rows = await hydrateAllDayEditions(["does-not-exist"])
    expect(rows[0].ok).toBe(false)
    expect("description" in toUpsertRow(rows[0])).toBe(false)
  })

  it("still maps the pre-existing fields unchanged", async () => {
    mockEditions([node()])
    const rows = await hydrateAllDayEditions(["e1"])
    expect(rows[0]).toMatchObject({
      player_name: "Patrick Mahomes",
      set_name: "Base",
      team_name: "Chiefs",
      play_type: "PASS",
      home_team: "Chiefs",
      away_team: "Raiders",
    })
  })
})
