import { describe, it, expect, vi } from "vitest"
import {
  readDuneBudget,
  recordDuneUsage,
  logDuneBudgetStop,
  estimateDatapoints,
  columnCount,
} from "@/lib/dune/budget"

// Unit-drive of the Dune spend budget (lib/dune/budget.ts), the gate all three
// Dune lanes ask before buying rows.
//
// The property under test throughout is FAIL CLOSED: every way the budget read
// can go wrong must authorise ZERO rows. On 2026-07-24 a whole billing cycle's
// datapoints were spent between the 00:00 UTC reset and 06:11 because nothing
// counted the spend; a guard that answers "plenty" when it cannot read the
// policy would reproduce that exactly, while looking like it was working.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function db(opts: {
  rpc?: (name: string, args?: unknown) => Promise<unknown>
  insert?: (row: unknown) => Promise<{ error: unknown }>
}): any {
  return {
    rpc: opts.rpc ?? (async () => ({ data: null, error: null })),
    from: () => ({
      insert: async (row: unknown) =>
        opts.insert ? opts.insert(row) : { error: null },
    }),
  }
}

const OK_STATUS = {
  configured: true,
  paused: false,
  pipeline: "ownership-sync-dune",
  datapoints_allowed_now: 700_000,
  rows_allowed_now: 42_000,
  min_start_datapoints: 600_000,
  can_start: true,
  pipeline_enabled: true,
  credits_est_left: 2_500,
  cycle_datapoint_cap: 1_000_000,
  day_row_cap: 150_000,
  rows_today: 108_000,
}

describe("readDuneBudget — the allowance", () => {
  it("returns both meters and asks for THIS lane's allocation", async () => {
    const seen: unknown[] = []
    const b = await readDuneBudget(
      "ownership-sync-dune",
      db({
        rpc: async (_n, args) => {
          seen.push(args)
          return { data: OK_STATUS, error: null }
        },
      }),
    )
    expect(b.read).toBe("ok")
    expect(b.configured).toBe(true)
    // ⚠ The lane name is load-bearing: without it every lane would read the
    // GLOBAL pool and the ownership reservation would protect nothing.
    expect(seen[0]).toEqual({ p_pipeline: "ownership-sync-dune" })
    expect(b.datapointsAllowedNow).toBe(700_000)
    expect(b.rowsAllowedNow).toBe(42_000)
    expect(b.canStart).toBe(true)
    expect(b.minStartDatapoints).toBe(600_000)
    expect(b.reason).toBeNull()
  })

  it("enough to spend but NOT enough to finish is a refusal, and the reason says so", async () => {
    // The case the ownership walk exists to avoid: 300k available against a
    // 684,498-datapoint walk that restarts at offset 0. Spending it would buy
    // 44% of a walk and leave the table capped there.
    const b = await readDuneBudget(
      "ownership-sync-dune",
      db({
        rpc: async () => ({
          data: { ...OK_STATUS, datapoints_allowed_now: 300_000, can_start: false },
          error: null,
        }),
      }),
    )
    expect(b.read).toBe("ok")
    expect(b.datapointsAllowedNow).toBe(300_000) // there IS budget...
    expect(b.canStart).toBe(false) // ...and it still must not start
    expect(b.reason).toContain("600000 needed to start")
  })

  it("a spent CREDIT meter zeroes the lane even with datapoints left", async () => {
    // Two meters, consumed by different lanes. Without executes the run can only
    // serve a stale cached execution — the spend that buys nothing.
    const b = await readDuneBudget(
      "sales-ingest-dune",
      db({
        rpc: async () => ({
          data: {
            ...OK_STATUS,
            credits_est_left: 0,
            datapoints_allowed_now: 0,
            can_start: false,
          },
          error: null,
        }),
      }),
    )
    expect(b.canStart).toBe(false)
    expect(b.reason).toContain("credit meter")
  })

  it("a lane disabled in the allocation table names that, not a cap", async () => {
    const b = await readDuneBudget(
      "sales-ingest-dune",
      db({
        rpc: async () => ({
          data: {
            ...OK_STATUS,
            pipeline_enabled: false,
            datapoints_allowed_now: 0,
            can_start: false,
          },
          error: null,
        }),
      }),
    )
    expect(b.reason).toContain("disabled in dune_budget_allocation")
  })

  it("reports paused with a zero allowance and names the switch", async () => {
    const b = await readDuneBudget(
      "ownership-sync-dune",
      db({
        rpc: async () => ({
          data: {
            ...OK_STATUS,
            paused: true,
            rows_allowed_now: 0,
            datapoints_allowed_now: 0,
            can_start: false,
          },
          error: null,
        }),
      }),
    )
    expect(b.read).toBe("ok") // the policy WAS read — this is not a failure
    expect(b.paused).toBe(true)
    expect(b.datapointsAllowedNow).toBe(0)
    expect(b.canStart).toBe(false)
    expect(b.reason).toContain("paused")
  })

  it("a spent day cap is an ok read with a zero allowance, not an error", async () => {
    const b = await readDuneBudget(
      "ownership-sync-dune",
      db({
        rpc: async () => ({
          data: {
            ...OK_STATUS,
            rows_allowed_now: 0,
            datapoints_allowed_now: 0,
            can_start: false,
          },
          error: null,
        }),
      }),
    )
    expect(b.read).toBe("ok")
    expect(b.rowsAllowedNow).toBe(0)
    expect(b.canStart).toBe(false)
    expect(b.reason).toContain("cap")
  })
})

