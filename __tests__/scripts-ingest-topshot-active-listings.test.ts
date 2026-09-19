import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import path from "node:path"
// A plain .mjs script — TS resolves it under allowJs, so no directive is needed.
// ⚠ An `@ts-expect-error` here is itself a tsc ERROR (TS2578, "unused directive"): green
// vitest, red typecheck, the repo's most-repeated CI breakage met from a new angle.
import { buildRow, parseAtlasBoundary, atlasBoundaryBody, dedupeRows } from "../scripts/ingest-topshot-active-listings.mjs"

// `scripts/ingest-topshot-active-listings.mjs` IS the whole of the
// `topshot-active-listings-ingest` workflow, and it had no test. It is one of only two
// CI-invoked scripts in the repo with no coverage at all (the other,
// find-swallowed-ledger-headings.awk, is now covered too).
//
// `buildRow` shapes every row this ingest writes: the ask price, the serial-level FMV
// estimate the underpriced-serials board compares against, and the deep link a collector
// clicks to go buy the moment. None of it errors when wrong — it just writes plausible
// rows.

const SCRIPT = path.resolve(__dirname, "../scripts/ingest-topshot-active-listings.mjs")

const target = {
  rpc_edition_id: "11111111-1111-1111-1111-111111111111",
  external_id: "48:1652",
  no1_estimate_usd: 9000,
  perfect_estimate_usd: 300,
}

describe("buildRow — the ask price", () => {
  it("converts cents to dollars", () => {
    expect(buildRow(target, { serialNumber: 5, priceCents: 12345 }, false).ask_usd).toBe(123.45)
  })

  // ⚠ The direction that matters: a MISSING price must stay null. A 0 here would be a
  // claim that the moment is listed for nothing, and the underpriced-serials board ranks
  // ASCENDING by ask — so a fabricated $0 would sit at the very top of a public board as
  // the best deal on the platform.
  it("leaves a missing price null rather than turning it into 0", () => {
    expect(buildRow(target, { serialNumber: 5, priceCents: null }, false).ask_usd).toBeNull()
    expect(buildRow(target, { serialNumber: 5 }, false).ask_usd).toBeNull()
  })

  it("keeps a genuine zero-cent ask as 0, distinct from absent (pinned as current behaviour)", () => {
    // Whether a $0 listing should be ingested at all is a product question; what must not
    // happen is the two collapsing into one value.
    expect(buildRow(target, { serialNumber: 5, priceCents: 0 }, false).ask_usd).toBe(0)
  })
})

describe("buildRow — the serial FMV estimate", () => {
  // #1 serials carry a very different estimate from an ordinary "perfect" serial (9000 vs
  // 300 in this fixture, and the real gap is comparable). Picking the wrong branch does not
  // error, it just prices the moment against the wrong benchmark — and the board's whole
  // output is ask-versus-this-number.
  it("uses the #1 estimate for a #1 serial", () => {
    expect(buildRow(target, { serialNumber: 1, priceCents: 100 }, true).serial_fmv_usd).toBe(9000)
  })

  it("uses the perfect-serial estimate otherwise", () => {
    expect(buildRow(target, { serialNumber: 25, priceCents: 100 }, false).serial_fmv_usd).toBe(300)
  })

  it("withholds the estimate when the chosen one is absent, rather than falling back to the other", () => {
    // Substituting the other branch's number would silently benchmark a #1 against an
    // ordinary serial's value (or vice versa) — a wrong answer wearing a right one's clothes.
    expect(
      buildRow({ ...target, no1_estimate_usd: null }, { serialNumber: 1, priceCents: 100 }, true)
        .serial_fmv_usd,
    ).toBeNull()
    expect(
      buildRow({ ...target, perfect_estimate_usd: undefined }, { serialNumber: 9, priceCents: 100 }, false)
        .serial_fmv_usd,
    ).toBeNull()
  })
})

