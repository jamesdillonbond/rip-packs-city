import { describe, it, expect, beforeEach, vi } from "vitest"

// Unit tests for lib/allow-list/prewarm.ts processSinglePrewarmRow — the per-row
// prewarm orchestrator. Drives the finish-status decision (complete /
// complete_partial / failed), the seeder success/HTTP-fail/throw branches, the
// username→wallet resolution branches, the welcome-email send / dedupe / Resend
// failure + Telegram-page branches, the ≥3-attempt fallback email, and the
// backfill-dispatch INGEST_SECRET_TOKEN-missing / HTTP-fail branches. Supabase
// (rpc + from() chain) and global fetch are stubbed via a mutable `state`.

const state: any = {}

function makeResp(spec: any = {}) {
  return {
    ok: spec.ok ?? true,
    status: spec.status ?? 200,
    json: async () => spec.json ?? {},
    text: async () => spec.text ?? "",
  }
}

vi.mock("@/lib/supabase", () => {
  const build = (table: string) => {
    let op = "select"
    const b: any = {
      select: () => b,
      update: () => {
        op = "update"
        return b
      },
      insert: () => {
        op = "insert"
        return b
      },
      eq: () => b,
      in: () => b,
      ilike: () => b,
      neq: () => b,
      not: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: async () =>
        table === "seeded_wallets" ? state.seededSelect : state.welcomeRow,
      then: (resolve: any) => {
        if (op === "insert") return resolve(state.seededInsert)
        // Backfill-completion polling reads these two tables; each poll tick
        // shifts state.backfillState so a test can script "not done yet → done".
        if (table === "collections") return resolve(state.collectionsRows)
        if (table === "wallet_backfill_state") {
          state.backfillReads++
          const next =
            state.backfillStateSeq.length > 0
              ? state.backfillStateSeq.shift()
              : state.backfillState
          return resolve(next)
        }
        return resolve(state.updateResult)
      },
    }
    return b
  }
  const client: any = {
    from: (t: string) => build(t),
    rpc: async (name: string, args: any) => {
      state.rpcCalls.push({ name, args })
      return state.rpcResult
    },
  }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/emails/welcome-email", () => ({
  buildWelcomeEmailSubject: () => "subject",
  buildWelcomeEmailHtml: () => "<html>",
  buildWelcomeEmailText: () => "text",
}))

vi.mock("@/lib/chains/flow/topshot-username-resolve", () => ({
  resolveTopShotUsername: async (u: string) => {
    if (state.usernameResolve.throw) throw state.usernameResolve.throw
    return state.usernameResolve.value
  },
}))

const fetchMock = vi.fn(async (url: string) => {
  const u = String(url)
  if (u.includes("/api/wallet-search")) {
    if (state.walletSearch.throw) throw state.walletSearch.throw
    return makeResp(state.walletSearch)
  }
  if (u.includes("/api/wallet-backfill-multicollection")) {
    return makeResp(state.backfill)
  }
  if (u.includes("api.telegram.org")) {
    state.telegramCalls++
    return makeResp({})
  }
  if (u.includes("api.resend.com")) {
    state.resendCalls++
    if (state.resend.throw) throw state.resend.throw
    return makeResp(state.resend)
  }
  return makeResp({})
})
vi.stubGlobal("fetch", fetchMock)

import { processSinglePrewarmRow, type AllowListRow } from "@/lib/allow-list/prewarm"

const ORIGIN = "https://www.rippackscity.com"

function baseRow(over: Partial<AllowListRow> = {}): AllowListRow {
  return {
    id: "row-1",
    email: "user@example.com",
    wallet_addr: "0xabc",
    username: null,
    collections: ["nba_top_shot"],
    prewarm_attempts: 0,
    ...over,
  }
}

