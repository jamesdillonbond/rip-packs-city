import { describe, it, expect } from "vitest"
import { readTopShotLocks, TOPSHOT_LOCK_SCRIPT } from "@/lib/chains/flow/topshot-lock"

// The on-view lock refresh's reader (2026-11-16). Three outcomes per id: a reading,
// ABSENT (not in that collection → caller stamps nothing), or a throw.
function reply(body: unknown, status = 200): typeof fetch {
  return (async () => ({ ok: status < 300, status, text: async () => typeof body === "string" ? body : JSON.stringify(body) })) as never
}
const dict = (m: Record<string, boolean>) => JSON.stringify(btoa(JSON.stringify({ type: "Dictionary", value: Object.entries(m).map(([k, v]) => ({ key: { type: "UInt64", value: k }, value: { type: "Bool", value: v } })) })))

describe("readTopShotLocks", () => {
  it("reads TopShotLocking.isLocked, not a GraphQL host", () => {
    expect(TOPSHOT_LOCK_SCRIPT).toContain("TopShotLocking.isLocked")
  })
  it("returns locked AND unlocked readings, and omits an id the wallet does not hold", async () => {
    const m = await readTopShotLocks("0xabc", ["1", "2", "3"], { fetchImpl: reply(dict({ "1": true, "2": false })) })
    expect(m.get("1")).toBe(true)
    expect(m.get("2")).toBe(false)
    expect(m.has("3")).toBe(false)
  })
  it("throws on an HTTP failure instead of returning an empty (all-unknown-looking) map", async () => {
    await expect(readTopShotLocks("0xabc", ["1"], { fetchImpl: reply("boom", 500) })).rejects.toThrow(/Flow 500/)
  })
  it("throws on a non-dictionary result", async () => {
    await expect(readTopShotLocks("0xabc", ["1"], { fetchImpl: reply(JSON.stringify(btoa(JSON.stringify({ type: "Optional", value: null })))) })).rejects.toThrow(/unexpected/)
  })
  it("refuses more than one chunk of ids", async () => {
    await expect(readTopShotLocks("0xabc", Array.from({ length: 51 }, (_, i) => String(i)))).rejects.toThrow(/exceeds/)
  })
})
