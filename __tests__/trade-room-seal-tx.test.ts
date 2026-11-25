import { describe, it, expect } from "vitest"
import { assertSealTx, txMismatch } from "@/lib/trade-room/seal-tx"
import { SWAP_CADENCE } from "@/lib/swap-test/swap-cadence"
import { MULTI_SWAP_CADENCE } from "@/lib/trade-room/multi-swap-cadence"
import type { LoadedRoom } from "@/lib/trade-room/store"

// 2026-11-13: `sealed` stored any 64-hex tx id and the room page links it as "the transaction that
// sealed this trade". The id must now be a final, error-free transaction authorized by BOTH wallets.
// 2026-11-24: …and it must run THIS room's trade — script and arguments — not any other transaction the
// same two wallets signed together. The fixture is the real 10-31 swap 3e1c0976… read from Flow REST
// (arguments and authorizers verbatim; its script is byte-identical to SWAP_CADENCE, md5 c9c72dc5…).

const TX = "a".repeat(64)
const SIGNER_A = "0x3d0b274c80263484"
const SIGNER_B = "0x68c1fb83ba8e634a"
const SOURCE_A = "0xbd94cade097e50ac"
const SOURCE_B = "0xa3d67b29e104e701"

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")
const arg = (v: unknown) => b64(JSON.stringify(v))
const ids = (...n: string[]) => ({ type: "Array", value: n.map((value) => ({ type: "UInt64", value })) })

/** The real transaction's arguments, verbatim from the chain. */
const REAL_ARGS = [
  "eyJ0eXBlIjoiQWRkcmVzcyIsInZhbHVlIjoiMHhiZDk0Y2FkZTA5N2U1MGFjIn0=",
  "eyJ0eXBlIjoiVUludDY0IiwidmFsdWUiOiI4NyJ9",
  "eyJ0eXBlIjoiQXJyYXkiLCJ2YWx1ZSI6W3sidHlwZSI6IlVJbnQ2NCIsInZhbHVlIjoiMjczMTU0MDUifV19",
  "eyJ0eXBlIjoiQWRkcmVzcyIsInZhbHVlIjoiMHhhM2Q2N2IyOWUxMDRlNzAxIn0=",
  "eyJ0eXBlIjoiVUludDY0IiwidmFsdWUiOiI4OSJ9",
  "eyJ0eXBlIjoiQXJyYXkiLCJ2YWx1ZSI6W3sidHlwZSI6IlVJbnQ2NCIsInZhbHVlIjoiMjczMjYyMjMifV19",
]
const REAL_TX = { script: b64(SWAP_CADENCE), arguments: REAL_ARGS, authorizers: ["3d0b274c80263484", "68c1fb83ba8e634a"] }

function room(over: { aItems?: string[]; bItems?: string[]; aSource?: string; flip?: boolean; collection?: string } = {}): LoadedRoom {
  const a = { side: "a", signer: SIGNER_A, source: over.aSource ?? SOURCE_A }
  const b = { side: "b", signer: SIGNER_B, source: SOURCE_B }
  const item = (side: string, moment_id: string) => ({ side, collection: over.collection ?? "nba_top_shot", moment_id })
  return {
    room: { id: "r1", status: "signing" },
    // `flip`: the room's side labels are the reverse of the transaction's A/B — the initiator may be either side
    sides: over.flip ? [{ ...a, side: "b" }, { ...b, side: "a" }] : [a, b],
    items: [
      ...(over.aItems ?? ["27315405"]).map((m) => item(over.flip ? "b" : "a", m)),
      ...(over.bItems ?? ["27326223"]).map((m) => item(over.flip ? "a" : "b", m)),
    ],
  } as unknown as LoadedRoom
}

function chainWith(opts: { tx?: Record<string, unknown>; txStatus?: number; resStatus?: number; authorizers?: string[]; status?: string; code?: number; error?: string; throws?: boolean }) {
  return async (url: string) => {
    if (opts.throws) throw new Error("fetch failed")
    if (url.includes("/v1/transactions/")) {
      const body = { ...REAL_TX, ...(opts.tx ?? {}), ...(opts.authorizers ? { authorizers: opts.authorizers } : {}) }
      return new Response(JSON.stringify(body), { status: opts.txStatus ?? 200 })
    }
    return new Response(JSON.stringify({ status: opts.status ?? "Sealed", status_code: opts.code ?? 0, error_message: opts.error ?? "" }), { status: opts.resStatus ?? 200 })
  }
}

