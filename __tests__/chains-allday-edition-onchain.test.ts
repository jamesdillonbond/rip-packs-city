import { describe, it, expect, vi, afterEach } from "vitest"

// Unit tests for lib/chains/flow/allday-edition-onchain.ts — the on-chain
// AllDay edition-resolution helpers used by the unmapped-sales resolver.
// Previously 0% coverage. Every network call is a single fetch to Flow REST,
// so we stub global fetch with hand-built base64 JSON-CDC payloads (the same
// encoding the module decodes) and pin: address normalization, the script
// runner's decode + !ok/empty branches, the Deposit-events scanner (match /
// chunking / transport-skip / malformed-skip), the tx-buyer recovery
// (candidate set minus excluded, !ok, throw), and the editions row builder
// (circulation fallback, name composition, tier normalization, date guard).

import {
  normalizeAddress,
  runAllDayScript,
  scanAllDayDepositsForNft,
  fetchTxBuyers,
  buildOnChainEditionRow,
  EXCLUDED_ADDRESSES,
  ALLDAY_COLLECTION_ID,
  COLLECTION_SLUG,
} from "@/lib/chains/flow/allday-edition-onchain"

// ── JSON-CDC node builders ────────────────────────────────────────────────────
const cstr = (s: string) => ({ type: "String", value: s })
const uint64 = (n: number | string) => ({ type: "UInt64", value: String(n) })
const addr = (a: string) => ({ type: "Address", value: a })
const optional = (node: unknown) => ({ type: "Optional", value: node })
const dict = (pairs: Array<[string, string]>) => ({
  type: "Dictionary",
  value: pairs.map(([k, v]) => ({ key: cstr(k), value: cstr(v) })),
})
function eventNode(id: string, fields: Array<[string, unknown]>) {
  return { type: "Event", value: { id, fields: fields.map(([name, value]) => ({ name, value })) } }
}
function b64(node: unknown): string {
  return Buffer.from(JSON.stringify(node), "utf8").toString("base64")
}

afterEach(() => vi.unstubAllGlobals())

// ── normalizeAddress ──────────────────────────────────────────────────────────
describe("normalizeAddress", () => {
  it("lowercases, strips an existing 0x, and left-pads to 16 hex chars", () => {
    expect(normalizeAddress("0xE4CF4BDC1751C65D")).toBe("0xe4cf4bdc1751c65d")
    expect(normalizeAddress("abc")).toBe("0x0000000000000abc")
    expect(normalizeAddress("  0x18eb4ee6b3c026d2  ")).toBe("0x18eb4ee6b3c026d2")
  })
})

// ── runAllDayScript ───────────────────────────────────────────────────────────
describe("runAllDayScript", () => {
  function stubScript(bodyJson: unknown, ok = true, status = 200) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok, status, json: async () => bodyJson }) as any),
    )
  }

  it("decodes a base64 JSON-CDC Optional<Dictionary> returned as a bare string body", async () => {
    const payload = b64(optional(dict([["id", "1"], ["editionID", "42"], ["serialNumber", "7"]])))
    stubScript(payload) // Flow REST commonly returns the value as a JSON string
    const out = (await runAllDayScript("main() {}", [])) as Record<string, string>
    expect(out).toEqual({ id: "1", editionID: "42", serialNumber: "7" })
  })

  it("decodes when the body is an object carrying { value } and strips surrounding quotes", async () => {
    const payload = b64(optional(dict([["playID", "9"], ["setID", "3"]])))
    stubScript({ value: `"${payload}"` }) // quoted, object-wrapped
    const out = (await runAllDayScript("main() {}", [{ type: "UInt64", value: "1" }])) as Record<string, string>
    expect(out).toEqual({ playID: "9", setID: "3" })
  })

  it("returns null when the decoded value is an empty string", async () => {
    stubScript({ value: "" })
    expect(await runAllDayScript("main() {}", [])).toBeNull()
  })

  it("returns null for a nil (Optional null) script result", async () => {
    stubScript(b64(optional(null)))
    expect(await runAllDayScript("main() {}", [])).toBeNull()
  })

  it("base64-encodes the script and each argument in the request body", async () => {
    const spy = vi.fn(async () => ({ ok: true, status: 200, json: async () => b64(optional(dict([]))) }) as any)
    vi.stubGlobal("fetch", spy)
    await runAllDayScript("access(all) fun main() {}", [{ type: "UInt64", value: "5" }])
    const sentBody = JSON.parse((spy.mock.calls[0][1] as any).body)
    expect(Buffer.from(sentBody.script, "base64").toString("utf8")).toBe("access(all) fun main() {}")
    expect(JSON.parse(Buffer.from(sentBody.arguments[0], "base64").toString("utf8"))).toEqual({
      type: "UInt64",
      value: "5",
    })
  })

  it("unwraps a top-level Array of Structs (and inner Type nodes)", async () => {
    const structNode = {
      type: "Struct",
      value: {
        id: "S",
        fields: [
          { name: "label", value: cstr("x") },
          { name: "kind", value: { type: "Type", value: { staticType: { kind: "Int" } } } },
        ],
      },
    }
    stubScript(b64({ type: "Array", value: [structNode] }))
    const out = (await runAllDayScript("main() {}", [])) as any[]
    expect(out).toEqual([{ label: "x", kind: { staticType: { kind: "Int" } } }])
  })

  it("throws on a non-2xx REST response", async () => {
    stubScript({}, false, 500)
    await expect(runAllDayScript("main() {}", [])).rejects.toThrow(/script HTTP 500/)
  })
})

