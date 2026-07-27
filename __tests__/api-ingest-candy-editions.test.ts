import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/ingest/candy-editions (GET + POST). FAIL-CLOSED
// auth accepts Bearer INGEST_SECRET_TOKEN or CRON_SECRET. Deep legs added: the
// discovery_pending 202 short-circuit, and the captured after() DAS walk —
// paginateGroup fan-out, the burnt/pack skip filter, per-page edition dedup +
// chunked upsert, the serial→wmc map (null wallet/moment dropped), the upsert
// error branches, the logRun success telemetry, and the thrown-walk catch.

const st = vi.hoisted(() => ({
  ready: true,
  pages: [] as any[][],
  edUpsert: { data: [{ id: "e1" }] as { id: string }[] | null, error: null as any },
  wmcUpsert: { data: [{ moment_id: "m1" }], error: null as any },
  packUpsert: { data: [{ token_mint: "p1" }] as { token_mint: string }[] | null, error: null as any },
  jerseyUpsert: { data: [{ external_id: "ed1" }] as { external_id: string }[] | null, error: null as any },
  paginateThrows: false,
  runs: [] as any[],
  captured: null as null | (() => Promise<void>),
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: any) => { st.captured = fn } }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (_name: string, args: any) => { st.runs.push(args); return { data: null, error: null } },
    from(table: string) {
      return {
        upsert: () => ({
          select: async () =>
            table === "editions"
              ? st.edUpsert
              : table === "candy_packs"
                ? st.packUpsert
                : st.wmcUpsert,
        }),
      }
    },
  },
}))
vi.mock("@/lib/chains/solana/das", () => ({
  paginateGroup: async (_addr: string, cb: (items: any[]) => Promise<void>) => {
    if (st.paginateThrows) throw new Error("DAS down")
    let seen = 0
    for (const page of st.pages) { seen += page.length; await cb(page) }
    return seen
  },
}))
vi.mock("@/lib/chains/solana/normalize", () => ({
  CANDY_MLB_COLLECTION_ADDRESS: "col-addr",
  CANDY_MLB_SLUG: "candy_mlb",
  candyDiscoveryReady: () => st.ready,
  // "burntpack" is BOTH — the case that proves packs are checked before the
  // burnt filter (a burnt pack is an OPENED pack and must still be recorded).
  isBurnt: (a: any) => a.kind === "burnt" || a.kind === "burntpack",
  isPack: (a: any) => a.kind === "pack" || a.kind === "burntpack",
  normalizeEdition: (a: any) => ({ external_id: a.ed ?? null, collection_id: "c1", jersey_number: a.jersey ?? null }),
  normalizeSerial: (a: any) => ({ wallet_address: a.w ?? null, moment_id: a.m ?? null, tier: "COMMON" }),
  normalizePack: (a: any) => ({ token_mint: a.m ?? "p1", collection_id: "c1", is_burnt: a.kind === "burntpack" }),
}))

import { GET, POST } from "@/app/api/ingest/candy-editions/route"

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv("CRON_SECRET", "")
  st.ready = true
  st.pages = [[{ kind: "icon", ed: "ed1", w: "w1", m: "m1" }, { kind: "burnt" }, { kind: "pack" }]]
  st.edUpsert = { data: [{ id: "e1" }], error: null }
  st.wmcUpsert = { data: [{ moment_id: "m1" }], error: null }
  st.packUpsert = { data: [{ token_mint: "p1" }], error: null }
  st.jerseyUpsert = { data: [{ external_id: "ed1" }], error: null }
  st.paginateThrows = false
  st.runs = []
  st.captured = null
})

describe("candy-editions — auth", () => {
  it("401s FAIL-CLOSED when no auth secret is set", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "")
    expect((await POST(makeReq({ url: "https://t/api/ingest/candy-editions" }))).status).toBe(401)
  })
  it("401s on a non-matching Bearer", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "secret")
    expect((await POST(makeReq({ url: "https://t/api/ingest/candy-editions", auth: "Bearer wrong" }))).status).toBe(401)
  })
  it("GET 401s FAIL-CLOSED", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "")
    expect((await GET(makeReq({ url: "https://t/api/ingest/candy-editions", method: "GET" }))).status).toBe(401)
  })
})

