import { describe, it, expect } from "vitest"

// lib/og/card-warm — after a pin change, the NEW card (new content token) is
// rendered before anyone pastes the link. Pins the paths it warms.

import { cardPathsAfterPinChange } from "@/lib/og/card-warm"
import { pinsToken } from "@/lib/og/card-url"
import { challengeBoardToken } from "@/lib/trophy/challenge-copy"

function db(tables: Record<string, { data: any; error: any }>, board: { data: any; error: any } = { data: null, error: { message: "n/a" } }) {
  return {
    rpc: () => Promise.resolve(board),
    from: (t: string) => {
      const q: any = {}
      for (const m of ["select", "eq", "is", "limit"]) q[m] = () => q
      q.then = (res: any) => res(tables[t] ?? { data: [], error: null })
      return q
    },
  }
}
const pins = [{ slot: 1, moment_id: "a" }, { slot: 2, moment_id: "b" }]

describe("cardPathsAfterPinChange", () => {
  it("main case → the profile and trophy-case cards at the NEW token", async () => {
    const p = await cardPathsAfterPinChange(db({ profile_bio: { data: [{ username: "trev" }], error: null }, trophy_moments: { data: pins, error: null } }), "u", null)
    const t = pinsToken(pins)
    expect(p).toEqual([`/api/og/profile/trev?v=2&s=${t}`, `/api/og/trophy-case/trev?v=2&s=${t}`])
  })
  it("a challenge entry → that entry's card at the NEW token", async () => {
    const p = await cardPathsAfterPinChange(
      db({
        profile_bio: { data: [{ username: "trev" }], error: null },
        trophy_cases: { data: [{ id: "c", trophy_challenges: { slug: "dame-time" } }], error: null },
        trophy_moments: { data: pins, error: null },
      }),
      "u",
      "c",
    )
    expect(p).toEqual([`/api/og/trophy-case/trev?case=dame-time&s=${pinsToken(pins)}`])
  })
  it("a challenge entry also warms the BOARD card at its new token (#239)", async () => {
    const boardData = { entry_count: 2, entries: [{ username: "trev", slabs: pins }] }
    const p = await cardPathsAfterPinChange(
      db(
        {
          profile_bio: { data: [{ username: "trev" }], error: null },
          trophy_cases: { data: [{ id: "c", trophy_challenges: { slug: "dame-time" } }], error: null },
          trophy_moments: { data: pins, error: null },
        },
        { data: boardData, error: null },
      ),
      "u",
      "c",
    )
    expect(p[1]).toBe(`/api/og/trophy-challenge/dame-time?s=${challengeBoardToken(boardData)}`)
  })
  it("no public handle, a named case, or a failed read → nothing (never a wrong card)", async () => {
    expect(await cardPathsAfterPinChange(db({ profile_bio: { data: [], error: null } }), "u", null)).toEqual([])
    expect(
      await cardPathsAfterPinChange(db({ profile_bio: { data: [{ username: "t" }], error: null }, trophy_cases: { data: [{ id: "c", trophy_challenges: null }], error: null } }), "u", "c"),
    ).toEqual([])
    expect(
      await cardPathsAfterPinChange(db({ profile_bio: { data: [{ username: "t" }], error: null }, trophy_moments: { data: null, error: { message: "x" } } }), "u", null),
    ).toEqual([])
  })
})
