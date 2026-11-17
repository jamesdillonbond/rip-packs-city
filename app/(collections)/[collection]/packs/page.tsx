import PackMarketView from "@/components/packs/PackMarketView"

// Standalone Packs route. After the 2026-07-18 IA reorg the Pack board is
// primarily reached via the Market tab's Moments|Packs sub-toggle, but this
// route stays live (deep-linkable + sitemap/SEO) and renders the exact same
// <PackMarketView/> the Market section mounts. The surrounding
// [collection]/packs/layout.tsx still gates access via collectionHasPage(id,
// "packs") — other collections get the "coming soon" shell.
//
// ⚠ THIS IS A SERVER PAGE, and it used to be a client one for a single reason:
// it called `useParams()` to read the collection slug. A server page receives
// the identical value as a prop, so the `"use client"` bought nothing — while
// costing measurement, since a `"use client"` page.tsx is matched by NEITHER
// coverage gate (the primary gate is lib/** + app/api/**/route.ts; the
// component gate is components/** + app/**/*Client.tsx).
//
// No `*Client.tsx` split was needed here because everything below the page is
// already a gated component. That makes this the cheapest shape of conversion
// and the one to look for first: a client page whose only client-side API is
// `useParams`/`useSearchParams` over a value the server already has.
export default async function PacksPage(props: {
  params: Promise<{ collection: string }>
}) {
  // ⚠ `params` is a Promise in this Next version — every sibling layout in this
  // route group awaits it the same way. Reading `props.params.collection`
  // directly yields undefined and silently falls back to Top Shot.
  const { collection } = await props.params
  return <PackMarketView collection={collection ?? "nba-top-shot"} />
}