beforeEach(() => {
  fetchMock.mockClear()
  state.rpcCalls = []
  state.rpcResult = { error: null }
  state.updateResult = { error: null }
  state.seededSelect = { data: null, error: null }
  state.seededInsert = { error: null }
  state.welcomeRow = { data: null, error: null }
  state.usernameResolve = { value: null, throw: null }
  state.walletSearch = { ok: true, status: 200, json: { summary: { totalMoments: 7 } } }
  state.backfill = { ok: true, status: 202 }
  state.resend = { ok: true, status: 200 }
  state.telegramCalls = 0
  state.resendCalls = 0
  // Backfill-completion poll: by default every flagged collection reports a
  // fresh scan on the first tick (baseline empty → any row counts as fresh).
  state.collectionsRows = {
    data: [
      { id: "id-nfl", slug: "nfl_all_day" },
      { id: "id-pin", slug: "disney_pinnacle" },
      { id: "id-gol", slug: "laliga_golazos" },
      { id: "id-ufc", slug: "ufc_strike" },
    ],
    error: null,
  }
  state.backfillState = {
    data: [
      { collection_id: "id-nfl", last_scanned_at: "2026-07-20T21:00:00Z", last_found_count: 67 },
      { collection_id: "id-pin", last_scanned_at: "2026-07-20T21:00:00Z", last_found_count: 0 },
      { collection_id: "id-gol", last_scanned_at: "2026-07-20T21:00:00Z", last_found_count: 0 },
      { collection_id: "id-ufc", last_scanned_at: "2026-07-20T21:00:00Z", last_found_count: 0 },
    ],
    error: null,
  }
  // Read #1 is the pre-dispatch baseline — empty, so the rows above read as
  // freshly scanned on the first poll tick (no fake timers needed).
  state.backfillStateSeq = [{ data: [], error: null }]
  state.backfillReads = 0
  // Env: enable backfill dispatch + Resend + Telegram by default.
  process.env.INGEST_SECRET_TOKEN = "ingest-token"
  process.env.RESEND_API_KEY = "resend-key"
  process.env.TELEGRAM_BOT_TOKEN = "tg-token"
  process.env.TELEGRAM_CHAT_ID = "tg-chat"
})

const finishCall = () => state.rpcCalls.find((c: any) => c.name === "allow_list_finish_prewarm")
const markCalls = () => state.rpcCalls.filter((c: any) => c.name === "allow_list_mark_welcome_sent")

