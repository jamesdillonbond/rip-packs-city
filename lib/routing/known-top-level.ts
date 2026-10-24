// lib/routing/known-top-level.ts
//
// 2026-10-15: the proxy is deny-by-default — any path not on its public list sends a
// signed-out visitor to /login?next=<path>. That included paths NO route serves
// (`/some-typo`, a dead link, a crawler guess), so instead of a 404 the visitor met a
// sign-in wall and a crawler saw a redirect-to-login (read as a soft 404). A path whose
// FIRST segment is not a real top-level route and not a collection slug cannot reach a
// gated page, so the proxy lets it through and Next renders its own 404 (an unknown
// first segment lands on the `[collection]` layout, whose getCollection() miss calls
// notFound()).
//
// ⛔ THIS LIST IS AN AUTH BOUNDARY. A new top-level route missing from it would be
// served to signed-out visitors without the gate. `__tests__/known-top-level-segments-
// match-the-app-tree.test.ts` derives the set from `app/` and reds on any difference, so
// adding a route without adding it here fails CI. There are no next.config rewrites (only
// redirects, which run BEFORE the proxy), so a first segment names its destination.

import { getCollection } from "@/lib/collections"

/** Every first path segment the app tree routes, route groups flattened, dynamic segments excluded. */
export const STATIC_TOP_LEVEL_SEGMENTS: ReadonlySet<string> = new Set([
  ".well-known",
  "_next",
  "about",
  "admin",
  "alerts",
  "analytics",
  "api",
  "auth",
  "blog",
  "dashboard",
  "early-access",
  "edition",
  "feed.xml",
  "giveaways",
  "help",
  "go",
  "insights",
  "legal",
  "login",
  "market",
  "moment",
  "my-teams",
  "nba",
  "pinnacle",
  "players",
  "pricing",
  "privacy",
  "profile",
  "rewards",
  "robots.txt",
  "share",
  "sitemap",
  "sitemap.xml",
  "sniper",
  "special-serial-owners",
  "teams",
  "terms",
])

/** The first segment of a pathname ("" for "/"). */
export function firstSegment(pathname: string): string {
  return pathname.replace(/^\/+/, "").split("/")[0] ?? ""
}

/**
 * True when some route could serve this path's first segment: the root, a static
 * top-level route, or a collection slug the `[collection]` segment accepts.
 */
export function isRoutableFirstSegment(pathname: string): boolean {
  const seg = firstSegment(pathname)
  if (seg === "") return true
  if (STATIC_TOP_LEVEL_SEGMENTS.has(seg)) return true
  return getCollection(seg) !== undefined
}
