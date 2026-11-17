import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  b64Utf8,
  b64ToUtf8,
  flattenCadenceDict,
  pickPlayerName,
  parseResolvedMeta,
  isUnresolvableMissingPlayer,
} from "@/supabase/functions/_shared/topshot-stub-parse"

// Pins topshot-stub-resolver's parse/decode core — the logic that decides what
// player/set/team name lands in `editions`. The mojibake trap here is the same
// class that corrupted 55 pack titles + 308 metadata rows on a sibling path.

describe("b64Utf8 / b64ToUtf8 — UTF-8-safe base64 round-trip (the mojibake guard)", () => {
  it("round-trips ASCII unchanged", () => {
    expect(b64ToUtf8(b64Utf8("Base Set"))).toBe("Base Set")
  })
  it("round-trips non-ASCII player names WITHOUT double-encoding", () => {
    for (const name of ["Dončić", "Jokić", "Şengün", "Nikola Jokić"]) {
      expect(b64ToUtf8(b64Utf8(name))).toBe(name)
    }
  })
  it("b64ToUtf8 differs from a latin1 atob on multi-byte input (proves the fix matters)", () => {
    const encoded = b64Utf8("Dončić")
    // atob (latin1) would mojibake; b64ToUtf8 must NOT equal it.
    expect(b64ToUtf8(encoded)).toBe("Dončić")
    expect(atob(encoded)).not.toBe("Dončić")
  })
})

describe("flattenCadenceDict — Flow REST {String:String} → JS dict", () => {
  it("flattens key/value string pairs", () => {
    const parsed = {
      value: [
        { key: { value: "FullName" }, value: { value: "LeBron James" } },
        { key: { value: "__SetName" }, value: { value: "Base Set" } },
      ],
    }
    expect(flattenCadenceDict(parsed)).toEqual({ FullName: "LeBron James", __SetName: "Base Set" })
  })
  it("skips non-string entries, never throws", () => {
    const parsed = {
      value: [
        { key: { value: "A" }, value: { value: "x" } },
        { key: { value: "B" }, value: { value: 5 } }, // non-string value → skipped
        { key: { value: 7 }, value: { value: "y" } }, // non-string key → skipped
      ],
    }
    expect(flattenCadenceDict(parsed)).toEqual({ A: "x" })
  })
  it("a non-array / malformed payload → empty dict", () => {
    expect(flattenCadenceDict(null)).toEqual({})
    expect(flattenCadenceDict({})).toEqual({})
    expect(flattenCadenceDict({ value: "nope" })).toEqual({})
  })
})

describe("pickPlayerName — FullName with FirstName/LastName fallback", () => {
  it("prefers a trimmed FullName", () => {
    expect(pickPlayerName({ FullName: "  Kevin Durant  " })).toBe("Kevin Durant")
  })
  it("falls back to First + Last when FullName is the literal <invalid Value>", () => {
    expect(pickPlayerName({ FullName: "<invalid Value>", FirstName: "Ja", LastName: "Morant" })).toBe(
      "Ja Morant",
    )
  })
  it("falls back when FullName is empty/whitespace", () => {
    expect(pickPlayerName({ FullName: "   ", FirstName: "Luka", LastName: "Dončić" })).toBe(
      "Luka Dončić",
    )
  })
  it("composes with only one of first/last present", () => {
    expect(pickPlayerName({ FirstName: "Giannis" })).toBe("Giannis")
    expect(pickPlayerName({ LastName: "Embiid" })).toBe("Embiid")
  })
  it("returns null when nothing usable exists (team-moment play)", () => {
    expect(pickPlayerName({})).toBeNull()
    expect(pickPlayerName({ FullName: "<invalid Value>" })).toBeNull()
  })

  // Regression, 2026-07-27. FirstName/LastName carry the SAME "<invalid Value>"
  // sentinel as FullName. Guarding only FullName let the fallback COMPOSE the
  // literal string "<invalid Value> <invalid Value>" and write it into
  // editions.player_name — which feeds player pages, slugs, search and the pooled
  // serial-FMV set/player effects. Live on 4 of 42 sampled stub targets (set 141,
  // "The Champion's Path 2024"); it had never fired only because the resolver's
  // queue was stuck on its first 50 rows and never reached them.
  it("does not compose the <invalid Value> sentinel out of FirstName/LastName", () => {
    expect(
      pickPlayerName({ FullName: "<invalid Value>", FirstName: "<invalid Value>", LastName: "<invalid Value>" }),
    ).toBeNull()
    expect(pickPlayerName({ FirstName: "<invalid Value>" })).toBeNull()
    expect(pickPlayerName({ LastName: "<invalid Value>" })).toBeNull()
  })

  it("still uses the half of the name that IS valid", () => {
    expect(pickPlayerName({ FullName: "<invalid Value>", FirstName: "Zion", LastName: "<invalid Value>" })).toBe(
      "Zion",
    )
    expect(pickPlayerName({ FirstName: "<invalid Value>", LastName: "Wembanyama" })).toBe("Wembanyama")
  })
})

