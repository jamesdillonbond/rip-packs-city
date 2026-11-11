import { describe, it, expect, vi } from "vitest"

// The giveaway page's link-preview metadata read (2026-11-10).
const h = vi.hoisted(() => ({ data: null as unknown, error: null as unknown, throws: false, slugs: [] as string[] }))
vi.mock("@/lib/supabase", () => {
  const q: Record<string, unknown> = {
    select: () => q,
    eq: (_c: string, v: string) => (h.slugs.push(v), q),
    maybeSingle: () => (h.throws ? Promise.reject(new Error("socket")) : Promise.resolve({ data: h.data, error: h.error })),
  }
  return { supabaseAdmin: { from: () => q } }
})
import { giveawayMeta } from "@/lib/giveaways/drop-meta"

describe("giveawayMeta", () => {
  it("names a live drop and says whether it is challenge-gated", async () => {
    h.data = { title: " Dame Time Challenge Reward Pack ", status: "open", eligible_challenge_id: "c" }
    expect(await giveawayMeta("dame-time-challenge-reward-pack")).toEqual({ title: "Dame Time Challenge Reward Pack", gated: true })
    h.data = { title: "Fall drop", status: "closed", eligible_challenge_id: null }
    expect(await giveawayMeta("fall-drop")).toEqual({ title: "Fall drop", gated: false })
  })

  it("a draft, a missing drop, a blank title, a failed or thrown read, or a bad slug names nothing", async () => {
    h.data = { title: "Secret", status: "draft", eligible_challenge_id: null }
    expect(await giveawayMeta("secret-drop")).toBeNull()
    h.data = null
    expect(await giveawayMeta("nope-drop")).toBeNull()
    h.data = { title: "  ", status: "open" }
    expect(await giveawayMeta("blank-drop")).toBeNull()
    h.data = { title: "X", status: "open" }
    h.error = { message: "timeout" }
    expect(await giveawayMeta("err-drop")).toBeNull()
    h.error = null
    h.throws = true
    expect(await giveawayMeta("throw-drop")).toBeNull()
    h.throws = false
    h.slugs.length = 0
    expect(await giveawayMeta("BAD SLUG")).toBeNull()
    expect(h.slugs).toEqual([]) // never reached the database
  })
})
