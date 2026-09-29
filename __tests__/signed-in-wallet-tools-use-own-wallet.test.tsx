// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, screen } from "@testing-library/react"
import SqueezeCheckPage from "@/app/insights/squeeze-check/page"
import TcReportPage from "@/app/insights/tc-report/page"
import AccountValueSearch from "@/components/insights/AccountValueSearch"
import InsightsWalletSearch from "@/components/insights/InsightsWalletSearch"
import { ownFlowWalletFrom } from "@/lib/hooks/useOwnFlowWallet"

// 2026-09-28 (Trevor: "redundant and unnecessary since I'm signed in"). A
// signed-in reader with a linked Flow wallet is never asked to paste their own
// wallet: squeeze-check and tc-report load it, account-value links to it. The
// input stays on each — these tools check ANY wallet. Signed out, no linked
// wallet, or an unreadable identity → the old empty box, never a guessed wallet.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/insights",
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("next/link", () => ({
  default: ({ children, href, ...p }: any) => <a href={typeof href === "string" ? href : "#"} {...p}>{children}</a>,
}))

const OWN = "0x1111222233334444"
const OTHER = "0xbd94cade097e50ac"
const res = (ok: boolean, body: unknown) =>
  Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body } as Response)

function stub(me: () => Promise<Response>) {
  const f = vi.fn((url: string) => {
    if (String(url).includes("/api/profile/me")) return me()
    return res(false, { error: "not under test" })
  })
  vi.stubGlobal("fetch", f)
  return f
}
const signedIn = (wallet_addr: string | null) => () => res(true, { user: { id: "u1", wallet_addr } })
const signedOut = () => res(true, { user: null })
const apiCalls = (f: ReturnType<typeof vi.fn>, path: string) =>
  f.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(path))

beforeEach(() => window.history.replaceState({}, "", "/insights"))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe("ownFlowWalletFrom", () => {
  it("accepts a Flow address (folded), refuses anything else", () => {
    expect(ownFlowWalletFrom("0xABCDEF0123456789")).toBe("0xabcdef0123456789")
    expect(ownFlowWalletFrom(null)).toBeNull()
    expect(ownFlowWalletFrom("")).toBeNull()
    expect(ownFlowWalletFrom("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")).toBeNull()
    expect(ownFlowWalletFrom("0x1234")).toBeNull()
  })
})

for (const [name, Page, path] of [
  ["squeeze-check", SqueezeCheckPage, "/api/public/insights/squeeze-check"],
  ["tc-report", TcReportPage, "/api/public/insights/tc-report"],
] as const) {
  describe(`/insights/${name}`, () => {
    it("signed in: loads your own wallet with no paste", async () => {
      const f = stub(signedIn(OWN))
      render(<Page />)
      await waitFor(() => expect(apiCalls(f, path).some((u) => u.includes(`wallet=${OWN}`))).toBe(true))
      expect((screen.getByLabelText(/Flow wallet address/i) as HTMLInputElement).value).toBe(OWN)
      // Assumed, never announced (Trevor 2026-09-29).
      expect(document.body.textContent).not.toMatch(/Showing your wallet/)
    })
    it("a ?wallet= in the URL wins over your own", async () => {
      window.history.replaceState({}, "", `/insights/${name}?wallet=${OTHER}`)
      const f = stub(signedIn(OWN))
      render(<Page />)
      await waitFor(() => expect(apiCalls(f, path).some((u) => u.includes(`wallet=${OTHER}`))).toBe(true))
      await waitFor(() => expect(apiCalls(f, "/api/profile/me").length).toBeGreaterThan(0))
      await new Promise((r) => setTimeout(r, 20))
      expect(apiCalls(f, path).some((u) => u.includes(`wallet=${OWN}`))).toBe(false)
    })
    it("signed out, no linked wallet, or a failed identity read: nothing is auto-loaded", async () => {
      for (const me of [signedOut, signedIn(null), () => res(false, null)]) {
        const f = stub(me)
        const { unmount } = render(<Page />)
        await waitFor(() => expect(apiCalls(f, "/api/profile/me").length).toBe(1))
        await new Promise((r) => setTimeout(r, 20))
        expect(apiCalls(f, path)).toEqual([])
        unmount()
      }
    })
  })
}

describe("/insights/account-value", () => {
  it("signed in: a one-click link to your own value card", async () => {
    stub(signedIn(OWN))
    render(<AccountValueSearch />)
    const link = await screen.findByText(/See your account's value/)
    expect(link.closest("a")?.getAttribute("href")).toBe(`/share/${OWN}`)
  })
  it("signed out: no link", async () => {
    const f = stub(signedOut)
    render(<AccountValueSearch />)
    await waitFor(() => expect(apiCalls(f, "/api/profile/me").length).toBe(1))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText(/See your account's value/)).toBeNull()
  })
})

describe("/insights hub", () => {
  it("signed in: 'Run your own report' links to YOUR tc-report", async () => {
    stub(signedIn(OWN))
    render(<InsightsWalletSearch />)
    const link = await screen.findByText(/Run your own report/)
    expect(link.closest("a")?.getAttribute("href")).toBe(`/insights/tc-report?wallet=${OWN}`)
  })
  it("signed out or unreadable identity: no link, the box is the only entry", async () => {
    for (const me of [signedOut, () => res(false, null)]) {
      const f = stub(me)
      const { unmount } = render(<InsightsWalletSearch />)
      await waitFor(() => expect(apiCalls(f, "/api/profile/me").length).toBe(1))
      await new Promise((r) => setTimeout(r, 20))
      expect(screen.queryByText(/Run your own report/)).toBeNull()
      unmount()
    }
  })
})
