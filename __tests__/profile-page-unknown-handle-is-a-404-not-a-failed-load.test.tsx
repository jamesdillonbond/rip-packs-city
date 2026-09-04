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
vi.mock("next/navigation", () => ({ notFound: () => notFound() }))

const getPublicProfile = vi.fn()
vi.mock("@/lib/profile/public-profile", () => ({ getPublicProfile: (...a: unknown[]) => getPublicProfile(...a) }))

vi.mock("@/app/profile/[username]/ProfileClient", () => ({ default: () => null }))

import PublicProfilePage from "@/app/profile/[username]/page"

beforeEach(() => { notFound.mockClear(); getPublicProfile.mockReset() })

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
