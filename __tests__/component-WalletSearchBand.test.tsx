// @vitest-environment jsdom
//
// The wallet-lookup wedge's layout-level placement. What is pinned here is the
// stuff that silently breaks the MEASUREMENT rather than the render:
//   - a DISTINCT surface per placement (collection_layout / insights_layout) —
//     without this the next funnel read can't attribute which placement worked
//   - wallet_paste actually FIRES on submit (the three pre-2026-07-25 forks of
//     this input did not, which is why wallet_paste read 24 lifetime)
//   - anon visitors land on a PUBLIC route, never the auth-gated /dashboard
//   - the band is in the FIRST render pass (so it ships in the SSR HTML) and
//     suppresses itself on the routes that already are the wallet tool
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, act, fireEvent, waitFor } from "@testing-library/react"

const pushMock = vi.fn()
let mockPath = "/nba-top-shot/edition/223:7506::19"

vi.mock("next/navigation", () => ({
  usePathname: () => mockPath,
  useRouter: () => ({ push: pushMock }),
}))

const trackMock = vi.fn()
vi.mock("@/lib/track-funnel", () => ({
  trackFunnelEvent: (...a: unknown[]) => trackMock(...a),
}))

// Auth. The band is an ANON acquisition affordance: a signed-in collector
// already has a wallet on their account, so the band must not render for them.
// `throws` reproduces a browser client that cannot be constructed (missing env)
// and `rejects` a failed getUser() — in BOTH the band must stay up, because
// hiding an entry point on a FAILED read would publish "we know who you are"
// out of an error.
const auth = vi.hoisted(() => ({
  user: null as { id: string } | null,
  rejects: false,
  throws: false,
  onChange: null as ((e: string, s: { user?: unknown } | null) => void) | null,
}))

vi.mock("@/lib/auth/supabase-client", () => ({
  getSupabaseBrowser: () => {
    if (auth.throws) throw new Error("no browser client")
    return {
      auth: {
        getUser: async () => {
          if (auth.rejects) throw new Error("auth read failed")
          return { data: { user: auth.user } }
        },
        onAuthStateChange: (cb: (e: string, s: { user?: unknown } | null) => void) => {
          auth.onChange = cb
          return { data: { subscription: { unsubscribe: () => {} } } }
        },
      },
    }
  },
}))

import WalletSearchBand from "@/components/WalletSearchBand"

function typeAndSubmit(container: HTMLElement, value: string) {
  const input = container.querySelector("input") as HTMLInputElement
  const form = container.querySelector("form") as HTMLFormElement
  // fireEvent.change goes through React's synthetic value tracker; assigning
  // .value and dispatching a raw event is de-duped by React and never lands.
  fireEvent.change(input, { target: { value } })
  fireEvent.submit(form)
}

beforeEach(() => {
  pushMock.mockReset()
  trackMock.mockReset()
  localStorage.clear()
  mockPath = "/nba-top-shot/edition/223:7506::19"
  auth.user = null
  auth.rejects = false
  auth.throws = false
  auth.onChange = null
})
afterEach(cleanup)

