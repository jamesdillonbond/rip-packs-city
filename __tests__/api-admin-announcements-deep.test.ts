import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// POST /api/admin/announcements — the community-announcement webhook ingest
// (Discord / Make.com). It is a PUBLIC-INTERNET write endpoint with a shared
// bearer, so its whole job is turning arbitrary third-party JSON into exactly
// one well-formed row. The parts that were untested are the ones that decide
// what actually lands:
//
//   - the ?token= auth lane (the header lane was covered; a webhook platform
//     that can't set headers uses the query one, so it must work AND must not
//     accept a wrong token);
//   - the DEDUPE KEY. With no external_id the route derives a stable
//     sha256(source|title|posted_at) — so a retrying webhook re-posts the same
//     row rather than duplicating the feed. If posted_at defaulted to `now()`
//     per attempt AND the hash used it, every retry would insert a duplicate;
//     the test pins that an explicit posted_at yields a STABLE id.
//   - raw_payload capture: unknown fields are preserved rather than dropped, so
//     a platform that renames a field doesn't silently lose data — but known
//     fields must NOT be duplicated into it.
//   - the ignoreDuplicates upsert reporting `skipped_duplicate` rather than
//     pretending it inserted.

const state = vi.hoisted(() => ({
  upserted: [] as Record<string, unknown>[],
  result: { data: [{ id: 4242 }] as unknown, error: null as unknown },
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      upsert: (row: Record<string, unknown>) => {
        state.upserted.push(row)
        return { select: async () => state.result }
      },
    }),
  },
}))

const { POST } = await import("@/app/api/admin/announcements/route")

const URL_ = "https://t/api/admin/announcements"
const authed = (body: unknown) => adminReq(URL_, { authorization: "Bearer tok", body })
const lastRow = () => state.upserted.at(-1)!

beforeEach(() => {
  process.env.ANNOUNCEMENTS_INGEST_TOKEN = "tok"
  state.upserted = []
  state.result = { data: [{ id: 4242 }], error: null }
})
afterEach(() => {
  delete process.env.ANNOUNCEMENTS_INGEST_TOKEN
})

describe("announcements — auth lanes", () => {
  it("accepts the ?token= lane and rejects a wrong value on both lanes", async () => {
    const ok = await POST(adminReq(`${URL_}?token=tok`, { body: { source: "topshot", title: "x" } }))
    expect(ok.status).toBe(200)

    expect((await POST(adminReq(`${URL_}?token=nope`, { body: { source: "topshot", title: "x" } }))).status).toBe(401)
    expect((await POST(adminReq(URL_, { authorization: "Bearer nope", body: { source: "topshot", title: "x" } }))).status).toBe(401)
  })
})

describe("announcements — body validation", () => {
  it("400s on an unparseable body and on a non-object body", async () => {
    const unparseable = await POST(adminReq(URL_, { authorization: "Bearer tok", noBody: true }))
    expect(unparseable.status).toBe(400)
    expect((await unparseable.json()).error).toBe("Invalid JSON body")

    // A webhook platform posting a bare array or scalar must be rejected as a
    // body problem, not mis-reported as a missing `source`.
    for (const body of [[], "a string", 7]) {
      const res = await POST(authed(body))
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((await res.json()).field).toBe("body")
    }
  })

  it("rejects a whitespace-only title but accepts and trims a padded one", async () => {
    const blank = await POST(authed({ source: "topshot", title: "   " }))
    expect(blank.status).toBe(400)
    expect((await blank.json()).error).toContain("must not be empty after trim")

    await POST(authed({ source: "topshot", title: "  Drop incoming  " }))
    expect(lastRow().title).toBe("Drop incoming")
  })

  it("accepts every allowed source and rejects a non-string one", async () => {
    for (const source of ["topshot", "pinnacle", "allday", "golazos", "ufc"]) {
      expect((await POST(authed({ source, title: "t" }))).status, source).toBe(200)
    }
    expect((await POST(authed({ source: 7, title: "t" }))).status).toBe(400)
  })

  it("validates source_url as a real URL and treats null/absent as no URL", async () => {
    const bad = await POST(authed({ source: "topshot", title: "t", source_url: "not a url" }))
    expect(bad.status).toBe(400)
    expect((await bad.json()).field).toBe("source_url")
    expect((await POST(authed({ source: "topshot", title: "t", source_url: 5 }))).status).toBe(400)

    await POST(authed({ source: "topshot", title: "t", source_url: null }))
    expect(lastRow().source_url).toBeNull()

    await POST(authed({ source: "topshot", title: "t", source_url: "https://discord.gg/x" }))
    expect(lastRow().source_url).toBe("https://discord.gg/x")
  })

  it("validates posted_at and normalizes it to ISO", async () => {
    expect((await POST(authed({ source: "topshot", title: "t", posted_at: 1720000000 }))).status).toBe(400)
    const unparseable = await POST(authed({ source: "topshot", title: "t", posted_at: "last tuesday" }))
    expect(unparseable.status).toBe(400)
    expect((await unparseable.json()).field).toBe("posted_at")

    await POST(authed({ source: "topshot", title: "t", posted_at: "2026-07-20T12:00:00+00:00" }))
    expect(lastRow().posted_at).toBe("2026-07-20T12:00:00.000Z")
  })

  it("rejects an empty or non-string external_id", async () => {
    for (const external_id of ["", "   ", 5]) {
      const res = await POST(authed({ source: "topshot", title: "t", external_id }))
      expect(res.status, JSON.stringify(external_id)).toBe(400)
      expect((await res.json()).field).toBe("external_id")
    }
  })
})

