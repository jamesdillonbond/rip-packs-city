// The Collection tab maps /api/wallet-summary's JSON into state by hand, field by field.
// A field the compute helpers read but the mapping omits is silently undefined: on 11-09
// `moments_with_cost` was added to the route, the type and computeCostBasisSummary, and the
// page still printed "moments with a known cost" with no number because the mapping dropped
// it (seen on the rendered page 11-10). `lock_unknown_*` had been dropped the same way, so
// the "N not checked" lock line could never render there.
//
// Derivation: the field list is read from the lib's WalletSummary type, not curated here —
// a field added to the type and not to the mapping reds this test.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const root = join(__dirname, "..")
const lib = readFileSync(join(root, "lib/portfolio-summary-compute.ts"), "utf8")
const client = readFileSync(
  join(root, "app/(collections)/[collection]/collection/CollectionTabClient.tsx"),
  "utf8",
)

function typeFields(): string[] {
  const start = lib.indexOf("export type WalletSummary = {")
  const end = lib.indexOf("} | null", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const body = lib.slice(start, end)
  return [...body.matchAll(/^\s{2}([a-z_]+)\??:/gm)].map((m) => m[1])
}

function mappedFields(): string[] {
  const start = client.indexOf("setWalletSummary({")
  const end = client.indexOf("})", start)
  expect(start).toBeGreaterThan(-1)
  const body = client.slice(start, end)
  return [...body.matchAll(/^\s+([a-z_]+):/gm)].map((m) => m[1])
}

describe("Collection tab wallet-summary mapping", () => {
  it("reads a non-trivial field list from the type", () => {
    const fields = typeFields()
    expect(fields.length).toBeGreaterThanOrEqual(12)
    expect(fields).toContain("moments_with_cost")
    expect(fields).toContain("lock_unknown_count")
  })

  it("maps every field the compute helpers can read", () => {
    const mapped = new Set(mappedFields())
    const missing = typeFields().filter((f) => !mapped.has(f))
    expect(missing).toEqual([])
  })
})
