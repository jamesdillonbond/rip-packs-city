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

describe("resolveDisplayName — ladder rungs, wallet fallbacks, shortAddress edges", () => {
  const UID = "00000000-0000-0000-0000-000000000000"

  // Re-import under a per-table mock. resolveDisplayName reads user_profiles +
  // profile_bio via .select().eq().maybeSingle() and allow_list (only when an
  // email is passed) via .select().ilike().limit().maybeSingle(). Each table's
  // maybeSingle resolves to { data: tables[table] ?? null }; .from also records
  // which tables were touched so we can assert the email-absent skip.
  async function loadResolver(tables: {
    user_profiles?: any
    profile_bio?: any
    allow_list?: any
  }) {
    const touched: string[] = []
    vi.resetModules()
    vi.doMock("@/lib/supabase", () => ({
      supabaseAdmin: {
        from: (table: string) => {
          touched.push(table)
          const result = async () => ({ data: (tables as any)[table] ?? null })
          return {
            select: () => ({
              eq: () => ({ maybeSingle: result }),
              ilike: () => ({ limit: () => ({ maybeSingle: result }) }),
            }),
          }
        },
      },
    }))
    const mod = await import("@/lib/user/resolveDisplayName")
    return { ...mod, touched }
  }

  describe("shortAddress", () => {
    it("returns null for missing / empty / whitespace-only input", async () => {
      const { shortAddress } = await loadResolver({})
      expect(shortAddress(null)).toBeNull()
      expect(shortAddress(undefined)).toBeNull()
      expect(shortAddress("")).toBeNull()
      expect(shortAddress("   ")).toBeNull()
    })

    it("passes a short (<10 char) address through untruncated", async () => {
      const { shortAddress } = await loadResolver({})
      expect(shortAddress("0x12")).toBe("0x12")
      expect(shortAddress("  0x12  ")).toBe("0x12")
    })

    it("truncates a full address to first-6 … last-4", async () => {
      const { shortAddress } = await loadResolver({})
      expect(shortAddress("0xbd94cade097e50ac")).toBe("0xbd94…50ac")
    })
  })

  it("picks profile_bio.display_name when user_profiles is empty (Step 2 rung)", async () => {
    const { resolveDisplayName } = await loadResolver({
      user_profiles: null,
      profile_bio: { display_name: "Sam" },
    })
    const r = await resolveDisplayName({ user_id: UID })
    expect(r).toEqual({ source: "profile_bio", display_name: "Sam" })
  })

  it("picks the email local-part when the table rungs are empty (Step 4 rung)", async () => {
    const { resolveDisplayName } = await loadResolver({})
    const r = await resolveDisplayName({ user_id: UID, email: "trevor@example.com" })
    expect(r).toEqual({ source: "email_local", display_name: "trevor" })
  })

  it("returns the Collector last-resort when every candidate AND the wallet are missing", async () => {
    const { resolveDisplayName } = await loadResolver({})
    const r = await resolveDisplayName({ user_id: UID })
    expect(r).toEqual({ source: "fallback", display_name: "Collector" })
  })

  it("falls back to allow_list.wallet_addr when the name rungs fail and no opts.wallet_addr", async () => {
    const { resolveDisplayName, shortAddress } = await loadResolver({
      // email local-part "fuck" is blocklisted → the email rung is skipped,
      // pushing resolution to the wallet fallback chain.
      allow_list: { username: null, wallet_addr: "0xdeadbeef12345678" },
    })
    const r = await resolveDisplayName({ user_id: UID, email: "fuck@example.com" })
    expect(r.source).toBe("wallet_short")
    expect(r.display_name).toBe(shortAddress("0xdeadbeef12345678"))
  })

  it("falls back to user_profiles.wallet_address as the last wallet source", async () => {
    const { resolveDisplayName, shortAddress } = await loadResolver({
      user_profiles: { display_name: null, wallet_address: "0x1111222233334444" },
    })
    // No email → allow_list is not queried; no opts.wallet_addr.
    const r = await resolveDisplayName({ user_id: UID })
    expect(r.source).toBe("wallet_short")
    expect(r.display_name).toBe(shortAddress("0x1111222233334444"))
  })

  it("skips the allow_list query entirely when no email is supplied", async () => {
    const { resolveDisplayName, touched } = await loadResolver({
      // Would win if consulted — but with no email it must never be queried.
      allow_list: { username: "should-not-appear" },
    })
    const r = await resolveDisplayName({ user_id: UID, wallet_addr: "0xaaaabbbbccccdddd" })
    expect(touched).not.toContain("allow_list")
    expect(r.source).toBe("wallet_short")
    expect(r.display_name).not.toBe("should-not-appear")
  })

  // 2026-09-02 (onboarding QA #9): the public handle outranks the raw email
  // local-part, so an address-path signup who chose a handle is not greeted as
  // `tdillonbond+qa0903` in their own header.
  describe("resolveDisplayName — the public handle beats the email local-part", () => {
    it("picks profile_bio.username when display_name is empty but a handle exists", async () => {
      const { resolveDisplayName } = await loadResolver({
        user_profiles: null,
        profile_bio: { display_name: null, username: "qa0903" },
      })
      const r = await resolveDisplayName({ user_id: UID, email: "tdillonbond+qa0903@example.com" })
      expect(r).toEqual({ source: "profile_bio_handle", display_name: "qa0903" })
    })

    it("still prefers a chosen display_name over the handle", async () => {
      const { resolveDisplayName } = await loadResolver({
        user_profiles: null,
        profile_bio: { display_name: "QA Nine Oh Three", username: "qa0903" },
      })
      const r = await resolveDisplayName({ user_id: UID, email: "x@example.com" })
      expect(r).toEqual({ source: "profile_bio", display_name: "QA Nine Oh Three" })
    })
  })
})
