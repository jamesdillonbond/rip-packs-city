import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { readCappedByEditionId, readCappedByExternalId } from "@/lib/fmv-capped"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// #215 — the ONE rule every "capped at sales" surface shares (lib/fmv-capped.ts):
// a snapshot describes a row only at the same price; any failed read is "not
// checked" (an empty map), never a claim either way.

function fakeDb(opts: {
  editions?: { data: unknown; error: unknown }
  wide?: { data: unknown; error: unknown }
}) {
  const calls = { from: 0, rpc: 0 }
  const builder: any = {}
  for (const m of ["select", "eq", "in", "limit"]) builder[m] = () => builder
  builder.then = (resolve: any) => resolve(opts.editions ?? { data: [], error: null })
  return {
    calls,
    db: {
      from: () => { calls.from += 1; return builder },
      rpc: async () => { calls.rpc += 1; return opts.wide ?? { data: [], error: null } },
    },
  }
}

const row = (key: string, fmv: number, confidence = "ASK_ONLY") => ({ key, fmv, confidence })

describe("readCappedByEditionId", () => {
  it("true for _salescap / _histcap, false for an uncapped ASK_ONLY price", async () => {
    const { db } = fakeDb({ wide: { data: [
      { edition_id: "a", fmv_usd: 10, algo_version: "v_salescap" },
      { edition_id: "b", fmv_usd: 20, algo_version: "v_histcap" },
      { edition_id: "c", fmv_usd: 30, algo_version: "v" },
    ], error: null } })
    const m = await readCappedByEditionId([row("a", 10), row("b", 20), row("c", 30)], db)
    expect([m.get("a"), m.get("b"), m.get("c")]).toEqual([true, true, false])
  })

  it("never pairs a snapshot at a different price", async () => {
    const { db } = fakeDb({ wide: { data: [{ edition_id: "a", fmv_usd: 11, algo_version: "v_salescap" }], error: null } })
    expect((await readCappedByEditionId([row("a", 10)], db)).has("a")).toBe(false)
  })

  it("does not read for rows that are not ASK_ONLY", async () => {
    const { db, calls } = fakeDb({})
    await readCappedByEditionId([row("a", 10, "HIGH")], db)
    expect(calls.rpc).toBe(0)
  })

  it("a failed read is an empty map, not a verdict", async () => {
    const { db } = fakeDb({ wide: { data: null, error: { message: "timeout" } } })
    expect((await readCappedByEditionId([row("a", 10)], db)).size).toBe(0)
  })
})

describe("readCappedByExternalId", () => {
  it("resolves external_id → UUID, then pairs, keyed back by external_id", async () => {
    const { db } = fakeDb({
      editions: { data: [{ id: "u1", external_id: "257:8869::17" }], error: null },
      wide: { data: [{ edition_id: "u1", fmv_usd: 5, algo_version: "ts_histcap" }], error: null },
    })
    const m = await readCappedByExternalId("c", [row("257:8869::17", 5)], db)
    expect(m.get("257:8869::17")).toBe(true)
  })

  it("a failed edition-id read is an empty map", async () => {
    const { db } = fakeDb({ editions: { data: null, error: { message: "boom" } } })
    expect((await readCappedByExternalId("c", [row("x", 5)], db)).size).toBe(0)
  })
})

describe("edition page parallel ladder — wired to the shared rule", () => {
  const src = stripComments(readFileSync("app/(collections)/[collection]/edition/[slug]/page.tsx", "utf8"))
  it("bounds the read and passes the flag to fmvBasis on the ladder cards", () => {
    expect(src).toMatch(/withBoardBudget\(\s*readCappedByExternalId\(/)
    expect(src).toContain("fmvBasis(s.confidence, siblingCapped.get(s.external_id) === true)")
  })
})
