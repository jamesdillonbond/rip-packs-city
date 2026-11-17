// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import TeamSets, { type SetRow } from "@/components/entity/TeamSets"

// Drives the Team Hub sets island: the server-provided `initial` list renders
// EDITIONS + cheapest entry; the empty state; and the localStorage-wallet path
// that refetches /api/entity/team-sets and flips to "owned / editions" + OWNED.

vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))

let fetchMock: ReturnType<typeof vi.fn>
const okJson = (b: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(b) } as Response)

const initial: SetRow[] = [
  { set_slug: "base", set_name: "Base Set", editions: 60, cheapest_entry_usd: 12, owned: null },
]

beforeEach(() => {
  window.localStorage.clear()
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("TeamSets", () => {
  it("renders the initial no-wallet list (EDITIONS + cheapest entry), no fetch", () => {
    const { getByText } = render(<TeamSets collectionUrlSlug="nba-top-shot" teamSlug="blazers" initial={initial} />)
    expect(getByText("Base Set")).toBeTruthy()
    expect(getByText("EDITIONS")).toBeTruthy()
    expect(getByText("60")).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled() // no wallet in localStorage
  })

  it("renders the empty state with no rows", () => {
    const { getByText } = render(<TeamSets collectionUrlSlug="nba-top-shot" teamSlug="blazers" initial={[]} />)
    expect(getByText("No sets yet.")).toBeTruthy()
  })

  it("with a persisted wallet, refetches and shows owned / editions + OWNED", async () => {
    window.localStorage.setItem("rpc_checklist_wallet", "0x0123456789abcdef")
    fetchMock.mockReturnValueOnce(
      okJson([{ set_slug: "base", set_name: "Base Set", editions: 60, cheapest_entry_usd: 12, owned: 45 }]),
    )
    const { getByText } = render(<TeamSets collectionUrlSlug="nba-top-shot" teamSlug="blazers" initial={initial} />)
    await waitFor(() => expect(getByText("OWNED")).toBeTruthy())
    expect(getByText("45 / 60")).toBeTruthy()
    // refetch carried the wallet
    expect(fetchMock.mock.calls[0][0]).toContain("wallet=0x0123456789abcdef")
  })
})
