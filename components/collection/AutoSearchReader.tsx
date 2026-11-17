"use client"

import { useEffect } from "react"
import { useSearchParams } from "next/navigation"
import { fetchSavedWalletForCollection } from "@/lib/profile/saved-wallet-for-collection"

/** Where the auto-loaded wallet came from: a URL param, or the signed-in collector's saved wallet. */
export type AutoSearchSource = "url" | "saved"

// Reads the wallet from the URL (?wallet= / ?address= / legacy ?q=) or falls
// back to the signed-in user's saved wallet, then fires onSearch. Renders null.
// Extracted verbatim from the collection page in the Phase 1 refactor.
//
// 2026-11-07: `onSearch` also says WHICH it was. A signed-in collector whose saved
// wallet loaded does not need the address box or the "this device's wallet" chip
// (Trevor: confusing and unnecessary) — the page hides them on `"saved"`.

// Hex (Flow/EVM) addresses compare case-insensitively; anything else (a Solana key)
// is case-sensitive, so it must match exactly.
function sameWallet(a: string, b: string): boolean {
  const x = a.trim(), y = b.trim()
  if (/^0x[0-9a-f]+$/i.test(x) && /^0x[0-9a-f]+$/i.test(y)) return x.toLowerCase() === y.toLowerCase()
  return x === y
}

export default function AutoSearchReader(props: {
  onSearch: (q: string, source: AutoSearchSource) => void
  /** Fires when a URL-supplied wallet turns out to be the signed-in reader's saved one. */
  onOwnWallet?: (q: string) => void
  /** Fires when no URL wallet was given and the account has no saved wallet here (or is signed out). */
  onNoSavedWallet?: () => void
  collectionSlug: string
}) {
  const searchParams = useSearchParams()
  useEffect(function() {
    let cancelled = false
    // Support ?wallet= (preferred), ?address=, and legacy ?q= param
    const wallet = searchParams.get("wallet")
    const address = searchParams.get("address")
    const q = searchParams.get("q")
    const query = wallet || address || q
    if (query && query.trim()) {
      const typed = query.trim()
      props.onSearch(typed, "url")
      // 2026-11-07: the binder writes ?wallet= into the URL after loading the saved
      // wallet, so a reload (or a link to your own binder) arrives as "url". When it
      // IS the signed-in reader's saved wallet, say so — the page then hides the
      // address box exactly as it does on a fresh load.
      fetchSavedWalletForCollection(props.collectionSlug).then((addr) => {
        if (cancelled || !addr) return
        // a separate callback: the search already ran, only its SOURCE is learned
        if (sameWallet(addr, typed)) props.onOwnWallet?.(typed)
      })
      return function() { cancelled = true }
    }
    // No URL param — fall back to the signed-in user's saved wallet for this
    // collection so the page auto-loads without requiring a trip to /profile.
    fetchSavedWalletForCollection(props.collectionSlug).then((addr) => {
      if (cancelled) return
      if (addr) props.onSearch(addr, "saved")
      else props.onNoSavedWallet?.()
    })
    return function() { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}