describe("readDuneBudget — every failure authorises nothing", () => {
  // ⚠ supabase-js RETURNS errors rather than throwing, so this is the shape a
  // real failure takes: data null, error set, promise RESOLVED. A truthiness
  // check or a `?? 0` on this payload would publish a number nobody measured —
  // and here that number would authorise spending.
  it("a returned error yields read:'failed' and 0 rows", async () => {
    const b = await readDuneBudget(
      "ownership-sync-dune",
      db({ rpc: async () => ({ data: null, error: { message: "pool timeout" } }) }),
    )
    expect(b.read).toBe("failed")
    expect(b.rowsAllowedNow).toBe(0)
    expect(b.reason).toContain("pool timeout")
  })

  it("a thrown rpc yields read:'failed' and 0 rows, and does not propagate", async () => {
    const b = await readDuneBudget(
      "ownership-sync-dune",
      db({
        rpc: async () => {
          throw new Error("socket hang up")
        },
      }),
    )
    expect(b.read).toBe("failed")
    expect(b.rowsAllowedNow).toBe(0)
    expect(b.reason).toContain("socket hang up")
  })

  it("an unconfigured policy is NOT unlimited", async () => {
    const b = await readDuneBudget(
      "ownership-sync-dune",
      db({
        rpc: async () => ({
          data: {
            configured: false,
            rows_allowed_now: 0,
            datapoints_allowed_now: 0,
            reason: "no dune_budget_state row",
          },
          error: null,
        }),
      }),
    )
    expect(b.read).toBe("failed")
    expect(b.rowsAllowedNow).toBe(0)
    expect(b.reason).toContain("no dune_budget_state row")
  })

  it.each([
    ["null payload", null],
    ["array payload", [{ datapoints_allowed_now: 999_999 }]],
    ["string payload", "150000"],
    ["missing both meters", { configured: true }],
    // ⚠ An unreadable PRIMARY meter must not fall back to the secondary one:
    // datapoints are what Dune's cycle limit is denominated in.
    ["unparseable datapoints", { configured: true, datapoints_allowed_now: "lots", rows_allowed_now: 9_000 }],
    ["datapoints present, rows unreadable", { configured: true, datapoints_allowed_now: 500_000 }],
  ])("%s authorises 0", async (_label, data) => {
    const b = await readDuneBudget("ownership-sync-dune", db({ rpc: async () => ({ data, error: null }) }))
    expect(b.read).toBe("failed")
    expect(b.datapointsAllowedNow).toBe(0)
    expect(b.rowsAllowedNow).toBe(0)
    expect(b.canStart).toBe(false)
  })

  it("a negative allowance is clamped to 0 on both meters, never treated as a credit", async () => {
    const b = await readDuneBudget(
      "ownership-sync-dune",
      db({
        rpc: async () => ({
          data: { ...OK_STATUS, rows_allowed_now: -5, datapoints_allowed_now: -900 },
          error: null,
        }),
      }),
    )
    expect(b.rowsAllowedNow).toBe(0)
    expect(b.datapointsAllowedNow).toBe(0)
    expect(b.canStart).toBe(false)
  })
})

