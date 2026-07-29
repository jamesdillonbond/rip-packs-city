// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import SupportChatConnected from "@/components/SupportChatConnected"

// Drives the concierge wiring wrapper: it derives collectionId/pageContext from
// the pathname, fetches the canonical identity from /api/profile/me, and passes
// the resolved props down to SupportChat (username-preferred ownerKey +
// signed-in label). SupportChat is stubbed to capture its props.

let capturedProps: any = null
vi.mock("@/components/SupportChat", () => ({
  default: (props: any) => {
    capturedProps = props
    return <div data-testid="support-chat" />
  },
}))
let pathname = "/nba-top-shot/analytics"
vi.mock("next/navigation", () => ({ usePathname: () => pathname }))
let flowUser: any = { addr: null, loggedIn: false }
vi.mock("@/lib/hooks/useFlowUser", () => ({ useFlowUser: () => ({ user: flowUser }) }))

let fetchMock: ReturnType<typeof vi.fn>
const okJson = (b: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(b) } as Response)

beforeEach(() => {
  capturedProps = null
  pathname = "/nba-top-shot/analytics"
  flowUser = { addr: null, loggedIn: false }
  fetchMock = vi.fn(() => okJson({}))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("SupportChatConnected", () => {
  it("derives pageContext + collectionId from the pathname and mounts SupportChat", async () => {
    render(<SupportChatConnected />)
    await waitFor(() => expect(capturedProps).toBeTruthy())
    expect(capturedProps.collectionId).toBe("nba-top-shot")
    expect(capturedProps.pageContext).toBe("analytics (nba-top-shot)")
    expect(fetchMock).toHaveBeenCalledWith("/api/profile/me", expect.objectContaining({ credentials: "include" }))
  })

  it("passes the resolved identity down (username-preferred ownerKey + signed-in label)", async () => {
    fetchMock.mockReturnValueOnce(
      okJson({ user: { email: "me@x.com", username: "whale", wallet_addr: "0xabc" } }),
    )
    render(<SupportChatConnected />)
    await waitFor(() => expect(capturedProps?.signedInLabel).toBe("whale"))
    expect(capturedProps.ownerKey).toBe("whale") // username preferred over addr
    expect(capturedProps.userWallet).toBe("0xabc")
    expect(capturedProps.walletConnected).toBe(true) // has email → signed in
  })

  it("falls back to the Flow address when no identity is returned", async () => {
    flowUser = { addr: "0xdead", loggedIn: true }
    fetchMock.mockReturnValueOnce(okJson({ user: null }))
    render(<SupportChatConnected />)
    await waitFor(() => expect(capturedProps).toBeTruthy())
    await waitFor(() => expect(capturedProps.ownerKey).toBe("0xdead"))
    expect(capturedProps.walletConnected).toBe(true) // user.loggedIn
  })
})
