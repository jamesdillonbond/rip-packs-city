import { describe, it, expect } from "vitest"
import { checklistRows, checklistState } from "@/lib/giveaways/checklist"
import { claimOutcomeResponse } from "@/lib/giveaways/claim-copy"
import { parseDraftBody } from "@/lib/giveaways/draft-input"
import { deliveryLabel, errorText, ptTime, statusLabel, usd, verifyCommand } from "@/lib/giveaways/view-format"
import { chaseMomentId, openedKey, revealOrder, topShotMomentImage } from "@/lib/giveaways/reveal"
import { commitmentHash } from "@/lib/giveaways/seal"
import { execFileSync } from "node:child_process"
import type { ClaimRow, PoolRow } from "@/lib/giveaways/store"

function pm(id: string, over: Partial<PoolRow> = {}): PoolRow {
  return {
    moment_id: id,
    pack_no: 1,
    slot: 1,
    edition_key: null,
    player_name: null,
    set_name: null,
    team_name: null,
    tier: null,
    serial_number: null,
    fmv_usd: 1,
    image_url: null,
    delivered_at: null,
    last_checked_at: null,
    last_check_recipient_holds: null,
    last_check_admin_holds: null,
    ...over,
  }
}

describe("giveaways/checklist", () => {
  it("every state", () => {
    expect(checklistState(pm("1", { pack_no: null, slot: null }), false)).toBe("unsealed")
    expect(checklistState(pm("1"), false)).toBe("unclaimed")
    expect(checklistState(pm("1"), true)).toBe("unchecked")
    expect(checklistState(pm("1", { delivered_at: "t" }), true)).toBe("delivered")
    expect(checklistState(pm("1", { last_checked_at: "t", last_check_recipient_holds: true }), true)).toBe("delivered")
    expect(checklistState(pm("1", { last_checked_at: "t", last_check_recipient_holds: false, last_check_admin_holds: true }), true)).toBe("awaiting")
    expect(checklistState(pm("1", { last_checked_at: "t", last_check_recipient_holds: false, last_check_admin_holds: false }), true)).toBe("missing")
  })

  it("rows are ordered by pack then slot, and carry who to gift to", () => {
    const claims: ClaimRow[] = [{ pack_no: 2, user_id: "u", topshot_username: "bob", recipient_address: "0x02", claimed_at: "t" }]
    const rows = checklistRows([pm("9", { pack_no: 2, slot: 2 }), pm("8", { pack_no: 2, slot: 1 }), pm("7", { pack_no: 1, slot: 1 }), pm("6", { pack_no: null, slot: null })], claims)
    expect(rows.map((r) => [r.moment_id, r.username, r.state])).toEqual([
      ["7", null, "unclaimed"],
      ["8", "bob", "unchecked"],
      ["9", "bob", "unchecked"],
      ["6", null, "unsealed"],
    ])
    expect(rows[1].stateLabel).toMatch(/Verify/)
  })
})

describe("giveaways/claim-copy", () => {
  it("success outcomes are 200 with ok:true; refusals carry their code", async () => {
    const a = claimOutcomeResponse("claimed", 3)
    expect(a.status).toBe(200)
    expect(await a.json()).toMatchObject({ ok: true, pack_no: 3 })
    expect((await claimOutcomeResponse("already_claimed", 1).json()).ok).toBe(true)
    for (const [o, s] of [
      ["not_found", 404],
      ["not_open", 409],
      ["admin_recipient", 400],
      ["recipient_taken", 409],
      ["all_claimed", 409],
    ] as const) {
      const r = claimOutcomeResponse(o, null)
      expect(r.status).toBe(s)
      expect(await r.json()).toMatchObject({ ok: false, code: o })
      expect(r.headers.get("cache-control")).toBe("no-store")
    }
  })
})

describe("giveaways/draft-input", () => {
  const good = { slug: "Fall-Drop", title: "Fall drop", sponsor_name: "Trevor", admin_wallet: "0x00000000000000AA", pack_count: 2, moments_per_pack: 1, moment_ids: [1, "2"] }
  it("normalizes a valid body", () => {
    expect(parseDraftBody(good)).toEqual({
      slug: "fall-drop",
      title: "Fall drop",
      description: null,
      sponsor_name: "Trevor",
      admin_wallet: "0x00000000000000aa",
      pack_count: 2,
      moments_per_pack: 1,
      moment_ids: ["1", "2"],
    })
  })
  it("names the first problem", () => {
    expect(parseDraftBody(null)).toMatch(/object/)
    expect(parseDraftBody({ ...good, slug: "a" })).toMatch(/slug/)
    expect(parseDraftBody({ ...good, title: "x" })).toMatch(/title/)
    expect(parseDraftBody({ ...good, sponsor_name: "" })).toMatch(/sponsor/)
    expect(parseDraftBody({ ...good, description: "x".repeat(2001) })).toMatch(/description/)
    expect(parseDraftBody({ ...good, admin_wallet: "0x1" })).toMatch(/admin_wallet/)
    expect(parseDraftBody({ ...good, pack_count: 0 })).toMatch(/pack_count/)
    expect(parseDraftBody({ ...good, pack_count: 1.5 })).toMatch(/pack_count/)
    expect(parseDraftBody({ ...good, moments_per_pack: 11 })).toMatch(/moments_per_pack/)
    expect(parseDraftBody({ ...good, moment_ids: "1,2" })).toMatch(/moment_ids/)
    expect(parseDraftBody({ ...good, moment_ids: ["1", "x"] })).toMatch(/moment_ids/)
    expect(parseDraftBody({ ...good, moment_ids: ["1"] })).toMatch(/need 2/)
  })
})

