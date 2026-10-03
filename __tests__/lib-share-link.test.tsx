// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"
import { walletShareUrl, shareWalletCard } from "@/lib/share-link"
import ShareButton from "@/app/share/[wallet]/ShareButton"

// The anonymous collection-card share (2026-10-03). Before this, both card
// share buttons copied a BARE url, so a visit from a shared card was the one
// share arrival lib/track-funnel.ts could not attribute; and both said
// "copied" whether or not the copy happened.

const writeText = vi.fn(() => Promise.resolve())
const share = vi.fn(() => Promise.resolve())

function setPointer(coarse: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (q: string) => ({ matches: coarse && q === "(pointer: coarse)", media: q }),
  })
}

beforeEach(() => {
  writeText.mockReset().mockImplementation(() => Promise.resolve())
  share.mockReset().mockImplementation(() => Promise.resolve())
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
  Object.defineProperty(navigator, "share", { value: share, configurable: true })
  setPointer(false)
})

afterEach(() => cleanup())

describe("walletShareUrl", () => {
  it("tags the link with the same utm vocabulary as the profile share", () => {
    expect(walletShareUrl("0xabc", "copy")).toBe(
      "https://www.rippackscity.com/share/0xabc?utm_source=share&utm_medium=copy",
    )
  })

  it("never case-folds the wallet (a Solana key is case-sensitive)", () => {
    const sol = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    expect(walletShareUrl(sol, "native")).toContain(`/share/${sol}?`)
  })

  it("encodes a username-shaped input instead of breaking the path", () => {
    expect(walletShareUrl(" a b/c ", "copy")).toContain("/share/a%20b%2Fc?")
  })
})

describe("shareWalletCard", () => {
  it("desktop (fine pointer) copies even though navigator.share exists", async () => {
    await expect(shareWalletCard("0xabc")).resolves.toBe("copied")
    expect(share).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("utm_medium=copy"))
  })

  it("touch uses the native sheet with the native medium", async () => {
    setPointer(true)
    await expect(shareWalletCard("0xabc")).resolves.toBe("shared")
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining("utm_medium=native") }),
    )
    expect(writeText).not.toHaveBeenCalled()
  })

  it("a dismissed sheet is cancelled, not silently copied", async () => {
    setPointer(true)
    share.mockImplementation(() => Promise.reject(Object.assign(new Error("x"), { name: "AbortError" })))
    await expect(shareWalletCard("0xabc")).resolves.toBe("cancelled")
    expect(writeText).not.toHaveBeenCalled()
  })

  it("a failed copy reports failed, not copied", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("denied")))
    // jsdom has no execCommand implementation, so the legacy path fails too.
    await expect(shareWalletCard("0xabc")).resolves.toBe("failed")
  })
})

describe("ShareButton", () => {
  it("shares the card's own wallet, not the page url the visitor arrived on", async () => {
    window.history.pushState({}, "", "/share/0xabc?utm_source=share&utm_medium=x")
    const { getByRole } = render(<ShareButton wallet="0xabc" />)
    fireEvent.click(getByRole("button"))
    await waitFor(() => expect(getByRole("button").textContent).toBe("Link Copied!"))
    expect(writeText).toHaveBeenCalledWith(
      "https://www.rippackscity.com/share/0xabc?utm_source=share&utm_medium=copy",
    )
  })

  it("does not claim a copy that failed", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("denied")))
    const { getByRole } = render(<ShareButton wallet="0xabc" />)
    fireEvent.click(getByRole("button"))
    await waitFor(() => expect(getByRole("button").textContent).toBe("Copy failed"))
  })
})
