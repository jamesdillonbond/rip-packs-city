import { describe, it, expect } from "vitest"
import { challengeOfDrop, hasCompletedChallenge, openRewardDropForChallenge } from "@/lib/giveaways/challenge-reward"

// The link between a trophy challenge and its reward drop (2026-11-10). Each read has THREE
// answers: the thing · a successful read that found nothing · a failed read, which THROWS so
// no caller can publish it as "no reward" or "not eligible".

type Res = { data: unknown; error: { message: string } | null }
interface Call { table: string; cols: string; eq: Record<string, string>; not: string[]; order: string[]; limit: number | null }

function db(answer: (c: Call) => Res) {
  const calls: Call[] = []
  return {
    calls,
    from(table: string) {
      return {
        select(cols: string) {
          const c: Call = { table, cols, eq: {}, not: [], order: [], limit: null }
          const chain = {
            eq: (k: string, v: string) => ((c.eq[k] = v), chain),
            not: (k: string, op: string) => (c.not.push(`${k} ${op}`), chain),
            order: (k: string, o: { ascending: boolean }) => (c.order.push(`${k} ${o.ascending ? "asc" : "desc"}`), chain),
            limit: (n: number) => ((c.limit = n), chain),
            then: (res: (r: Res) => unknown, rej?: (e: unknown) => unknown) => {
              calls.push(c)
              return Promise.resolve(answer(c)).then(res, rej)
            },
          }
          return chain
        },
      }
    },
  }
}
const ok = (data: unknown): Res => ({ data, error: null })
const fail: Res = { data: null, error: { message: "timeout" } }

describe("challengeOfDrop", () => {
  it("names the drop's challenge; a drop with none is open to everyone", async () => {
    const d = db((c) => (c.table === "giveaway_drops" ? ok([{ eligible_challenge_id: "ch1" }]) : ok([{ id: "ch1", slug: "dame-time", title: "Dame Time" }])))
    expect(await challengeOfDrop(d as never, "drop1")).toEqual({ id: "ch1", slug: "dame-time", title: "Dame Time" })
    expect(d.calls[0]).toMatchObject({ table: "giveaway_drops", eq: { id: "drop1" } })
    expect(d.calls[1]).toMatchObject({ table: "trophy_challenges", eq: { id: "ch1" } })
    const none = db(() => ok([{ eligible_challenge_id: null }]))
    expect(await challengeOfDrop(none as never, "drop1")).toBeNull()
    expect(none.calls).toHaveLength(1)
  })
  it("a failed read, or a challenge that cannot be named, throws — never 'open to everyone'", async () => {
    await expect(challengeOfDrop(db(() => fail) as never, "drop1")).rejects.toThrow(/giveaway_drops read failed/)
    const half = db((c) => (c.table === "giveaway_drops" ? ok([{ eligible_challenge_id: "ch1" }]) : fail))
    await expect(challengeOfDrop(half as never, "drop1")).rejects.toThrow(/trophy_challenges read failed/)
    const gone = db((c) => (c.table === "giveaway_drops" ? ok([{ eligible_challenge_id: "ch1" }]) : ok([])))
    await expect(challengeOfDrop(gone as never, "drop1")).rejects.toThrow(/could not be read/)
  })
})

describe("hasCompletedChallenge", () => {
  it("asks for a COMPLETED case of this user in this challenge — the claim function's own test", async () => {
    const d = db(() => ok([{ id: "case1" }]))
    expect(await hasCompletedChallenge(d as never, "ch1", "u1")).toBe(true)
    expect(d.calls[0]).toMatchObject({ table: "trophy_cases", eq: { challenge_id: "ch1", user_id: "u1" }, not: ["completed_at is"] })
    expect(await hasCompletedChallenge(db(() => ok([])) as never, "ch1", "u1")).toBe(false)
  })
  it("a failed read throws, never false", async () => {
    await expect(hasCompletedChallenge(db(() => fail) as never, "ch1", "u1")).rejects.toThrow(/trophy_cases read failed/)
  })
})

describe("openRewardDropForChallenge", () => {
  it("returns the newest OPEN drop tied to the challenge", async () => {
    const d = db((c) => (c.table === "trophy_challenges" ? ok([{ id: "ch1" }]) : ok([{ slug: "dame-time-challenge-reward-pack", title: "Dame Time Challenge Reward Pack" }])))
    expect(await openRewardDropForChallenge(d as never, "dame-time")).toEqual({ slug: "dame-time-challenge-reward-pack", title: "Dame Time Challenge Reward Pack" })
    expect(d.calls[0]).toMatchObject({ table: "trophy_challenges", eq: { slug: "dame-time" } })
    expect(d.calls[1]).toMatchObject({ table: "giveaway_drops", eq: { eligible_challenge_id: "ch1", status: "open" }, order: ["opened_at desc"], limit: 1 })
  })
  it("no such challenge, or no open drop, is null without a second guess", async () => {
    const noCh = db(() => ok([]))
    expect(await openRewardDropForChallenge(noCh as never, "nope")).toBeNull()
    expect(noCh.calls).toHaveLength(1)
    expect(await openRewardDropForChallenge(db((c) => (c.table === "trophy_challenges" ? ok([{ id: "ch1" }]) : ok([]))) as never, "dame-time")).toBeNull()
  })
  it("either failed read throws, never null", async () => {
    await expect(openRewardDropForChallenge(db(() => fail) as never, "dame-time")).rejects.toThrow(/trophy_challenges read failed/)
    await expect(openRewardDropForChallenge(db((c) => (c.table === "trophy_challenges" ? ok([{ id: "ch1" }]) : fail)) as never, "dame-time")).rejects.toThrow(/giveaway_drops read failed/)
  })
})
