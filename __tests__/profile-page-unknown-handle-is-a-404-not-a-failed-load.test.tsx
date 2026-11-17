// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest"

// /profile/<handle> for a collector who does not exist must be a 404 — never a
// profile shell that says "we couldn't load this portfolio".
//
// Until 2026-09-03 the page mapped EVERY non-ok result to `initialFailed`, so
// an unknown handle rendered "<HANDLE> · COLLECTOR", "PORTFOLIO FMV —", and
// "We couldn't load this portfolio … Refresh to try again" at HTTP 200: a load
// failure claimed about someone who is not on the platform, on an unbounded
// URL space. The trophy-case sibling already called notFound(); this pins the
// same contract on the profile page, and keeps the mirror — a 500/503 is NOT
// a 404 and must still seed initialFailed (that is the honest-failure path).

const notFound = vi.fn(() => { throw new Error("NEXT_NOT_FOUND") })
const permanentRedirect = vi.fn((to: string) => { throw new Error("NEXT_REDIRECT " + to) })
vi.mock("next/navigation", () => ({ notFound: () => notFound(), permanentRedirect: (to: string) => permanentRedirect(to) }))

const getPublicProfile = vi.fn()
vi.mock("@/lib/profile/public-profile", () => ({ getPublicProfile: (...a: unknown[]) => getPublicProfile(...a) }))

vi.mock("@/app/profile/[username]/ProfileClient", () => ({ default: () => null }))

import PublicProfilePage from "@/app/profile/[username]/page"

beforeEach(() => { notFound.mockClear(); permanentRedirect.mockClear(); getPublicProfile.mockReset() })

describe("/profile/[username] — unknown handle", () => {
  it("calls notFound() on a 404 and never seeds the client", async () => {
    getPublicProfile.mockResolvedValue({ ok: false, status: 404, error: "Not found", username: "ghost" })
    await expect(PublicProfilePage({ params: Promise.resolve({ username: "ghost" }) })).rejects.toThrow("NEXT_NOT_FOUND")
    expect(notFound).toHaveBeenCalledTimes(1)
  })

  it("CONTROL — a 503 (read did not answer) is NOT a 404: it seeds initialFailed", async () => {
    getPublicProfile.mockResolvedValue({ ok: false, status: 503, error: "bound" })
    const el = (await PublicProfilePage({ params: Promise.resolve({ username: "trevor" }) })) as any
    expect(notFound).not.toHaveBeenCalled()
    expect(el.props).toMatchObject({ initialFailed: true })
  })

  it("CONTROL — a resolved profile seeds the client with initialFailed false", async () => {
    getPublicProfile.mockResolvedValue({ ok: true, data: { username: "trevor", bio: { username: "trevor" }, trophies: [], wallets: [], wallet_count: 0 } })
    const el = (await PublicProfilePage({ params: Promise.resolve({ username: "trevor" }) })) as any
    expect(el.props).toMatchObject({ initialFailed: false, initialWalletCount: 0 })
  })
})

// 2026-10-28: /profile/<Flow address> is a fossil of two since-fixed link builders
// that Google keeps re-crawling (46 404s in Search Console). A wallet has a public
// page, so an address 308s to /share/<wallet> — but ONLY after the username lookup
// answered 404, and only for a strict 0x + 16-hex Flow address.
describe("/profile/[username] — a Flow address that is not a username", () => {
  it("308s an unknown Flow address to its /share page (lower-cased)", async () => {
    getPublicProfile.mockResolvedValue({ ok: false, status: 404, error: "Not found" })
    await expect(PublicProfilePage({ params: Promise.resolve({ username: "0xB3D0A7A2E1F4C9A1" }) })).rejects.toThrow("NEXT_REDIRECT /share/0xb3d0a7a2e1f4c9a1")
    expect(permanentRedirect).toHaveBeenCalledTimes(1)
    expect(notFound).not.toHaveBeenCalled()
  })

  it("CONTROL — a handle that resolves is never redirected, even if it looks like an address", async () => {
    getPublicProfile.mockResolvedValue({ ok: true, data: { username: "0xb3d0a7a2e1f4c9a1", bio: null, trophies: [], wallets: [], wallet_count: 0 } })
    await PublicProfilePage({ params: Promise.resolve({ username: "0xb3d0a7a2e1f4c9a1" }) })
    expect(permanentRedirect).not.toHaveBeenCalled()
  })

  it("CONTROL — not an address (wrong length, no 0x, EVM) stays an honest 404", async () => {
    getPublicProfile.mockResolvedValue({ ok: false, status: 404, error: "Not found" })
    for (const u of ["0xb3d0a7a2e1f4c9", "b3d0a7a2e1f4c9a1", "0x" + "a".repeat(40), "ghost"]) {
      await expect(PublicProfilePage({ params: Promise.resolve({ username: u }) })).rejects.toThrow("NEXT_NOT_FOUND")
    }
    expect(permanentRedirect).not.toHaveBeenCalled()
  })

  it("CONTROL — a failed read (503) for an address is NOT redirected; it seeds initialFailed", async () => {
    getPublicProfile.mockResolvedValue({ ok: false, status: 503, error: "bound" })
    const el = (await PublicProfilePage({ params: Promise.resolve({ username: "0xb3d0a7a2e1f4c9a1" }) })) as any
    expect(permanentRedirect).not.toHaveBeenCalled()
    expect(el.props).toMatchObject({ initialFailed: true })
  })
})

