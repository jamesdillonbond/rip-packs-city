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

let fetchMock: ReturnType<typeof vi.fn>
const okJson = (b: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(b) } as Response)

beforeEach(() => {
  capturedProps = null
  pathname = "/nba-top-shot/analytics"
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

  // The old fcl.currentUser fallback went with the 2026-08-08 wallet-connect
  // removal. With no connect surface it could only ever be null, so signed-out
  // must now report signed-out rather than inventing a connected wallet.
  it("reports no identity (and not connected) when /api/profile/me returns none", async () => {
    fetchMock.mockReturnValueOnce(okJson({ user: null }))
    render(<SupportChatConnected />)
    await waitFor(() => expect(capturedProps).toBeTruthy())
    expect(capturedProps.ownerKey).toBeNull()
    expect(capturedProps.userWallet).toBeNull()
    expect(capturedProps.walletConnected).toBe(false)
    expect(capturedProps.signedInLabel).toBeNull()
  })
})
