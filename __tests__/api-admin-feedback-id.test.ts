import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/feedback/[id] (PATCH).
// verifyAdminRequest-gated single-row update on support_conversations. Pins the
// fail-closed 401, the invalid-id 400, the invalid-JSON 400, and the
// no-updatable-fields 400. The id comes from ctx.params (a Promise).

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({}) } }))

import { PATCH } from "@/app/api/admin/feedback/[id]/route"

const ADMIN = "test-admin-token"

function patch(body: unknown, auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/admin/feedback/5", {
    method: "PATCH",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("PATCH /api/admin/feedback/[id]", () => {
  it("401s fail-closed when RPC_ADMIN_TOKEN is unset", async () => {
    expect((await PATCH(patch({ admin_note: "x" }, `Bearer ${ADMIN}`), ctx("5"))).status).toBe(401)
  })

  it("400s on a non-numeric id", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await PATCH(patch({ admin_note: "x" }, `Bearer ${ADMIN}`), ctx("abc"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid id")
  })

  it("400s on invalid JSON", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await PATCH(patch("{not json", `Bearer ${ADMIN}`), ctx("5"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })

  it("400s when no updatable fields are supplied", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await PATCH(patch({}, `Bearer ${ADMIN}`), ctx("5"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("No updatable fields supplied")
  })
})