describe("buildRow — the deep link", () => {
  it("builds the dapper.market moment URL from the on-chain nft id", () => {
    const r = buildRow(target, { serialNumber: 5, priceCents: 100, nftId: 987654 }, false)
    expect(r.listing_url).toBe("https://dapper.market/nba/moment/987654")
  })

  // ⚠ Without the guard this would produce ".../moment/null" — a live-looking link that
  // 404s, handed to a collector at the exact moment they have decided to buy. A null URL
  // degrades to the board's own fallback instead.
  it("returns null rather than a URL containing 'null' when the nft id is missing", () => {
    for (const tx of [{ serialNumber: 5, priceCents: 1, nftId: null }, { serialNumber: 5, priceCents: 1 }]) {
      const r = buildRow(target, tx, false)
      expect(r.listing_url).toBeNull()
      expect(r.nft_id).toBeNull()
    }
  })

  it("percent-encodes the id rather than interpolating it raw", () => {
    const r = buildRow(target, { serialNumber: 5, priceCents: 1, nftId: "a/b?c" }, false)
    expect(r.listing_url).toBe("https://dapper.market/nba/moment/a%2Fb%3Fc")
  })
})

describe("buildRow — identifiers", () => {
  // Flow nft ids are 64-bit. Kept as text so a large id cannot lose precision on the way
  // through JSON, and so the value joins against the text columns downstream.
  it("stores the nft id as a string, not a number", () => {
    expect(buildRow(target, { serialNumber: 5, priceCents: 1, nftId: 12345 }, false).nft_id).toBe("12345")
    expect(typeof buildRow(target, { serialNumber: 5, priceCents: 1, nftId: "678" }, false).nft_id).toBe("string")
  })

  it("carries the edition identity from the target, not the transaction", () => {
    const r = buildRow(target, { serialNumber: 5, priceCents: 1, nftId: "1" }, false)
    expect(r.edition_id).toBe(target.rpc_edition_id)
    expect(r.edition_key).toBe(target.external_id)
  })

  it("coerces the serial to a number", () => {
    expect(buildRow(target, { serialNumber: "42", priceCents: 1 }, false).serial_number).toBe(42)
  })

  it("passes listing identity and time through as null when absent", () => {
    const r = buildRow(target, { serialNumber: 1, priceCents: 1 }, false)
    expect(r.listing_resource_id).toBeNull()
    expect(r.listed_at).toBeNull()
  })
})

describe("the script still runs when invoked directly", () => {
  // ⚠ THE POINT OF THIS CASE. Making the module importable meant guarding its entrypoint,
  // and a wrong guard fails SILENTLY: the workflow would exit 0 having done nothing and
  // written no pipeline_runs row — indistinguishable from "the cron never fired", which is
  // the invisible-failure shape CLAUDE.md records for the 401'd catalog cron and the
  // gate-key outage. So the guard is verified by SPAWNING the script, not by reading it.
  it("reaches main() and fails fast on the missing token, exit code 1", () => {
    let status = 0
    let stderr = ""
    try {
      execFileSync(process.execPath, [SCRIPT], {
        encoding: "utf8",
        env: { ...process.env, INGEST_SECRET_TOKEN: "" },
        timeout: 60_000,
      })
    } catch (e) {
      const err = e as { status?: number; stderr?: string }
      status = err.status ?? -1
      stderr = err.stderr ?? ""
    }
    expect(stderr).toContain("missing INGEST_SECRET_TOKEN")
    expect(status).toBe(1)
  })

  it("importing it does NOT run main (that is what makes the tests above possible)", () => {
    // If the entrypoint guard regressed, importing this module at the top of THIS FILE
    // would have exited the vitest process before any test ran. Reaching this line is the
    // assertion; the expect makes it explicit rather than incidental.
    expect(typeof buildRow).toBe("function")
  })
})

// ── the shared Atlas response rule (2026-09-19, ATLAS_FETCH_MODE=browser) ────────────
// The night of 09-18 Cloudflare began answering curl with a JavaScript challenge from
// both arms (known-issues #125). Both transports — curl and the new browser page — are
// now judged by ONE parser, so a challenge page is classified the same way whichever
// path fetched it, and the egress-probe short-circuit in main() sees the same signal.
const CHALLENGE_HTML =
  '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta http-equiv="Content-Type" content="text/html">'

