import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Companion to api-stripe-webhook.test.ts. That file pins the pre-processing
// guards (config 503, bad-signature 400) and the invoice.payment_succeeded
// happy path. This file drives the remaining event-handler BRANCHES, which
// were previously untested:
//   - invoice.payment_succeeded: missing user_id → skip RPC; RPC error → 503 + paper trail
//   - checkout.session.completed: wallet present → upsert pro_users; no wallet → no-op
//   - customer.subscription.updated: active vs canceled expiry write; no matching row → no-op
//   - customer.subscription.deleted: expire by customer id
// A richer createClient mock records the pro_users writes so each branch can be
// asserted structurally.

const h = vi.hoisted(() => ({
  event: null as any,
  rpcResult: { data: { ok: true } as any, error: null as any },
  proUsersRow: null as any, // what select().eq().maybeSingle() returns
  writes: [] as any[], // recorded upsert/update ops against pro_users
  logInserts: [] as any[], // recorded stripe_payment_log inserts
}))

vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    webhooks: { constructEvent: () => h.event },
    subscriptions: { retrieve: async () => ({ current_period_end: 1_900_000_000 }) },
  }),
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => h.rpcResult,
    from: (table: string) => ({
      insert: async (row: any) => {
        if (table === "stripe_payment_log") h.logInserts.push(row)
        return { error: null }
      },
    }),
  },
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      upsert: async (row: any, opts: any) => {
        h.writes.push({ op: "upsert", table, row, opts })
        return { error: null }
      },
      update: (patch: any) => ({
        eq: async (col: string, val: any) => {
          h.writes.push({ op: "update", table, patch, col, val })
          return { error: null }
        },
      }),
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: h.proUsersRow, error: null }) }),
      }),
    }),
  }),
}))

process.env.STRIPE_WEBHOOK_SECRET = "whsec_test"
process.env.STRIPE_SECRET_KEY = "sk_test"

const { POST } = await import("@/app/api/stripe/webhook/route")

function post(): NextRequest {
  return new NextRequest("https://t/api/stripe/webhook", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", "stripe-signature": "t=1,v1=ok" }),
    body: "{}",
  })
}

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test"
  h.event = null
  h.rpcResult = { data: { ok: true }, error: null }
  h.proUsersRow = null
  h.writes = []
  h.logInserts = []
})

describe("invoice.payment_succeeded branches", () => {
  it("skips the RPC and 200s when user_id metadata is missing", async () => {
    h.event = {
      id: "evt_1",
      type: "invoice.payment_succeeded",
      data: { object: { subscription: "sub_1", customer: "cus_1", amount_paid: 999, lines: { data: [] } } },
    }
    const res = await POST(post())
    expect(res.status).toBe(200)
    expect((await res.json()).received).toBe(true)
    expect(h.logInserts).toHaveLength(0)
  })

  it("503s and writes a handler_error paper-trail row when the activate RPC errors", async () => {
    h.rpcResult = { data: null, error: { message: "rpc exploded" } }
    h.event = {
      id: "evt_2",
      type: "invoice.payment_succeeded",
      data: {
        object: {
          subscription: "sub_2",
          customer: "cus_2",
          amount_paid: 500,
          subscription_details: { metadata: { user_id: "u2", wallet_address: "0xABC" } },
          lines: { data: [] },
        },
      },
    }
    const res = await POST(post())
    expect(res.status).toBe(503)
    expect(h.logInserts).toHaveLength(1)
    expect(h.logInserts[0].status).toBe("handler_error")
    // wallet is lowercased before the write
    expect(h.logInserts[0].wallet_address).toBe("0xabc")
  })
})

describe("checkout.session.completed branch", () => {
  it("upserts pro_users with a lowercased wallet when metadata carries one", async () => {
    h.event = {
      id: "evt_3",
      type: "checkout.session.completed",
      data: { object: { subscription: "sub_3", customer: "cus_3", metadata: { wallet_address: "0xDeAd" } } },
    }
    const res = await POST(post())
    expect(res.status).toBe(200)
    const upsert = h.writes.find((w) => w.op === "upsert" && w.table === "pro_users")
    expect(upsert).toBeDefined()
    expect(upsert.row.wallet_address).toBe("0xdead")
    expect(upsert.opts.onConflict).toBe("wallet_address")
  })

  it("no-ops (no write) when the session has no wallet metadata", async () => {
    h.event = {
      id: "evt_4",
      type: "checkout.session.completed",
      data: { object: { subscription: "sub_4", customer: "cus_4", metadata: {} } },
    }
    const res = await POST(post())
    expect(res.status).toBe(200)
    expect(h.writes).toHaveLength(0)
  })
})

describe("customer.subscription.updated branch", () => {
  it("writes a future expiry when the subscription is active", async () => {
    h.proUsersRow = { wallet_address: "0xwallet" }
    h.event = {
      id: "evt_5",
      type: "customer.subscription.updated",
      data: { object: { customer: "cus_5", status: "active", current_period_end: 1_900_000_000 } },
    }
    const res = await POST(post())
    expect(res.status).toBe(200)
    const upd = h.writes.find((w) => w.op === "update" && w.table === "pro_users")
    expect(upd).toBeDefined()
    // active → expires_at is the period end (year 2030), not "now"
    expect(new Date(upd.patch.expires_at).getFullYear()).toBe(2030)
  })

  it("no-ops when no pro_users row matches the customer id", async () => {
    h.proUsersRow = null
    h.event = {
      id: "evt_6",
      type: "customer.subscription.updated",
      data: { object: { customer: "cus_6", status: "active", current_period_end: 1_900_000_000 } },
    }
    const res = await POST(post())
    expect(res.status).toBe(200)
    expect(h.writes.filter((w) => w.op === "update")).toHaveLength(0)
  })
})

describe("customer.subscription.deleted branch", () => {
  it("expires the subscription by customer id", async () => {
    h.event = {
      id: "evt_7",
      type: "customer.subscription.deleted",
      data: { object: { customer: "cus_7" } },
    }
    const res = await POST(post())
    expect(res.status).toBe(200)
    const upd = h.writes.find((w) => w.op === "update" && w.table === "pro_users")
    expect(upd).toBeDefined()
    expect(upd.col).toBe("stripe_customer_id")
    expect(upd.val).toBe("cus_7")
  })
})
