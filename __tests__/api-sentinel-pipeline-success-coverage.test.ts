import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type InstalledFetchMock,
} from "./helpers/route-harness"

// Pins the `Pipeline Success Coverage` sentinel arm.
//
// The gap it closes: a cadence arm watches SILENCE, and a FAILING run still
// writes a pipeline_runs row — so a watchlisted pipeline can fail 100% of its
// runs for days with every cadence instrument green. Measured 2026-08-17,
// `apply-fmv-haircut` and `match-topshot-players` did exactly that for 3+ days.
//
// The assertions below are NOT arbitrary: each one pins a formulation that was
// measured against 20 days of pipeline_runs_daily history before shipping, and
// the two REJECTED formulations (`fail_count > 0`, and zero-successes without
// the rows_written guard) get their own cases, because those are the ways this
// arm degenerates into a cry-wolf board that trains the operator to skim.

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () =>
    new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))

process.env.INGEST_SECRET_TOKEN = "sentinel-token"
// No notification env: these tests are about check classification, not delivery.
delete process.env.TELEGRAM_BOT_TOKEN
delete process.env.TELEGRAM_CHAT_ID
delete process.env.RESEND_API_KEY
delete process.env.ALERT_EMAIL

const { POST } = await import("@/app/api/sentinel/route")

interface Check { name: string; status: string; detail: string; value?: string | number }

function post(): NextRequest {
  return new NextRequest("https://t/api/sentinel", {
    method: "POST",
    headers: new Headers({ authorization: "Bearer sentinel-token" }),
  })
}

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

type Roll = {
  pipeline: string
  runs: number
  ok_count: number
  rows_written: number
  last_error?: string | null
  refreshed_at?: string
}

/**
 * Installs a fixture whose ONLY meaningful content is the three tables this arm
 * reads; every other table/RPC falls through to the harness default (empty), so
 * the other checks land wherever they land and are ignored here.
 *
 * Records filter arguments, because the fixture's chainables discard them: an
 * assertion on the resulting STATUS alone would pass just as happily with the
 * `is_active` filter or the watchlist scoping deleted.
 */
function install(opts: {
  watchlist?: string[]
  suppressions?: Array<{ pipeline: string; expires_at: string | null }>
  rollup?: Roll[]
  config?: Array<{ check_name: string; warn_at: number | null; crit_at: number | null; enabled: boolean }>
}) {
  const rollup = (opts.rollup ?? []).map((r) => ({
    last_error: null,
    refreshed_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    ...r,
  }))
  const base = makeSupabaseFixture({
    sentinel_threshold_config: { data: opts.config ?? [], error: null },
    pipeline_cadence_watchlist: {
      data: (opts.watchlist ?? []).map((p) => ({ pipeline: p })),
      error: null,
    },
    pipeline_alert_suppression: { data: opts.suppressions ?? [], error: null },
    pipeline_runs_daily: { data: rollup, error: null },
  }) as { from: (t: string) => Record<string, unknown> }

  const filters: Record<string, Array<{ op: string; col: string; val?: unknown }>> = {}
  const baseFrom = base.from.bind(base)
  base.from = (table: string) => {
    const b = baseFrom(table)
    for (const op of ["eq", "in", "gte"] as const) {
      b[op] = (...args: unknown[]) => {
        ;(filters[table] ??= []).push({ op, col: String(args[0]), val: args[1] })
        return b
      }
    }
    return b
  }
  state.sb = base
  return { filters }
}

async function runCheck(): Promise<Check> {
  const res = await POST(post())
  const report = await res.json()
  const c = (report.checks as Check[]).find((x) => x.name === "Pipeline Success Coverage")
  if (!c) throw new Error("Pipeline Success Coverage check missing from report")
  return c
}

let fetchStub: InstalledFetchMock
beforeEach(() => {
  // The Sniper Feed check makes a real fetch; stub it so it cannot reach out.
  // An unmatched request throws by design, which is what we want here.
  fetchStub = installFetchMock([jsonRoute("sniper-feed", { deals: [] })])
})
afterEach(() => {
  fetchStub.restore()
  vi.restoreAllMocks()
})