describe("giveaways/view-format", () => {
  it("usd never shows $0 for an absent value", () => {
    expect(usd(1234.5)).toBe("$1,234.50")
    expect(usd(0)).toBe("$0.00")
    expect(usd(-12.5)).toBe("-$12.50")
    expect(usd(null)).toBe("—")
    expect(usd(Number.NaN)).toBe("—")
  })
  it("ptTime is Pacific and labelled", () => {
    expect(ptTime("2026-09-29T19:40:00Z")).toBe("Sep 29, 2026, 12:40 PM PT")
    expect(ptTime(null)).toBe("—")
    expect(ptTime("garbage")).toBe("—")
  })
  it("statusLabel for each status", () => {
    expect(statusLabel("sealed", 0, 5)).toMatch(/haven't opened/)
    expect(statusLabel("open", 2, 5)).toBe("Open · 3 of 5 packs left")
    expect(statusLabel("open", 5, 5)).toBe("Open · all 5 packs claimed")
    expect(statusLabel("closed", 4, 5)).toBe("Closed · 4 of 5 packs claimed")
  })
  it("deliveryLabel", () => {
    expect(deliveryLabel(true, null)).toMatch(/Delivered/)
    expect(deliveryLabel(false, null)).toBe("Awaiting the sponsor's gift")
    expect(deliveryLabel(false, "2026-09-29T19:40:00Z")).toMatch(/last checked Sep 29/)
  })
  it("the printed verify command really reproduces the commitment", () => {
    const salt = "ab".repeat(32)
    const manifest = "1:10,20;2:40,30"
    const out = execFileSync("sh", ["-c", verifyCommand(salt, manifest)]).toString()
    expect(out.split(" ")[0]).toBe(commitmentHash(salt, manifest))
  })
})

describe("giveaways/view-format errorText", () => {
  it("never renders a wallet rejection as [object Object]", () => {
    expect(errorText({ code: 5000, message: "User rejected the request." })).toBe("User rejected the request. (code 5000)")
    expect(errorText({ reason: "Declined: Externally Halted" })).toBe("Declined: Externally Halted")
    expect(errorText({ foo: 1 })).toBe('{"foo":1}')
    for (const e of [{ code: 1, message: "x" }, { foo: 1 }, {}]) expect(errorText(e)).not.toContain("[object Object]")
  })

  it("passes Errors and strings through, and names an empty one", () => {
    expect(errorText(new Error("boom"))).toBe("boom")
    expect(errorText(new TypeError(""))).toBe("TypeError")
    expect(errorText("Declined")).toBe("Declined")
    expect(errorText("")).toBe("(empty error)")
    expect(errorText(undefined)).toBe("undefined")
  })
})

describe("giveaways/reveal", () => {
  it("orders lowest value first, unpriced first, ties by id, never mutating the input", () => {
    const input = [
      { moment_id: "b", fmv_usd: 5 },
      { moment_id: "a", fmv_usd: 5 },
      { moment_id: "z", fmv_usd: null },
      { moment_id: "c", fmv_usd: 1 },
    ]
    expect(revealOrder(input).map((m) => m.moment_id)).toEqual(["z", "c", "a", "b"])
    expect(input[0].moment_id).toBe("b")
  })

  it("names a chase card only when one card is worth strictly more than every other", () => {
    expect(chaseMomentId([{ moment_id: "1", fmv_usd: 1 }, { moment_id: "2", fmv_usd: 9 }])).toBe("2")
    expect(chaseMomentId([{ moment_id: "1", fmv_usd: 9 }, { moment_id: "2", fmv_usd: 9 }])).toBeNull()
    expect(chaseMomentId([{ moment_id: "1", fmv_usd: 9 }])).toBeNull()
    expect(chaseMomentId([{ moment_id: "1", fmv_usd: 9 }, { moment_id: "2", fmv_usd: null }])).toBeNull()
  })

  it("builds Top Shot art only for a numeric Flow id; keys the opened flag per pack", () => {
    expect(topShotMomentImage("47724526")).toBe("https://assets.nbatopshot.com/media/47724526/image?width=480")
    expect(topShotMomentImage("123", 199.6)).toBe("https://assets.nbatopshot.com/media/123/image?width=200")
    expect(topShotMomentImage("abc")).toBeNull()
    expect(openedKey("fall-drop", 4)).toBe("rpc_giveaway_opened:fall-drop:4")
  })
})