describe("columnCount / estimateDatapoints", () => {
  it("counts the WIDEST row, so a null-dropped key cannot under-count the page", () => {
    const rows = [{ a: 1, b: 2 }, { a: 1, b: 2, c: 3 }]
    expect(columnCount(rows)).toBe(3)
    expect(estimateDatapoints(rows)).toBe(6)
  })

  it("an empty page is 0 columns and 0 datapoints — a measurement, not a gap", () => {
    expect(columnCount([])).toBe(0)
    expect(estimateDatapoints([])).toBe(0)
  })
})

describe("recordDuneUsage", () => {
  it("writes rows x columns, and NULLs both when nothing was measured", async () => {
    const written: unknown[] = []
    const sink = db({
      insert: async (row) => {
        written.push(row)
        return { error: null }
      },
    })

    await recordDuneUsage(
      { pipeline: "p", endpoint: "results", queryId: "7", rows: 1000, columns: 6, httpStatus: 200 },
      sink,
    )
    await recordDuneUsage({ pipeline: "p", endpoint: "execute", queryId: "7", httpStatus: 402 }, sink)

    expect(written[0]).toMatchObject({
      endpoint: "results",
      rows_returned: 1000,
      columns_returned: 6,
      datapoints_est: 6000,
      http_status: 200,
    })
    // ⚠ NULL, never 0. A 0 row-count on an /execute would make the ledger read
    // as "this call was free" — the fabricated-measurement shape, in telemetry.
    expect(written[1]).toMatchObject({
      endpoint: "execute",
      rows_returned: null,
      columns_returned: null,
      datapoints_est: null,
      http_status: 402,
    })
  })

  it("never throws, and reports the miss, when the ledger write fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const returned = await recordDuneUsage(
      { pipeline: "p", endpoint: "results", rows: 1, columns: 1 },
      db({ insert: async () => ({ error: { message: "rls denied" } }) }),
    )
    const threw = await recordDuneUsage(
      { pipeline: "p", endpoint: "results", rows: 1, columns: 1 },
      db({
        insert: async () => {
          throw new Error("connection reset")
        },
      }),
    )
    expect(returned).toBe(false)
    expect(threw).toBe(false)
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })
})

describe("logDuneBudgetStop — the ok split", () => {
  async function stopRow(budgetOverrides: Parameters<typeof logDuneBudgetStop>[0]["budget"]) {
    const calls: Array<{ name: string; args: any }> = []
    await logDuneBudgetStop(
      { pipeline: "ownership-sync-dune", startedAt: "2026-08-22T00:00:00Z", budget: budgetOverrides },
      db({
        rpc: async (name, args) => {
          calls.push({ name, args })
          return { data: null, error: null }
        },
      }),
    )
    return calls.at(-1)!.args
  }

  it("a CONFIGURED cap stop stays ok=true — pacing is not a failure", async () => {
    const args = await stopRow({
      read: "ok",
      configured: true,
      paused: false,
      datapointsAllowedNow: 0,
      rowsAllowedNow: 0,
      canStart: false,
      minStartDatapoints: 600_000,
      reason: "day/cycle row cap reached",
      raw: { rows_today: 150_000 },
    })
    expect(args.p_ok).toBe(true)
    expect(args.p_error).toBeNull()
    expect(args.p_extra.budget_stopped).toBe(true)
    expect(args.p_extra.budget_reason).toContain("cap")
  })

  it("an UNREADABLE budget stop is ok=false — a silent stop must not report success", async () => {
    const args = await stopRow({
      read: "failed",
      configured: false,
      paused: false,
      datapointsAllowedNow: 0,
      rowsAllowedNow: 0,
      canStart: false,
      minStartDatapoints: 0,
      reason: "budget read: pool timeout",
      raw: null,
    })
    expect(args.p_ok).toBe(false)
    expect(String(args.p_error)).toContain("pool timeout")
    expect(args.p_extra.budget_stopped).toBe(true)
  })

  it("never throws when the log write itself fails", async () => {
    await expect(
      logDuneBudgetStop(
        {
          pipeline: "p",
          startedAt: "2026-08-22T00:00:00Z",
          budget: {
            read: "ok",
            configured: true,
            paused: true,
            datapointsAllowedNow: 0,
            rowsAllowedNow: 0,
            canStart: false,
            minStartDatapoints: 0,
            reason: "paused",
            raw: null,
          },
        },
        db({
          rpc: async () => {
            throw new Error("log write failed")
          },
        }),
      ),
    ).resolves.toBeUndefined()
  })
})
