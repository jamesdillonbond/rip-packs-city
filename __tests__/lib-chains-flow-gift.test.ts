import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Coverage for lib/chains/flow/gift.ts — the parent-signed gifting flow's
// server-side reads. Exercised through the public API (runLinkedChildren /
// runGiftQuote / quoteFailureReason) with a mocked proxy fetch, which drives
// the module's real parsing logic:
//   - extractResultB64: Flow REST /v1/scripts returns either a raw base64
//     string OR {"value":"<b64>"} OR a quoted string — all must decode.
//   - decodeDict: JSON-CDC {String: AnyStruct} Dictionary -> plain object.
//   - quoteFailureReason: the ordered precondition ladder (first-failing wins),
//     where a reordering bug would hand the client a misleading gift reason.

// PROXY_SECRET is read at module load from INGEST_SECRET_TOKEN — set it before
// the import so callProxyScript is configured (hoisted above the import).
vi.hoisted(() => {
  process.env.INGEST_SECRET_TOKEN = "test-secret"
})

import {
  runLinkedChildren,
  runGiftQuote,
  quoteFailureReason,
  type GiftQuoteChain,
} from "@/lib/chains/flow/gift"

// JSON-CDC node -> the base64 payload the worker returns (raw-b64 form).
const cdcRawB64 = (node: unknown) => Buffer.from(JSON.stringify(node)).toString("base64")

// A Response-like stub whose text() yields `body`.
const res = (status: number, body: string): any => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
})

const addr = (a: string) => ({ type: "Address", value: a })
const arrayNode = (addrs: string[]) => ({ type: "Array", value: addrs.map(addr) })
const boolKV = (k: string, v: boolean) => ({ key: { value: k }, value: { value: v } })
const strKV = (k: string, v: string) => ({ key: { value: k }, value: { value: v } })

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("runLinkedChildren", () => {
  it("decodes an Address array (raw-b64 response), filtering + lowercasing", async () => {
    fetchMock.mockResolvedValueOnce(res(200, cdcRawB64(arrayNode(["0xABCdef12", "0x00Ff"]))))
    const out = await runLinkedChildren("0xparent")
    expect(out).toEqual(["0xabcdef12", "0x00ff"])
  })

  it("handles the {\"value\":\"<b64>\"} wrapper form", async () => {
    const wrapped = JSON.stringify({ value: cdcRawB64(arrayNode(["0xAAA"])) })
    fetchMock.mockResolvedValueOnce(res(200, wrapped))
    expect(await runLinkedChildren("0xparent")).toEqual(["0xaaa"])
  })

  it("drops non-Address entries and returns [] for a non-array node", async () => {
    const mixed = { type: "Array", value: [addr("0xAAA"), { type: "UInt64", value: "7" }] }
    fetchMock.mockResolvedValueOnce(res(200, cdcRawB64(mixed)))
    expect(await runLinkedChildren("0xp")).toEqual(["0xaaa"])

    fetchMock.mockResolvedValueOnce(res(200, cdcRawB64({ type: "Bool", value: false })))
    expect(await runLinkedChildren("0xp")).toEqual([])
  })

  it("throws on a proxy HTTP error", async () => {
    fetchMock.mockResolvedValueOnce(res(502, "bad gateway"))
    await expect(runLinkedChildren("0xp")).rejects.toThrow(/proxy_http_502/)
  })
})

describe("runGiftQuote", () => {
  it("maps every precondition and coerces the controller id (string -> number)", async () => {
    const dict = {
      type: "Dictionary",
      value: [
        boolKV("parent_has_manager", true),
        boolKV("child_is_linked", true),
        boolKV("provider_controller_exists", true),
        strKV("provider_controller_id", "42"),
        boolKV("withdraw_permitted", true),
        boolKV("child_owns_moment", true),
        boolKV("recipient_ready", true),
      ],
    }
    fetchMock.mockResolvedValueOnce(res(200, cdcRawB64(dict)))
    const q = await runGiftQuote("0xp", "0xc", "12345", "0xr")
    expect(q).toEqual<GiftQuoteChain>({
      parentHasManager: true,
      childIsLinked: true,
      providerControllerExists: true,
      providerControllerID: 42,
      withdrawPermitted: true,
      childOwnsMoment: true,
      recipientReady: true,
    })
    // sends the 4 args in order (parent, child, momentID, recipient)
    const body = JSON.parse((fetchMock.mock.calls[0] as any[])[1].body)
    expect(body.arguments).toHaveLength(4)
  })

  it("defaults missing keys to false and a null controller id", async () => {
    const dict = {
      type: "Dictionary",
      value: [boolKV("parent_has_manager", true), boolKV("child_is_linked", false)],
    }
    fetchMock.mockResolvedValueOnce(res(200, cdcRawB64(dict)))
    const q = await runGiftQuote("0xp", "0xc", "1", "0xr")
    expect(q.parentHasManager).toBe(true)
    expect(q.childIsLinked).toBe(false)
    expect(q.providerControllerExists).toBe(false)
    expect(q.providerControllerID).toBeNull()
    expect(q.recipientReady).toBe(false)
  })
})

describe("quoteFailureReason — ordered precondition ladder", () => {
  const ok: GiftQuoteChain = {
    parentHasManager: true,
    childIsLinked: true,
    providerControllerExists: true,
    providerControllerID: 1,
    withdrawPermitted: true,
    childOwnsMoment: true,
    recipientReady: true,
  }

  it("returns null when every precondition passes", () => {
    expect(quoteFailureReason(ok)).toBeNull()
  })

  it("reports the FIRST failing rung (order: manager -> link -> withdraw -> owns -> recipient)", () => {
    expect(quoteFailureReason({ ...ok, parentHasManager: false })).toBe("no_manager")
    expect(quoteFailureReason({ ...ok, childIsLinked: false })).toBe("not_your_link")
    expect(quoteFailureReason({ ...ok, withdrawPermitted: false })).toBe("withdraw_not_permitted")
    expect(quoteFailureReason({ ...ok, providerControllerExists: false })).toBe("withdraw_not_permitted")
    expect(quoteFailureReason({ ...ok, childOwnsMoment: false })).toBe("moment_not_owned")
    expect(quoteFailureReason({ ...ok, recipientReady: false })).toBe("recipient_needs_setup")
  })

  it("earlier failures take precedence over later ones", () => {
    // manager missing AND recipient not ready -> manager wins (it is checked first)
    expect(quoteFailureReason({ ...ok, parentHasManager: false, recipientReady: false })).toBe("no_manager")
    // link missing AND moment not owned -> link wins
    expect(quoteFailureReason({ ...ok, childIsLinked: false, childOwnsMoment: false })).toBe("not_your_link")
  })
})
