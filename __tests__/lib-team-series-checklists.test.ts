import { describe, expect, it } from "vitest"
import { closestSeries, parseTeamSeriesChecklists, toGoParts, type SeriesChecklist } from "@/lib/entity/team-series-checklists"

const row = (over: Partial<SeriesChecklist>): SeriesChecklist => ({
  series_num: 0, players_total: 10, players_owned: 0, to_go: 10, cost_to_go_usd: 0, unlisted: 0, complete: false, players: [], ...over,
})
const usd = (n: number) => `$${n.toFixed(2)}`

describe("team series checklists", () => {
  it("parses the RPC jsonb, numerics as strings included, and drops malformed rows", () => {
    const d = parseTeamSeriesChecklists({
      wallet_cached: true,
      series: [
        { series_num: 9, players_total: 6, players_owned: 1, to_go: 5, cost_to_go_usd: "73.43", unlisted: 0, complete: false,
          players: [{ player_key: "p1", player_name: "Cooper Flagg", owned: false, owned_count: 0, cheapest_ask_usd: "12.5", cheapest_route_slug: "1:2", edition_count: 3 }, { player_name: "" }] },
        { players_total: 3 },
      ],
    })
    expect(d.wallet_cached).toBe(true)
    expect(d.series).toHaveLength(1)
    expect(d.series[0].cost_to_go_usd).toBe(73.43)
    expect(d.series[0].players).toHaveLength(1)
    expect(d.series[0].players[0].cheapest_ask_usd).toBe(12.5)
    expect(parseTeamSeriesChecklists(null)).toEqual({ wallet_cached: null, series: [] })
  })

  it("an unlisted player is never priced: the total reads as a lower bound and names the count", () => {
    expect(toGoParts(row({ to_go: 19, cost_to_go_usd: 253.23, unlisted: 1 }), usd)).toEqual(["19 to go", "≥ $253.23", "1 unlisted"])
    expect(toGoParts(row({ to_go: 6, cost_to_go_usd: 73.43 }), usd)).toEqual(["6 to go", "$73.43"])
    // every missing player unlisted → no money figure at all, never "$0.00"
    expect(toGoParts(row({ to_go: 1, cost_to_go_usd: 0, unlisted: 1 }), usd)).toEqual(["1 to go", "1 unlisted"])
  })

  it("Closest = fewest to go among incomplete series; none without a wallet", () => {
    const list = [
      row({ series_num: 9, to_go: 6, cost_to_go_usd: 73 }),
      row({ series_num: 8, to_go: 16 }),
      row({ series_num: 3, to_go: 0, complete: true }),
      row({ series_num: 4, to_go: 6, cost_to_go_usd: 1119 }),
    ]
    expect(closestSeries(list, true)).toBe(9)
    expect(closestSeries(list, false)).toBeNull()
    // a fully priced tie beats one with an unlisted player
    expect(closestSeries([row({ series_num: 9, to_go: 2, cost_to_go_usd: 1, unlisted: 1 }), row({ series_num: 2, to_go: 2, cost_to_go_usd: 50 })], true)).toBe(2)
    expect(closestSeries([row({ series_num: 1, to_go: 0, complete: true })], true)).toBeNull()
    // a full tie (same to-go, both priced, same cost) goes to the NEWER series, in either input order
    const a = row({ series_num: 5, to_go: 3, cost_to_go_usd: 20 })
    const b = row({ series_num: 7, to_go: 3, cost_to_go_usd: 20 })
    expect(closestSeries([a, b], true)).toBe(7)
    expect(closestSeries([b, a], true)).toBe(7)
  })
})