describe("parseResolvedMeta — coercion into the editions write payload", () => {
  it("shapes a full meta dict", () => {
    const r = parseResolvedMeta({
      FullName: "Anthony Edwards",
      __SetName: "  Rookie Debut  ",
      __SetSeries: "5",
      __Circulation: "749",
      TeamAtMoment: "  Minnesota Timberwolves  ",
    })
    expect(r).toEqual({
      playerName: "Anthony Edwards",
      setName: "Rookie Debut",
      circulation: 749,
      team: "Minnesota Timberwolves",
      series: 5,
    })
  })
  it("series/circulation are null (never NaN) when non-numeric on chain", () => {
    const r = parseResolvedMeta({ FullName: "X", __SetSeries: "n/a", __Circulation: "n/a" })
    expect(r.series).toBeNull()
    expect(r.circulation).toBeNull()
  })
  it("verbatim edge behavior: an empty-string numeric coerces to 0, not null (Number('')===0)", () => {
    // Documents the real inline behavior so a future 'fix' to null is a conscious
    // change, not an accident. __Circulation is only set when on-chain returns it.
    expect(parseResolvedMeta({ FullName: "X", __Circulation: "" }).circulation).toBe(0)
  })
  it("series 0 is kept (a real on-chain value, Series 1)", () => {
    expect(parseResolvedMeta({ FullName: "X", __SetSeries: "0" }).series).toBe(0)
  })
  it("empty setName/team trim to null", () => {
    const r = parseResolvedMeta({ FullName: "X", __SetName: "   ", TeamAtMoment: "" })
    expect(r.setName).toBeNull()
    expect(r.team).toBeNull()
  })
})

describe("edge-fn source-drift guard — topshot-stub-resolver inline copies", () => {
  const root = process.cwd()
  const norm = (s: string) => s.replace(/\s+/g, " ").trim()
  const edgeSrc = norm(
    readFileSync(path.join(root, "supabase/functions/topshot-stub-resolver/index.ts"), "utf8"),
  )
  const importsShared = /from\s+["'][^"']*_shared\/topshot-stub-parse/.test(edgeSrc)

  // Canonical inline expressions (whitespace-normalized) — an un-mirrored edit
  // reddens CI. Import-or-inline pattern like the other edge-fn guards.
  const DECODE = norm("new TextDecoder(\"utf-8\").decode(bytes)")
  const INVALID_GUARD = norm('full && full !== "<invalid Value>" && full.trim() !== ""')
  const SERIES_COERCE = norm("Number.isFinite(Number(seriesRaw)) ? Number(seriesRaw) : null")

  it.each([
    ["utf-8 decode", DECODE],
    ["<invalid Value> guard", INVALID_GUARD],
    ["series numeric coercion", SERIES_COERCE],
  ])("edge fn imports _shared, or carries the inline %s verbatim", (_label, expr) => {
    expect(importsShared || edgeSrc.includes(expr)).toBe(true)
  })
})

describe("flattenCadenceDict parity — both stub resolvers match _shared/topshot-stub-parse", () => {
  // topshot-stub-resolver and ufc-stub-thumbnail-resolver both carry an inline
  // flattenCadenceDict identical to the _shared export (tested above). Pin them so
  // an un-mirrored edit to either inline copy reddens CI.
  const root = process.cwd()
  const norm = (s: string) =>
    s.replace(/\/\/[^\n]*/g, "").replace(/^\s*export\s+/, "").replace(/\s+/g, " ").trim()
  function extractFn(src: string, name: string): string | null {
    const sig = src.search(new RegExp(`(export\\s+)?function ${name}\\(`))
    if (sig < 0) return null
    const open = src.indexOf("{", sig)
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++
      else if (src[i] === "}") {
        depth--
        if (depth === 0) return norm(src.slice(sig, i + 1))
      }
    }
    return null
  }
  const shared = extractFn(
    readFileSync(path.join(root, "supabase/functions/_shared/topshot-stub-parse.ts"), "utf8"),
    "flattenCadenceDict",
  )
  it.each(["topshot-stub-resolver", "ufc-stub-thumbnail-resolver"])(
    "%s inline flattenCadenceDict == _shared",
    (fn) => {
      const inline = extractFn(
        readFileSync(path.join(root, `supabase/functions/${fn}/index.ts`), "utf8"),
        "flattenCadenceDict",
      )
      expect(inline).not.toBeNull()
      expect(inline).toBe(shared)
    },
  )
})

