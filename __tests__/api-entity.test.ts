import { describe, it, expect, beforeEach, vi } from "vitest"

// The 12 entity detail routes (edition/player/team/set/series/pack + 6 team-*
// surfaces) share one guard contract: unknown collection → 404, missing
// slug/dist_id → 400, then an RPC via supabaseAdmin → data (or 500). One
// consolidated suite mocks supabaseAdmin.rpc and drives all 12.

const rpc: { data: any; error: any } = { data: null, error: null }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
  supabase: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET as edition } from "@/app/api/entity/edition/route"
import { GET as player } from "@/app/api/entity/player/route"
import { GET as team } from "@/app/api/entity/team/route"
import { GET as set } from "@/app/api/entity/set/route"
import { GET as series } from "@/app/api/entity/series/route"
import { GET as pack } from "@/app/api/entity/pack/route"
import { GET as teamActivity } from "@/app/api/entity/team-activity/route"
import { GET as teamChecklist } from "@/app/api/entity/team-checklist/route"
import { GET as teamChecklistProgress } from "@/app/api/entity/team-checklist-progress/route"
import { GET as teamEditions } from "@/app/api/entity/team-editions/route"
import { GET as teamSets } from "@/app/api/entity/team-sets/route"
import { GET as teamSqueeze } from "@/app/api/entity/team-squeeze/route"

const r = (path: string, qs: string) => new Request(`https://t/api/entity/${path}?${qs}`)

// [label, handler, url path, the required identifier param name]
const ROUTES: Array<[string, (req: Request) => Promise<Response>, string, string]> = [
  ["edition", edition as any, "edition", "slug"],
  ["player", player as any, "player", "slug"],
  ["team", team as any, "team", "slug"],
  ["set", set as any, "set", "slug"],
  ["series", series as any, "series", "slug"],
  ["pack", pack as any, "pack", "dist_id"],
  ["team-activity", teamActivity as any, "team-activity", "slug"],
  ["team-checklist", teamChecklist as any, "team-checklist", "slug"],
  ["team-checklist-progress", teamChecklistProgress as any, "team-checklist-progress", "slug"],
  ["team-editions", teamEditions as any, "team-editions", "slug"],
  ["team-sets", teamSets as any, "team-sets", "slug"],
  ["team-squeeze", teamSqueeze as any, "team-squeeze", "slug"],
]

beforeEach(() => {
  rpc.data = []
  rpc.error = null
})

describe("entity routes — shared guards", () => {
  it.each(ROUTES)("%s: 404 for an unknown collection", async (_label, fn, path) => {
    const res = await fn(r(path, "collection=not-a-collection&slug=x&dist_id=x"))
    expect(res.status).toBe(404)
  })

  it.each(ROUTES)("%s: 400 when the identifier param is missing", async (_label, fn, path) => {
    const res = await fn(r(path, "collection=nba-top-shot"))
    expect(res.status).toBe(400)
  })

  it.each(ROUTES)("%s: 200 on a valid request", async (_label, fn, path, idParam) => {
    const res = await fn(r(path, `collection=nba-top-shot&${idParam}=abc&part=sales`))
    expect(res.status).toBe(200)
  })
})

describe("entity RPC error handling", () => {
  it("edition surfaces a 500 on RPC error", async () => {
    rpc.error = { message: "db down" }
    const res = await edition(r("edition", "collection=nba-top-shot&slug=abc&part=fmv-history"))
    expect(res.status).toBe(500)
  })

  it("edition 400s on an unknown part", async () => {
    rpc.error = null
    const res = await edition(r("edition", "collection=nba-top-shot&slug=abc&part=bogus"))
    expect(res.status).toBe(400)
  })
})
