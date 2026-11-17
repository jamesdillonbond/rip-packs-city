// __tests__/funnel-profile-view-wiring.test.ts
//
// 2026-09-12. /profile/<username> is where every share link this product emits
// lands, and it fired NOTHING into funnel_events — measured whole-table, 0 of
// 28,129 rows carried a profile surface and 0 carried the utm_source=share we
// attach to every shared URL. Vercel Web Analytics is not enabled on this
// project, so funnel_events is the only instrument that exists.
//
// ⚠ WHAT MAKES THIS WORTH A GUARD is the FAILURE MODE, not the wiring. A funnel
// event_type must be admitted by THREE independent allowlists:
//
//   1. the funnel_events_event_type_check CHECK constraint  (rejects the INSERT)
//   2. ALLOWED_EVENT_TYPES in app/api/track-funnel/route.ts (rejects at the route)
//   3. the FunnelEventType union in lib/track-funnel.ts     (rejects at compile)
//
// Only (3) fails loudly. (2) returns HTTP 200 {ok:false} by design — "never
// throw into a beacon caller" — and (1) fails inside a route that logs the
// error and still returns {ok:true}. So a type present in the union but missing
// from either of the others produces a beacon that looks perfectly accepted and
// stores nothing: an accepted event is not a stored event. That is invisible
// until someone queries for rows that were never written.
//
// This file pins (2) against (3) mechanically. (1) lives in the database and is
// covered by the migration that added the type.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.join(__dirname, "..")
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8")

/** Members of the exported `FunnelEventType` union in lib/track-funnel.ts. */
function unionMembers(): string[] {
  const src = read("lib/track-funnel.ts")
  const start = src.indexOf("export type FunnelEventType")
  expect(start, "FunnelEventType union not found — was it renamed?").toBeGreaterThan(-1)
  // The union runs to the next top-level `export`/`const` after it.
  const rest = src.slice(start)
  const end = rest.indexOf("\nexport type FunnelEventPayload")
  expect(end, "could not bound the FunnelEventType union").toBeGreaterThan(-1)
  const block = rest.slice(0, end)
  return [...block.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1])
}

/** String literals inside the ALLOWED_EVENT_TYPES Set in the route. */
function routeAllowlist(): string[] {
  const src = read("app/api/track-funnel/route.ts")
  const start = src.indexOf("const ALLOWED_EVENT_TYPES")
  expect(start, "ALLOWED_EVENT_TYPES not found — was it renamed?").toBeGreaterThan(-1)
  const block = src.slice(start, src.indexOf("]);", start))
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])
}

describe("funnel event types: the client union and the route allowlist cannot drift", () => {
  it("every FunnelEventType is accepted by the route", () => {
    const union = unionMembers()
    const allowed = new Set(routeAllowlist())

    // A satisfiable-at-zero sanity check: if the parsers silently matched
    // nothing, the set-comparison below would pass vacuously.
    expect(union.length).toBeGreaterThan(5)

    const unaccepted = union.filter((t) => !allowed.has(t))
    expect(
      unaccepted,
      `these event types compile but the route rejects them with 200 {ok:false}, ` +
        `so the beacon silently stores nothing: ${unaccepted.join(", ")}`,
    ).toEqual([])
  })

  it("includes profile_view, the type the share funnel lands on", () => {
    expect(unionMembers()).toContain("profile_view")
    expect(routeAllowlist()).toContain("profile_view")
  })
})

describe("/profile/<username> reports its arrivals", () => {
  const layout = read("app/profile/[username]/layout.tsx")

  it("mounts the funnel tracker in the layout, so the trophy-case sub-route is covered too", () => {
    expect(layout).toMatch(/<FunnelTracker[^>]*eventType="profile_view"/)
    expect(layout).toMatch(/import FunnelTracker from "@\/components\/FunnelTracker"/)
  })

  it("uses perPath, or /profile/<u>/trophy-case would never fire its own event", () => {
    const tag = layout.match(/<FunnelTracker[\s\S]*?\/>/)?.[0] ?? ""
    expect(tag).toMatch(/perPath/)
  })
})

describe("sharer attribution does not collide with referrer attribution", () => {
  const src = read("lib/track-funnel.ts")

  // The attribution string already spends `ref=` on the external
  // document.referrer. Writing the share link's own `ref` param under the same
  // key would put two `ref=` keys in one column and make the obvious
  // split_part(referrer,'ref=',2) read mix sharer ids with referring URLs.
  it("stores the share link's ref under a distinct key", () => {
    expect(src).toMatch(/SHARE_REF_KEY\s*=\s*"share_ref"/)
    expect(src).toMatch(/SHARE_REF_PARAM\s*=\s*"ref"/)
    // The two must not be the same string, which is the whole point.
    const key = src.match(/SHARE_REF_KEY\s*=\s*"([a-z_]+)"/)?.[1]
    const param = src.match(/SHARE_REF_PARAM\s*=\s*"([a-z_]+)"/)?.[1]
    expect(key).toBeTruthy()
    expect(key).not.toBe(param)
    // And it must not be the key the referrer already occupies.
    expect(key).not.toBe("ref")
  })
})
