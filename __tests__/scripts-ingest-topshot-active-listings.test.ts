import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import path from "node:path"
// A plain .mjs script — TS resolves it under allowJs, so no directive is needed.
// ⚠ An `@ts-expect-error` here is itself a tsc ERROR (TS2578, "unused directive"): green
// vitest, red typecheck, the repo's most-repeated CI breakage met from a new angle.
import { buildRow } from "../scripts/ingest-topshot-active-listings.mjs"

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