describe("processSinglePrewarmRow — finish status + seeder branches", () => {
  it("complete: TS seeder 200 → status complete, welcome sent, found recorded", async () => {
    const out = await processSinglePrewarmRow(baseRow(), ORIGIN)
    expect(out.finish_status).toBe("complete")
    expect(out.prewarm_summary.nba_top_shot).toBe("complete")
    expect((out.prewarm_summary as any)._meta.nba_top_shot).toEqual({ scanned: true, found: 7 })
    expect(out.ts_error).toBeNull()
    expect(out.welcome_sent).toBe(true)
    expect(out.attempts).toBe(1)
    expect(finishCall().args.p_status).toBe("complete")
    expect(markCalls()[0].args.p_error).toBeNull()
  })

  it("failed: seeder HTTP non-ok → status failed, ts_error set, no welcome email", async () => {
    state.walletSearch = { ok: false, status: 500 }
    const out = await processSinglePrewarmRow(baseRow(), ORIGIN)
    expect(out.finish_status).toBe("failed")
    expect(out.ts_error).toBe("wallet-search HTTP 500")
    expect(out.welcome_sent).toBe(false)
    expect(finishCall().args.p_status).toBe("failed")
    // finishStatus failed + attempts < 3 → no resend, no fallback
    expect(state.resendCalls).toBe(0)
  })

  it("failed: seeder fetch throws → ts_error 'wallet-search threw'", async () => {
    state.walletSearch = { throw: new Error("network down") }
    const out = await processSinglePrewarmRow(baseRow(), ORIGIN)
    expect(out.finish_status).toBe("failed")
    expect(out.ts_error).toContain("wallet-search threw")
    expect(out.ts_error).toContain("network down")
  })

  it("complete_partial: no wallet + no username → nba_top_shot deferred", async () => {
    const out = await processSinglePrewarmRow(
      baseRow({ wallet_addr: null, username: null }),
      ORIGIN
    )
    expect(out.finish_status).toBe("complete_partial")
    expect(out.prewarm_summary.nba_top_shot).toBe("deferred")
    expect((out.prewarm_summary as any)._meta.nba_top_shot).toEqual({ scanned: false, found: 0 })
    // deferred is not "failed" → welcome email still sends
    expect(out.welcome_sent).toBe(true)
  })

  it("complete: non-TopShot collections resolve from the dispatched backfill, not 'deferred'", async () => {
    // Regression guard for the chase.standen 2026-07-20 signup: the four
    // non-TopShot collections used to be hardcoded "deferred", which renders
    // "Coming soon" in the welcome email — so a user holding 67 All Day moments
    // was told All Day wasn't available yet. They are now read back from
    // wallet_backfill_state, which the multicollection backfill already writes.
    const out = await processSinglePrewarmRow(
      baseRow({ collections: ["nba_top_shot", "nfl_all_day", "ufc_strike"] }),
      ORIGIN
    )
    expect(out.prewarm_summary.nfl_all_day).toBe("complete")
    expect(out.prewarm_summary.ufc_strike).toBe("complete")
    expect((out.prewarm_summary as any)._meta.nfl_all_day).toEqual({
      scanned: true,
      found: 67,
    })
    // A scanned-but-empty collection is complete with found:0 — not deferred.
    expect((out.prewarm_summary as any)._meta.ufc_strike).toEqual({
      scanned: true,
      found: 0,
    })
    // Everything flagged resolved → the reconciler never has to touch this row.
    expect(out.finish_status).toBe("complete")
  })

  it("in_progress (not deferred) when the backfill hasn't landed inside the budget", async () => {
    // Baseline read, then a poll read that still shows only the stale baseline
    // row → nothing fresh. Budget 0 stops after one tick with no sleeping.
    state.backfillStateSeq = [
      {
        data: [
          {
            collection_id: "id-nfl",
            last_scanned_at: "2026-07-19T00:00:00Z",
            last_found_count: 12,
          },
        ],
        error: null,
      },
    ]
    state.backfillState = {
      data: [
        {
          collection_id: "id-nfl",
          last_scanned_at: "2026-07-19T00:00:00Z",
          last_found_count: 12,
        },
      ],
      error: null,
    }
    const out = await processSinglePrewarmRow(
      baseRow({ collections: ["nba_top_shot", "nfl_all_day"] }),
      ORIGIN,
      { pollBudgetMs: 0 }
    )
    // Stale row from a PRIOR scan must not be mistaken for this run's result.
    expect(out.prewarm_summary.nfl_all_day).toBe("in_progress")
    expect((out.prewarm_summary as any)._meta.nfl_all_day).toEqual({
      scanned: false,
      found: 0,
    })
    // Unresolved → complete_partial, which is what the hourly reconciler scans.
    expect(out.finish_status).toBe("complete_partial")
  })

  it("deferred stays deferred when there is no wallet to scan", async () => {
    const out = await processSinglePrewarmRow(
      baseRow({
        wallet_addr: null,
        username: null,
        collections: ["nba_top_shot", "nfl_all_day"],
      }),
      ORIGIN
    )
    expect(out.prewarm_summary.nfl_all_day).toBe("deferred")
    expect(out.finish_status).toBe("complete_partial")
  })
})

describe("processSinglePrewarmRow — username → wallet resolution", () => {
  it("resolves username to a wallet, then seeds against it (status complete)", async () => {
    state.usernameResolve = { value: { walletAddress: "0xresolved" }, throw: null }
    const out = await processSinglePrewarmRow(
      baseRow({ wallet_addr: null, username: "collector1" }),
      ORIGIN
    )
    expect(out.prewarm_summary.username_resolution_failure).toBeUndefined()
    expect(out.finish_status).toBe("complete")
    expect(out.prewarm_summary.nba_top_shot).toBe("complete")
  })

  it("records not_found when username does not resolve → deferred", async () => {
    state.usernameResolve = { value: null, throw: null }
    const out = await processSinglePrewarmRow(
      baseRow({ wallet_addr: null, username: "ghost" }),
      ORIGIN
    )
    expect(out.prewarm_summary.username_resolution_failure).toBe("not_found:ghost")
    expect(out.prewarm_summary.nba_top_shot).toBe("deferred")
  })

  it("records gql_error when username resolution throws", async () => {
    state.usernameResolve = { value: null, throw: new Error("gql boom") }
    const out = await processSinglePrewarmRow(
      baseRow({ wallet_addr: null, username: "collector1" }),
      ORIGIN
    )
    expect(out.prewarm_summary.username_resolution_failure).toContain("gql_error:")
    expect(out.prewarm_summary.username_resolution_failure).toContain("gql boom")
  })
})

