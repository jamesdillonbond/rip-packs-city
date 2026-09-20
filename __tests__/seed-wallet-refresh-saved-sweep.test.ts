import { describe, it, expect, vi } from "vitest"

// Unit tests for the saved-wallet ownership sweep added to
// /api/seed-wallet-refresh on 2026-09-20.
//
// ⚠ WHY THESE ARE UNIT TESTS AND NOT ROUTE TESTS. The route suite
// (api-seed-wallet-refresh.test.ts) stubs `after()` to a no-op so the 202 is
// observable, which makes EVERYTHING inside `after()` unreachable from a test —
// and the selection policy is what this change is about. That is exactly why
// `dispatchPlan` was extracted in 2026-09-13 and why `planSavedWalletSweep`,
// `cohortOfAddress` and the loader are exported here.
//
// ⛔ THE DEFECT THESE PIN IS A POPULATION BUG, NOT A FRESHNESS ONE. Before this
// change the recurring sweep selected from `seeded_wallets` only, so a wallet a
// real user SAVED was re-verified only if it also happened to be a seeded
// demo/benchmark wallet (measured 2026-09-20: 22 of 27 saved wallets swept at
// 0.18-0.71 days, the other 5 at 5.86-42.87 days, ranges non-overlapping). So the
// properties worth holding are: a saved-only wallet IS selected, an
// already-seeded one is NOT (or the cost doubles), and one wallet maps to exactly
// ONE cohort (or four lambdas each dispatch it).

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: () => ({}) }) }))

import {
  cohortOfAddress,
  planSavedWalletSweep,
  loadSavedOnlyCandidates,
  type SavedSweepCandidate,
} from "@/app/api/seed-wallet-refresh/route"

const HOUR = 60 * 60 * 1000
const NOW = Date.parse("2026-09-20T12:00:00Z")
const STALE_MS = 24 * HOUR

function cadence(nibble: string): string {
  return `0x${nibble.repeat(16).slice(0, 16)}`
}

const FLOW_A = cadence("a")
const FLOW_B = cadence("b")
const FLOW_C = cadence("c")
const SOLANA = "AGzqZEJXbYeJze7aba6xTvQRHCt5ENmLhjbXejnzSpcQ"
const EVM = "0x" + "d".repeat(40)

function plan(candidates: SavedSweepCandidate[], overrides: Partial<{ staleMs: number; maxPerWave: number }> = {}) {
  return planSavedWalletSweep({
    candidates,
    nowMs: NOW,
    staleMs: overrides.staleMs ?? STALE_MS,
    maxPerWave: overrides.maxPerWave ?? 10,
  })
}

describe("planSavedWalletSweep — which saved wallets get re-verified", () => {
  it("picks a wallet whose newest walk is older than the threshold", () => {
    const out = plan([{ wallet: FLOW_A, lastScannedAtMs: NOW - 42 * 24 * HOUR }])
    expect(out.picked.map((p) => p.wallet)).toEqual([FLOW_A])
    expect(out.freshSkipped).toBe(0)
  })

  it("leaves a wallet walked inside the threshold alone", () => {
    // The seeded herd sits at 0.18-0.71 days; this is the arm that keeps the
    // sweep from re-dispatching work a primary wave already did.
    const out = plan([{ wallet: FLOW_A, lastScannedAtMs: NOW - 4 * HOUR }])
    expect(out.picked).toHaveLength(0)
    expect(out.freshSkipped).toBe(1)
  })

  it("treats a NEVER-scanned wallet as the most stale thing there is", () => {
    // ⛔ NaN must not read as "freshness unknown, skip it" — a saved wallet with
    // no wallet_backfill_state row has never had its ownership verified at all,
    // which is the worst case this sweep exists for.
    const out = plan([
      { wallet: FLOW_A, lastScannedAtMs: NOW - 30 * 24 * HOUR },
      { wallet: FLOW_B, lastScannedAtMs: NaN },
    ])
    expect(out.picked.map((p) => p.wallet)).toEqual([FLOW_B, FLOW_A])
  })

  it("caps the BURST at maxPerWave and drops the FRESHEST, never an arbitrary slice", () => {
    const out = plan(
      [
        { wallet: FLOW_A, lastScannedAtMs: NOW - 10 * 24 * HOUR },
        { wallet: FLOW_B, lastScannedAtMs: NOW - 40 * 24 * HOUR },
        { wallet: FLOW_C, lastScannedAtMs: NOW - 25 * 24 * HOUR },
      ],
      { maxPerWave: 2 }
    )
    expect(out.picked.map((p) => p.wallet)).toEqual([FLOW_B, FLOW_C])
    expect(out.cappedOut).toBe(1)
  })

  it("staleMs=0 DISABLES the sweep, and says so rather than reporting zero stale", () => {
    // ⚠ The operator kill switch (SEED_REFRESH_SAVED_STALE_HOURS=0). A disabled
    // sweep must not look like a sweep that ran and found nothing: every counter
    // stays 0 INCLUDING freshSkipped, so the caller's `state` field is the only
    // thing distinguishing them — which is why the caller reports NULL counts here.
    const out = plan(
      [
        { wallet: FLOW_A, lastScannedAtMs: NOW - 40 * 24 * HOUR },
        { wallet: FLOW_B, lastScannedAtMs: NOW - 2 * HOUR },
      ],
      { staleMs: 0 }
    )
    expect(out.picked).toHaveLength(0)
    expect(out.freshSkipped).toBe(0)
    expect(out.cappedOut).toBe(0)
  })

  it("excludes a non-Flow address from this Flow fan-out and COUNTS the exclusion", () => {
    const out = plan([
      { wallet: SOLANA, lastScannedAtMs: NaN },
      { wallet: EVM, lastScannedAtMs: NaN },
      { wallet: FLOW_A, lastScannedAtMs: NaN },
    ])
    expect(out.nonCadenceSkipped).toBe(2)
    // ⛔ THE NO-CHANGE ARM. `isValidAddressForChain`-style gating is STRICTER than
    // the `startsWith("0x")` it replaces, so a Solana assertion can pass against a
    // function that silently stopped selecting Flow wallets too. This pins the hex
    // path as its own subject.
    expect(out.picked.map((p) => p.wallet)).toEqual([FLOW_A])
  })
})

