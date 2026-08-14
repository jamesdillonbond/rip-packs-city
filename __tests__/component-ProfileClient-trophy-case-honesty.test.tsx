// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

// ─────────────────────────────────────────────────────────────────────────────
// /profile/<username> — an unreadable trophy case must not render as an empty one.
//
// The public profile renders an empty slab list as "No trophies pinned yet."
// Until 2026-08-13 the fetch collapsed a non-ok response AND a thrown network
// error into that same empty list, so a momentary DB blip told every visitor
// that a collector with a full case had pinned nothing — a claim about that
// person, manufactured from our own outage, on the page they share and the
// section this page is built around.
//
// Both directions are asserted. Over-correcting is its own defect: if a genuine
// zero-trophy profile started claiming an error, every new collector's page
// would look broken instead of new.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({ useParams: () => ({ username: "trevor" }) }))
vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))
vi.mock("@/components/RpcLogo", () => ({ default: () => <div /> }))
vi.mock("@/components/profile/CostBasisCard", () => ({ default: () => <div /> }))
vi.mock("@/components/profile/TopMoversCard", () => ({ default: () => <div /> }))
vi.mock("@/components/profile/CollectionBreakdownCard", () => ({ default: () => <div /> }))
vi.mock("@/components/profile/PublicAchievements", () => ({ default: () => <div /> }))
vi.mock("@/components/profile/ShareProfileButtons", () => ({ default: () => <div /> }))
vi.mock("@/components/profile/FollowButton", () => ({ default: () => <div /> }))
vi.mock("@/components/TrophySlab", () => ({
  default: ({ slab }: any) => <div data-testid="slab">{slab?.player_name ?? "empty"}</div>,
}))

import ProfileClient from "@/app/profile/[username]/ProfileClient"

const SLAB = {
  id: 1,
  slot: 1,
  moment_id: "m1",
  player_name: "Damian Lillard",
  tier: "LEGENDARY",
  note: null,
}

/** Routes every profile fetch; only the trophy-slabs leg varies per case. */
function installFetch(slabs: { status: number; body?: unknown } | "throw") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes("/api/profile/trophy-slabs")) {
        if (slabs === "throw") throw new Error("network down")
        return {
          ok: slabs.status < 400,
          status: slabs.status,
          json: async () => slabs.body ?? {},
        } as never
      }
      return { ok: true, status: 200, json: async () => ({}) } as never
    }),
  )
}

beforeEach(() => vi.stubGlobal("scrollTo", vi.fn()))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("public profile — trophy case", () => {
  it("says the case could not be LOADED when the read 503s", async () => {
    installFetch({ status: 503 })
    const { container } = render(<ProfileClient />)
    await waitFor(() => expect(container.textContent).toMatch(/Couldn’t load this trophy case/i))
    expect(container.textContent).not.toMatch(/No trophies pinned yet/i)
  })

  it("says the same when the fetch throws outright", async () => {
    // A thrown transport failure and a non-ok response are different code
    // paths; only one of them was ever going to be remembered.
    installFetch("throw")
    const { container } = render(<ProfileClient />)
    await waitFor(() => expect(container.textContent).toMatch(/Couldn’t load this trophy case/i))
  })

  it("still says NO TROPHIES for a collector who has genuinely pinned none", async () => {
    installFetch({ status: 200, body: { slabs: [] } })
    const { container } = render(<ProfileClient />)
    await waitFor(() => expect(container.textContent).toMatch(/No trophies pinned yet/i))
    expect(container.textContent).not.toMatch(/Couldn’t load/i)
  })

  it("renders the trophies when the read succeeds", async () => {
    installFetch({ status: 200, body: { slabs: [SLAB] } })
    const { container } = render(<ProfileClient />)
    await waitFor(() => expect(container.textContent).toContain("Damian Lillard"))
    expect(container.textContent).not.toMatch(/Couldn’t load|No trophies pinned/i)
  })

  it("withholds the N / 6 count when the case could not be read", async () => {
    // "0 / 6 TROPHY MOMENTS" is a measurement. Printing it from a read we never
    // completed states something we do not know, in the profile's subtitle.
    installFetch({ status: 503 })
    const { container } = render(<ProfileClient />)
    await waitFor(() => expect(container.textContent).toMatch(/Couldn’t load this trophy case/i))
    expect(container.textContent).not.toMatch(/0 \/ 6 TROPHY MOMENTS/i)
  })

  it("prints the count once the case really is read as empty", async () => {
    installFetch({ status: 200, body: { slabs: [] } })
    const { container } = render(<ProfileClient />)
    await waitFor(() => expect(container.textContent).toMatch(/0 \/ 6 TROPHY MOMENTS/i))
  })
})
