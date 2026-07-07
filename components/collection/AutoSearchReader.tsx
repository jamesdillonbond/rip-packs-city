"use client"

import { useEffect } from "react"
import { useSearchParams } from "next/navigation"
import { fetchSavedWalletForCollection } from "@/lib/profile/saved-wallet-for-collection"

// Reads the wallet from the URL (?wallet= / ?address= / legacy ?q=) or falls
// back to the signed-in user's saved wallet, then fires onSearch. Renders null.
// Extracted verbatim from the collection page in the Phase 1 refactor.
export default function AutoSearchReader(props: { onSearch: (q: string) => void; collectionSlug: string }) {
  const searchParams = useSearchParams()
  useEffect(function() {
    let cancelled = false
    // Support ?wallet= (preferred), ?address=, and legacy ?q= param
    const wallet = searchParams.get("wallet")
    const address = searchParams.get("address")
    const q = searchParams.get("q")
    const query = wallet || address || q
    if (query && query.trim()) {
      props.onSearch(query.trim())
      return
    }
    // No URL param — fall back to the signed-in user's saved wallet for this
    // collection so the page auto-loads without requiring a trip to /profile.
    fetchSavedWalletForCollection(props.collectionSlug).then((addr) => {
      if (cancelled) return
      if (addr) props.onSearch(addr)
    })
    return function() { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}