describe("WalletSearchBand", () => {
  it("renders the lookup input on a collection tab that is not /overview", () => {
    const { container } = render(<WalletSearchBand scope="collection" collectionId="nba-top-shot" />)
    // edition/* is 51% of collection_view — the placement exists for this case.
    expect(container.querySelector("input")).toBeTruthy()
    expect(container.querySelector("[data-rpc-wallet-band='collection']")).toBeTruthy()
  })

  it("is present on the FIRST render pass so it ships in the server HTML", () => {
    // A wallet in localStorage must NOT remove the band before hydration —
    // the deferred check is what keeps the entry point in the delivered HTML.
    localStorage.setItem("rpc_last_wallet", "0xbd94cade097e50ac")
    const { container } = render(<WalletSearchBand scope="collection" collectionId="nba-top-shot" />)
    expect(container.querySelector("input")).toBeTruthy()
  })

  it("emits wallet_paste with surface=collection_layout and routes anon to PUBLIC /share", () => {
    const { container } = render(<WalletSearchBand scope="collection" collectionId="nba-top-shot" />)
    typeAndSubmit(container, "0xbd94cade097e50ac")

    expect(trackMock).toHaveBeenCalledWith({
      eventType: "wallet_paste",
      walletAddress: "0xbd94cade097e50ac",
      surface: "collection_layout",
    })
    expect(pushMock).toHaveBeenCalledWith("/share/0xbd94cade097e50ac")
    // Regression guard: the block this replaced pushed anon visitors at the
    // auth-gated /dashboard, bouncing the #1 CTA to /login.
    expect(pushMock.mock.calls.flat().join(" ")).not.toContain("/dashboard")
  })

  it("uses a DISTINCT surface for the insights placement and the deep public report", () => {
    mockPath = "/insights/first-mint"
    const { container } = render(<WalletSearchBand scope="insights" />)
    typeAndSubmit(container, "0xbd94cade097e50ac")

    expect(trackMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "wallet_paste", surface: "insights_layout" })
    )
    expect(pushMock).toHaveBeenCalledWith("/insights/tc-report?wallet=0xbd94cade097e50ac")
  })

  it("keeps the two placements' surfaces attributable (they must not collide)", () => {
    const a = render(<WalletSearchBand scope="collection" collectionId="nba-top-shot" />)
    typeAndSubmit(a.container, "0x1111111111111111")
    cleanup()
    mockPath = "/insights/squeeze"
    const b = render(<WalletSearchBand scope="insights" />)
    typeAndSubmit(b.container, "0x2222222222222222")

    const surfaces = trackMock.mock.calls.map((c) => (c[0] as { surface: string }).surface)
    expect(new Set(surfaces).size).toBe(surfaces.length)
    expect(surfaces).toEqual(["collection_layout", "insights_layout"])
  })

  it("stashes the wallet so the in-app tabs hydrate it", () => {
    const { container } = render(<WalletSearchBand scope="collection" collectionId="nba-top-shot" />)
    typeAndSubmit(container, "0xbd94cade097e50ac")
    expect(localStorage.getItem("rpc_last_wallet")).toBe("0xbd94cade097e50ac")
    expect(localStorage.getItem("rpc_collection_last_wallet")).toBe("0xbd94cade097e50ac")
  })

  it.each([
    "/insights",
    "/insights/account-value",
    "/insights/tc-report",
    "/insights/squeeze-check",
  ])("suppresses itself on %s, which already is the wallet tool", (p) => {
    mockPath = p
    const { container } = render(<WalletSearchBand scope="insights" />)
    // No second box on a surface whose own hero/page IS the lookup.
    expect(container.querySelector("input")).toBeNull()
  })

  it("hides itself after hydration once a wallet is already known", async () => {
    vi.useFakeTimers()
    localStorage.setItem("rpc_collection_last_wallet", "0xbd94cade097e50ac")
    const { container } = render(<WalletSearchBand scope="collection" collectionId="nba-top-shot" />)
    expect(container.querySelector("input")).toBeTruthy()
    await act(async () => {
      vi.runAllTimers()
    })
    expect(container.querySelector("input")).toBeNull()
    vi.useRealTimers()
  })

  it("renders NOTHING for a signed-in visitor — we already know their wallet", async () => {
    auth.user = { id: "u1" }
    const { container } = render(<WalletSearchBand scope="collection" collectionId="nba-top-shot" />)
    await waitFor(() => expect(container.querySelector("input")).toBeNull())
    // Assert the ABSENCE of the whole section, not just of the input: the copy
    // ("What's your collection worth?") is the half the user asked to remove.
    expect(container.querySelector("[data-rpc-wallet-band]")).toBeNull()
    expect(container.textContent ?? "").not.toContain("collection worth")
  })

  it("renders nothing for a signed-in visitor on the insights placement too", async () => {
    auth.user = { id: "u1" }
    mockPath = "/insights/first-mint"
    const { container } = render(<WalletSearchBand scope="insights" />)
    await waitFor(() => expect(container.querySelector("input")).toBeNull())
  })

  it("re-appears when that session ends", async () => {
    auth.user = { id: "u1" }
    const { container } = render(<WalletSearchBand scope="collection" collectionId="nba-top-shot" />)
    await waitFor(() => expect(container.querySelector("input")).toBeNull())
    act(() => {
      auth.onChange?.("SIGNED_OUT", null)
    })
    await waitFor(() => expect(container.querySelector("input")).toBeTruthy())
  })

  it("KEEPS the band when the auth read FAILS (a failed read is not a session)", async () => {
    auth.rejects = true
    const { container } = render(<WalletSearchBand scope="collection" collectionId="nba-top-shot" />)
    await waitFor(() => expect(container.querySelector("input")).toBeTruthy())
    // and again when the browser client itself cannot be constructed
    cleanup()
    auth.rejects = false
    auth.throws = true
    const b = render(<WalletSearchBand scope="collection" collectionId="nba-top-shot" />)
    await waitFor(() => expect(b.container.querySelector("input")).toBeTruthy())
  })

  it("keeps the touch target at or above the 44px mobile minimum (§9)", () => {
    const { container } = render(<WalletSearchBand scope="collection" collectionId="nba-top-shot" />)
    const form = container.querySelector("form") as HTMLFormElement
    expect(parseInt(form.style.height, 10)).toBeGreaterThanOrEqual(44)
  })

  it("keeps the input's flex in CSS, not inline — inline, a 300px BASIS becomes a 300px HEIGHT", () => {
    // MEASURED 2026-08-22, Chromium at 390x844: the band rendered 350px tall
    // because the input wrapper carried style={{flex:"1 1 300px"}}. flex-basis
    // sizes the MAIN axis, the <=640px rule below flips that axis from width to
    // height, and a media query cannot override an inline style. 102px after.
    const { container } = render(<WalletSearchBand scope="collection" collectionId="nba-top-shot" />)
    const wrapper = container.querySelector(".rpc-wsb-input") as HTMLElement
    expect(wrapper).toBeTruthy()
    // Assert the ABSENCE of the unoverridable declaration, in either spelling.
    expect(wrapper.style.flex).toBe("")
    expect(wrapper.style.flexBasis).toBe("")
    // maxWidth is breakpoint-INDEPENDENT, so it legitimately stays inline.
    expect(wrapper.style.maxWidth).toBe("420px")
  })

  it("ships the mobile override that the CSS move exists for", () => {
    const { container } = render(<WalletSearchBand scope="collection" collectionId="nba-top-shot" />)
    const css = (container.querySelector("style")?.textContent ?? "").replace(/\s+/g, "")
    // Row layout keeps the grow/shrink/basis it always had…
    expect(css).toContain(".rpc-wsb-input{flex:11300px;}")
    // …and the column layout must neutralise the basis. Pinned INSIDE the
    // media block, not anywhere in the sheet: outside it the rule is inert.
    const mobile = css.slice(css.indexOf("@media(max-width:640px){"))
    expect(mobile).toContain(".rpc-wsb-input{flex:00auto;}")
  })

  it("uses no literal hex and no literal font-family strings (§0)", () => {
    const { container } = render(<WalletSearchBand scope="collection" collectionId="nba-top-shot" />)
    const html = container.innerHTML
    // #fff on the red CTA is the documented brand-exception in WalletSearch.
    const hexes = (html.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).filter(
      (h) => h.toLowerCase() !== "#fff"
    )
    expect(hexes).toEqual([])
    expect(html).not.toContain("Barlow Condensed")
    expect(html).not.toContain("Share Tech Mono")
  })
})