// ── scanAllDayDepositsForNft ──────────────────────────────────────────────────
describe("scanAllDayDepositsForNft", () => {
  function depositBlock(height: number, entries: Array<[string, string]>) {
    return {
      block_height: String(height),
      events: entries.map(([id, to]) =>
        ({ payload: b64(eventNode("A.e4cf4bdc1751c65d.AllDay.Deposit", [["id", uint64(id)], ["to", addr(to)]])) }),
      ),
    }
  }

  it("returns in-window recipients of the target nftId, normalizing the address", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          depositBlock(100, [["55", "0xAAAAAAAAAAAAAAAA"], ["99", "0xother"]]),
          depositBlock(140, [["55", "0xbbbbbbbbbbbbbbbb"]]),
        ],
      }) as any),
    )
    const chunks: number[] = []
    const out = await scanAllDayDepositsForNft("55", 0, 0, () => chunks.push(1))
    expect(out).toEqual([
      { block: 100, to: "0xaaaaaaaaaaaaaaaa" },
      { block: 140, to: "0xbbbbbbbbbbbbbbbb" },
    ])
    expect(chunks.length).toBe(1) // windowBlocks 0 → single range request
  })

  it("splits a >250-block window into multiple range requests (onChunk per request)", async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => [] }) as any)
    vi.stubGlobal("fetch", spy)
    let chunkCalls = 0
    const out = await scanAllDayDepositsForNft("1", 1000, 300, () => chunkCalls++)
    expect(out).toEqual([])
    expect(chunkCalls).toBe(2) // [1000..1249] + [1250..1300]
    expect(spy).toHaveBeenCalledTimes(2)
    const firstUrl = spy.mock.calls[0][0] as string
    expect(firstUrl).toContain("start_height=1000")
    expect(firstUrl).toContain("end_height=1249")
  })

  it("skips a chunk on a transport error and returns no candidates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET") }))
    expect(await scanAllDayDepositsForNft("1", 0, 0)).toEqual([])
  })

  it("skips a chunk on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => [] }) as any))
    expect(await scanAllDayDepositsForNft("1", 0, 0)).toEqual([])
  })

  it("ignores malformed payloads and events with no payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          { block_height: "10", events: [{ payload: "@@not-base64@@" }, { /* no payload */ }] },
          depositBlock(11, [["7", "0xcccccccccccccccc"]]),
        ],
      }) as any),
    )
    const out = await scanAllDayDepositsForNft("7", 0, 0)
    expect(out).toEqual([{ block: 11, to: "0xcccccccccccccccc" }])
  })
})

