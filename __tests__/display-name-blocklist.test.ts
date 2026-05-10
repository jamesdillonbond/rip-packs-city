import { describe, it, expect, vi, beforeEach } from "vitest"
import { isBlocklisted, normalizeForBlocklistMatch } from "@/lib/user/blocklist"

// Lock in the resolver's profanity guard. The blocklist itself lives in
// lib/user/blocklist.json; this suite asserts the matcher behaves the way
// the resolver expects so a regression in normalization doesn't silently
// re-allow obvious slurs.

describe("blocklist normalization", () => {
  it("lowercases and strips non-alphanumerics", () => {
    expect(normalizeForBlocklistMatch("F.U.C.K.")).toBe("fuck")
    expect(normalizeForBlocklistMatch("__a_s_s__")).toBe("ass")
    expect(normalizeForBlocklistMatch("Trevor")).toBe("trevor")
  })
})

describe("isBlocklisted", () => {
  it("returns false for nullish or empty input", () => {
    expect(isBlocklisted(null)).toBe(false)
    expect(isBlocklisted(undefined)).toBe(false)
    expect(isBlocklisted("")).toBe(false)
    expect(isBlocklisted("    ")).toBe(false)
  })

  it("returns false for clean handles", () => {
    expect(isBlocklisted("trevor")).toBe(false)
    expect(isBlocklisted("RipPacksCity")).toBe(false)
    expect(isBlocklisted("samwise222")).toBe(false)
    expect(isBlocklisted("0xbd94cade097e50ac")).toBe(false)
  })

  it("rejects exact slurs case-insensitively", () => {
    expect(isBlocklisted("fuck")).toBe(true)
    expect(isBlocklisted("FUCK")).toBe(true)
    expect(isBlocklisted("Shit")).toBe(true)
  })

  it("rejects padded / l33t-style variants by substring match", () => {
    expect(isBlocklisted("_fuck_")).toBe(true)
    expect(isBlocklisted("xX-shit-Xx")).toBe(true)
    expect(isBlocklisted("a.s.s.")).toBe(true)
  })
})

describe("resolveDisplayName", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("falls through to truncated wallet when every candidate is blocklisted or empty", async () => {
    vi.doMock("@/lib/supabase", () => ({
      supabaseAdmin: {
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null }),
            }),
            ilike: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: null }),
              }),
            }),
          }),
        }),
      },
    }))

    const { resolveDisplayName, shortAddress } = await import("@/lib/user/resolveDisplayName")
    const r = await resolveDisplayName({
      user_id: "00000000-0000-0000-0000-000000000000",
      email: "fuckface@example.com",
      wallet_addr: "0xbd94cade097e50ac",
    })
    expect(r.source).toBe("wallet_short")
    expect(r.display_name).toBe(shortAddress("0xbd94cade097e50ac"))
  })

  it("prefers user_profiles.display_name when clean", async () => {
    vi.doMock("@/lib/supabase", () => ({
      supabaseAdmin: {
        from: (table: string) => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: table === "user_profiles" ? { display_name: "Trevor" } : null,
              }),
            }),
            ilike: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: { username: "rippackscity" } }),
              }),
            }),
          }),
        }),
      },
    }))

    const { resolveDisplayName } = await import("@/lib/user/resolveDisplayName")
    const r = await resolveDisplayName({
      user_id: "00000000-0000-0000-0000-000000000000",
      email: "tdillonbond@gmail.com",
    })
    expect(r.source).toBe("user_profiles")
    expect(r.display_name).toBe("Trevor")
  })

  it("skips user_profiles.display_name when it is blocklisted and falls to allow_list.username", async () => {
    vi.doMock("@/lib/supabase", () => ({
      supabaseAdmin: {
        from: (table: string) => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: table === "user_profiles" ? { display_name: "fucker" } : null,
              }),
            }),
            ilike: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: { username: "rippackscity" } }),
              }),
            }),
          }),
        }),
      },
    }))

    const { resolveDisplayName } = await import("@/lib/user/resolveDisplayName")
    const r = await resolveDisplayName({
      user_id: "00000000-0000-0000-0000-000000000000",
      email: "tdillonbond@gmail.com",
    })
    expect(r.source).toBe("allow_list_username")
    expect(r.display_name).toBe("rippackscity")
  })
})