describe("processSinglePrewarmRow — welcome email dedupe + failure + fallback", () => {
  it("dedupes: already-welcomed row does not re-send resend", async () => {
    state.welcomeRow = {
      data: { welcome_email_sent_at: "2026-07-12T00:00:00Z", welcome_email_error: null },
      error: null,
    }
    const out = await processSinglePrewarmRow(baseRow(), ORIGIN)
    expect(out.welcome_sent).toBe(true)
    expect(state.resendCalls).toBe(0)
    // no mark_welcome_sent RPC on the dedupe path
    expect(markCalls().length).toBe(0)
  })

  it("Resend HTTP failure → welcome_error set, mark_welcome_sent(p_error), Telegram paged", async () => {
    state.resend = { ok: false, status: 422, text: "bad address" }
    const out = await processSinglePrewarmRow(baseRow(), ORIGIN)
    expect(out.welcome_sent).toBe(false)
    expect(out.welcome_error).toContain("Resend HTTP 422")
    expect(markCalls()[0].args.p_error).toContain("Resend HTTP 422")
    expect(state.telegramCalls).toBe(1)
  })

  it("Resend fetch throws → welcome_error 'Resend threw'", async () => {
    state.resend = { throw: new Error("socket hang up") }
    const out = await processSinglePrewarmRow(baseRow(), ORIGIN)
    expect(out.welcome_error).toContain("Resend threw")
    expect(out.welcome_error).toContain("socket hang up")
  })

  it("RESEND_API_KEY missing → welcome_error without any resend fetch", async () => {
    delete process.env.RESEND_API_KEY
    const out = await processSinglePrewarmRow(baseRow(), ORIGIN)
    expect(out.welcome_sent).toBe(false)
    expect(out.welcome_error).toContain("RESEND_API_KEY is not set")
    expect(state.resendCalls).toBe(0)
  })

  it("fallback email + Telegram page after 3 failed attempts", async () => {
    state.walletSearch = { ok: false, status: 500 }
    const out = await processSinglePrewarmRow(baseRow({ prewarm_attempts: 2 }), ORIGIN)
    expect(out.finish_status).toBe("failed")
    expect(out.attempts).toBe(3)
    // fallback loading email sent via resend + Telegram paged
    expect(state.resendCalls).toBe(1)
    expect(out.welcome_sent).toBe(true)
    expect(state.telegramCalls).toBe(1)
  })
})

describe("processSinglePrewarmRow — backfill dispatch branches", () => {
  it("INGEST_SECRET_TOKEN missing → backfill_dispatch failed marker, no backfill fetch", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    const out = await processSinglePrewarmRow(baseRow(), ORIGIN)
    expect(out.prewarm_summary.backfill_dispatch).toBe("failed: INGEST_SECRET_TOKEN not set")
    const calledBackfill = fetchMock.mock.calls.some((c) =>
      String(c[0]).includes("/api/wallet-backfill-multicollection")
    )
    expect(calledBackfill).toBe(false)
  })

  it("backfill HTTP non-ok → backfill_dispatch records the status", async () => {
    state.backfill = { ok: false, status: 503 }
    const out = await processSinglePrewarmRow(baseRow(), ORIGIN)
    expect(out.prewarm_summary.backfill_dispatch).toBe("failed: HTTP 503")
    // still completes + welcomes (dispatch failure never blocks)
    expect(out.finish_status).toBe("complete")
    expect(out.welcome_sent).toBe(true)
  })

  it("seeded_wallets already present → no insert attempted", async () => {
    state.seededSelect = { data: { id: "sw-1" }, error: null }
    const out = await processSinglePrewarmRow(baseRow(), ORIGIN)
    // select returns existing → early return before insert; still completes
    expect(out.finish_status).toBe("complete")
  })
})
