import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { CURRENT_SPORK_START_ISO, buyerBackfillVerdict, cursorOrFilter, cursorRowBelow } from "@/lib/pipeline/buyer-backfill-window"

// #192: the All Day/Golazos buyer backfill walked rows older than mainnet27's
// root (2025-10-22), which current-spork REST cannot decode — 480 of 480 failed
// every run, 0 written, ok=true. These pin the floor and the verdict.
describe("buyer backfill window + verdict (#192)", () => {
  it("floors the window at the root block of the spork rest-mainnet serves, not a calendar date", () => {
    // 2026-10-23: the root block of the spork rest-mainnet.onflow.org serves
    // (mainnet28, 137,390,146), not a midnight date — a date floor admitted 41
    // pre-mainnet27 rows that failed every wrap.
    expect(CURRENT_SPORK_START_ISO).toBe("2025-12-29T03:11:27Z")
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

// 2026-10-23: the walk's cursor is (sold_at, id). `sold_at` alone is not unique,
// and a batch ending inside a shared timestamp skipped the rest of that
// timestamp (9 All Day rows measured at the 8:15 PM cursor's own value).
describe("buyer backfill cursor — (sold_at, id), never sold_at alone", () => {
  it("cursorRowBelow orders by sold_at DESC then id DESC (the walk order)", () => {
    expect(cursorRowBelow({ sold_at: "2026-06-11T14:55:09.664Z", id: "b" }, { sold_at: "2026-06-11T14:55:10.000Z", id: "a" })).toBe(true)
    expect(cursorRowBelow({ sold_at: "2026-06-11T14:55:09.664Z", id: "a" }, { sold_at: "2026-06-11T14:55:09.664Z", id: "b" })).toBe(true)
    expect(cursorRowBelow({ sold_at: "2026-06-11T14:55:09.664Z", id: "b" }, { sold_at: "2026-06-11T14:55:09.664Z", id: "a" })).toBe(false)
    expect(cursorRowBelow({ sold_at: "2026-06-11T14:55:09.664Z", id: "a" }, { sold_at: "2026-06-11T14:55:09.664Z", id: "a" })).toBe(false)
  })
  it("cursorOrFilter resumes strictly below (sold_at, id), and below sold_at alone for a cursor logged before the id half existed", () => {
    expect(cursorOrFilter({ soldAt: "2026-06-11T14:55:09.664+00:00", id: "0f7b" })).toBe(
      "sold_at.lt.2026-06-11T14:55:09.664+00:00,and(sold_at.eq.2026-06-11T14:55:09.664+00:00,id.lt.0f7b)",
    )
    expect(cursorOrFilter({ soldAt: "2026-06-11T14:55:09.664+00:00", id: null })).toBe("sold_at.lt.2026-06-11T14:55:09.664+00:00")
  })
  it("the All Day route orders by (sold_at, id), filters by cursorOrFilter and writes cursor_id — never a bare .lt(sold_at)", () => {
    const route = readFileSync("app/api/admin/backfill-allday-buyers/route.ts", "utf8")
    expect(route).toMatch(/\.order\("sold_at", \{ ascending: false \}\)\s*\.order\("id", \{ ascending: false \}\)/)
    expect(route).toMatch(/\.or\(cursorOrFilter\(\{ soldAt: cursorBefore, id: cursorBeforeId \}\)\)/)
    expect(route).not.toMatch(/\.lt\("sold_at"/)
    expect(route).toContain("cursor_id: cursorAfterId")
    expect(route).toMatch(/cursorRowBelow\(row, minRow\)/)
  })

  // 2026-10-23 (same morning): the Top Shot lane had the identical shape on BOTH
  // of its walks. Measured live at the 12:04 AM PT run's boundary: SIX sales
  // shared the cursor's exact sold_at (06:30:53.446Z); the 12:34 AM run's
  // `sold_at < cursor` skipped the ones the first batch had not reached.
  it("the Top Shot route's two walks order by (sold_at, id) and resume via cursorOrFilter — the only bare .lt(sold_at) left is the historical window's fixed end", () => {
    const route = readFileSync("app/api/admin/backfill-topshot-buyers/route.ts", "utf8")
    // both lanes: the walk order carries the tiebreak
    expect(route.match(/\.order\("sold_at", \{ ascending: false \}\)\s*\.order\("id", \{ ascending: false \}\)/g)).toHaveLength(2)
    expect(route.match(/\.or\(cursorOrFilter\(\{ soldAt: cursorBefore, id: cursorBeforeId \}\)\)/g)).toHaveLength(2)
    expect(route.match(/cursorRowBelow\(row, minRow\)/g)).toHaveLength(2)
    expect(route.match(/cursor_id: cursorAfterId/g)).toHaveLength(2)
    // the defect: a cursor applied as a plain upper bound on sold_at
    expect(route).not.toMatch(/\.lt\("sold_at", cursorBefore/)
    expect(route).not.toMatch(/cursorBefore < HIST_WINDOW_END \? cursorBefore/)
    // the legitimate bare bounds — the historical window's fixed end, on its select and its exhausted count
    expect(route.match(/\.lt\("sold_at", HIST_WINDOW_END\)/g)).toHaveLength(2)
    // the exec-fill phase is a window, not a cursor walk: its order is unchanged
    expect(route).toMatch(/\.order\("sold_at", \{ ascending: false \}\)\s*\.order\("id", \{ ascending: true \}\)\s*\.limit\(EXEC_FILL_BATCH\)/)
  })
})

// 2026-10-23: the Top Shot forward lane's floor is the same root block (#192's
// lesson, a second time). Its window began 2025-01-01, so one mainnet26-era sale
// (2025-05-05, `ts_history_backfill_v1`) was re-fetched and re-failed on every
// run: `rows_found 1 · decode_failed 1` at every :34 tick, 48 decodes a day.
describe("Top Shot buyer backfill — the two lanes tile at the spork root, and the band below the forward floor is counted", () => {
  const route = readFileSync("app/api/admin/backfill-topshot-buyers/route.ts", "utf8")
  it("forward lane floor = historical lane end = CURRENT_SPORK_START_ISO; no calendar-date floor remains", () => {
    expect(route).toMatch(/const HIST_WINDOW_END = CURRENT_SPORK_START_ISO/)
    expect(route).toMatch(/const FORWARD_WINDOW_START = CURRENT_SPORK_START_ISO/)
    expect(route).not.toMatch(/"2025-01-01T00:00:00Z"/)
    // the forward select and its exhausted count both read the SAME floor
    expect(route.match(/\.gte\("sold_at", FORWARD_WINDOW_START\)/g)).toHaveLength(2)
    // nothing in the forward lane still reads the historical end as its own floor
    expect(route).not.toMatch(/\.gte\("sold_at", HIST_WINDOW_END\)/)
  })
  it("the rows the forward lane no longer walks are COUNTED on the wrapping run (below_forward_floor), with the same candidate predicate", () => {
    expect(route).toMatch(
      /\.is\("buyer_address", null\)\s*\.is\("payer_address", null\)\s*\.not\("transaction_hash", "is", null\)\s*\.gte\("sold_at", HIST_WINDOW_START\)\s*\.lt\("sold_at", FORWARD_WINDOW_START\)/,
    )
    expect(route).toMatch(/belowForwardFloor = belowErr \? -1 : \(belowCount \?\? -1\)/)
    expect(route).toContain("below_forward_floor: belowForwardFloor")
  })
})
