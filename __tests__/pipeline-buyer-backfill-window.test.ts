import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { CURRENT_SPORK_START_ISO, buyerBackfillVerdict } from "@/lib/pipeline/buyer-backfill-window"

// #192: the All Day/Golazos buyer backfill walked rows older than mainnet27's
// root (2025-10-22), which current-spork REST cannot decode — 480 of 480 failed
// every run, 0 written, ok=true. These pin the floor and the verdict.
describe("buyer backfill window + verdict (#192)", () => {
  it("floors the window at mainnet27's root, not a calendar year", () => {
    expect(CURRENT_SPORK_START_ISO).toBe("2025-10-22T00:00:00Z")
    const route = readFileSync("app/api/admin/backfill-allday-buyers/route.ts", "utf8")
    expect(route).toMatch(/const FORWARD_WINDOW_START = CURRENT_SPORK_START_ISO/)
    expect(route).not.toMatch(/"2025-01-01T00:00:00Z"/)
  })

  it("a batch where every row fails to decode is a FAILED run, not ok", () => {
    const v = buyerBackfillVerdict({ found: 480, decodeFailed: 480, updateFailed: 0 })
    expect(v.ok).toBe(false)
    expect(v.error).toMatch(/decode wall/)
  })

  it("a swallowed UPDATE error fails the run", () => {
    expect(buyerBackfillVerdict({ found: 10, decodeFailed: 0, updateFailed: 1 }).ok).toBe(false)
  })

  it("partial decode misses and an empty batch stay ok", () => {
    expect(buyerBackfillVerdict({ found: 480, decodeFailed: 12, updateFailed: 0 })).toEqual({ ok: true, error: null })
    expect(buyerBackfillVerdict({ found: 0, decodeFailed: 0, updateFailed: 0 }).ok).toBe(true)
  })

  it("the route counts update errors and applies the verdict", () => {
    const route = readFileSync("app/api/admin/backfill-allday-buyers/route.ts", "utf8")
    expect(route).toMatch(/updateFailed\+\+/)
    expect(route).toMatch(/buyerBackfillVerdict\(\{ found, decodeFailed, updateFailed, custodial \}\)/)
    expect(route).toMatch(/update_failed: updateFailed/)
  })
})

// 2026-10-22 (inbox 2026-10-23T0310Z): ~1,295 All Day sales (mostly 05-18 → 06-29) deposit to the
// Dapper custodian 0xddfbe848a81b2236. The decoder rightly returns no buyer; counted as decode
// failures, every batch in that band was a "decode wall" and the pipeline flapped red each wrap.
describe("buyer backfill verdict — custodial deposits are not decode failures", () => {
  it("a batch of only custodial rows is ok — the txs decoded and say no buyer is knowable", () => {
    expect(buyerBackfillVerdict({ found: 480, decodeFailed: 0, updateFailed: 0, custodial: 480 })).toEqual({ ok: true, error: null })
  })
  it("CONTROL: genuine failures among the non-custodial rows still make a wall", () => {
    const v = buyerBackfillVerdict({ found: 480, decodeFailed: 30, updateFailed: 0, custodial: 450 })
    expect(v.ok).toBe(false)
    expect(v.error).toMatch(/all 30 non-custodial rows/)
  })
  it("a mixed batch that resolved some rows stays ok", () => {
    expect(buyerBackfillVerdict({ found: 480, decodeFailed: 10, updateFailed: 0, custodial: 400 }).ok).toBe(true)
  })
  // The persistence half (Cowork, 10-22 ~9 PM PT): without it every cursor wrap
  // re-fetched ~1,300 custodial txs and spent 3 runs in 8 before a new row.
  // 10-22 ~11:20 PM PT (first run's outcome table): 154 of the 480 rows the lane
  // stamped were proposed by the DUC co-signer, not the custodian, so an exclusion
  // keyed on "proposer IS a custodial target" let a third of the churn back in.
  // The lane is the only writer of proposer_address on these rows: the STAMP is
  // the exclusion, whichever signer proposed.
  it("the candidate select excludes rows already STAMPED custodial-held (proposer_address IS NULL), never keyed on which signer proposed, never on buyer_address", () => {
    const route = readFileSync("app/api/admin/backfill-allday-buyers/route.ts", "utf8")
    expect(route).toMatch(/\.is\("proposer_address", null\)/)
    // the signer-keyed form is the defect: a co-signer-proposed row escaped it
    expect(route).not.toMatch(/proposer_address\.not\.in\./)
    expect(route).not.toMatch(/custodialProposerFilter/)
    // the custodian never lands in buyer_address (#83)
    expect(route).not.toMatch(/buyer_address\s*=\s*signers\.proposer/)
    expect(route).not.toMatch(/patch\.buyer_address\s*=\s*signers\.proposer/)
    // a signers write only after the tx was actually read
    expect(route).toMatch(/dec\.custodialDeposit === true && signers\.ok && signers\.proposer !== null/)
    expect(route).toContain("custodial_recorded: custodialRecorded")
  })

  it("the route counts a custodial no-buyer row as custodial, not decode_failed, and reports it", () => {
    const route = readFileSync("app/api/admin/backfill-allday-buyers/route.ts", "utf8")
    expect(route).toMatch(/if \(dec\.custodialDeposit\) custodial\+\+\s*else decodeFailed\+\+/)
    expect(route).toContain("custodial_deposit: custodial")
  })
})
