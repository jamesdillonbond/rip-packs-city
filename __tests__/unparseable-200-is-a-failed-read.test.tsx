// @vitest-environment jsdom
//
// 2026-11-02: a 200 whose body does not parse (a truncated response, an HTML
// error page served 200 by an edge) is a FAILED read. Five client sites turned
// `res.json().catch(() => null)` into an ANSWER because they discriminated only on
// `res.ok`:
//   - WalletSoldMomentsView: "No moments sold from this wallet" + a $0.00 proceeds tile
//   - WalletPacksView:       "No sealed packs held in …"
//   - FmvDashboard:          "No pipeline data available." (any failed health read)
//   - WalletSearch / ShareEmptyState: "Couldn't find that username" (a claim about the
//     username, made without having read anything)
// Each test asserts the ABSENCE of the false claim, not merely the presence of an error.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"

let urlWallet: string | null = "0xabc0000000000001"
const pushMock = vi.fn()
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: (k: string) => (k === "wallet" ? urlWallet : null) }),
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}))
vi.mock("@/lib/owner-key", () => ({ getOwnerKey: () => "" }))
vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))
vi.mock("@/lib/track-funnel", () => ({ trackFunnelEvent: () => {} }))

import WalletSoldMomentsView from "@/components/collection/WalletSoldMomentsView"
import WalletPacksView from "@/components/packs/WalletPacksView"
import FmvDashboard from "@/components/analytics/FmvDashboard"
import WalletSearch from "@/components/WalletSearch"
import ShareEmptyState from "@/app/share/[wallet]/ShareEmptyState"

const unparseable200 = () =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.reject(new SyntaxError("Unexpected token <")),
    text: () => Promise.resolve("<html>"),
  } as unknown as Response)

beforeEach(() => {
  urlWallet = "0xabc0000000000001"
  pushMock.mockReset()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("a 200 with an unparseable body is a failed read, not an answer", () => {
  it("WalletSoldMomentsView: no 'No moments sold' and no $0.00", async () => {
    vi.stubGlobal("fetch", vi.fn(unparseable200))
    const { container, getByText } = render(<WalletSoldMomentsView collection="nba-top-shot" />)
    await waitFor(() => expect(getByText("Failed to load sold moments")).toBeTruthy())
    expect(container.textContent).not.toContain("No moments sold")
    expect(container.textContent).not.toContain("$0.00")
  })

  it("WalletPacksView: no 'No sealed packs held' empty state", async () => {
    vi.stubGlobal("fetch", vi.fn(unparseable200))
    const { container, getByText } = render(<WalletPacksView collection="nba-top-shot" />)
    await waitFor(() => expect(getByText("Failed to load pack history")).toBeTruthy())
    expect(container.textContent).not.toMatch(/No sealed packs held|No marketplace pack sales/)
  })

  it("FmvDashboard: a failed health read does not say 'No pipeline data available.'", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) =>
      String(u).includes("/fmv/health")
        ? ({ ok: false, status: 503, json: async () => ({ error: "down" }) } as any)
        : ({ ok: true, status: 200, json: async () => ({ rows: [] }) } as any),
    ))
    const { container, findByText } = render(<FmvDashboard />)
    await findByText("Couldn't load pipeline health right now.")
    expect(container.textContent).not.toContain("No pipeline data available.")
  })

  it("FmvDashboard no-change control: a healthy-but-empty read still says 'No pipeline data available.'", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) =>
      ({ ok: true, status: 200, json: async () => (String(u).includes("/fmv/health") ? { collections: {} } : { rows: [] }) }) as any,
    ))
    const { findByText } = render(<FmvDashboard />)
    await findByText("No pipeline data available.")
  })

  it("WalletSearch: does not claim the username was not found", async () => {
    vi.stubGlobal("fetch", vi.fn(unparseable200))
    const { container, findByText } = render(<WalletSearch surface="t" />)
    fireEvent.change(container.querySelector("input")!, { target: { value: "somecollector" } })
    fireEvent.submit(container.querySelector("form")!)
    await findByText(/Couldn't search just now/)
    expect(container.textContent).not.toMatch(/Couldn't find that username/)
    expect(pushMock).not.toHaveBeenCalled()
  })

  it("ShareEmptyState: does not claim the username was not found", async () => {
    vi.stubGlobal("fetch", vi.fn(unparseable200))
    const { container, findByText } = render(<ShareEmptyState wallet="not-a-wallet" />)
    const form = container.querySelector("form")!
    fireEvent.change(form.querySelector("input")!, { target: { value: "somecollector" } })
    fireEvent.submit(form)
    await findByText(/Couldn't search just now/)
    expect(container.textContent).not.toMatch(/Couldn't find that\./)
  })
})