describe("candy-editions — accept + discovery gate", () => {
  it("202-accepts on a valid INGEST token and captures the after() walk", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "secret")
    const res = await POST(makeReq({ url: "https://t/api/ingest/candy-editions", auth: "Bearer secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)
    expect(st.captured).toBeTypeOf("function")
  })
  it("GET 202-accepts on Bearer CRON_SECRET (Vercel cron path)", async () => {
    vi.stubEnv("CRON_SECRET", "cronsecret")
    const res = await GET(makeReq({ url: "https://t/api/ingest/candy-editions", method: "GET", auth: "Bearer cronsecret" }))
    expect(res.status).toBe(202)
  })
  it("202 discovery_pending (no walk) when discovery isn't ready", async () => {
    st.ready = false
    vi.stubEnv("INGEST_SECRET_TOKEN", "secret")
    const res = await POST(makeReq({ url: "https://t/api/ingest/candy-editions", auth: "Bearer secret" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(false)
    expect(body.skipped).toBe("discovery_pending")
    expect(st.captured).toBeNull() // after() never scheduled
    // logRun recorded the skip
    expect(st.runs[0].p_extra.skip_reason).toBe("discovery_pending")
  })
})

describe("candy-editions — the after() DAS walk", () => {
  async function accept() {
    vi.stubEnv("INGEST_SECRET_TOKEN", "secret")
    await POST(makeReq({ url: "https://t/api/ingest/candy-editions", auth: "Bearer secret" }))
  }

  it("filters burnt+pack, upserts editions + serials, and logs a success run", async () => {
    await accept()
    await st.captured!()
    const run = st.runs[0]
    expect(run.p_ok).toBe(true)
    expect(run.p_extra.assets_seen).toBe(3)
    // Renamed 2026-07-26: these are upsert ROWS TOUCHED, not catalog size — the
    // same edition is re-upserted on every DAS page, which is why the old
    // `editions_written` read 3,108 against a 125-edition catalog.
    expect(run.p_extra.edition_rows_touched).toBe(1)
    expect(run.p_extra.serial_rows_touched).toBe(1)
    expect(run.p_extra.editions_written).toBeUndefined()
    expect(run.p_extra.serials_written).toBeUndefined()
    // The honest catalog counts, deduped across pages.
    expect(run.p_extra.editions_distinct).toBe(1)
    expect(run.p_extra.serials_distinct).toBe(1)
    expect(run.p_extra.burnt_skipped).toBe(1)
    expect(run.p_extra.packs_skipped).toBe(1)
    // Packs are no longer thrown away — the DAS walk already paid for them and
    // they feed candy_pack_market.
    expect(run.p_extra.pack_rows_touched).toBe(1)
    expect(run.p_extra.packs_distinct).toBe(1)
  })

  it("drops serials with a null wallet/moment and tolerates upsert errors", async () => {
    st.pages = [[{ kind: "icon", ed: "ed1", w: null, m: null }]] // serial dropped
    st.edUpsert = { data: null, error: { message: "ed err" } } // edition upsert error branch
    await accept()
    await st.captured!()
    const run = st.runs[0]
    expect(run.p_ok).toBe(true)
    expect(run.p_extra.edition_rows_touched).toBe(0)
    expect(run.p_extra.serial_rows_touched).toBe(0)
    // The edition WAS seen (distinct counts the payload, not the write), the
    // upsert just failed; the serial was dropped before it could be counted.
    expect(run.p_extra.editions_distinct).toBe(1)
    expect(run.p_extra.serials_distinct).toBe(0)
  })

  it("logs an ok:false run when the DAS walk throws", async () => {
    st.paginateThrows = true
    await accept()
    await st.captured!()
    expect(st.runs[0].p_ok).toBe(false)
    expect(st.runs[0].p_error).toContain("DAS down")
  })
})


// Sealed-pack capture (added 2026-07-27). The collection mixes Item Type=Pack
// assets with the ICONs; the walk used to count them (`packs_skipped`) and drop
// them, so RPC had no pack supply, no pack holders and no opened-vs-sealed
// split — while paying for the fetch every day.
describe("candy-editions — sealed-pack inventory", () => {
  it("records a BURNT pack (an opened pack) rather than discarding it as burnt", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "secret")
    // A burnt PACK must reach candy_packs; a burnt CARD must still be skipped.
    st.pages = [[{ kind: "burntpack", m: "p9" }, { kind: "burnt" }]]
    st.packUpsert = { data: [{ token_mint: "p9" }], error: null }
    await POST(makeReq({ url: "https://t/api/ingest/candy-editions", auth: "Bearer secret" }))
    await st.captured!()
    const run = st.runs[0]
    expect(run.p_ok).toBe(true)
    // The pack was counted as a pack, NOT as a burnt card...
    expect(run.p_extra.packs_skipped).toBe(1)
    expect(run.p_extra.burnt_skipped).toBe(1) // the burnt CARD only
    // ...and it landed in candy_packs, because is_burnt IS the opened signal.
    expect(run.p_extra.pack_rows_touched).toBe(1)
    expect(run.p_extra.packs_distinct).toBe(1)
    // No card rows from a page of a pack + a burnt card.
    expect(run.p_extra.editions_distinct).toBe(0)
    expect(run.p_extra.serials_distinct).toBe(0)
  })

  it("a candy_packs upsert error is non-fatal and leaves the run ok", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "secret")
    st.pages = [[{ kind: "pack", m: "p1" }]]
    st.packUpsert = { data: null, error: { message: "pack err" } }
    await POST(makeReq({ url: "https://t/api/ingest/candy-editions", auth: "Bearer secret" }))
    await st.captured!()
    const run = st.runs[0]
    expect(run.p_ok).toBe(true)
    expect(run.p_extra.pack_rows_touched).toBe(0)
    expect(run.p_extra.packs_distinct).toBe(0)
  })
})


