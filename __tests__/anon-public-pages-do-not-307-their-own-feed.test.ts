import { describe, it, expect } from "vitest"
import { isPublicPath } from "@/proxy"

// ── An anon-public page whose only data API is gated (2026-09-04) ────────────
// Found by loading every collection's /sniper and /packs SIGNED OUT in a real browser and watching
// for 307s. `/disney-pinnacle/sniper` is anon-public, and the one endpoint it calls —
// `/api/pinnacle-sniper-feed` — answered `307 → /login`, so the page rendered
// "FMV coverage unavailable — discount and FMV show once the feed loads" **permanently**. That is
// not a degraded read; it is a page waiting for a response that can never arrive.
//
// ⭐ The route is `export { GET } from "../pinnacle-sniper/route"` — the SAME handler as
// `/api/pinnacle-sniper`, which was already on the allowlist. One handler, public under one name
// and gated under its alias.
//
// This is the third instance of the class (badge-taxonomy and profile/me were 2026-09-03), so the
// pairing is pinned rather than the single URL: a page that is anon-public must not call an API
// that is not.
describe("anon-public pages can reach the APIs they actually call", () => {
  const PAGE_TO_APIS: Array<[string, string[]]> = [
    ["/disney-pinnacle/sniper", ["/api/pinnacle-sniper-feed", "/api/pinnacle-sniper"]],
    ["/nba-top-shot/sniper", ["/api/sniper-feed"]],
    ["/nba-top-shot/packs", ["/api/pack-listings"]],
    ["/nfl-all-day/packs", ["/api/pack-listings"]],
    // 2026-09-04, fourth instance: 26 of 374 tiles on the public collection tab were broken —
    // each an <img src="/api/moment-thumbnail?…"> that 307'd and rendered 21 KB of login HTML.
    // Only 26 because most tiles carry a direct CDN URL and this is the fallback, so the failure
    // is invisible on a spot check and permanent for the Moments that need it.
    ["/nba-top-shot/collection", ["/api/moment-thumbnail", "/api/collection-moments"]],
  ]

  it.each(PAGE_TO_APIS)("%s is anon-public and so are its feeds", (page, apis) => {
    expect(isPublicPath(page, "GET"), `${page} should be anon-public`).toBe(true)
    for (const api of apis) {
      expect(isPublicPath(api, "GET"), `${api} is called by anon ${page} but is gated`).toBe(true)
    }
  })

  // The control: opening these must not open everything. A dashboard/profile API stays gated, and
  // the widened routes stay GET-only — POST on a read allowlist would be a write hole.
  it("still gates session-scoped APIs, and the widened reads are GET-only", () => {
    expect(isPublicPath("/api/cost-basis", "GET")).toBe(false)
    expect(isPublicPath("/api/saved-wallets", "GET")).toBe(false)
    expect(isPublicPath("/api/pack-listings", "POST")).toBe(false)
    expect(isPublicPath("/api/pinnacle-sniper-feed", "POST")).toBe(false)
    expect(isPublicPath("/api/moment-thumbnail", "POST")).toBe(false)
  })

  // ⚠ Deliberately NOT opened: both also 307, and neither has an anon-public caller.
  // /laliga-golazos/sniper fires zero 307s and renders 54 rows, verified live. Widening for a
  // route with no caller is how the public surface grows without anyone deciding to grow it.
  it("does not open feeds that no anon page calls", () => {
    expect(isPublicPath("/api/golazos-sniper-feed", "GET")).toBe(false)
    expect(isPublicPath("/api/allday-pack-listings", "GET")).toBe(false)
  })
})