describe("sentinel — Pipeline Success Coverage", () => {
  it("fires on a watchlisted pipeline with zero successes AND zero rows written", async () => {
    install({
      watchlist: ["match-topshot-players", "fmv-recalc"],
      rollup: [
        { pipeline: "match-topshot-players", runs: 2, ok_count: 0, rows_written: 0, last_error: "rpc_failed: upstream request timeout" },
        { pipeline: "fmv-recalc", runs: 40, ok_count: 25, rows_written: 19000 },
      ],
    })
    const c = await runCheck()
    expect(c.status).toBe("warn")
    expect(c.value).toBe(1)
    expect(c.detail).toContain("match-topshot-players")
    expect(c.detail).toContain("0/2 ok")
    // The operator needs the cause without a second query.
    expect(c.detail).toContain("upstream request timeout")
    // A healthy sibling must never be named as dead.
    expect(c.detail).not.toContain("fmv-recalc")
  })

  it("does NOT fire on zero successes when the pipeline WROTE rows (graceful degradation)", async () => {
    // `reconcile-saved-wallet-stats` reports ok=false on a soft-deadline partial
    // sweep whose work IS committed. Measured over 20 days, zero-successes WITHOUT
    // this guard produced 4 false positives and all 4 were this shape (7, 19, 12
    // and 14 rows written). Dropping the rows_written term reddens this case.
    install({
      watchlist: ["reconcile-saved-wallet-stats"],
      rollup: [{ pipeline: "reconcile-saved-wallet-stats", runs: 3, ok_count: 0, rows_written: 19 }],
    })
    const c = await runCheck()
    expect(c.status).toBe("ok")
    expect(c.value).toBe(0)
    expect(c.detail).not.toContain("reconcile-saved-wallet-stats")
  })

  it("does NOT fire on a high failure rate that still has successes (the rejected fail_count>0 form)", async () => {
    // `refresh_wmc_fmv_changed` runs at a ~32.6% failure rate and writes 409k rows.
    // An arm keyed on the PRESENCE of failures fires here constantly and is useless.
    install({
      watchlist: ["refresh_wmc_fmv_changed"],
      rollup: [{ pipeline: "refresh_wmc_fmv_changed", runs: 100, ok_count: 67, rows_written: 409110 }],
    })
    const c = await runCheck()
    expect(c.status).toBe("ok")
    expect(c.value).toBe(0)
  })

  it("does NOT fire on a SUCCEEDING pipeline that legitimately writes zero rows", async () => {
    // The large real population this arm must never touch: dispatchers,
    // heartbeats and MV refreshers all write 0 to a counted table by design
    // (`fmv-recalc-heartbeat`, `alerts-send`, `refresh-pack-grail-metrics-mv`,
    // `wallet-backfill-multicollection-dispatch`). rows_written is a null
    // instrument ON ITS OWN, so the zero-success term is what protects them —
    // dropping it turns this arm into a cry-wolf board overnight.
    install({
      watchlist: ["fmv-recalc-heartbeat", "refresh-pack-grail-metrics-mv"],
      rollup: [
        { pipeline: "fmv-recalc-heartbeat", runs: 288, ok_count: 288, rows_written: 0 },
        { pipeline: "refresh-pack-grail-metrics-mv", runs: 24, ok_count: 24, rows_written: 0 },
      ],
    })
    const c = await runCheck()
    expect(c.status).toBe("ok")
    expect(c.value).toBe(0)
  })

  it("sums successes across the window for a zero-rows pipeline that succeeded on the EARLIER day", async () => {
    // The summing has to be decisive on its own. In the mixed case the
    // rows_written term masks it, so this uses a zero-rows-throughout pipeline:
    // only ACCUMULATING ok_count across both rows distinguishes "succeeded
    // yesterday, has only failed so far today" (healthy, and the normal state of
    // a daily job every morning) from "dead". Last-row-wins fires on it.
    install({
      watchlist: ["refresh-pack-grail-metrics-mv"],
      rollup: [
        { pipeline: "refresh-pack-grail-metrics-mv", runs: 12, ok_count: 12, rows_written: 0 },
        { pipeline: "refresh-pack-grail-metrics-mv", runs: 3, ok_count: 0, rows_written: 0 },
      ],
    })
    const c = await runCheck()
    expect(c.status).toBe("ok")
    expect(c.value).toBe(0)
  })

  it("does NOT fire on a pipeline that never ran (runs=0) — that is Pipeline Silence's job", async () => {
    install({
      watchlist: ["candy-editions-ingest"],
      rollup: [{ pipeline: "candy-editions-ingest", runs: 0, ok_count: 0, rows_written: 0 }],
    })
    const c = await runCheck()
    expect(c.status).toBe("ok")
    expect(c.value).toBe(0)
  })

  it("honours an active suppression, and ignores an EXPIRED one", async () => {
    const dead: Roll[] = [{ pipeline: "match-topshot-players", runs: 2, ok_count: 0, rows_written: 0 }]

    install({
      watchlist: ["match-topshot-players"],
      suppressions: [{ pipeline: "match-topshot-players", expires_at: new Date(Date.now() + 86_400_000).toISOString() }],
      rollup: dead,
    })
    const active = await runCheck()
    expect(active.status).toBe("ok")
    expect(active.detail).toContain("1 suppressed")

    // A spent suppression must not keep hiding a broken pipeline — that is the
    // whole point of the expiry, and a `>` comparison written the wrong way round
    // would silence it forever.
    install({
      watchlist: ["match-topshot-players"],
      suppressions: [{ pipeline: "match-topshot-players", expires_at: new Date(Date.now() - 86_400_000).toISOString() }],
      rollup: dead,
    })
    const expired = await runCheck()
    expect(expired.status).toBe("warn")
    expect(expired.detail).toContain("match-topshot-players")
  })

  it("treats a NULL expires_at as a permanent suppression", async () => {
    install({
      watchlist: ["match-topshot-players"],
      suppressions: [{ pipeline: "match-topshot-players", expires_at: null }],
      rollup: [{ pipeline: "match-topshot-players", runs: 2, ok_count: 0, rows_written: 0 }],
    })
    expect((await runCheck()).status).toBe("ok")
  })

  it("ignores a dead pipeline that is NOT on the active watchlist", async () => {
    // Scope is the operator's existing curation; the arm must not fire on
    // something nobody chose to monitor.
    install({
      watchlist: ["fmv-recalc"],
      rollup: [
        { pipeline: "fmv-recalc", runs: 40, ok_count: 25, rows_written: 19000 },
        { pipeline: "some-unwatched-job", runs: 9, ok_count: 0, rows_written: 0 },
      ],
    })
    const c = await runCheck()
    expect(c.status).toBe("ok")
    expect(c.detail).not.toContain("some-unwatched-job")
  })

  it("escalates to critical only at crit_at, and that is above the observed ceiling", async () => {
    const mk = (n: number): Roll[] =>
      Array.from({ length: n }, (_, i) => ({ pipeline: `dead-${i}`, runs: 2, ok_count: 0, rows_written: 0 }))

    // 2 dead = the worst 48h window seen in the 20 days to 2026-08-17. Must NOT
    // fail the GHA job: a red scheduled workflow that stays red gets skimmed.
    install({ watchlist: mk(2).map((r) => r.pipeline), rollup: mk(2) })
    expect((await runCheck()).status).toBe("warn")

    install({ watchlist: mk(3).map((r) => r.pipeline), rollup: mk(3) })
    expect((await runCheck()).status).toBe("critical")
  })

  it("takes both thresholds from sentinel_threshold_config", async () => {
    const rollup: Roll[] = [
      { pipeline: "dead-a", runs: 2, ok_count: 0, rows_written: 0 },
      { pipeline: "dead-b", runs: 2, ok_count: 0, rows_written: 0 },
    ]
    install({
      watchlist: ["dead-a", "dead-b"],
      rollup,
      config: [{ check_name: "Pipeline Success Coverage", warn_at: 1, crit_at: 2, enabled: true }],
    })
    expect((await runCheck()).status).toBe("critical")
  })

  it("is neutralized but still visible when disabled via config", async () => {
    install({
      watchlist: ["match-topshot-players"],
      rollup: [{ pipeline: "match-topshot-players", runs: 2, ok_count: 0, rows_written: 0 }],
      config: [{ check_name: "Pipeline Success Coverage", warn_at: null, crit_at: null, enabled: false }],
    })
    const c = await runCheck()
    expect(c.status).toBe("ok")
    expect(c.detail).toContain("[check disabled via config]")
  })

  it("reports the rollup's age on every reading, healthy or not", async () => {
    // pipeline_runs_daily refreshes every 6h, so a clean reading can be hours old.
    // The standing rule is never to read that table's recency without stating it —
    // a 6h-stale all-clear is a weaker claim than a fresh one and the reader
    // cannot tell the difference without this.
    install({
      watchlist: ["fmv-recalc"],
      rollup: [{ pipeline: "fmv-recalc", runs: 40, ok_count: 25, rows_written: 19000 }],
    })
    const healthy = await runCheck()
    expect(healthy.status).toBe("ok")
    expect(healthy.detail).toMatch(/rollup \d+m old/)

    install({
      watchlist: ["match-topshot-players"],
      rollup: [{ pipeline: "match-topshot-players", runs: 2, ok_count: 0, rows_written: 0 }],
    })
    expect((await runCheck()).detail).toMatch(/rollup \d+m old/)
  })

  it("reports INCONCLUSIVE rather than ok when the watchlist is empty", async () => {
    // "We measured nothing" must never render as "everything is fine" — the
    // failed-read-renders-as-an-answer class, on a monitoring arm.
    install({ watchlist: [], rollup: [] })
    const c = await runCheck()
    expect(c.status).toBe("warn")
    expect(c.detail).toContain("INCONCLUSIVE")
  })

  it("reports INCONCLUSIVE rather than ok when the rollup has no rows in the window", async () => {
    install({ watchlist: ["fmv-recalc"], rollup: [] })
    const c = await runCheck()
    expect(c.status).toBe("warn")
    expect(c.detail).toContain("INCONCLUSIVE")
  })

  it("scopes the reads: is_active on the watchlist, and the rollup bounded by day AND watchlist", async () => {
    // The fixture's chainables discard their arguments, so without recording them
    // a status assertion would pass with either filter deleted — and dropping the
    // day bound is exactly how this read would grow past the 1000-row cap.
    const { filters } = install({
      watchlist: ["fmv-recalc"],
      rollup: [{ pipeline: "fmv-recalc", runs: 40, ok_count: 25, rows_written: 19000 }],
    })
    await runCheck()

    expect(filters.pipeline_cadence_watchlist).toContainEqual({ op: "eq", col: "is_active", val: true })

    const roll = filters.pipeline_runs_daily ?? []
    const gte = roll.find((f) => f.op === "gte" && f.col === "day")
    expect(gte).toBeDefined()
    // Yesterday (UTC) — a 24-48h window. Wider is the safe direction.
    expect(gte!.val).toBe(day(-1))
    expect(roll).toContainEqual({ op: "in", col: "pipeline", val: ["fmv-recalc"] })
  })

  it("sums across the two days of the window rather than reading one day", async () => {
    // The rollup is one row per (pipeline, day). A pipeline that succeeded
    // yesterday and has only failed so far today is NOT zero-success, and reading
    // a single day would fire on it every morning.
    install({
      watchlist: ["apply-fmv-haircut"],
      rollup: [
        { pipeline: "apply-fmv-haircut", runs: 1, ok_count: 1, rows_written: 500 },
        { pipeline: "apply-fmv-haircut", runs: 1, ok_count: 0, rows_written: 0 },
      ],
    })
    const c = await runCheck()
    expect(c.status).toBe("ok")
    expect(c.value).toBe(0)
  })
})
