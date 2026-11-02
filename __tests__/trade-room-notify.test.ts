import { describe, it, expect } from "vitest"
import { memorySupabase } from "./helpers/memory-supabase"
import { buildTradeNoticeEmail, notifyOtherSide, tradeRoomUrl, type TradeNotice } from "@/lib/trade-room/notify"
import type { LoadedRoom } from "@/lib/trade-room/store"
import type { SupabaseClient } from "@supabase/supabase-js"

// The trade room's counterparty notices (2026-10-31). Rules pinned here: the mail
// names the other collector by USERNAME and links the room — never a wallet, a
// Moment, a price, an FMV or a confidence; an opt-out is honoured and an unreadable
// opt-out state SKIPS (fail closed); a failed send is reported, never thrown and
// never retried into a duplicate; a room with no other side sends nothing.

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"
const BOB = "bbbbbbbb-0000-4000-8000-000000000002"

function loaded(sides: Array<{ side: "a" | "b"; user_id: string }>): LoadedRoom {
  return {
    room: { id: "r1", code: "abcde12345", created_by: ALICE, collection: "nba-top-shot", status: "building", version: 3, tx_id: null, landed: null, sealed_at: null, cancelled_by: null, cancel_reason: null, expires_at: "2026-11-07T00:00:00Z", created_at: "2026-10-31T00:00:00Z", updated_at: "2026-10-31T00:00:00Z" },
    sides: sides.map((s) => ({ room_id: "r1", side: s.side, user_id: s.user_id, signer: "0x00000000000000aa", source: "0x00000000000000ab", proven_at: null, accepted_version: null, notice_read_at: null, updated_at: "2026-10-31T00:00:00Z" })),
    items: [{ room_id: "r1", side: "a", collection: "nba_top_shot", moment_id: "1", edition_key: "1:2", serial_number: 1, player_name: "LeBron James", set_name: "Set", tier: "COMMON", series_number: 8, image_url: null, fmv_usd: 123.45, added_at: "2026-10-31T00:00:00Z" }],
  }
}

describe("buildTradeNoticeEmail", () => {
  it.each<TradeNotice>(["joined", "accepted", "ready", "cancelled", "sealed"])("%s: names the other collector, links the room, and carries nothing from the trade itself", (notice) => {
    const m = buildTradeNoticeEmail(notice, { code: "abcde12345", other: "ripcity" })
    expect(m.subject).toContain("ripcity")
    const all = m.subject + m.html + m.text
    expect(all).toContain(notice === "cancelled" ? "https://www.rippackscity.com/trades" : tradeRoomUrl("abcde12345"))
    expect(all).not.toMatch(/0x[0-9a-f]{16}|FMV|HIGH|MEDIUM|LOW|\$\d|LeBron|Moment #/)
    // email red is hardcoded on purpose (no CSS custom properties in mail clients)
    expect(m.html).toContain("#e55a4c")
    expect(m.html).not.toContain("var(--")
  })
  it("an empty username reads as 'A collector', and HTML is escaped", () => {
    const m = buildTradeNoticeEmail("joined", { code: "abcde12345", other: " " })
    expect(m.subject).toBe("A collector joined your trade room")
    const x = buildTradeNoticeEmail("joined", { code: "abcde12345", other: "<b>x</b>" })
    expect(x.html).toContain("&lt;b&gt;x&lt;/b&gt;")
  })
})

describe("notifyOtherSide", () => {
  const sends: Array<{ to: string; subject: string }> = []
  const send = async (a: { to: string; subject: string }) => { sends.push({ to: a.to, subject: a.subject }); return { ok: true as const } }
  const emails: Record<string, string | null> = { [ALICE]: "alice@example.com", [BOB]: "bob@example.com" }
  const lookupEmail = async (_db: unknown, id: string) => emails[id] ?? null

  it("emails the side that is not the actor, by the actor's username", async () => {
    sends.length = 0
    const m = memorySupabase({ profile_bio: [{ user_id: BOB, username: "bobby" }], email_subscribers: [] })
    const out = await notifyOtherSide(m.db as unknown as SupabaseClient, loaded([{ side: "a", user_id: ALICE }, { side: "b", user_id: BOB }]), BOB, "joined", { send, lookupEmail, log: () => {} })
    expect(out).toMatchObject({ status: "sent", to_user: ALICE })
    expect(sends).toEqual([{ to: "alice@example.com", subject: "bobby joined your trade room" }])
  })

  it("no other side, no email, an opt-out, and an UNREADABLE opt-out each send nothing", async () => {
    sends.length = 0
    const two = [{ side: "a" as const, user_id: ALICE }, { side: "b" as const, user_id: BOB }]
    const m = memorySupabase({ profile_bio: [], email_subscribers: [{ email: "alice@example.com", unsubscribed_at: "2026-10-01T00:00:00Z" }] })
    const db = m.db as unknown as SupabaseClient
    expect(await notifyOtherSide(db, loaded([{ side: "a", user_id: ALICE }]), ALICE, "accepted", { send, lookupEmail, log: () => {} })).toMatchObject({ status: "skipped", reason: "no_other_side" })
    expect(await notifyOtherSide(db, loaded(two), ALICE, "accepted", { send, lookupEmail: async () => null, log: () => {} })).toMatchObject({ status: "skipped", reason: "no_email" })
    expect(await notifyOtherSide(db, loaded(two), BOB, "accepted", { send, lookupEmail, log: () => {} })).toMatchObject({ status: "skipped", reason: "unsubscribed" })
    m.failNext("select", "email_subscribers", "statement timeout")
    expect(await notifyOtherSide(db, loaded(two), ALICE, "accepted", { send, lookupEmail, log: () => {} })).toMatchObject({ status: "skipped", reason: "optout_unknown" })
    expect(sends).toEqual([])
  })

  it("a failed send or a thrown lookup is reported, never thrown", async () => {
    const m = memorySupabase({ profile_bio: [], email_subscribers: [] })
    const db = m.db as unknown as SupabaseClient
    const two = [{ side: "a" as const, user_id: ALICE }, { side: "b" as const, user_id: BOB }]
    const failing = async () => ({ ok: false as const, error: "Resend HTTP 500" })
    expect(await notifyOtherSide(db, loaded(two), ALICE, "sealed", { send: failing, lookupEmail, log: () => {} })).toMatchObject({ status: "failed", error: "Resend HTTP 500" })
    expect(await notifyOtherSide(db, loaded(two), ALICE, "sealed", { send, lookupEmail: async () => { throw new Error("auth read failed: boom") }, log: () => {} })).toMatchObject({ status: "failed", error: expect.stringContaining("auth read failed") })
  })
})
