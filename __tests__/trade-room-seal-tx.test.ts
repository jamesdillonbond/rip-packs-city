import { describe, it, expect } from "vitest"
import { assertSealTx } from "@/lib/trade-room/seal-tx"

// 2026-11-13: `sealed` stored any 64-hex tx id and the room page links it as "the transaction that
// sealed this trade". The id must now be a final, error-free transaction authorized by BOTH wallets.

const TX = "a".repeat(64)
const A = "0x3d0b274c80263484"
const B = "0x00000000000000bb"

function chainWith(opts: { txStatus?: number; resStatus?: number; authorizers?: string[]; status?: string; code?: number; error?: string; throws?: boolean }) {
  return async (url: string) => {
    if (opts.throws) throw new Error("fetch failed")
    if (url.includes("/v1/transactions/")) {
      return new Response(JSON.stringify({ authorizers: opts.authorizers ?? ["3d0b274c80263484", "00000000000000bb"] }), { status: opts.txStatus ?? 200 })
    }
    return new Response(JSON.stringify({ status: opts.status ?? "Sealed", status_code: opts.code ?? 0, error_message: opts.error ?? "" }), { status: opts.resStatus ?? 200 })
  }
}

const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: { status?: number; code?: string }) => `${e.status}:${e.code}`)

describe("assertSealTx", () => {
  it("accepts a sealed, error-free transaction both wallets authorized (prefix and case don't matter)", async () => {
    expect(await codeOf(assertSealTx(TX, [A, B], chainWith({})))).toBe("ok")
    expect(await codeOf(assertSealTx(TX, [A, B], chainWith({ authorizers: ["0x3D0B274C80263484", "0x00000000000000BB", "0x1"] })))).toBe("ok")
    expect(await codeOf(assertSealTx(TX, [A, B], chainWith({ status: "Executed" })))).toBe("ok")
  })

  it("refuses a transaction one of the room's wallets did not authorize", async () => {
    expect(await codeOf(assertSealTx(TX, [A, B], chainWith({ authorizers: ["3d0b274c80263484"] })))).toBe("409:bad_tx")
    expect(await codeOf(assertSealTx(TX, [A, B], chainWith({ authorizers: ["1111111111111111", "2222222222222222"] })))).toBe("409:bad_tx")
  })

  it("refuses an unknown transaction and one that failed on chain", async () => {
    expect(await codeOf(assertSealTx(TX, [A, B], chainWith({ txStatus: 404 })))).toBe("409:bad_tx")
    expect(await codeOf(assertSealTx(TX, [A, B], chainWith({ resStatus: 400 })))).toBe("409:bad_tx")
    expect(await codeOf(assertSealTx(TX, [A, B], chainWith({ code: 1, error: "panic" })))).toBe("409:bad_tx")
  })

  it("a read that fails, or a transaction not final yet, is 503 + retryable — never 'not this trade'", async () => {
    expect(await codeOf(assertSealTx(TX, [A, B], chainWith({ throws: true })))).toBe("503:upstream_unavailable")
    expect(await codeOf(assertSealTx(TX, [A, B], chainWith({ txStatus: 502 })))).toBe("503:upstream_unavailable")
    expect(await codeOf(assertSealTx(TX, [A, B], chainWith({ status: "Pending" })))).toBe("503:upstream_unavailable")
  })

  it("rejects a malformed id before any read", async () => {
    let called = false
    const f = async () => {
      called = true
      return new Response("{}")
    }
    expect(await codeOf(assertSealTx("0xabc", [A, B], f))).toBe("400:bad_tx")
    expect(called).toBe(false)
  })
})
