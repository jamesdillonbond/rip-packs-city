import { describe, it, expect, vi } from "vitest"
import {
  checkCronGate,
  cronGate,
  cronGateResponse,
  presentedGateKey,
  timingSafeEqual,
  GATE_HEADER,
} from "../supabase/functions/_shared/cron-gate"

// The shared Vault-backed gate for pg_cron-dispatched edge functions
// (2026-10-13, D2b). The properties pinned are the ones whose failure would
// either open the gate (a missing/blank key accepted) or make a database blip
// indistinguishable from a wrong key (a failed Vault read answered as 403).

const KEY = "rpc_pls_0123456789abcdef0123456789abcdef"
const vault = (data: unknown, error: { message?: string } | null = null) => {
  const rpc = vi.fn(async () => ({ data, error }))
  return { sb: { rpc }, rpc }
}
const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers })

describe("presentedGateKey", () => {
  it("prefers the header over ?key=", () => {
    expect(presentedGateKey(req("https://x/f?key=fromquery", { [GATE_HEADER]: "fromheader" }))).toBe("fromheader")
  })
  it("falls back to ?key=", () => {
    expect(presentedGateKey(req("https://x/f?key=fromquery"))).toBe("fromquery")
  })
  it("treats a blank header or an empty ?key= as ABSENT, never as a key", () => {
    expect(presentedGateKey(req("https://x/f?key=", { [GATE_HEADER]: "  " }))).toBeNull()
    expect(presentedGateKey(req("https://x/f"))).toBeNull()
  })
})

describe("checkCronGate — three outcomes", () => {
  it("ok when the presented key equals the Vault value, and it asks for THIS function's secret", async () => {
    const { sb, rpc } = vault(KEY)
    expect(await checkCronGate(req(`https://x/f?key=${KEY}`), sb, "ingest-golazos-pack-opens")).toBe("ok")
    expect(rpc).toHaveBeenCalledWith("cron_gate_key", { p_fn: "ingest-golazos-pack-opens" })
  })
  it("ok via the header too", async () => {
    const { sb } = vault(KEY)
    expect(await checkCronGate(req("https://x/f", { [GATE_HEADER]: KEY }), sb, "fn")).toBe("ok")
  })
  it("denied for a wrong key", async () => {
    const { sb } = vault(KEY)
    expect(await checkCronGate(req("https://x/f?key=rpc_pls_wrong"), sb, "fn")).toBe("denied")
  })
  it("denied with NO key — and does not even read Vault", async () => {
    const { sb, rpc } = vault(KEY)
    expect(await checkCronGate(req("https://x/f"), sb, "fn")).toBe("denied")
    expect(rpc).not.toHaveBeenCalled()
  })
  it("UNAVAILABLE (not denied) when the Vault read errors", async () => {
    const { sb } = vault(null, { message: "cron_gate_key: no vault secret named cron_gate_key__fn" })
    expect(await checkCronGate(req(`https://x/f?key=${KEY}`), sb, "fn")).toBe("unavailable")
  })
  it("UNAVAILABLE when Vault returns an empty or non-string value — never compared against ''", async () => {
    for (const data of ["", null, 42]) {
      const { sb } = vault(data)
      expect(await checkCronGate(req("https://x/f?key=x"), sb, "fn"), JSON.stringify(data)).toBe("unavailable")
    }
  })
  it("UNAVAILABLE when the read throws", async () => {
    const sb = { rpc: vi.fn(async () => { throw new Error("fetch failed") }) }
    expect(await checkCronGate(req(`https://x/f?key=${KEY}`), sb, "fn")).toBe("unavailable")
  })
})

describe("cronGateResponse / cronGate", () => {
  it("null for ok, 403 for denied, 503 + retry-after for unavailable", async () => {
    expect(cronGateResponse("ok")).toBeNull()
    expect(cronGateResponse("denied")!.status).toBe(403)
    const u = cronGateResponse("unavailable")!
    expect(u.status).toBe(503)
    expect(u.headers.get("retry-after")).toBe("60")
    expect(await u.json()).toEqual({ error: "gate_unavailable", retry: true })
  })
  it("cronGate composes the two", async () => {
    expect(await cronGate(req(`https://x/f?key=${KEY}`), vault(KEY).sb, "fn")).toBeNull()
    expect((await cronGate(req("https://x/f?key=nope"), vault(KEY).sb, "fn"))!.status).toBe(403)
  })
})

describe("timingSafeEqual", () => {
  it("equal strings match; any difference, including length, does not", () => {
    expect(timingSafeEqual(KEY, KEY)).toBe(true)
    expect(timingSafeEqual(KEY, KEY + "x")).toBe(false)
    expect(timingSafeEqual(KEY, KEY.slice(0, -1) + "0")).toBe(false)
    expect(timingSafeEqual("", "")).toBe(true)
    expect(timingSafeEqual("", "a")).toBe(false)
  })
})
