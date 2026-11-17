// 2026-11-08: the Panini edition-page account prompt shows ONLY on a successful
// read that says signed out — a failed /api/profile/me read must never ask a
// signed-in collector to create the account they already have.
import { describe, expect, it } from "vitest"
import { isSignedOutRead } from "@/components/auth/AnonCollectionValueCta"

describe("isSignedOutRead", () => {
  it("true only for ok + { user: null }", () => {
    expect(isSignedOutRead({ ok: true, json: { user: null } })).toBe(true)
  })
  it("false for a signed-in user, a failed read, or an unexpected body", () => {
    expect(isSignedOutRead({ ok: true, json: { user: { id: "u" } } })).toBe(false)
    expect(isSignedOutRead({ ok: false, json: null })).toBe(false)
    expect(isSignedOutRead({ ok: true, json: null })).toBe(false)
    expect(isSignedOutRead({ ok: true, json: {} })).toBe(false)
  })
})
