// 2026-11-08 activity review: 8 of 15 outside visitors to /trophy-challenges/dame-time
// saw only that page and left, and its one button ("Enter from your dashboard")
// read as "you need an account already". A signed-out viewer now gets a
// create-account CTA that carries the challenge deep link through the magic link.
//
// THREE viewer states: only a SUCCESSFUL read saying `user: null` is
// "signed-out"; a failed read is "unknown" and keeps the old link (the auth
// gate still bounces it to /login with the deep link intact).

import { describe, expect, it } from "vitest"
import {
  challengeSigninHref,
  challengeSignupHref,
  viewerFromMe,
} from "@/app/trophy-challenges/[slug]/ChallengeBoardClient"
import { challengeEntryHref } from "@/lib/trophy/challenge-link"

describe("viewerFromMe", () => {
  it("reads a successful { user: null } as signed out", () => {
    expect(viewerFromMe({ ok: true, json: { user: null } })).toBe("signed-out")
  })
  it("reads a user as signed in", () => {
    expect(viewerFromMe({ ok: true, json: { user: { email: "a@b.c" } } })).toBe("signed-in")
  })
  it("never reads a failed or shapeless read as signed out", () => {
    expect(viewerFromMe({ ok: false, json: null })).toBe("unknown")
    expect(viewerFromMe({ ok: true, json: null })).toBe("unknown")
    expect(viewerFromMe({ ok: true, json: {} })).toBe("unknown")
  })
})

describe("signed-out challenge links", () => {
  it("signup heads the login page as account creation and returns to the challenge's dashboard spot", () => {
    const href = challengeSignupHref("dame-time")
    const u = new URL(href, "https://www.rippackscity.com")
    expect(u.pathname).toBe("/login")
    expect(u.searchParams.get("intent")).toBe("signup")
    expect(u.searchParams.get("next")).toBe(challengeEntryHref("dame-time"))
  })
  it("sign-in keeps the same deep link", () => {
    const u = new URL(challengeSigninHref("dame-time"), "https://www.rippackscity.com")
    expect(u.searchParams.get("intent")).toBeNull()
    expect(u.searchParams.get("next")).toBe("/dashboard?tab=trophy&challenge=dame-time")
  })
})

import { challengeFromNext } from "@/app/login/LoginClient"

describe("challengeFromNext (magic-link telemetry)", () => {
  it("names the challenge a return path carries", () => {
    expect(challengeFromNext("/dashboard?tab=trophy&challenge=dame-time")).toBe("dame-time")
  })
  it("records nothing for a plain return path or a malformed slug", () => {
    expect(challengeFromNext("/dashboard")).toBeNull()
    expect(challengeFromNext("/dashboard?challenge=<script>")).toBeNull()
  })
})

import { ownEntryOf, viewerHandleFromMe } from "@/app/trophy-challenges/[slug]/ChallengeBoardClient"

describe("the signed-in viewer's own entry", () => {
  const entries = [{ username: "Samwise222", slab_count: 4 }, { username: "webz_80", slab_count: 6 }]
  it("finds it case-insensitively by public handle", () => {
    expect(ownEntryOf("samwise222", entries, 2)).toEqual(entries[0])
  })
  it("says 'none' only when the board lists every entry", () => {
    expect(ownEntryOf("someone", entries, 2)).toBe("none")
  })
  it("says nothing when the board is truncated or the handle is unknown", () => {
    expect(ownEntryOf("someone", entries, 60)).toBeNull()
    expect(ownEntryOf(null, entries, 2)).toBeNull()
  })
  it("reads the handle only from a signed-in answer", () => {
    expect(viewerHandleFromMe({ ok: true, json: { user: { username: " Samwise222 " } } })).toBe("Samwise222")
    expect(viewerHandleFromMe({ ok: true, json: { user: null } })).toBeNull()
    expect(viewerHandleFromMe({ ok: false, json: null })).toBeNull()
  })
})

import { challengeShopHref } from "@/lib/trophy/challenge-link"

describe("challengeShopHref", () => {
  it("a one-player challenge points at that player's cross-collection hub", () => {
    expect(challengeShopHref({ player_names: ["Damian Lillard"] })).toBe("/players/damian-lillard")
    expect(challengeShopHref({ player_names: ["Luka Dončić"] })).toBe("/players/luka-doncic")
  })
  it("no single player, no link", () => {
    expect(challengeShopHref({ player_names: ["A", "B"] })).toBeNull()
    expect(challengeShopHref({})).toBeNull()
    expect(challengeShopHref(null)).toBeNull()
  })
})
