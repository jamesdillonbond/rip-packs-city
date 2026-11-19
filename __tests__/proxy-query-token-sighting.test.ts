import { describe, it, expect } from "vitest"
import { queryTokenSighting } from "@/proxy"

// 2026-11-19: measure who still sends a server secret as `?token=` before removing that form.
describe("queryTokenSighting", () => {
  const q = (s: string) => new URLSearchParams(s)

  it("flags an API request that carries a token query parameter", () => {
    expect(queryTokenSighting("/api/admin/backfill-pinnacle-catalog", q("token=x"))).toBe(true)
    expect(queryTokenSighting("/api/cron/snapshot-pack-asks", q("floors_only=1&token=x"))).toBe(true)
    expect(queryTokenSighting("/api/allday-listings-indexer", q("token="))).toBe(true)
  })

  it("does not flag the email-link routes, whose token is a per-subscriber link token", () => {
    expect(queryTokenSighting("/api/subscribe/unsubscribe", q("token=abc"))).toBe(false)
    expect(queryTokenSighting("/api/subscribe/verify", q("token=abc"))).toBe(false)
  })

  it("does not flag pages, or API requests without the parameter", () => {
    expect(queryTokenSighting("/insights/trophies", q("token=x"))).toBe(false)
    expect(queryTokenSighting("/api/cron/snapshot-pack-asks", q("floors_only=1"))).toBe(false)
  })
})