describe("parseAtlasBoundary — one rule for every transport", () => {
  it("returns the first transaction from a JSON body", () => {
    const r = parseAtlasBoundary('{"transactions":[{"nftId":"7618856","serialNumber":"1","priceCents":"13500"}]}', 200)
    expect("tx" in r && r.tx?.nftId).toBe("7618856")
  })

  it("returns tx:null when nothing is listed — distinct from a block", () => {
    const r = parseAtlasBoundary('{"transactions":[]}', 200)
    expect(r).toEqual({ tx: null })
  })

  it("classifies the Cloudflare challenge page as a block, naming the mechanism, for a 403", () => {
    const r = parseAtlasBoundary(CHALLENGE_HTML, 403)
    expect("blocked" in r).toBe(true)
    expect((r as { blocked: string }).blocked).toMatch(/^challenge 403/)
  })

  it("classifies the same page as a challenge when the transport carries no status (curl)", () => {
    const r = parseAtlasBoundary(CHALLENGE_HTML, null)
    expect((r as { blocked: string }).blocked).toMatch(/^challenge:/)
  })

  it("keeps the legacy wording for a non-JSON body that is not a challenge", () => {
    const r = parseAtlasBoundary("error code: 1015", null)
    expect((r as { blocked: string }).blocked).toMatch(/^non-JSON \(WAF block\/throttle\)/)
  })

  it("treats any non-200 status as a block even when the body is JSON", () => {
    const r = parseAtlasBoundary('{"message":"rate limited"}', 429)
    expect((r as { blocked: string }).blocked).toMatch(/^http 429/)
  })

  it("never returns a tx from a block", () => {
    for (const [text, status] of [[CHALLENGE_HTML, 403], ["", 502], ["<html>", null]] as const) {
      const r = parseAtlasBoundary(text as string, status as number | null)
      expect("tx" in r).toBe(false)
    }
  })
})

describe("atlasBoundaryBody — the request both transports send", () => {
  it("is the exact SearchMarketplaceTransactions shape the console probe and the workflow use", () => {
    const b = JSON.parse(atlasBoundaryBody(2402, "ASC"))
    expect(b).toEqual({
      product: "nba",
      completed: false,
      editionId: "2402",
      sortByOption: "SERIAL_NUMBER",
      sortByDirection: "ASC",
      limit: "1",
      offset: "0",
      offers: false,
    })
  })

  it("stringifies the edition id (Atlas rejects a numeric editionId)", () => {
    expect(JSON.parse(atlasBoundaryBody(15601, "DESC")).editionId).toBe("15601")
  })
})

describe("ATLAS_FETCH_MODE is validated at startup", () => {
  it("a misspelt mode fails fast with exit 1 rather than silently curling", () => {
    let status = 0
    let stderr = ""
    try {
      execFileSync(process.execPath, [SCRIPT], {
        encoding: "utf8",
        env: { ...process.env, INGEST_SECRET_TOKEN: "x", ATLAS_FETCH_MODE: "brwoser" },
        timeout: 60_000,
      })
    } catch (e) {
      const err = e as { status?: number; stderr?: string }
      status = err.status ?? -1
      stderr = err.stderr ?? ""
    }
    expect(status).toBe(1)
    expect(stderr).toMatch(/ATLAS_FETCH_MODE must be curl or browser/)
  })
})

describe("dedupeRows — one row per (edition_id, serial_number) before an upsert", () => {
  // A 1-of-1 edition yields the same listing at both boundaries; two rows with one
  // primary key in a single INSERT is a Postgres error that discards the whole chunk.
  const one = { rpc_edition_id: "e1", external_id: "1:1", no1_estimate_usd: 500, perfect_estimate_usd: 500, circulation_count: 1 }
  it("collapses the #1 and perfect rows of a 1-of-1 into one, keeping the #1 pick", () => {
    const tx = { serialNumber: 1, priceCents: 12345, nftId: "77", uuid: "u" }
    const rows = dedupeRows([buildRow(one, tx, true), buildRow(one, tx, false)])
    expect(rows).toHaveLength(1)
    expect(rows[0].serial_fmv_usd).toBe(500)
  })
  it("keeps distinct serials of the same edition and the same serial of different editions", () => {
    const a = buildRow({ ...one, circulation_count: 99 }, { serialNumber: 1, priceCents: 1 }, true)
    const b = buildRow({ ...one, circulation_count: 99 }, { serialNumber: 99, priceCents: 1 }, false)
    const c = buildRow({ ...one, rpc_edition_id: "e2" }, { serialNumber: 1, priceCents: 1 }, true)
    expect(dedupeRows([a, b, c])).toHaveLength(3)
  })
  it("is a no-op on an already-unique buffer and preserves order", () => {
    const rows = [1, 2, 3].map((n) => buildRow(one, { serialNumber: n, priceCents: n }, n === 1))
    expect(dedupeRows(rows).map((r) => r.serial_number)).toEqual([1, 2, 3])
  })
})
