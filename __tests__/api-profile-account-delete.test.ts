import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

// DELETE /api/profile/account — account deletion (platform review C1).
//
// The contract under test is ORDER and HONESTY, not the SQL (the purge
// function is pinned in supabase/tests/delete_user_account.sql):
//   * the purge RPC runs BEFORE auth.admin.deleteUser, and a failed purge
//     never reaches deleteUser (deleting the auth user first would cascade
//     profile_bio away and strand every owner_key row);
//   * a purge that returns without ok:true is a 502, not a success;
//   * a failed auth delete after a successful purge says so (502) and carries
//     the row report, because the data IS gone;
//   * the typed confirmation gates the request; a wrong one does nothing.

const st = vi.hoisted(() => ({
  user: { id: "11111111-1111-1111-1111-111111111111", email: "u1@example.com" } as { id: string; email: string } | null,
  rpc: { data: { ok: true, owner_keys: 2, rows: { "profile_bio.user_id:deleted": 1 } } as unknown, error: null as unknown },
  authDel: { error: null as unknown },
  calls: [] as string[],
  signOutCalls: 0,
}))

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!st.user) {
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }
    return st.user
  },
  getSupabaseServer: async () => ({
    auth: {
      signOut: async () => {
        st.signOutCalls += 1
        return { error: null }
      },
    },
  }),
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      st.calls.push(`rpc:${fn}:${String(args.p_user_id)}`)
      return { data: st.rpc.data, error: st.rpc.error }
    },
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          st.calls.push(`deleteUser:${id}`)
          return { data: {}, error: st.authDel.error }
        },
      },
    },
  },
}))

import { DELETE } from "@/app/api/profile/account/route"

const req = (body: unknown) =>
  new NextRequest("https://t/api/profile/account", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

beforeEach(() => {
  st.user = { id: "11111111-1111-1111-1111-111111111111", email: "u1@example.com" }
  st.rpc = { data: { ok: true, owner_keys: 2, rows: { "profile_bio.user_id:deleted": 1 } }, error: null }
  st.authDel = { error: null }
  st.calls = []
  st.signOutCalls = 0
})

describe("DELETE /api/profile/account — gates", () => {
  it("401s with no session and touches nothing", async () => {
    st.user = null
    const res = await DELETE(req({ confirm: "DELETE" }))
    expect(res.status).toBe(401)
    expect(st.calls).toEqual([])
  })
  it("400s without the typed confirmation and touches nothing", async () => {
    for (const body of [undefined, {}, { confirm: "delete" }, { confirm: "yes" }]) {
      const res = await DELETE(req(body))
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(st.calls).toEqual([])
  })
})

describe("DELETE /api/profile/account — order and honesty", () => {
  it("purges FIRST, then deletes the auth user, then signs out and clears the allow-list cookie", async () => {
    const res = await DELETE(req({ confirm: "DELETE" }))
    expect(res.status).toBe(200)
    expect(st.calls).toEqual([
      "rpc:delete_user_account:11111111-1111-1111-1111-111111111111",
      "deleteUser:11111111-1111-1111-1111-111111111111",
    ])
    expect(st.signOutCalls).toBe(1)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.rows).toEqual({ "profile_bio.user_id:deleted": 1 })
    // The handler's return type is the union with requireUser's thrown Response,
    // so the cookie jar needs the concrete NextResponse.
    const cookie = (res as NextResponse).cookies.get("rpc_al_check")
    expect(cookie?.value).toBe("")
    expect(cookie?.maxAge).toBe(0)
  })

  it("a failed purge is a 5xx and NEVER reaches deleteUser", async () => {
    st.rpc = { data: null, error: { message: "permission denied for function delete_user_account", code: "42501" } }
    const res = await DELETE(req({ confirm: "DELETE" }))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(st.calls.some((c) => c.startsWith("deleteUser:")), "deleteUser must not run after a failed purge").toBe(false)
    const body = await res.json()
    expect(body.ok).toBeUndefined()
  })

  it("a purge that returns without ok:true is a 502, not a success, and deleteUser does not run", async () => {
    st.rpc = { data: { rows: {} }, error: null }
    const res = await DELETE(req({ confirm: "DELETE" }))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe("purge_incomplete")
    expect(st.calls).toEqual(["rpc:delete_user_account:11111111-1111-1111-1111-111111111111"])
  })

  it("a failed auth delete after a successful purge says so and carries the report (the data IS gone)", async () => {
    st.authDel = { error: { message: "gotrue unavailable" } }
    const res = await DELETE(req({ confirm: "DELETE" }))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toBe("auth_delete_failed")
    expect(body.rows).toEqual({ "profile_bio.user_id:deleted": 1 })
    expect(body.ok).toBeUndefined()
    expect(st.signOutCalls).toBe(0)
  })
})