// Jersey capture (added 2026-07-27, rehomed the same day). The board's Serials
// footnote asserted that "Candy players carry no jersey number" and used that to
// justify having no jersey-match rows. It is false — Aaron Judge #99, Manny
// Machado #13, Mike Trout #27, all verified on-chain metadata. The walk already
// reads the same attribute map for player_name and team; it was dropping this one.
//
// REHOMED: this first shipped writing a Candy-only `candy_player_numbers` table.
// That was wrong — `editions.jersey_number` is the platform-wide column Top Shot
// (65% filled) and All Day (88%) already use, and the one that feeds the
// jersey-match special-serial row. The value now rides the editions upsert that
// was happening anyway, so there is no second write to fail and no Candy-specific
// table for downstream consumers to special-case.
describe("candy-editions — jersey numbers", () => {
  it("carries Player Number on the editions row and counts trait coverage", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "secret")
    st.pages = [[{ kind: "icon", ed: "ed1", w: "w1", m: "m1", pn: "Mike Trout", jersey: 27 }]]
    await POST(makeReq({ url: "https://t/api/ingest/candy-editions", auth: "Bearer secret" }))
    await st.captured!()
    const run = st.runs[0]
    expect(run.p_ok).toBe(true)
    expect(run.p_extra.jerseys_distinct).toBe(1)
    expect(run.p_extra.editions_distinct).toBe(1)
  })

  it("counts no jersey for an asset with no Player Number, but still lands the edition", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "secret")
    st.pages = [[{ kind: "icon", ed: "ed1", w: "w1", m: "m1", pn: "No Number", jersey: null }]]
    await POST(makeReq({ url: "https://t/api/ingest/candy-editions", auth: "Bearer secret" }))
    await st.captured!()
    const run = st.runs[0]
    expect(run.p_ok).toBe(true)
    expect(run.p_extra.jerseys_distinct).toBe(0)
    expect(run.p_extra.editions_distinct).toBe(1)
  })

  // Replaces "a candy_player_numbers upsert error is non-fatal". There is no
  // separate jersey write left to fail: the jersey shares the editions upsert, so
  // the guarantee worth pinning is that an editions failure does not leave the
  // jersey counter claiming coverage the DB never received.
  it("does not count jersey coverage when the editions upsert itself failed", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "secret")
    st.pages = [[{ kind: "icon", ed: "ed1", w: "w1", m: "m1", jersey: 99 }]]
    st.edUpsert = { data: null, error: { message: "editions err" } }
    await POST(makeReq({ url: "https://t/api/ingest/candy-editions", auth: "Bearer secret" }))
    await st.captured!()
    const run = st.runs[0]
    expect(run.p_ok).toBe(true)
    expect(run.p_extra.edition_rows_touched).toBe(0)
  })
})
