import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

// Route test for GET /api/pack-listings/historical-pulls.
//
// 🚨 THIS FILE USED TO PIN THE DEFECT IT WAS NAMED TO PREVENT. Its second case
// was literally `it("returns total 0 when the acquisitions query errors")`,
// asserting `{ total: 0, tierBreakdown: {} }` on a failed read — a measured zero
// published out of our own outage, and the single most productive defect class
// on this platform. A passing test asserting that promise is what held it in
// place. Per CLAUDE.md the assertion is INVERTED, never deleted: the case below
// now asserts the ABSENCE of the false claim, so re-introducing the old body
// reds this file at the case whose title names the property.
//
// The route was withdrawn 2026-09-09 (501) because the number it published was a
// 0.12% unordered sample of 838,392 rows AND the pack_dist_id join it needed is
// NULL on every one of them. Its header carries the full account.

import { GET } from "@/app/api/pack-listings/historical-pulls/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

describe("GET /api/pack-listings/historical-pulls", () => {
  it("400s when title is missing", async () => {
    const res = await GET(req("https://t/api/pack-listings/historical-pulls"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("title required")
  })

  it("NEVER answers with a count — a total it cannot compute is a fabrication", async () => {
    // ⚠ The inverted pin. The old body answered 200 + `{ total: 0 }` here, and
    // a reader could not tell that from "this pack really had no pulls".
    const res = await GET(req("https://t/api/pack-listings/historical-pulls?title=Metallic+Gold"))
    const body = await res.json()
    expect(res.status).toBe(501)
    expect(body).not.toHaveProperty("total")
    expect(body).not.toHaveProperty("tierBreakdown")
    expect(body.error).toMatch(/unavailable/i)
    expect(body.code).toBe("unavailable")
  })

  it("does not read moment_acquisitions at all — the sampled scan is gone", () => {
    // ⚠ Asserted on the SOURCE, not on a mock. A behavioural test cannot tell
    // "the read was removed" from "the mock returned nothing", and the property
    // this route was withdrawn for is that the read existed at all: an unordered
    // 1,000-row window over 838,392 rows, reported as a total.
    const src = readFileSync("app/api/pack-listings/historical-pulls/route.ts", "utf8")
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n")
    expect(code).not.toMatch(/from\(\s*["']moment_acquisitions["']\s*\)/)
    expect(code).not.toMatch(/from\(\s*["']wallet_moments_cache["']\s*\)/)
    expect(code).not.toMatch(/\.limit\(/)
  })
})
