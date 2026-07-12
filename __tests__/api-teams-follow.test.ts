import { describe, it, expect, vi } from "vitest"

// Route integration test for /api/teams/follow (Team Hub write). Pins the pre-DB
// validation guards that fire before the auth/session read:
//   POST invalid JSON → 400, invalid league → 400, missing team_slug → 400
//   GET invalid league/slug → { authed: false } (200)
// The authenticated write path runs through the user's Supabase session client
// and is out of scope here (no cookie context in-test). NOTE: happy-path write
// not exercised.

import { GET, POST } from "@/app/api/teams/follow/route"

const getReq = (u: string) => ({ nextUrl: new URL(u) }) as any
const postReq = (body: any, bad = false) =>
  ({ json: async () => { if (bad) throw new Error("bad json"); return body } }) as any

describe("POST /api/teams/follow — pre-DB guards", () => {
  it("400s on invalid JSON", async () => {
    expect((await POST(postReq(null, true))).status).toBe(400)
  })
  it("400s on an invalid league", async () => {
    expect((await POST(postReq({ league: "XYZ", team_slug: "lakers" }))).status).toBe(400)
  })
  it("400s when team_slug is missing", async () => {
    expect((await POST(postReq({ league: "NBA" }))).status).toBe(400)
  })
})

describe("GET /api/teams/follow", () => {
  it("returns { authed: false } for an invalid league/slug (no auth reached)", async () => {
    const res = await GET(getReq("https://t/api/teams/follow?league=XYZ&slug=x"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.authed).toBe(false)
    expect(body.following).toBe(false)
  })
})
