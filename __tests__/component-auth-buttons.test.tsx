// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"

// Covers the auth component subtree (siblings of the already-tested
// SignInWithDapper): ConnectButton (FCL connect/disconnect pill), ProBadge
// (Pro/Founding gating), and SignOutButton (the header identity dropdown). The
// underlying FCL/Supabase hooks are mocked — these tests pin the components'
// OWN branch logic (loading vs signed-in vs signed-out, plan labels, the
// email-initials + dropdown state machine).

const flowUser = vi.hoisted(() => ({
  user: { addr: null as string | null, loggedIn: false, walletProvider: "unknown" },
  logIn: vi.fn(),
  logOut: vi.fn(),
  isLoading: false,
}))
const proStatus = vi.hoisted(() => ({ isPro: false, plan: null as string | null, daysRemaining: 0, loading: false }))
const signOutMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/hooks/useFlowUser", () => ({ useFlowUser: () => flowUser }))
vi.mock("@/lib/hooks/useProStatus", () => ({ useProStatus: () => proStatus }))
vi.mock("@/lib/auth/supabase-client", () => ({ signOut: signOutMock }))

import { ConnectButton } from "@/components/auth/ConnectButton"
import { ProBadge } from "@/components/auth/ProBadge"
import SignOutButton from "@/components/auth/SignOutButton"

const okJson = (b: unknown) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(b) } as Response)

beforeEach(() => {
  flowUser.user = { addr: null, loggedIn: false, walletProvider: "unknown" }
  flowUser.isLoading = false
  flowUser.logIn.mockClear()
  flowUser.logOut.mockClear()
  proStatus.isPro = false
  proStatus.plan = null
  signOutMock.mockClear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("ConnectButton", () => {
  it("shows a loading skeleton while FCL initialises", () => {
    flowUser.isLoading = true
    const { container } = render(<ConnectButton />)
    expect(container.querySelector(".animate-pulse")).toBeTruthy()
  })

  it("renders Connect Wallet and calls logIn when signed out", () => {
    const { getByText } = render(<ConnectButton />)
    const btn = getByText("Connect Wallet")
    fireEvent.click(btn)
    expect(flowUser.logIn).toHaveBeenCalledTimes(1)
  })

  it("renders the shortened address and calls logOut when signed in", () => {
    flowUser.user = { addr: "0x1234567890abcdef", loggedIn: true, walletProvider: "dapper" }
    const { getByTitle } = render(<ConnectButton />)
    const btn = getByTitle("Click to disconnect")
    expect(btn.textContent).toContain("0x1234")
    expect(btn.textContent).toContain("cdef")
    fireEvent.click(btn)
    expect(flowUser.logOut).toHaveBeenCalledTimes(1)
  })
})

describe("ProBadge", () => {
  it("renders nothing for a non-Pro user", () => {
    const { container } = render(<ProBadge />)
    expect(container.textContent).toBe("")
  })

  it("renders PRO for a standard Pro plan", () => {
    proStatus.isPro = true
    proStatus.plan = "monthly"
    const { getByTitle } = render(<ProBadge />)
    expect(getByTitle("RPC Pro").textContent).toBe("PRO")
  })

  it("renders FOUNDING for a founding plan", () => {
    proStatus.isPro = true
    proStatus.plan = "founding"
    const { getByTitle } = render(<ProBadge />)
    expect(getByTitle("Founding Member").textContent).toBe("FOUNDING")
  })
})

describe("SignOutButton", () => {
  it("renders a Sign In link when there is no session email", async () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(okJson({ user: null })))
    const { findByText } = render(<SignOutButton />)
    const link = await findByText("Sign In")
    expect(link.getAttribute("href")).toBe("/login")
  })

  it("shows the email initials and opens a dropdown with Sign Out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValueOnce(okJson({ user: { email: "trevor.bond@example.com" } })),
    )
    const { findByTitle, getByRole, getByText } = render(<SignOutButton />)
    const pill = await findByTitle("trevor.bond@example.com")
    // initials = first letters of the two dot-separated local parts, uppercased
    expect(pill.textContent).toContain("TB")

    fireEvent.click(pill)
    getByRole("menu") // dropdown opened
    fireEvent.click(getByText("Sign Out"))
    expect(signOutMock).toHaveBeenCalledTimes(1)
  })

  it("degrades to Sign In (no crash) when /api/profile/me fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(Promise.reject(new Error("net"))))
    const { findByText } = render(<SignOutButton />)
    await waitFor(() => expect(findByText("Sign In")).resolves.toBeTruthy())
  })
})