describe("announcements — the dedupe key", () => {
  it("derives a STABLE 32-hex id from source|title|posted_at when none is supplied", async () => {
    const payload = { source: "topshot", title: "Series 5 drop", posted_at: "2026-07-20T12:00:00Z" }
    const first = await (await POST(authed(payload))).json()
    const second = await (await POST(authed(payload))).json()

    // A retrying webhook must land on the SAME key, or the feed duplicates.
    expect(first.external_id).toBe(second.external_id)
    expect(first.external_id).toMatch(/^[0-9a-f]{32}$/)
  })

  it("changes the derived id when any of the three inputs changes", async () => {
    const base = { source: "topshot", title: "A", posted_at: "2026-07-20T12:00:00Z" }
    const id = async (over: Record<string, unknown>) =>
      (await (await POST(authed({ ...base, ...over }))).json()).external_id

    const original = await id({})
    expect(await id({ source: "allday" })).not.toBe(original)
    expect(await id({ title: "B" })).not.toBe(original)
    expect(await id({ posted_at: "2026-07-21T12:00:00Z" })).not.toBe(original)
  })

  it("prefers an explicitly supplied external_id over the derived one", async () => {
    const body = await (await POST(authed({ source: "topshot", title: "t", external_id: "discord-msg-9" }))).json()
    expect(body.external_id).toBe("discord-msg-9")
    expect(lastRow().external_id).toBe("discord-msg-9")
  })
})

describe("announcements — raw_payload + outcomes", () => {
  it("captures unknown fields into raw_payload without duplicating the known ones", async () => {
    await POST(authed({
      source: "topshot", title: "t", content: "c", source_channel: "#drops",
      author: "mod", reactions: 12,
    }))
    const row = lastRow()
    expect(row.raw_payload).toEqual({ author: "mod", reactions: 12 })
    expect(row).toMatchObject({ content: "c", source_channel: "#drops" })
  })

  it("leaves raw_payload null when every field is known, and defaults the optionals", async () => {
    await POST(authed({ source: "topshot", title: "t" }))
    expect(lastRow()).toMatchObject({
      raw_payload: null, content: "", source_channel: null, attachments: null, source_url: null,
    })
  })

  it("reports skipped_duplicate rather than pretending it inserted", async () => {
    state.result = { data: [], error: null }
    const body = await (await POST(authed({ source: "topshot", title: "t", external_id: "dup" }))).json()
    expect(body).toMatchObject({ status: "skipped_duplicate", source: "topshot", external_id: "dup" })
    expect(body.id).toBeUndefined()

    state.result = { data: null, error: null }
    expect((await (await POST(authed({ source: "topshot", title: "t" }))).json()).status).toBe("skipped_duplicate")
  })

  it("500s with the DB code and a request id on an upsert error", async () => {
    state.result = { data: null, error: { message: "constraint violated", code: "23514" } }
    const res = await POST(authed({ source: "topshot", title: "t" }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toMatchObject({ error: "constraint violated", code: "23514" })
    // A correlation id so an operator can find the failure in logs.
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/)
  })
})
