import { describe, it, expect, vi, beforeEach } from "vitest"

// supabase-server.ts builds a server Supabase client from cookies() and exposes
// getCurrentUser (null on no-session/error, never throws) + requireUser (throws a
// 401 Response when signed-out). We mock @supabase/ssr's createServerClient and
// next/headers' cookies so we can drive the auth.getUser() result per test, and
// assert the cookie getAll/setAll adapters are wired without exploding.

const state: { getUser: any; cookieStore: any } = {
  getUser: async () => ({ data: { user: { id: "u1" } } }),
  cookieStore: {
    getAll: () => [{ name: "sb-access", value: "tok" }],
    set: vi.fn(),
  },
}

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn((_url: string, _key: string, opts: any) => ({
    __opts: opts,
    auth: { getUser: () => state.getUser() },
  })),
}))

vi.mock("next/headers", () => ({
  cookies: async () => state.cookieStore,
}))

import { getSupabaseServer, getCurrentUser, requireUser } from "@/lib/auth/supabase-server"
import { createServerClient } from "@supabase/ssr"

beforeEach(() => {
  vi.clearAllMocks()
  state.getUser = async () => ({ data: { user: { id: "u1" } } })
  state.cookieStore = {
    getAll: () => [{ name: "sb-access", value: "tok" }],
    set: vi.fn(),
  }
})

describe("getSupabaseServer", () => {
  it("constructs the client with the env URL/key and cookie adapters", async () => {
    await getSupabaseServer()
    expect(createServerClient).toHaveBeenCalledWith(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      expect.objectContaining({ cookies: expect.any(Object) })
    )
  })

  it("cookie getAll maps the store to {name,value} pairs", async () => {
    await getSupabaseServer()
    const opts = (createServerClient as any).mock.results[0].value.__opts
    expect(opts.cookies.getAll()).toEqual([{ name: "sb-access", value: "tok" }])
  })

  it("cookie setAll swallows the throw when the store cannot set (Server Component)", async () => {
    state.cookieStore.set = vi.fn(() => {
      throw new Error("cannot set cookies")
    })
    await getSupabaseServer()
    const opts = (createServerClient as any).mock.results[0].value.__opts
    // Must not throw even though the underlying set() throws.
    expect(() =>
      opts.cookies.setAll([{ name: "a", value: "b", options: {} }])
    ).not.toThrow()
    expect(state.cookieStore.set).toHaveBeenCalled()
  })
})

describe("getCurrentUser", () => {
  it("returns the user on an active session", async () => {
    state.getUser = async () => ({ data: { user: { id: "u42" } } })
    expect(await getCurrentUser()).toEqual({ id: "u42" })
  })

  it("returns null when there is no user in the response", async () => {
    state.getUser = async () => ({ data: { user: null } })
    expect(await getCurrentUser()).toBeNull()
  })

  it("returns null (never throws) when getUser rejects", async () => {
    state.getUser = async () => {
      throw new Error("boom")
    }
    expect(await getCurrentUser()).toBeNull()
  })
})

describe("requireUser", () => {
  it("returns the user when signed in", async () => {
    state.getUser = async () => ({ data: { user: { id: "u7" } } })
    expect(await requireUser()).toEqual({ id: "u7" })
  })

  it("throws a 401 JSON Response when signed out", async () => {
    state.getUser = async () => ({ data: { user: null } })
    let thrown: any
    try {
      await requireUser()
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Response)
    expect(thrown.status).toBe(401)
    expect(await thrown.json()).toEqual({ error: "Authentication required" })
  })
})
