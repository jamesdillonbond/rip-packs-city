// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// supabase-client.ts exposes: getSupabaseBrowser (lazy singleton over
// createBrowserClient), sendMagicLink (POSTs /api/auth/request-magic-link and maps
// status/reason → {ok,notOnAllowList,error}), and signOut (auth.signOut + local
// cleanup + redirect). We mock @supabase/ssr, stub fetch, and use vi.resetModules
// + dynamic import so the module-level `client` singleton is reset per test.

const signOutMock = vi.fn(async () => {})
const createBrowserClientMock = vi.fn(() => ({ auth: { signOut: signOutMock } }))

vi.mock("@supabase/ssr", () => ({
  createBrowserClient: createBrowserClientMock,
}))

let fetchMock: ReturnType<typeof vi.fn>

function mockRes(status: number, body: unknown, jsonThrows = false) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: jsonThrows ? () => Promise.reject(new Error("not json")) : () => Promise.resolve(body),
  } as Response
}

async function loadModule() {
  vi.resetModules()
  return await import("@/lib/auth/supabase-client")
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
  createBrowserClientMock.mockClear()
  signOutMock.mockClear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("getSupabaseBrowser", () => {
  it("constructs the browser client once and reuses the singleton", async () => {
    const mod = await loadModule()
    const a = mod.getSupabaseBrowser()
    const b = mod.getSupabaseBrowser()
    expect(a).toBe(b)
    expect(createBrowserClientMock).toHaveBeenCalledTimes(1)
    expect(createBrowserClientMock).toHaveBeenCalledWith(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    )
  })
})

describe("sendMagicLink", () => {
  it("returns ok:true when the API accepts the send", async () => {
    fetchMock.mockResolvedValue(mockRes(200, { ok: true }))
    const mod = await loadModule()
    expect(await mod.sendMagicLink("a@b.com", "/dash")).toEqual({ ok: true, error: null })
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/request-magic-link",
      expect.objectContaining({ method: "POST" })
    )
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body)
    expect(body).toEqual({ email: "a@b.com", redirect: "/dash" })
  })

  it("sends redirect:null when redirectTo omitted", async () => {
    fetchMock.mockResolvedValue(mockRes(200, { ok: true }))
    const mod = await loadModule()
    await mod.sendMagicLink("a@b.com")
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body)
    expect(body.redirect).toBeNull()
  })

  it("maps 403 + reason=not_on_allow_list to notOnAllowList", async () => {
    fetchMock.mockResolvedValue(mockRes(403, { reason: "not_on_allow_list" }))
    const mod = await loadModule()
    const r = await mod.sendMagicLink("waitlist@b.com")
    expect(r).toMatchObject({ ok: false, notOnAllowList: true })
    expect(r.error).toContain("/early-access")
  })

  it("surfaces the payload error on a non-ok status", async () => {
    fetchMock.mockResolvedValue(mockRes(500, { error: "server exploded" }))
    const mod = await loadModule()
    expect(await mod.sendMagicLink("a@b.com")).toEqual({ ok: false, error: "server exploded" })
  })

  it("falls back to the generic message when a non-ok body has no error", async () => {
    fetchMock.mockResolvedValue(mockRes(502, {}, /* jsonThrows */ true))
    const mod = await loadModule()
    const r = await mod.sendMagicLink("a@b.com")
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/temporarily unavailable/i)
  })

  it("treats a 200 body with ok:false as a failure", async () => {
    fetchMock.mockResolvedValue(mockRes(200, { ok: false, error: "otp send failed" }))
    const mod = await loadModule()
    expect(await mod.sendMagicLink("a@b.com")).toEqual({ ok: false, error: "otp send failed" })
  })

  it("returns the unavailable message when fetch itself rejects", async () => {
    fetchMock.mockRejectedValue(new Error("network down"))
    vi.spyOn(console, "error").mockImplementation(() => {})
    const mod = await loadModule()
    const r = await mod.sendMagicLink("a@b.com")
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/temporarily unavailable/i)
  })
})

describe("signOut", () => {
  it("calls auth.signOut, clears the owner key, and redirects to /login", async () => {
    // Make window.location.href assignable without triggering jsdom navigation.
    const loc = { href: "" }
    Object.defineProperty(window, "location", { value: loc, writable: true })
    window.localStorage.setItem("rpc_owner_key", "someone")

    const mod = await loadModule()
    await mod.signOut()

    expect(signOutMock).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem("rpc_owner_key")).toBeNull()
    expect(loc.href).toBe("/login")
  })
})
