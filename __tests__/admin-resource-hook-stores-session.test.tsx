// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { useAdminResource, ADMIN_TOKEN_KEY } from "@/lib/admin/use-admin-resource"

// R134 step 2 (security audit 2026-10-25): admin pages store a 12 h signed
// session, never the master RPC_ADMIN_TOKEN. The first pass converted seven
// hand-rolled pages but missed this shared hook — eight pages (pipeline-health,
// fmv-health, beta-activity, giveaways, swap-test, trophy-campaign,
// visitor-journeys, click-purchases) kept writing the master token to
// localStorage. These cases hold the hook to the contract.

const SESSION = "rpcadm1.1900000000000.sig"
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  localStorage.clear()
  fetchMock = vi.fn(async (url: string) =>
    String(url) === "/api/admin/session"
      ? new Response(JSON.stringify({ session: SESSION }), { status: 200 })
      : new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
  )
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe("useAdminResource stores a session, never the master token", () => {
  it("sign-in exchanges the typed token and stores + sends the SESSION", async () => {
    const { result } = renderHook(() => useAdminResource<{ ok: number }>("/api/admin/x"))
    act(() => result.current.setTokenInput("master-secret"))
    act(() => result.current.submitToken())
    await waitFor(() => expect(result.current.token).toBe(SESSION))
    expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBe(SESSION)
    const dataCall = fetchMock.mock.calls.find(([u]) => String(u) === "/api/admin/x")
    expect((dataCall?.[1] as RequestInit).headers).toEqual({ Authorization: `Bearer ${SESSION}` })
  })

  it("upgrades a master token left in storage by an older build, in place", async () => {
    localStorage.setItem(ADMIN_TOKEN_KEY, "master-secret")
    const { result } = renderHook(() => useAdminResource<{ ok: number }>("/api/admin/x"))
    await waitFor(() => expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBe(SESSION))
    await waitFor(() => expect(result.current.token).toBe(SESSION))
  })

  it("if the exchange fails, sign-in still works with what was typed (no lock-out)", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url) === "/api/admin/session" ? new Response("{}", { status: 503 }) : new Response("{}", { status: 200 }),
    )
    const { result } = renderHook(() => useAdminResource<unknown>("/api/admin/x"))
    act(() => result.current.setTokenInput("master-secret"))
    act(() => result.current.submitToken())
    await waitFor(() => expect(result.current.token).toBe("master-secret"))
    // …but the master token is NEVER persisted (2026-10-27): memory only, for this page.
    expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull()
  })
})

describe("every writer of the admin token key goes through the session exchange", () => {
  const WRITE = /localStorage\.setItem\(\s*(ADMIN_TOKEN_KEY|RPC_ADMIN_TOKEN_STORAGE|["']rpc_admin_token["'])/
  const files = execFileSync("git", ["ls-files", "-z", "--", "app", "lib", "components"], { encoding: "utf8" })
    .split("\0")
    .filter((f) => /\.(ts|tsx)$/.test(f))
  const writers = files.filter((f) => WRITE.test(readFileSync(f, "utf8")))

  // Re-pinned 2026-10-27: every page now writes through lib/admin-token.ts's setAdminToken, which persists a
  // SESSION only (a failed exchange's master token is never stored), so the direct writers shrank to that file and
  // the cookie-mirroring triage page.
  it("finds the writers (not vacuous)", () => {
    expect(writers).toContain("lib/admin-token.ts")
    expect(readFileSync("lib/admin/use-admin-resource.ts", "utf8")).toMatch(/setAdminToken\(stored\)/)
  })

  it("each writer references toAdminSession / upgradeStoredAdminToken, or is lib/admin-token.ts itself", () => {
    const bad = writers.filter(
      (f) => f !== "lib/admin-token.ts" && !/toAdminSession|upgradeStoredAdminToken/.test(readFileSync(f, "utf8")),
    )
    expect(bad).toEqual([])
  })

  it("the pattern fires on the shapes it guards (planted)", () => {
    expect(WRITE.test("localStorage.setItem(ADMIN_TOKEN_KEY, t)")).toBe(true)
    expect(WRITE.test('localStorage.setItem("rpc_admin_token", t)')).toBe(true)
    expect(WRITE.test('localStorage.setItem("rpc_other", t)')).toBe(false)
  })
})
