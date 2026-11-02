import { describe, it, expect } from "vitest"
import { buildEmailMessage, buildTelegramMessage, buildDiscordEmbeds, packChaseLine } from "@/lib/alerts/format"
import type { Delivery } from "@/lib/alerts"

// A 'pack_digest' (pack-chase) delivery must RENDER in every channel. Before this
// branch the formatters knew only deal/fmv, so a chase row would have been marked
// sent with nothing in the message — an alert's output is silence, so that failure
// would have been invisible.

const d: Delivery = {
  id: "00000000-0000-0000-0000-000000000001",
  owner_key: "u1",
  channel: "email",
  channel_user_id: "a@b.c",
  alert_kind: "pack_digest",
  subject_key: "pack_chase:8903:legendary",
  dedup_bucket: "w1:2026-11-02",
  status: "pending",
  attempts: 0,
  payload: {
    watch_id: "w1", dist_id: "8903", title: "Rookie Year Royalty Pack", tier: "legendary",
    remaining: 1, unopened: 18, total_packs: 719, per100_now: 100 / 18, per100_launch: 300 / 719,
    vs_launch: (100 / 18) / (300 / 719), min_vs_launch: 10, as_of: "2026-11-02T10:00:00Z",
  },
}

describe("pack chase alerts render in every channel", () => {
  it("line states a density, never a percent", () => {
    const line = packChaseLine(d.payload as any)
    expect(line).toBe("1 Legendary left in 18 sealed packs — 5.6 per 100 (launch 0.42, 13× launch rate)")
    expect(line).not.toMatch(/%/)
  })
  it("email", () => {
    const m = buildEmailMessage([d])
    expect(m.subject).toBe("1 pack chase alert from Rip Packs City")
    expect(m.html).toContain("Rookie Year Royalty Pack")
    expect(m.html).toContain("/nba-top-shot/pack/dist/8903")
    expect(m.text).toContain("1 Legendary left in 18 sealed packs")
  })
  it("telegram", () => {
    const t = buildTelegramMessage([d])
    expect(t).toContain("pack chase alert")
    expect(t).toContain("Rookie Year Royalty Pack")
  })
  it("discord", () => {
    const e = buildDiscordEmbeds([d])
    expect(e).toHaveLength(1)
    expect(e[0].title).toBe("Rookie Year Royalty Pack")
    expect(e[0].url).toContain("/nba-top-shot/pack/dist/8903")
  })
})