describe("isUnresolvableMissingPlayer — the per-FIELD test the AND-guard cannot express", () => {
  // MEASURED 2026-08-28: resolve-topshot-stubs ran 88 times in 48 h over 520
  // eligible editions (~4,400 Cadence calls) with `rows_resolved: 0` on EVERY
  // run, while `rows_skipped_no_player_data` stayed 0 — so its telemetry could
  // not distinguish "re-attempting the impossible" from "already up to date".
  // The stuck rows are Top Shot Reels sampled live off the queue head.

  it("is TRUE when the edition needs a player and the chain has none (the stuck case)", () => {
    expect(isUnresolvableMissingPlayer(false, null)).toBe(true)
  })

  it("is FALSE when the chain CAN supply the missing player (a real repair)", () => {
    expect(isUnresolvableMissingPlayer(false, "LeBron James")).toBe(false)
  })

  it("is FALSE when the edition already has a player name", () => {
    expect(isUnresolvableMissingPlayer(true, null)).toBe(false)
    expect(isUnresolvableMissingPlayer(true, "Joel Embiid")).toBe(false)
  })

  it("catches what the resolver's own `!playerName && !setName` guard misses", () => {
    // The exact shape measured on mainnet for external_id 118:4151::8 —
    // PlayType "Reel", a real set name, no FullName. The AND-guard sees a
    // setName and lets it through; this predicate sees the missing player.
    const meta = { __SetName: "2022-23 Season Rewind", TeamAtMoment: "Philadelphia 76ers" }
    const resolved = parseResolvedMeta(meta)
    expect(resolved.playerName).toBeNull()
    expect(resolved.setName).toBe("2022-23 Season Rewind")

    const andGuardWouldSkip = !resolved.playerName && !resolved.setName
    expect(andGuardWouldSkip).toBe(false) // ← the blind spot, pinned
    expect(isUnresolvableMissingPlayer(false, resolved.playerName)).toBe(true)
  })
})

describe("edge-fn source-drift guard — the unresolvable-player sub-count", () => {
  const root = process.cwd()
  const norm = (s: string) => s.replace(/\s+/g, " ").trim()
  const edgeSrc = norm(
    readFileSync(path.join(root, "supabase/functions/topshot-stub-resolver/index.ts"), "utf8"),
  )
  const importsShared = /from\s+["'][^"']*_shared\/topshot-stub-parse/.test(edgeSrc)

  it("the resolver imports _shared, or carries the inline predicate verbatim", () => {
    // Same import-or-inline shape as the guards above. If someone rewrites the
    // classification in index.ts without mirroring it here, this reddens.
    const INLINE = norm("if (!t.has_player_name && !resolved.playerName) {")
    expect(importsShared || edgeSrc.includes(INLINE)).toBe(true)
  })

  it("the resolver still declares the sub-counter it logs", () => {
    expect(edgeSrc.includes(norm("rows_no_change_no_onchain_player: 0,"))).toBe(true)
    expect(edgeSrc.includes(norm("counters.rows_no_change_no_onchain_player++"))).toBe(true)
  })

  it("the sub-count did NOT replace rows_no_change (existing consumers must keep working)", () => {
    expect(edgeSrc.includes(norm("counters.rows_no_change++"))).toBe(true)
  })
})
