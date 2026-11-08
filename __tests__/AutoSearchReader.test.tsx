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
  // 2026-11-07: the saved wallet is now CONSULTED on a ?wallet= load — only to learn
  // whether the typed wallet is the reader's own (onOwnWallet), never to search it.
  it("uses ?wallet= first and never SEARCHES the saved wallet in its place", async () => {
    params = new URLSearchParams({ wallet: " 0xWALLET ", address: "0xADDR", q: "0xQ" })
    savedWalletMock.mockResolvedValue("0xSAVED")
    const onSearch = vi.fn()
    const onOwnWallet = vi.fn()
    render(<AutoSearchReader onSearch={onSearch} onOwnWallet={onOwnWallet} collectionSlug="nba-top-shot" />)
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith("0xWALLET", "url")) // trimmed
    await waitFor(() => expect(savedWalletMock).toHaveBeenCalled())
    expect(onSearch).toHaveBeenCalledTimes(1)
    expect(onOwnWallet).not.toHaveBeenCalled()
  })

  it("a ?wallet= that IS the reader's saved wallet (any hex case) reports onOwnWallet, without a second search", async () => {
    params = new URLSearchParams({ wallet: "0xbd94cade097e50ac" })
    savedWalletMock.mockResolvedValue("0xBD94CADE097E50AC")
    const onSearch = vi.fn()
    const onOwnWallet = vi.fn()
    render(<AutoSearchReader onSearch={onSearch} onOwnWallet={onOwnWallet} collectionSlug="nba-top-shot" />)
    await waitFor(() => expect(onOwnWallet).toHaveBeenCalledWith("0xbd94cade097e50ac"))
    expect(onSearch).toHaveBeenCalledTimes(1)
  })

  it("falls back to ?address= then legacy ?q=", async () => {
    params = new URLSearchParams({ address: "0xADDR" })
    const onSearch1 = vi.fn()
    const { unmount } = render(<AutoSearchReader onSearch={onSearch1} collectionSlug="ufc" />)
    await waitFor(() => expect(onSearch1).toHaveBeenCalledWith("0xADDR", "url"))
    unmount()

    params = new URLSearchParams({ q: "0xLEGACY" })
    const onSearch2 = vi.fn()
    render(<AutoSearchReader onSearch={onSearch2} collectionSlug="ufc" />)
    await waitFor(() => expect(onSearch2).toHaveBeenCalledWith("0xLEGACY", "url"))
  })

  it("falls back to the saved wallet when there is no URL param", async () => {
    savedWalletMock.mockResolvedValue("0xSAVED")
    const onSearch = vi.fn()
    render(<AutoSearchReader onSearch={onSearch} collectionSlug="laliga-golazos" />)
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith("0xSAVED", "saved"))
    expect(savedWalletMock).toHaveBeenCalledWith("laliga-golazos")
  })

  it("fires nothing when there is no param and no saved wallet", async () => {
    const onSearch = vi.fn()
    render(<AutoSearchReader onSearch={onSearch} collectionSlug="ufc" />)
    await waitFor(() => expect(savedWalletMock).toHaveBeenCalled())
    expect(onSearch).not.toHaveBeenCalled()
  })
})
