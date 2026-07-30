// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import SignInWithDapper from "@/components/SignInWithDapper"

// Drives the Dapper sign-in CTA's run() flow: the Dapper-custodied "no addr"
// guidance, the happy link path (fcl auth → POST /api/auth/fcl-verify → onSuccess
// + rpc_owner_key persisted), and the verify-failure path (error shown +
// fcl.unauthenticate called). fcl / fcl-config / supabase-client are stubbed.

const authenticate = vi.fn()
const unauthenticate = vi.fn(() => Promise.resolve())
vi.mock("@onflow/fcl", () => ({ authenticate: (...a: any[]) => authenticate(...a), unauthenticate: () => unauthenticate() }))
// configureFcl is the single owner of FCL wallet discovery; the component calls it
// with intent "sign-in" (self-custody). configureFclAuth is its back-compat alias.
vi.mock("@/lib/chains/flow/fcl-config", () => ({
  configureFcl: vi.fn(),
  configureFclAuth: vi.fn(),
}))
vi.mock("@/lib/auth/supabase-client", () => ({
  getSupabaseBrowser: () => ({ auth: { verifyOtp: vi.fn(() => Promise.resolve({ error: null })) } }),
}))

let fetchMock: ReturnType<typeof vi.fn>
const okJson = (b: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(b) } as Response)

// A user object carrying a valid account-proof service.
const userWithProof = (addr: string) => ({
  addr,
  services: [{ type: "account-proof", data: { nonce: "n1", signatures: ["s1"] } }],
})

beforeEach(() => {
  window.localStorage.clear()
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
  // window.location.reload isn't implemented in jsdom; no-op it for the success path.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload: vi.fn(), href: "http://localhost/" },
  })
  authenticate.mockReset()
  unauthenticate.mockClear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("SignInWithDapper", () => {
  it("surfaces actionable guidance when the wallet returns no address (Dapper-custodied)", async () => {
    authenticate.mockResolvedValueOnce({ addr: undefined })
    const { getByText } = render(<SignInWithDapper />)
    fireEvent.click(getByText("Sign in with Dapper"))
    await waitFor(() => expect(getByText(/Dapper wallets can't connect here yet/)).toBeTruthy())
    expect(fetchMock).not.toHaveBeenCalled()
    expect(unauthenticate).toHaveBeenCalled() // cleanup on failure
  })

  it("happy link path: verifies, calls onSuccess, and persists rpc_owner_key", async () => {
    authenticate.mockResolvedValueOnce(userWithProof("0xabc"))
    fetchMock.mockReturnValueOnce(okJson({ mode: "linked" }))
    const onSuccess = vi.fn()
    const { getByText } = render(<SignInWithDapper onSuccess={onSuccess} />)
    fireEvent.click(getByText("Sign in with Dapper"))
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("0xabc"))
    expect(window.localStorage.getItem("rpc_owner_key")).toBe("0xabc")
    // POSTed the account proof
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.addr).toBe("0xabc")
    expect(body.accountProof.nonce).toBe("n1")
  })

  it("verify failure: shows the server error and does not call onSuccess", async () => {
    authenticate.mockResolvedValueOnce(userWithProof("0xabc"))
    fetchMock.mockReturnValueOnce(
      Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: "nonce expired" }) } as Response),
    )
    const onSuccess = vi.fn()
    const { getByText } = render(<SignInWithDapper onSuccess={onSuccess} />)
    fireEvent.click(getByText("Sign in with Dapper"))
    await waitFor(() => expect(getByText("nonce expired")).toBeTruthy())
    expect(onSuccess).not.toHaveBeenCalled()
    expect(unauthenticate).toHaveBeenCalled()
  })
})
