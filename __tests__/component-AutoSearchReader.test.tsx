// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

// AutoSearchReader reads a wallet from the URL (?wallet= preferred, then
// ?address=, then legacy ?q=) and fires onSearch; with no URL param it falls
// back to the signed-in user's saved wallet for the collection. It renders
// null. These pin the precedence ladder, the trim, and the saved-wallet
// fallback (incl. the "no saved wallet → no search" branch).

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }))
vi.mock("next/navigation", () => ({
  useSearchParams: () => nav.params,
}))

const savedWallet = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock("@/lib/profile/saved-wallet-for-collection", () => ({
  fetchSavedWalletForCollection: (slug: string) => savedWallet.fn(slug),
}))

import AutoSearchReader from "@/components/collection/AutoSearchReader"

beforeEach(() => {
  nav.params = new URLSearchParams()
  savedWallet.fn.mockReset()
  savedWallet.fn.mockResolvedValue(null)
})
afterEach(() => cleanup())

// Flush the fetchSavedWalletForCollection().then(...) microtask chain.
const flush = () => new Promise((r) => setTimeout(r, 0))

describe("AutoSearchReader — URL param path", () => {
  it("uses ?wallet= and never searches the saved wallet instead (2026-11-07: it may be consulted for onOwnWallet)", async () => {
    nav.params = new URLSearchParams("wallet=0xABC")
    savedWallet.fn.mockResolvedValue("0xOTHER")
    const onSearch = vi.fn()
    const onOwnWallet = vi.fn()
    render(<AutoSearchReader onSearch={onSearch} onOwnWallet={onOwnWallet} collectionSlug="nba-top-shot" />)
    await flush()
    expect(onSearch).toHaveBeenCalledTimes(1)
    expect(onSearch).toHaveBeenCalledWith("0xABC", "url")
    expect(onOwnWallet).not.toHaveBeenCalled()
  })

  it("a Solana key is matched case-SENSITIVELY: a case-folded twin is not your wallet", async () => {
    nav.params = new URLSearchParams("wallet=7yc5dvqapb5p7bya5s2z3h9mvdqkgyx6hftj8wq2nz4r")
    savedWallet.fn.mockResolvedValue("7Yc5dVqAPB5p7bYa5s2z3h9MvdqkGyX6hFtJ8Wq2nZ4r")
    const onOwnWallet = vi.fn()
    render(<AutoSearchReader onSearch={vi.fn()} onOwnWallet={onOwnWallet} collectionSlug="candy-mlb" />)
    await flush()
    expect(onOwnWallet).not.toHaveBeenCalled()
  })

  it("prefers ?wallet= over ?address= over legacy ?q=", async () => {
    nav.params = new URLSearchParams("q=0xQ&address=0xADDR&wallet=0xWALLET")
    const onSearch = vi.fn()
    render(<AutoSearchReader onSearch={onSearch} collectionSlug="ufc" />)
    await flush()
    expect(onSearch).toHaveBeenCalledWith("0xWALLET", "url")
  })

  it("falls to ?address= then ?q= when earlier params are absent", async () => {
    nav.params = new URLSearchParams("q=0xQ&address=0xADDR")
    const a = vi.fn()
    render(<AutoSearchReader onSearch={a} collectionSlug="ufc" />)
    await flush()
    expect(a).toHaveBeenCalledWith("0xADDR", "url")
    cleanup()

    nav.params = new URLSearchParams("q=0xQ")
    const b = vi.fn()
    render(<AutoSearchReader onSearch={b} collectionSlug="ufc" />)
    await flush()
    expect(b).toHaveBeenCalledWith("0xQ", "url")
  })

  it("trims surrounding whitespace on the URL value", async () => {
    nav.params = new URLSearchParams("wallet=%20%200xTRIM%20")
    const onSearch = vi.fn()
    render(<AutoSearchReader onSearch={onSearch} collectionSlug="ufc" />)
    await flush()
    expect(onSearch).toHaveBeenCalledWith("0xTRIM", "url")
  })
})

describe("AutoSearchReader — saved-wallet fallback", () => {
  it("fires onSearch with the saved wallet when there is no URL param", async () => {
    savedWallet.fn.mockResolvedValue("0xSAVED")
    const onSearch = vi.fn()
    render(<AutoSearchReader onSearch={onSearch} collectionSlug="nfl-all-day" />)
    await flush()
    expect(savedWallet.fn).toHaveBeenCalledWith("nfl-all-day")
    expect(onSearch).toHaveBeenCalledWith("0xSAVED", "saved")
  })

  it("does nothing when there is neither a URL param nor a saved wallet", async () => {
    savedWallet.fn.mockResolvedValue(null)
    const onSearch = vi.fn()
    render(<AutoSearchReader onSearch={onSearch} collectionSlug="ufc" />)
    await flush()
    expect(savedWallet.fn).toHaveBeenCalled()
    expect(onSearch).not.toHaveBeenCalled()
  })

  it("ignores a whitespace-only URL param and falls back to the saved wallet", async () => {
    nav.params = new URLSearchParams("wallet=%20%20")
    savedWallet.fn.mockResolvedValue("0xSAVED")
    const onSearch = vi.fn()
    render(<AutoSearchReader onSearch={onSearch} collectionSlug="ufc" />)
    await flush()
    expect(onSearch).toHaveBeenCalledWith("0xSAVED", "saved")
  })
})