// ── fetchTxBuyers ─────────────────────────────────────────────────────────────
describe("fetchTxBuyers", () => {
  it("collects proposer/authorizers/payer and drops known escrow/fee addresses", async () => {
    const excluded = "0x18eb4ee6b3c026d2" // in EXCLUDED_ADDRESSES
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          proposal_key: { address: "0xAAAAAAAAAAAAAAAA" },
          authorizers: [excluded, "0xbbbbbbbbbbbbbbbb"],
          payer: "0xaaaaaaaaaaaaaaaa", // dup of proposer → set-deduped
        }),
      }) as any),
    )
    const out = await fetchTxBuyers("0xdeadbeef")
    expect(EXCLUDED_ADDRESSES.has(excluded)).toBe(true)
    expect(out.sort()).toEqual(["0xaaaaaaaaaaaaaaaa", "0xbbbbbbbbbbbbbbbb"])
    expect(out).not.toContain(excluded)
  })

  it("strips a 0x prefix from the tx id when building the REST path", async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ payer: "0xf1f1f1f1f1f1f1f1" }) }) as any)
    vi.stubGlobal("fetch", spy)
    await fetchTxBuyers("0xABC123")
    expect(spy.mock.calls[0][0]).toContain("/v1/transactions/ABC123")
  })

  it("returns [] on a non-2xx transaction fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) }) as any))
    expect(await fetchTxBuyers("0xabc")).toEqual([])
  })

  it("returns [] when the fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom") }))
    expect(await fetchTxBuyers("0xabc")).toEqual([])
  })
})

// ── buildOnChainEditionRow ────────────────────────────────────────────────────
describe("buildOnChainEditionRow", () => {
  const NOW = "2026-07-13T00:00:00.000Z"

  it("builds a full row: maxMintSize-driven circulation, composed name, normalized tier, valid game date", () => {
    const row = buildOnChainEditionRow(
      "42",
      {
        playerName: "Patrick Mahomes",
        setName: "Series 3 Base",
        teamName: "Kansas City Chiefs",
        tier: "legendary edition",
        maxMintSize: "500",
        numMinted: "120",
        seriesID: "3",
        setID: "77",
        playID: "88",
        playType: "Pass",
        dateOfMoment: "2024-09-08T20:00:00Z",
        homeTeamName: "KC",
        awayTeamName: "BAL",
      },
      NOW,
    )
    expect(row.external_id).toBe("42")
    expect(row.collection_id).toBe(ALLDAY_COLLECTION_ID)
    expect(row.collection).toBe(COLLECTION_SLUG)
    expect(row.name).toBe("Patrick Mahomes — Series 3 Base")
    expect(row.player_name).toBe("Patrick Mahomes")
    expect(row.set_name).toBe("Series 3 Base")
    expect(row.team_name).toBe("Kansas City Chiefs")
    expect(row.tier).toBe("LEGENDARY")
    expect(row.circulation_count).toBe(500) // maxMint wins
    expect(row.series).toBe(3)
    expect(row.set_id_onchain).toBe(77)
    expect(row.play_id_onchain).toBe(88)
    expect(row.play_type).toBe("Pass")
    expect(row.game_date).toBe("2024-09-08")
    expect(row.home_team).toBe("KC")
    expect(row.away_team).toBe("BAL")
    expect(row.updated_at).toBe(NOW)
  })

  it("falls back to numMinted for circulation when maxMintSize is blank/zero", () => {
    const row = buildOnChainEditionRow("1", { maxMintSize: "", numMinted: "250" }, NOW)
    expect(row.circulation_count).toBe(250)
  })

  it("yields null circulation when neither mint figure is a positive number", () => {
    const row = buildOnChainEditionRow("1", { maxMintSize: "x", numMinted: "0" }, NOW)
    expect(row.circulation_count).toBeNull()
  })

  it("composes name from a single side and nulls unknown tier / bad date / non-positive series", () => {
    const playerOnly = buildOnChainEditionRow("1", { playerName: "Solo Player", tier: "mystic", dateOfMoment: "not-a-date", seriesID: "0" }, NOW)
    expect(playerOnly.name).toBe("Solo Player")
    expect(playerOnly.tier).toBeNull()
    expect(playerOnly.game_date).toBeNull()
    expect(playerOnly.series).toBeNull()

    const setOnly = buildOnChainEditionRow("1", { setName: "Set Only" }, NOW)
    expect(setOnly.name).toBe("Set Only")
    expect(setOnly.player_name).toBeNull()

    const neither = buildOnChainEditionRow("1", {}, NOW)
    expect(neither.name).toBeNull()
    expect(neither.set_id_onchain).toBeNull()
    expect(neither.play_id_onchain).toBeNull()
  })

  it("normalizes the ULTIMATE/RARE/COMMON tier synonyms", () => {
    expect(buildOnChainEditionRow("1", { tier: "the ULTIMATE one" }, NOW).tier).toBe("ULTIMATE")
    expect(buildOnChainEditionRow("1", { tier: "super rare" }, NOW).tier).toBe("RARE")
    expect(buildOnChainEditionRow("1", { tier: "COMMON" }, NOW).tier).toBe("COMMON")
  })
})
