// lib/ia.ts — the information architecture registry (IA Phase 2, 2026-11-06).
//
// ONE taxonomy of features, grouped by the collector's JOB; the header
// (TopNav), the mobile bar (MobileNav) and the footer (SiteFooter) all render
// FROM it; the dashboard's one-line tools strip names four of its hubs by hand
// because the first-run tour anchors to one of them. No nav carries a hand-written link
// list any more — the standing rule: a hardcoded allowlist beside a registry
// goes stale silently (CLAUDE.md, testing-and-ci.md).
//
// Rules this file enforces by shape (docs/strategy/features/information-architecture-2026-11-06.md §3):
//   1. a feature ships with a home — a group here, or a dashboard tab;
//   2. collections are a SCOPE, never a destination of their own: no group
//      item is "Top Shot"; collection-scoped pages carry `{collection}` and
//      are resolved against the current / remembered collection at render;
//   3. `auth: true` items are shown to signed-in visitors only (anon would
//      302 to /login — the TopNav test checks every anon href is public).
//
// Nothing here creates a page. Every href below already exists.

import { getCollection, collectionHasPage, type CollectionPage } from "@/lib/collections"

export type IaGroupId = "market" | "packs" | "insights" | "collectors" | "trade" | "me"

export interface IaItem {
  label: string
  /** Absolute path; `{collection}` is replaced at render by `resolveHref`. */
  href: string
  /** Shown to signed-in visitors only. */
  auth?: boolean
  /** When the href is collection-scoped, the page it needs (for the fallback). */
  page?: CollectionPage
  /** One line for the footer / dropdown, optional. */
  hint?: string
}

export interface IaGroup {
  id: IaGroupId
  label: string
  /** What this group answers for the collector — the door's subtitle. */
  job: string
  /** Where the group's own link goes (its hub). */
  href: string
  page?: CollectionPage
  auth?: boolean
  items: IaItem[]
}

export const DEFAULT_COLLECTION = "nba-top-shot"

export const IA_GROUPS: readonly IaGroup[] = [
  {
    id: "market",
    label: "Market",
    job: "What is it worth, what should I buy",
    href: "/market",
    items: [
      { label: "Market", href: "/market", hint: "Floors, asks and sales across every collection" },
      { label: "Sniper", href: "/sniper", hint: "Listings below FMV, live" },
      { label: "Hot floors", href: "/{collection}/hot-floors", page: "hot-floors" },
      { label: "Offer spread", href: "/insights/offer-spread" },
      { label: "Underpriced serials", href: "/insights/underpriced-serials" },
      { label: "Serial premiums", href: "/insights/serial-premiums" },
      { label: "Top sales", href: "/insights/top-sales" },
      { label: "Market pulse", href: "/insights/market-pulse" },
      { label: "Market cap", href: "/insights/market-cap" },
    ],
  },
  {
    id: "packs",
    label: "Packs",
    job: "Should I rip, and what did I pull",
    href: "/{collection}/packs",
    page: "packs",
    items: [
      { label: "Pack EV", href: "/{collection}/packs", page: "packs", hint: "Expected value per pack, by drop" },
      { label: "Pack Sniper", href: "/{collection}/pack-sniper", page: "pack-sniper" },
      { label: "Pack drops", href: "/insights/pack-drops" },
      { label: "Pack reality", href: "/insights/pack-reality" },
      { label: "Top Shot pack market", href: "/insights/topshot-pack-market" },
      { label: "All Day pack market", href: "/insights/allday-pack-market" },
      { label: "My pack history", href: "/dashboard/packs", auth: true },
    ],
  },
  {
    id: "insights",
    label: "Insights",
    job: "What the marketplaces won't tell you",
    href: "/insights",
    items: [
      { label: "All insights", href: "/insights" },
      { label: "Squeeze board", href: "/insights/squeeze" },
      { label: "Below FMV", href: "/insights/deals" },
      { label: "Rookie index", href: "/insights/rookies" },
      { label: "First-mint trophies", href: "/insights/first-mint" },
      { label: "Set completers", href: "/insights/set-completers" },
      { label: "Autographs", href: "/insights/autographs" },
      { label: "Parallel premiums", href: "/insights/parallel-premiums" },
      { label: "The RPC Index", href: "/insights/market" },
      { label: "Analytics", href: "/analytics" },
      { label: "Blog", href: "/blog" },
    ],
  },
  {
    id: "collectors",
    label: "Collectors",
    job: "People, teams, players, challenges",
    href: "/teams",
    items: [
      // (There is no /players index page — players are reached by search and
      // from every team / edition page; the hub is Teams.)
      { label: "Teams", href: "/teams", hint: "Franchise hubs across every collection" },
      { label: "My teams", href: "/my-teams", auth: true },
      { label: "Dame Time challenge", href: "/trophy-challenges/dame-time" },
      { label: "Special-serial owners", href: "/special-serial-owners", auth: true },
      { label: "Fast Break optimizer", href: "/nba-top-shot/fast-break", auth: true },
    ],
  },
  {
    id: "trade",
    label: "Trade",
    job: "Swap, post, trade in",
    // The browse page is public; the room itself is signed-in.
    href: "/trades/block",
    items: [
      { label: "Trade Block", href: "/trades/block", hint: "What collectors would move" },
      { label: "Trade room", href: "/trades", auth: true, hint: "Two wallets, one signed swap, no custody" },
      { label: "Top Shot This trade-in", href: "/insights/trade-in" },
    ],
  },
  {
    id: "me",
    label: "Me",
    job: "My collection",
    href: "/dashboard",
    auth: true,
    items: [
      { label: "Dashboard", href: "/dashboard", auth: true },
      { label: "Trophy cases", href: "/dashboard?tab=trophy", auth: true },
      { label: "Alerts", href: "/alerts", auth: true },
      { label: "Email settings", href: "/dashboard/notifications", auth: true },
      { label: "Edit profile", href: "/profile/edit", auth: true },
      { label: "Help", href: "/help" },
    ],
  },
]

