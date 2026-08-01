// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

// AutoSearchReader auto-loads a wallet on mount: URL params take precedence
// (?wallet > ?address > legacy ?q), else it falls back to the signed-in user's
// saved wallet for the collection. A regression in that precedence would load
// the wrong wallet (or none).

let params = new URLSearchParams()
vi.mock("next/navigation", () => ({
  useSearchParams: () => params,
}))

const savedWalletMock = vi.fn()
vi.mock("@/lib/profile/saved-wallet-for-collection", () => ({
  fetchSavedWalletForCollection: (slug: string) => savedWalletMock(slug),
}))

import AutoSearchReader from "@/components/collection/AutoSearchReader"

beforeEach(() => {
  params = new URLSearchParams()
  savedWalletMock.mockReset()
  savedWalletMock.mockResolvedValue(null)
})
afterEach(() => cleanup())

describe("AutoSearchReader", () => {
  it("uses ?wallet= first and does NOT hit the saved-wallet fallback", async () => {
    params = new URLSearchParams({ wallet: " 0xWALLET ", address: "0xADDR", q: "0xQ" })
    const onSearch = vi.fn()
    render(<AutoSearchReader onSearch={onSearch} collectionSlug="nba-top-shot" />)
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith("0xWALLET")) // trimmed
    expect(savedWalletMock).not.toHaveBeenCalled()
  })

  it("falls back to ?address= then legacy ?q=", async () => {
    params = new URLSearchParams({ address: "0xADDR" })
    const onSearch1 = vi.fn()
    const { unmount } = render(<AutoSearchReader onSearch={onSearch1} collectionSlug="ufc" />)
    await waitFor(() => expect(onSearch1).toHaveBeenCalledWith("0xADDR"))
    unmount()

    params = new URLSearchParams({ q: "0xLEGACY" })
    const onSearch2 = vi.fn()
    render(<AutoSearchReader onSearch={onSearch2} collectionSlug="ufc" />)
    await waitFor(() => expect(onSearch2).toHaveBeenCalledWith("0xLEGACY"))
  })

  it("falls back to the saved wallet when there is no URL param", async () => {
    savedWalletMock.mockResolvedValue("0xSAVED")
    const onSearch = vi.fn()
    render(<AutoSearchReader onSearch={onSearch} collectionSlug="laliga-golazos" />)
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith("0xSAVED"))
    expect(savedWalletMock).toHaveBeenCalledWith("laliga-golazos")
  })

  it("fires nothing when there is no param and no saved wallet", async () => {
    const onSearch = vi.fn()
    render(<AutoSearchReader onSearch={onSearch} collectionSlug="ufc" />)
    await waitFor(() => expect(savedWalletMock).toHaveBeenCalled())
    expect(onSearch).not.toHaveBeenCalled()
  })
})
