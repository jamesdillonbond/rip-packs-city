import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/support-chat/feedback. Pins the pre-DB
// 400 guards, the update-by-id happy path, and — the load-bearing part — that
// every write is SCOPED BY session_id.
//
// Why the scoping assertions matter: this route is anon-reachable and holds a
// service-role client, so an update keyed on the sequential bigint id alone was
// an unauthenticated write IDOR. The mock records the filters applied to each
// update so a regression that drops `.eq("session_id", …)` fails here rather
// than shipping. Deleting the session_id filter from the route must red these.

type Filter = { col: string; val: any }
const state: {
  updateError: any
  updatedRows: any[] | null
  updateFilters: Filter[]
  updatePayload: any
  latestRow: any
} = {
  updateError: null,
  updatedRows: [{ id: 42 }],
  updateFilters: [],
  updatePayload: null,
  latestRow: { id: 7 },
}

vi.mock("@supabase/supabase-js", () => {
  const makeUpdateChain = () => {
    const chain: any = {
      eq: (col: string, val: any) => {
        state.updateFilters.push({ col, val })
        return chain
      },
      select: async () => ({ data: state.updatedRows, error: state.updateError }),
      // Awaiting the chain without .select() (the session-fallback path) still
      // has to resolve — supabase-js returns a thenable builder.
      then: (resolve: any) => resolve({ data: state.updatedRows, error: state.updateError }),
    }
    return chain
  }
  const b: any = {
    select: () => b,
    eq: () => b,
    ilike: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: async () => ({ data: state.latestRow }),
    update: (payload: any) => {
      state.updatePayload = payload
      return makeUpdateChain()
    },
  }
  return { createClient: () => ({ from: () => b }) }
})
vi.mock("@/lib/auth/supabase-server", () => ({
  getSupabaseServer: async () => ({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } }),
}))

import { POST } from "@/app/api/support-chat/feedback/route"

const req = (body: any) => ({ json: async () => body }) as any

beforeEach(() => {
  state.updateError = null
  state.updatedRows = [{ id: 42 }]
  state.updateFilters = []
  state.updatePayload = null
  state.latestRow = { id: 7 }
})

describe("POST /api/support-chat/feedback", () => {
  it("400s when feedback is not 'up' or 'down'", async () => {
    const res = await POST(req({ feedback: "meh", sessionId: "s1" }))
    expect(res.status).toBe(400)
  })

  it("400s when sessionId is absent, even if messageId is present", async () => {
    // sessionId is the capability that authorizes the write. A messageId-only
    // request is exactly the IDOR shape and must never reach the DB.
    const res = await POST(req({ feedback: "up", messageId: 42 }))
    expect(res.status).toBe(400)
    expect(state.updatePayload).toBeNull()
  })

  it("400s when sessionId is present but blank", async () => {
    const res = await POST(req({ feedback: "up", messageId: 42, sessionId: "   " }))
    expect(res.status).toBe(400)
    expect(state.updatePayload).toBeNull()
  })

  it("updates by primary-key id on the preferred path", async () => {
    const res = await POST(req({ feedback: "up", messageId: 42, sessionId: "rpc_abc" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.target).toBe("id")
  })

  it("scopes the by-id update to BOTH id and session_id", async () => {
    await POST(req({ feedback: "up", messageId: 42, sessionId: "rpc_abc" }))
    expect(state.updateFilters).toEqual([
      { col: "id", val: 42 },
      { col: "session_id", val: "rpc_abc" },
    ])
  })

  it("404s when the id/session pair matches no row (the enumeration attempt)", async () => {
    // A valid row id paired with a session that does not own it updates zero
    // rows. Postgres reports no error for that, so without the row-count check
    // the route would answer 200 and the attacker would learn the id exists.
    state.updatedRows = []
    const res = await POST(req({ feedback: "down", messageId: 999, sessionId: "not-my-session" }))
    expect(res.status).toBe(404)
    const body = await res.json()
    // Must not distinguish "no such id" from "id belongs to someone else".
    expect(body.error).toBe("no row found for session")
  })

  it("scopes the session-fallback update to session_id too", async () => {
    await POST(req({ feedback: "up", sessionId: "rpc_xyz" }))
    expect(state.updateFilters).toEqual([
      { col: "id", val: 7 },
      { col: "session_id", val: "rpc_xyz" },
    ])
  })

  it("writes a bare 'up'/'down' to feedback — never a concatenated comment", async () => {
    // support_conversations_feedback_check allows exactly 'up' | 'down', so the
    // old `${feedback}: ${comment}` value could only ever 500.
    await POST(req({ feedback: "up", messageId: 42, sessionId: "rpc_abc", comment: "very helpful" }))
    expect(state.updatePayload.feedback).toBe("up")
  })

  it("routes a comment to feedback_details", async () => {
    await POST(req({ feedback: "down", messageId: 42, sessionId: "rpc_abc", comment: "  wrong FMV  " }))
    expect(state.updatePayload.feedback_details).toBe("wrong FMV")
  })

  it("omits feedback_details entirely when no comment is supplied", async () => {
    await POST(req({ feedback: "up", messageId: 42, sessionId: "rpc_abc" }))
    expect(state.updatePayload).not.toHaveProperty("feedback_details")
  })

  it("caps an oversized comment rather than writing it whole", async () => {
    await POST(req({ feedback: "down", messageId: 42, sessionId: "rpc_abc", comment: "x".repeat(5000) }))
    expect(state.updatePayload.feedback_details.length).toBe(2000)
  })
})
