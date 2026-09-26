import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

// #144 (2026-09-26): ingest-topshot-atlas-pool reads its gate key from the
// Authorization header ONLY. The `?key=` form wrote ATLAS_POOL_INGEST_KEY into
// Supabase edge request logs (they record full URLs) on every call. This pins
// the deletion so a query-string key cannot quietly come back.
const src = readFileSync(
  path.join(process.cwd(), "supabase/functions/ingest-topshot-atlas-pool/index.ts"),
  "utf8",
)

describe("ingest-topshot-atlas-pool gate key", () => {
  it("never reads the key from the query string", () => {
    expect(src).not.toMatch(/searchParams\.get\(\s*["']key["']\s*\)/)
  })

  it("still gates on the Authorization bearer (control: the check exists)", () => {
    expect(src).toMatch(/req\.headers\.get\("authorization"\)/)
    expect(src).toMatch(/bearer !== KEY/)
  })
})
