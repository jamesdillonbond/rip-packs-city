import { describe, it, expect, beforeEach, vi } from "vitest"

// GET /api/admin/trophy-campaign — operator-token-gated campaign board.
// Pins: 401 without the token; the started/finished/not-started split and the
// internal-account exclusion; and that EVERY failed read is a 500, never a
// partial answer (a missing auth page would move real accounts into
// "not started" — the list an operator emails).

const state: any = {}

vi.mock("@/lib/supabase", () => {
  const table = (name: string) => {
    const b: any = {
      select: () => b,
      order: () => b,
      limit: () => Promise.resolve(state.tables[name]),
    }
    return b
  }
  const client: any = {
    from: (n: string) => table(n),
    auth: { admin: { listUsers: async (args: any) => state.listUsers(args) } },
  }
  return { supabaseAdmin: client, supabase: client }
})

import { GET } from "@/app/api/admin/trophy-campaign/route"

const authed = () => ({ headers: new Headers({ authorization: "Bearer tok" }) }) as any

const U = (id: string, email: string) => ({ id, email, created_at: "2026-09-01T00:00:00Z", last_sign_in_at: null })

beforeEach(() => {
  process.env.RPC_ADMIN_TOKEN = "tok"
  state.tables = {
    trophy_case_campaign_users: {
      data: [
        { user_id: "a", is_internal: false, started_at: "2026-05-08T00:00:00Z", started_at_source: "backfill_upper_bound", completed_at: "2026-06-05T00:00:00Z", completed_at_source: "backfill_upper_bound", current_slots: 6 },
        { user_id: "b", is_internal: false, started_at: "2026-05-09T00:00:00Z", started_at_source: "backfill_upper_bound", completed_at: null, completed_at_source: null, current_slots: 1 },
        { user_id: "q", is_internal: true, internal_reason: "QA", started_at: "2026-09-10T00:00:00Z", started_at_source: "observed", completed_at: "2026-09-10T00:05:00Z", completed_at_source: "observed", current_slots: 6 },
      ],
      error: null,
    },
    trophy_case_campaign_daily: { data: [], error: null },
    internal_accounts: { data: [{ user_id: "q", reason: "QA" }, { user_id: "f", reason: "founder" }], error: null },
  }
  state.listUsers = async () => ({
    data: { users: [U("a", "a@x.com"), U("b", "b@x.com"), U("c", "c@x.com"), U("q", "qa@x.com"), U("f", "f@x.com")] },
    error: null,
  })
})

describe("GET /api/admin/trophy-campaign", () => {
  it("401s without the operator token", async () => {
    const res = await GET({ headers: new Headers() } as any)
    expect(res.status).toBe(401)
  })

  it("splits finished / started / not-started and excludes internal accounts from the totals", async () => {
    const res = await GET(authed())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totals).toEqual({
      accounts: 5,
      accounts_external: 3,
      started_external: 2,
      completed_external: 1,
      not_started_external: 1,
      started_internal: 1,
      completed_internal: 1,
    })
    expect(body.users.find((u: any) => u.user_id === "a")).toMatchObject({ status: "completed", email: "a@x.com" })
    expect(body.users.find((u: any) => u.user_id === "b")).toMatchObject({ status: "started" })
    expect(body.not_started.map((u: any) => u.user_id).sort()).toEqual(["c", "f"])
    expect(body.not_started.find((u: any) => u.user_id === "f")).toMatchObject({ is_internal: true, internal_reason: "founder" })
  })

  it("a failed view read is a 500, not '0 started'", async () => {
    state.tables.trophy_case_campaign_users = { data: null, error: { message: "boom" } }
    const res = await GET(authed())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.totals).toBeUndefined()
  })

  it("a failed auth-user page is a 500, not a shorter not-started list", async () => {
    state.listUsers = async () => ({ data: null, error: { message: "auth down" } })
    const res = await GET(authed())
    expect(res.status).toBe(500)
    expect((await res.json()).not_started).toBeUndefined()
  })

  it("walks auth users past the first page", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => U(`p${i}`, `p${i}@x.com`))
    state.listUsers = async ({ page }: any) => ({
      data: { users: page === 1 ? page1 : [U("a", "a@x.com")] },
      error: null,
    })
    const body = await (await GET(authed())).json()
    expect(body.totals.accounts).toBe(1001)
  })
})
