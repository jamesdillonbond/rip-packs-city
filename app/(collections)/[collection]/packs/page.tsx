"use client"

import { useParams } from "next/navigation"
import PackMarketView from "@/components/packs/PackMarketView"

// Standalone Packs route. After the 2026-07-18 IA reorg the Pack board is
// primarily reached via the Market tab's Moments|Packs sub-toggle, but this
// route stays live (deep-linkable + sitemap/SEO) and renders the exact same
// <PackMarketView/> the Market section mounts. The surrounding
// [collection]/packs/layout.tsx still gates access via collectionHasPage(id,
// "packs") — other collections get the "coming soon" shell.
export default function PacksPage() {
  const params = useParams()
  const collection = (params?.collection as string) ?? "nba-top-shot"
  return <PackMarketView collection={collection} />
}