/** The four groups the mobile bar shows beside HOME, in header order. */
export const MOBILE_GROUP_IDS: readonly IaGroupId[] = ["market", "packs", "insights", "trade"]

/**
 * Resolve a registry href for a collection. A `{collection}` href lands on the
 * current collection when it has that page, else on the default collection —
 * never on a page that would soft-404 (the MobileNav "inert tab" rule is the
 * other half of this: a tab for a page the collection lacks is disabled, not
 * substituted; a global menu has no inert state, so it falls back instead).
 */
export function resolveHref(href: string, collectionId: string | null | undefined, page?: CollectionPage): string {
  if (!href.includes("{collection}")) return href
  const wanted = collectionId && getCollection(collectionId) ? collectionId : DEFAULT_COLLECTION
  const ok = page ? collectionHasPage(wanted, page) : true
  return href.replace("{collection}", ok ? wanted : DEFAULT_COLLECTION)
}

export function iaGroup(id: IaGroupId): IaGroup {
  const g = IA_GROUPS.find((x) => x.id === id)
  if (!g) throw new Error(`unknown IA group ${id}`)
  return g
}

/** Items a visitor may see: anon loses every `auth` item (and auth-only groups). */
export function visibleItems(group: IaGroup, signedIn: boolean): IaItem[] {
  return group.items.filter((i) => signedIn || !i.auth)
}

export function visibleGroups(signedIn: boolean): IaGroup[] {
  return IA_GROUPS.filter((g) => signedIn || !g.auth)
}

/** Collection pages owned by a group even when no menu item names that page. */
const COLLECTION_PAGE_GROUP: Record<string, IaGroupId> = {
  market: "market",
  sniper: "market",
  "hot-floors": "market",
  packs: "packs",
  "pack-sniper": "packs",
}

/** The group whose hub or items own this path (first match in header order). */
export function groupForPath(pathname: string): IaGroupId | null {
  const p = pathname.split("?")[0]
  const seg = p.split("/").filter(Boolean)
  if (seg.length === 2 && getCollection(seg[0]) && COLLECTION_PAGE_GROUP[seg[1]]) return COLLECTION_PAGE_GROUP[seg[1]]
  for (const g of IA_GROUPS) {
    const hrefs = [g.href, ...g.items.map((i) => i.href)].map((h) => h.split("?")[0])
    for (const h of hrefs) {
      if (h.includes("{collection}")) {
        const tail = h.slice(h.indexOf("{collection}") + "{collection}".length) // e.g. /packs
        const m = p.match(/^\/[^/]+(\/.*)?$/)
        if (m && (m[1] ?? "") === tail) return g.id
      } else if (p === h || p.startsWith(h + "/")) {
        return g.id
      }
    }
  }
  return null
}
