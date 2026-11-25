import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "fs"
import { fireUfcEnrichmentDrain, UFC_DRAIN_PATH } from "@/lib/chains/flow/ufc-drain-handoff"

// 2026-11-25: the UFC enrichment chain stops at its deadline with NULL-key rows left and logged
// "the rest stays NULL for the next run" — but the NULL-key drain had no caller since 10-18, so 114
// rows of 0x9a26549ac659995d stayed unkeyed. The backfill now hands the remainder to the drain.

describe("fireUfcEnrichmentDrain", () => {
  it("POSTs the drain with the ingest bearer and reports fired only on its 202", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 202 }))
    expect(await fireUfcEnrichmentDrain("https://x.test", "tok", f)).toEqual({ fired: true, status: 202, error: null })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://x.test${UFC_DRAIN_PATH}`)
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok")
  })

  it("a non-202 or a thrown fetch is a FAILED hand-off, never reported as fired, and never throws", async () => {
    expect(await fireUfcEnrichmentDrain("https://x.test", "tok", async () => new Response("", { status: 401 }))).toEqual({ fired: false, status: 401, error: "drain answered 401" })
    expect(await fireUfcEnrichmentDrain("https://x.test", "tok", async () => { throw new Error("boom") })).toEqual({ fired: false, status: null, error: "boom" })
  })

  it("does not call anything without a token", async () => {
    const f = vi.fn()
    expect((await fireUfcEnrichmentDrain("https://x.test", undefined, f as never)).fired).toBe(false)
    expect(f).not.toHaveBeenCalled()
  })

  it("⚠ the backfill route hands off exactly when the chain did not finish", () => {
    const src = readFileSync("app/api/wallet-backfill-ufc/route.ts", "utf8")
    expect(src).toMatch(/chainDone = result\.done/)
    expect(src).toMatch(/if \(!chainDone\) \{\s*const h = await fireUfcEnrichmentDrain\(origin, process\.env\.INGEST_SECRET_TOKEN\)/)
  })

  it("the drain route still exists at the path handed to", () => {
    expect(readFileSync(`app${UFC_DRAIN_PATH}/route.ts`, "utf8")).toMatch(/export async function POST/)
  })
})