const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: { status?: number; code?: string }) => `${e.status}:${e.code}`)

describe("assertSealTx", () => {
  it("accepts the room's own sealed, error-free trade (prefix and case don't matter)", async () => {
    expect(await codeOf(assertSealTx(TX, room(), chainWith({})))).toBe("ok")
    expect(await codeOf(assertSealTx(TX, room(), chainWith({ authorizers: ["0x3D0B274C80263484", "0x68C1FB83BA8E634A"] })))).toBe("ok")
    expect(await codeOf(assertSealTx(TX, room(), chainWith({ status: "Executed" })))).toBe("ok")
  })

  it("accepts it whichever side of the room initiated (the room's a/b need not be the transaction's A/B)", async () => {
    expect(txMismatch(REAL_TX, room({ flip: true }))).toBeNull()
    expect(await codeOf(assertSealTx(TX, room({ flip: true }), chainWith({})))).toBe("ok")
  })

  it("refuses a transaction one of the room's wallets did not authorize", async () => {
    expect(await codeOf(assertSealTx(TX, room(), chainWith({ authorizers: ["3d0b274c80263484"] })))).toBe("409:bad_tx")
    expect(await codeOf(assertSealTx(TX, room(), chainWith({ authorizers: ["1111111111111111", "2222222222222222"] })))).toBe("409:bad_tx")
  })

  it("⚠ refuses ANOTHER trade between the same two wallets: different Moments", async () => {
    // the 10-31 c48f280a… swap: same wallets, same script, B gave nothing — a room for 3e1c… must not seal on it
    expect(await codeOf(assertSealTx(TX, room(), chainWith({ tx: { arguments: [...REAL_ARGS.slice(0, 5), arg(ids())] } })))).toBe("409:bad_tx")
    expect(txMismatch(REAL_TX, room({ aItems: ["27315405", "1"] }))).toBe("it moves different Moments")
    expect(txMismatch(REAL_TX, room({ bItems: [] }))).toBe("it moves different Moments")
  })

  it("⚠ refuses a transaction running a different script", async () => {
    expect(txMismatch({ ...REAL_TX, script: b64(MULTI_SWAP_CADENCE) }, room())).toBe("it runs a different transaction")
    expect(txMismatch({ ...REAL_TX, script: b64(SWAP_CADENCE + " ") }, room())).toBe("it runs a different transaction")
    expect(txMismatch({ ...REAL_TX, script: undefined }, room())).toBe("it runs a different transaction")
    expect(await codeOf(assertSealTx(TX, room(), chainWith({ tx: { script: b64("transaction {}") } })))).toBe("409:bad_tx")
  })

  it("⚠ refuses a transaction moving Moments from other wallets, or with its signers swapped", async () => {
    expect(txMismatch(REAL_TX, room({ aSource: "0x0000000000000001" }))).toBe("it moves Moments between other wallets")
    expect(txMismatch({ ...REAL_TX, authorizers: ["68c1fb83ba8e634a", "3d0b274c80263484"] }, room())).toBe("its signers are in the wrong roles")
    expect(txMismatch({ ...REAL_TX, arguments: ["not base64 json", ...REAL_ARGS.slice(1)] }, room())).toBe("its arguments don't decode as a trade")
  })

  it("refuses an unknown transaction and one that failed on chain", async () => {
    expect(await codeOf(assertSealTx(TX, room(), chainWith({ txStatus: 404 })))).toBe("409:bad_tx")
    expect(await codeOf(assertSealTx(TX, room(), chainWith({ resStatus: 400 })))).toBe("409:bad_tx")
    expect(await codeOf(assertSealTx(TX, room(), chainWith({ code: 1, error: "panic" })))).toBe("409:bad_tx")
  })

  it("a read that fails, or a transaction not final yet, is 503 + retryable — never 'not this trade'", async () => {
    expect(await codeOf(assertSealTx(TX, room(), chainWith({ throws: true })))).toBe("503:upstream_unavailable")
    expect(await codeOf(assertSealTx(TX, room(), chainWith({ txStatus: 502 })))).toBe("503:upstream_unavailable")
    expect(await codeOf(assertSealTx(TX, room(), chainWith({ status: "Pending" })))).toBe("503:upstream_unavailable")
  })

  it("rejects a malformed id before any read", async () => {
    let called = false
    const f = async () => {
      called = true
      return new Response("{}")
    }
    expect(await codeOf(assertSealTx("0xabc", room(), f))).toBe("400:bad_tx")
    expect(called).toBe(false)
  })
})