describe("cohortOfAddress — one wallet, exactly one cohort", () => {
  const addresses = Array.from({ length: 200 }, (_, i) =>
    "0x" + i.toString(16).padStart(16, "0")
  )

  it("assigns every address to exactly one of N cohorts", () => {
    // ⛔ THE PROPERTY THAT PREVENTS A 4x FAN-OUT. The four cron cohorts run in
    // separate lambdas minutes apart and never see each other's picks; the walks
    // are async, so `last_scanned_at` has not moved when the next cohort reads.
    // If an address could land in two buckets it would be dispatched twice.
    for (const n of [2, 3, 4, 8]) {
      const hits = addresses.map((a) =>
        Array.from({ length: n }, (_, k) => k).filter((k) => cohortOfAddress(a, n) === k)
      )
      expect(hits.every((h) => h.length === 1)).toBe(true)
    }
  })

  it("is stable across calls — the bucket is a function of the address alone", () => {
    for (const a of addresses.slice(0, 20)) {
      expect(cohortOfAddress(a, 4)).toBe(cohortOfAddress(a, 4))
    }
  })

  it("actually spreads across the cohorts rather than piling into one", () => {
    // A not-vacuous check: a constant function would satisfy "exactly one cohort"
    // above while destroying the split that bounds per-wave load.
    const counts = new Map<number, number>()
    for (const a of addresses) {
      const k = cohortOfAddress(a, 4)
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    expect(counts.size).toBe(4)
    for (const c of counts.values()) expect(c).toBeGreaterThan(200 / 4 / 3)
  })

  it("collapses to cohort 0 when the wave is not split", () => {
    for (const a of addresses.slice(0, 10)) expect(cohortOfAddress(a, 1)).toBe(0)
  })
})

// ── Loader ────────────────────────────────────────────────────────────────
// A minimal PostgREST-shaped stub. Every builder method returns `this`; the
// object is awaited directly, which is how the supabase-js builder behaves.
function stubSupabase(opts: {
  saved?: Array<{ wallet_addr: string | null }>
  savedError?: string
  scans?: Array<{ wallet_address: string; last_scanned_at: string | null }>
  scansError?: string
}) {
  return {
    from(table: string) {
      const builder: any = {
        _in: null as string[] | null,
        select: () => builder,
        not: () => builder,
        order: () => builder,
        limit: () => builder,
        gt: () => builder,
        in: (_col: string, values: string[]) => {
          builder._in = values
          return builder
        },
        then: (resolve: (v: any) => unknown) => {
          if (table === "saved_wallets") {
            return Promise.resolve(
              opts.savedError
                ? { data: null, error: { message: opts.savedError } }
                : { data: opts.saved ?? [], error: null }
            ).then(resolve)
          }
          const rows = (opts.scans ?? []).filter(
            (r) => !builder._in || builder._in.includes(r.wallet_address)
          )
          return Promise.resolve(
            opts.scansError
              ? { data: null, error: { message: opts.scansError } }
              : { data: rows, error: null }
          ).then(resolve)
        },
      }
      return builder
    },
  }
}

describe("loadSavedOnlyCandidates — the population, and honesty about reading it", () => {
  it("returns saved wallets that no ACTIVE seeded row covers", async () => {
    const out = await loadSavedOnlyCandidates(
      stubSupabase({
        saved: [{ wallet_addr: FLOW_A }, { wallet_addr: FLOW_B }],
        scans: [
          { wallet_address: FLOW_A, last_scanned_at: "2026-08-08T20:58:22Z" },
          { wallet_address: FLOW_A, last_scanned_at: "2026-09-14T21:22:03Z" },
        ],
      }),
      new Set<string>(),
      0,
      1
    )
    expect(out.error).toBeNull()
    expect(out.candidates.map((c) => c.wallet).sort()).toEqual([FLOW_A, FLOW_B].sort())
    // Newest stamp wins — an older per-collection row must not make a wallet
    // look staler than it is.
    const a = out.candidates.find((c) => c.wallet === FLOW_A)!
    expect(a.lastScannedAtMs).toBe(Date.parse("2026-09-14T21:22:03Z"))
    // No wallet_backfill_state row at all -> never scanned.
    expect(Number.isNaN(out.candidates.find((c) => c.wallet === FLOW_B)!.lastScannedAtMs)).toBe(true)
  })

  it("excludes a wallet an active seeded row already sweeps", async () => {
    // ⭐ THIS IS WHAT BOUNDS THE COST. The marginal load of this sweep is
    // |saved \ active-seeded|, which was 5 wallets on 2026-09-20 — 22 of the 27
    // saved wallets are already walked by their own seeded cohort, and dispatching
    // them here would double that work while adding no freshness at all.
    const out = await loadSavedOnlyCandidates(
      stubSupabase({ saved: [{ wallet_addr: FLOW_A }, { wallet_addr: FLOW_B }] }),
      new Set([FLOW_A]),
      0,
      1
    )
    expect(out.candidates.map((c) => c.wallet)).toEqual([FLOW_B])
  })

  it("keeps only this cohort's slice, and the slices partition the population", async () => {
    const saved = Array.from({ length: 60 }, (_, i) => ({
      wallet_addr: "0x" + i.toString(16).padStart(16, "0"),
    }))
    const seen: string[] = []
    for (let k = 0; k < 4; k++) {
      const out = await loadSavedOnlyCandidates(
        stubSupabase({ saved }),
        new Set<string>(),
        k,
        4
      )
      seen.push(...out.candidates.map((c) => c.wallet))
    }
    expect(seen.sort()).toEqual(saved.map((s) => s.wallet_addr!).sort())
    expect(new Set(seen).size).toBe(saved.length)
  })

  it("reports a FAILED read as an error, never as an empty sweep", async () => {
    // ⛔ The defect class this repo calls the most productive one: a read fails and
    // the surface publishes the failure as a fact. An empty candidate list with
    // `error: null` would mean "no saved wallet needs verifying" — a claim nobody
    // measured. The caller keys its NULL counts on this field.
    const savedFailed = await loadSavedOnlyCandidates(
      stubSupabase({ savedError: "boom" }),
      new Set<string>(),
      0,
      1
    )
    expect(savedFailed.candidates).toHaveLength(0)
    expect(savedFailed.error).toContain("saved_wallets")

    const scansFailed = await loadSavedOnlyCandidates(
      stubSupabase({ saved: [{ wallet_addr: FLOW_A }], scansError: "timeout" }),
      new Set<string>(),
      0,
      1
    )
    expect(scansFailed.candidates).toHaveLength(0)
    expect(scansFailed.error).toContain("wallet_backfill_state")
  })

  it("is satisfiable at a population of zero", async () => {
    // A guard that punishes its own success is a guard that gets deleted. When
    // every saved wallet is seeded, an empty list with no error is the honest
    // answer and must not read as a failure.
    const out = await loadSavedOnlyCandidates(
      stubSupabase({ saved: [{ wallet_addr: FLOW_A }] }),
      new Set([FLOW_A]),
      0,
      1
    )
    expect(out.candidates).toHaveLength(0)
    expect(out.error).toBeNull()
    expect(out.truncated).toBe(false)
  })
})
