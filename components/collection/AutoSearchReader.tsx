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
export default function AutoSearchReader(props: {
  onSearch: (q: string, source: AutoSearchSource) => void
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
      props.onSearch(query.trim(), "url")
      return
    }
    // No URL param — fall back to the signed-in user's saved wallet for this
    // collection so the page auto-loads without requiring a trip to /profile.
    fetchSavedWalletForCollection(props.collectionSlug).then((addr) => {
      if (cancelled) return
      if (addr) props.onSearch(addr, "saved")
    })
    return function() { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}
