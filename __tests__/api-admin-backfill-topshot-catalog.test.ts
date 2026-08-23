import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for /api/admin/backfill-topshot-catalog (GET + POST
// share handle()). Bearer-gated via verifyAdminRequest (RPC_ADMIN_TOKEN).
// None set => fail-closed 401 on both verbs.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }) } }))

import { GET, POST } from "@/app/api/admin/backfill-topshot-catalog/route"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("/api/admin/backfill-topshot-catalog", () => {
  it("GET 401s when RPC_ADMIN_TOKEN is unset (fail-closed)", async () => {
    const res = await GET(adminReq("https://t/api/admin/backfill-topshot-catalog"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("POST 401s with a wrong bearer even when the token is configured", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await POST(adminReq("https://t/api/admin/backfill-topshot-catalog", { authorization: "Bearer nope" }))
    expect(res.status).toBe(401)
  })

  it("200s the stale-thumbnails mode with 0 sets when none are stale (authed)", async () => {
    // topshot_sets_with_stale_thumbnails mocked [] → early return, no GQL walk.
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await GET(
      adminReq("https://t/api/admin/backfill-topshot-catalog?forceRefresh=stale_thumbnails", { authorization: "Bearer secret" })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.sets_processed).toBe(0)
    expect(body.terminated_reason).toBe("no_stale_thumbnails")
  })
})

// ⚠ GraphQL field PLACEMENT, pinned as a source guard because getting it wrong
// fails SILENTLY AND TOTALLY. An invalid field invalidates the whole query,
// Top Shot answers HTTP 422, fetchPage returns null, and the walk upserts ZERO
// editions while still reporting ok:true. That exact regression shipped on
// 2026-08-11 (commit b1018e63) when `description` was put inside `stats { }`.
//
// The placements below are not guesses: /api/admin/discover-moment-descriptors
// established them against live Top Shot on 2026-08-13 with all controls
// passing — description/headline on `Play`, the bio fields on `PlayStats`.
describe("backfill-topshot-catalog — GraphQL field placement", () => {
  function querySrc(): string {
    const { readFileSync } = require("node:fs") as typeof import("node:fs")
    const src = readFileSync("app/api/admin/backfill-topshot-catalog/route.ts", "utf8")
    const start = src.indexOf("const SEARCH_EDITIONS_QUERY")
    const end = src.indexOf("`;", start)
    expect(start).toBeGreaterThan(-1)
    return src.slice(start, end)
  }

  function statsBlock(q: string): string {
    const start = q.indexOf("stats {")
    expect(start).toBeGreaterThan(-1)
    return q.slice(start, q.indexOf("}", start))
  }

  it("keeps description on Play, OUTSIDE the stats block", () => {
    const q = querySrc()
    expect(q).toContain("description")
    // The 2026-08-11 regression, pinned: description must not be in stats { }.
    expect(statsBlock(q)).not.toContain("description")
  })

  it.each([["birthdate"], ["birthplace"], ["draftYear"]])(
    "keeps %s INSIDE the stats block, where PlayStats exposes it",
    (field) => {
      // The mirror-image of the description rule: these live on PlayStats, so
      // hoisting them to Play would 422 the query just as surely.
      expect(statsBlock(querySrc())).toContain(field)
    }
  )

  it("normalizes bio sentinels to NULL rather than storing 0 / N/A", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs")
    const src = stripComments(
      readFileSync("app/api/admin/backfill-topshot-catalog/route.ts", "utf8")
    )
    // Top Shot answers 0 / "N/A" / "" for unknown bio. Without isSentinel every
    // undrafted player would store draft_year 0, and a "serial matches draft
    // year" check would start firing on garbage.
    // ⚠ Match the ASSIGNMENT, not the first line mentioning the column — the
    // interface declares `player_birthdate: string | null` earlier in the file,
    // and a naive first-match lands on the type and reports a false failure.
    const lines = src.split("\n")
    for (const col of ["player_birthdate", "player_birthplace", "player_draft_year"]) {
      const decl = lines.filter((l) => l.includes(`${col}:`))
      expect(decl.length, `${col} must appear`).toBeGreaterThan(0)
      const assigned = decl.filter((l) => l.includes("e.play?.stats?."))
      expect(assigned.length, `${col} must be written from the GQL row`).toBe(1)
      expect(assigned[0], `${col} must be sentinel-guarded`).toContain("isSentinel")
    }
  })
})
