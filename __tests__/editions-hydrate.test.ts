import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { hydrateTopShotEditions, toUpsertRow } from "@/lib/editions-hydrate"

// Locks in the 2026-05-09 hydrator fix: every UUID-format TopShot edition
// produced by hydrateTopShotEditions must carry set_id_onchain +
// play_id_onchain pulled from the GQL response, since the UUID external_id
// has no int pair to parse out.
//
// TopShot GQL quirk: set.flowId is lowercase d, play.flowID is uppercase D.
// The hydrator coerces both to int.

const SET_UUID = "11111111-1111-1111-1111-111111111111"
const PLAY_UUID = "22222222-2222-2222-2222-222222222222"
const UUID_EXTERNAL_ID = `${SET_UUID}:${PLAY_UUID}`
const INT_EXTERNAL_ID = "73:2785"

function fakeGqlResponse(opts: {
  setFlowId: number | string
  playFlowID: string
  playerName?: string
  setName?: string
}) {
  return {
    ok: true,
    json: async () => ({
      data: {
        searchEditions: {
          searchSummary: {
            data: {
              data: [
                {
                  tier: "COMMON",
                  circulationCount: 12345,
                  set: {
                    flowId: opts.setFlowId,
                    flowName: opts.setName ?? "Base Set",
                    flowSeriesNumber: 4,
                  },
                  play: {
                    flowID: opts.playFlowID,
                    stats: {
                      playerName: opts.playerName ?? "Test Player",
                      teamAtMoment: "POR",
                      teamAtMomentNbaId: "1610612757",
                      playCategory: "Dunk",
                      playType: "2 Pointer",
                      dateOfMoment: "2024-12-25T20:00:00Z",
                      homeTeamName: "POR",
                      awayTeamName: "GSW",
                    },
                  },
                },
              ],
            },
          },
        },
      },
    }),
  }
}

describe("hydrateTopShotEditions — on-chain id population", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeGqlResponse({ setFlowId: 73, playFlowID: "2785" })
      )
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("UUID-format external_id populates set_id_onchain and play_id_onchain from GQL response", async () => {
    const [row] = await hydrateTopShotEditions([UUID_EXTERNAL_ID])
    expect(row.external_id).toBe(UUID_EXTERNAL_ID)
    expect(row.set_id_onchain).toBe(73)
    expect(row.play_id_onchain).toBe(2785)
    expect(row.ok).toBe(true)
  })

  it("UUID-format insert survives toUpsertRow → both columns retained for upsert", async () => {
    const [row] = await hydrateTopShotEditions([UUID_EXTERNAL_ID])
    const clean = toUpsertRow(row)
    expect(clean.set_id_onchain).toBe(73)
    expect(clean.play_id_onchain).toBe(2785)
    expect("ok" in clean).toBe(false)
    expect("redirect" in clean).toBe(false)
  })

  it("int-pair external_id keeps the parsed values (regression: don't overwrite on the merge)", async () => {
    const [row] = await hydrateTopShotEditions([INT_EXTERNAL_ID])
    expect(row.set_id_onchain).toBe(73)
    expect(row.play_id_onchain).toBe(2785)
  })

  it("GQL returns string flowId — coerces to int, not preserved as string", async () => {
    vi.unstubAllGlobals()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeGqlResponse({ setFlowId: "99", playFlowID: "1234" })
      )
    )
    const [row] = await hydrateTopShotEditions([UUID_EXTERNAL_ID])
    expect(row.set_id_onchain).toBe(99)
    expect(row.play_id_onchain).toBe(1234)
    expect(typeof row.set_id_onchain).toBe("number")
    expect(typeof row.play_id_onchain).toBe("number")
  })

  it("GQL fault returns null meta → on-chain ids absent for UUID input (no fabrication)", async () => {
    vi.unstubAllGlobals()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: {
            searchEditions: { searchSummary: { data: { data: [] } } },
          },
        }),
      }))
    )
    const [row] = await hydrateTopShotEditions([UUID_EXTERNAL_ID])
    const clean = toUpsertRow(row)
    expect(clean.set_id_onchain).toBeUndefined()
    expect(clean.play_id_onchain).toBeUndefined()
    expect(row.ok).toBe(false)
  })
})
