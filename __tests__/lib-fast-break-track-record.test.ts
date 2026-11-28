import { describe, it, expect } from "vitest"
import { scorePrediction, summarizeTrackRecord, type BoxLine, type GameState, type PredictedPick } from "@/lib/fast-break/track-record"

// Fast Break track record scoring: three states (pending until every game is final WITH box
// rows), Captain 1.5×, the bench replaces a starter who sat, and a sub never takes the bonus.

const pick = (id: string, extra: Partial<PredictedPick> = {}): PredictedPick => ({
  id, name: id, team: "POR", gameId: "g1", captain: false, bench: false, ...extra,
})
const final: Map<string, GameState> = new Map([["g1", { final: true, hasBoxRows: true }]])
const line = (pts: number, didPlay = true): BoxLine => ({ didPlay, pts })

describe("scorePrediction", () => {
  const picks = [pick("a", { captain: true }), pick("b"), pick("c"), pick("d"), pick("e"), pick("f", { bench: true })]

  it("is pending — not a miss — while a game is not final", () => {
    const r = scorePrediction(picks, { pts: 100 }, new Map(), new Map([["g1", { final: false, hasBoxRows: false }]]))
    expect(r).toEqual({ state: "pending", reason: "game_not_final" })
  })

  it("is pending when a final game has no box-score rows yet (an absent read is not a DNP)", () => {
    const r = scorePrediction(picks, { pts: 100 }, new Map(), new Map([["g1", { final: true, hasBoxRows: false }]]))
    expect(r).toEqual({ state: "pending", reason: "box_score_missing" })
  })

  it("counts the Captain 1.5× and clears at exactly the target", () => {
    const box = new Map([["a", line(20)], ["b", line(20)], ["c", line(20)], ["d", line(20)], ["e", line(10)], ["f", line(30)]])
    // 1.5×20 + 20 + 20 + 20 + 10 = 100
    const r = scorePrediction(picks, { pts: 100 }, box, final)
    expect(r).toMatchObject({ state: "scored", cleared: true, totals: { pts: 100 }, benchUsed: false })
  })

  it("misses one point under the target", () => {
    const box = new Map([["a", line(20)], ["b", line(20)], ["c", line(20)], ["d", line(20)], ["e", line(9)]])
    expect(scorePrediction(picks, { pts: 100 }, box, final)).toMatchObject({ state: "scored", cleared: false, totals: { pts: 99 } })
  })

  it("subs the bench in for a starter who sat, at 1× even when the Captain sat", () => {
    const box = new Map([["a", line(0, false)], ["b", line(20)], ["c", line(20)], ["d", line(20)], ["e", line(10)], ["f", line(30)]])
    const r = scorePrediction(picks, { pts: 100 }, box, final)
    expect(r).toMatchObject({ state: "scored", cleared: true, totals: { pts: 100 }, benchUsed: true })
    if (r.state === "scored") expect(r.used).toEqual(["f", "b", "c", "d", "e"])
  })

  it("treats a pick with no row in a final, box-scored game as not playing", () => {
    const box = new Map([["b", line(20)], ["c", line(20)], ["d", line(20)], ["e", line(10)]])
    const r = scorePrediction(picks, { pts: 100 }, box, final)
    expect(r).toMatchObject({ state: "scored", cleared: false, totals: { pts: 70 }, benchUsed: false })
  })
})

describe("summarizeTrackRecord", () => {
  it("averages the predicted chance over scored nights only, and reports no average with none scored", () => {
    expect(summarizeTrackRecord([
      { predicted_p: 0.8, cleared: true }, { predicted_p: "0.6", cleared: false }, { predicted_p: 0.9, cleared: null },
    ])).toEqual({ scored: 2, cleared: 1, avgPredicted: 0.7, pending: 1 })
    expect(summarizeTrackRecord([{ predicted_p: 0.9, cleared: null }]).avgPredicted).toBeNull()
  })
})
