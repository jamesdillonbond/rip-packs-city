import { describe, it, expect, vi } from "vitest"

// The route builds a supabase client at module load; give it a URL so the
// import succeeds. Nothing here talks to it — the test passes its own client.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321"
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test"

import {
  readPreviousSweep,
  summarizeSentinelChange,
  PREVIOUS_SWEEP_READ_MS,
  DELIVERY_TIMEOUT_MS,
  SENTINEL_WALL_MS,
  SENTINEL_RESERVE_MS,
} from "@/app/api/sentinel/route"
import { MIN_TERMINAL_MS, TERMINAL_MARGIN_MS } from "@/lib/sentinel/wall-budget"

/**
 * ── WHY THIS EXISTS (register R77, 2026-10-03) ─────────────────────────────
 * During the 2026-09-18 outage (#122) GitHub fired the sentinel at 16:38Z and
 * got `504 FUNCTION_INVOCATION_TIMEOUT` three times while Supabase answered
 * Cloudflare `522`. The alarm RAN and died at its wall — the register had read
 * the 420-minute gap in `pipeline_runs` as "the sentinel never executed".
 *
 * Between the checks and delivery sits ONE database read (the previous sweep,
 * for the header delta), and the terminal phase used to hand it the whole
 * remaining wall. A database that HANGS instead of failing fast could therefore
 * spend the seconds Telegram and email were reserved. These cases pin that it
 * cannot: the read answers or gives up inside its own bound, and the bound fits
 * the delivery guarantee.
 */

/** A client whose every query never settles — the hung-database shape. */
function hungClient() {
  const chain: any = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    lt: () => chain,
    order: () => chain,
    limit: () => new Promise(() => {}),
  }
  return chain
}

function answeringClient(rows: unknown[], error: unknown = null) {
  const chain: any = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    lt: () => chain,
    order: () => chain,
    limit: async () => ({ data: rows, error }),
  }
  return chain
}

describe("readPreviousSweep — the one read standing between the checks and the page", () => {
  it("⭐ gives up on a database that never answers, inside its own bound", async () => {
    vi.useFakeTimers()
    try {
      let settled: unknown = undefined
      const p = readPreviousSweep(hungClient(), "2026-09-18T16:39:00Z", 8_000).then((r) => (settled = r))

      await vi.advanceTimersByTimeAsync(7_999)
      expect(settled).toBeUndefined()

      await vi.advanceTimersByTimeAsync(1)
      await p
      expect(settled).toMatchObject({ ok: false })
      expect((settled as any).reason).toContain("did not answer within 8s")
    } finally {
      vi.useRealTimers()
    }
  })

  // The give-up must still render as UNAVAILABLE, never as "no change" — the
  // honesty property the header test pins for every other failure arm.
  it("a timed-out read never becomes a claim about the fleet", async () => {
    vi.useFakeTimers()
    try {
      const p = readPreviousSweep(hungClient(), "2026-09-18T16:39:00Z", 1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      const prev = await p
      const line = summarizeSentinelChange([{ name: "Pipeline Silence", status: "critical" }], prev)
      expect(line).toContain("UNAVAILABLE")
      expect(line).not.toMatch(/no change|NEW:|cleared:/)
    } finally {
      vi.useRealTimers()
    }
  })

  it("still returns the real answer when the database is healthy", async () => {
    const prev = await readPreviousSweep(
      answeringClient([{ started_at: "2026-09-18T15:34:00Z", extra: { warn: ["Dune Spend"], critical: [] } }]),
      "2026-09-18T16:39:00Z",
    )
    expect(prev).toEqual({ ok: true, names: ["Dune Spend"], at: "2026-09-18T15:34:00Z" })
  })

  it("keeps the existing failure arms (read error → UNAVAILABLE with the reason)", async () => {
    const prev = await readPreviousSweep(answeringClient([], { message: "boom" }), "2026-09-18T16:39:00Z")
    expect(prev).toEqual({ ok: false, reason: "read failed: boom" })
  })
})

describe("the delivery guarantee, as arithmetic", () => {
  // Once the checks budget (wall − reserve) is spent, everything left before the
  // terminal write must fit: the previous-sweep read, BOTH delivery bounds, and
  // the margin the wall keeps for the JSON — with the terminal write's floor
  // still available. Raising any of these without re-deriving reds here.
  it("checks budget + previous read + two sends + terminal floor + margin ≤ wall", () => {
    const checksBudget = SENTINEL_WALL_MS - SENTINEL_RESERVE_MS
    expect(
      checksBudget + PREVIOUS_SWEEP_READ_MS + 2 * DELIVERY_TIMEOUT_MS + MIN_TERMINAL_MS + TERMINAL_MARGIN_MS,
    ).toBeLessThanOrEqual(SENTINEL_WALL_MS)
  })

  it("the previous read's default bound is the one the route uses", async () => {
    vi.useFakeTimers()
    try {
      const p = readPreviousSweep(hungClient(), "2026-09-18T16:39:00Z")
      await vi.advanceTimersByTimeAsync(PREVIOUS_SWEEP_READ_MS)
      expect(await p).toMatchObject({ ok: false })
    } finally {
      vi.useRealTimers()
    }
  })
})
