"use client"

import { usePathname } from "next/navigation"
import { type Collection, type CollectionPage, PAGE_LABELS } from "@/lib/collections"

// The collection banner's title element, promoted from a styled <div> to a real <h1>
// on the routes that would otherwise ship NO heading of any level.
//
// WHY THIS IS NOT JUST `<h1>` IN THE BANNER: CollectionBanner is mounted by
// app/(collections)/[collection]/layout.tsx, which wraps BOTH the tab routes and every
// entity route beneath them (edition/, moment/, set/, series/, player/, team/, pack/,
// profile/). The entity pages already ship a specific, well-crafted <h1> ("LeBron James",
// the edition name, …). Hardcoding an <h1> here would put a GENERIC collection-label
// heading ahead of every one of those in the DOM, diluting the strongest on-page title
// signal on the pages that currently get it right. Six tab pages (sniper, sets,
// challenges, hot-floors, fast-break, road-to-the-ring) likewise own their heading.
//
// So the rule is structural, not a hand-maintained page list:
//   • depth <= 2  (`/{collection}` or `/{collection}/{tab}`)  -> a tab route
//   • minus the tab segments that already render their own <h1>
// Entity routes are 3+ segments and are excluded automatically, so adding a new entity
// route needs no change here.
//
// Measured 2026-07-28 against SERVER-RENDERED html (what a crawler sees, not the hydrated
// DOM): /{collection}/{overview,collection,market,sets} returned 0 h1 AND 0 h2 — roughly
// 5 collections x 6 tabs, the site's highest-traffic surface, shipping with an empty
// document outline while its <title> and meta were correct and specific.
//
// The tab name rides along in an sr-only span rather than in the visible text: the visible
// banner is unchanged (this is a semantics fix, not a redesign), while crawlers and screen
// readers get "NBA Top Shot — Market", which matches that tab's own distinct <title>
// instead of repeating one identical h1 across all six tabs of a collection.

// Tab segments that already put an <h1> on the page. `sniper` also covers the bespoke
// Disney Pinnacle sniper page, which is why this keys on the tab SEGMENT, not the path.
//
// ⚠ DERIVED BY MEASURING RENDERED HTML, NOT BY GREPPING page.tsx. A first cut built this
// list from `grep -c '<h1' <tab>/page.tsx` and was WRONG for three tabs — packs, play and
// pack-sniper render their heading from a CHILD component, so their page.tsx greps 0 while
// the route serves an h1. Shipping that list put TWO h1s on those routes. If you add a tab
// here, confirm it against the served HTML (`curl -sL <url> | grep -c '<h1'`), not the file.
const TABS_WITH_OWN_H1 = new Set<string>([
  "sniper",
  "sets",
  "challenges",
  "hot-floors",
  "fast-break",
  "road-to-the-ring",
  "packs",
  "play",
  "pack-sniper",
])

const TITLE_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontWeight: 900,
  fontSize: 20,
  letterSpacing: "0.06em",
  color: "var(--rpc-text-primary)",
  textTransform: "uppercase",
  lineHeight: 1,
  margin: 0, // h1 carries a UA margin the <div> did not — pin it so nothing shifts
}

export default function CollectionHeading({ collection }: { collection: Collection }) {
  const pathname = usePathname() ?? ""
  const segments = pathname.split("/").filter(Boolean)
  const tab = segments[1] ?? null

  const isTabRoute = segments.length <= 2 && !(tab && TABS_WITH_OWN_H1.has(tab))

  if (!isTabRoute) {
    return <div style={TITLE_STYLE}>{collection.label}</div>
  }

  const tabLabel = tab ? PAGE_LABELS[tab as CollectionPage] : null

  return (
    <h1 style={TITLE_STYLE}>
      {collection.label}
      {tabLabel ? <span className="sr-only"> — {tabLabel}</span> : null}
    </h1>
  )
}
