// 2026-11-10: the concierge recognises members who joined through sign-up.
// 23 of 24 accounts created since 10-01 have no allow_list row, so the
// concierge treated them as anonymous and get_my_feedback_status told a
// signed-in collector to sign in. These pin the fallback and the read filter.
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { feedbackOwnerFilter, profileUsernameFor } from "@/lib/concierge/identity"

function fakeDb(result: { data: any; error: any } | Error) {
  const calls: Array<[string, unknown[]]> = []
  const chain: any = {}
  for (const m of ["select", "eq", "limit", "maybeSingle"]) {
    chain[m] = (...args: unknown[]) => { calls.push([m, args]); return chain }
  }
  chain.abortSignal = () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result))
  return { db: { from: (t: string) => { calls.push(["from", [t]]); return chain } }, calls }
}

describe("profileUsernameFor", () => {
  it("reads the caller's own profile row by auth uid and lower-cases the username", async () => {
    const { db, calls } = fakeDb({ data: { username: "KnotBean", topshot_username: null }, error: null })
    expect(await profileUsernameFor(db, "uid-1")).toBe("knotbean")
    expect(calls).toContainEqual(["from", ["user_profiles"]])
    expect(calls).toContainEqual(["eq", ["id", "uid-1"]])
  })
  it("falls back to the Top Shot username when the RPC username is empty", async () => {
    const { db } = fakeDb({ data: { username: null, topshot_username: "Mxtthxw" }, error: null })
    expect(await profileUsernameFor(db, "uid-2")).toBe("mxtthxw")
  })
  it("returns null — never a guess — on an error, a missing row, or a throw", async () => {
    expect(await profileUsernameFor(fakeDb({ data: null, error: { message: "boom" } }).db, "u")).toBeNull()
    expect(await profileUsernameFor(fakeDb({ data: null, error: null }).db, "u")).toBeNull()
    expect(await profileUsernameFor(fakeDb(new Error("timeout")).db, "u")).toBeNull()
    expect(await profileUsernameFor(fakeDb({ data: { username: "  ", topshot_username: "" }, error: null }).db, "u")).toBeNull()
  })
})

describe("feedbackOwnerFilter", () => {
  it("matches the username OR the verified email, quoted", () => {
    expect(feedbackOwnerFilter("mxtthxw", "a.b@example.com")).toBe('owner_key.eq."mxtthxw",user_email.eq."a.b@example.com"')
  })
  it("works with only the email (a new member before any username is on file)", () => {
    expect(feedbackOwnerFilter(null, "a@example.com")).toBe('user_email.eq."a@example.com"')
  })
  it("never widens: quote characters are dropped and an empty identity matches nothing", () => {
    expect(feedbackOwnerFilter('x",user_email.neq."', null)).toBe('owner_key.eq."x,user_email.neq."')
    expect(feedbackOwnerFilter(null, null)).toBe("id.eq.-1")
    expect(feedbackOwnerFilter("  ", "")).toBe("id.eq.-1")
  })
})

describe("the concierge route uses the fallback", () => {
  const ROUTE = readFileSync(join(process.cwd(), "app", "api", "support-chat", "route.ts"), "utf8")
  it("deriveIdentity falls back to the profile username when allow_list has no row", () => {
    const start = ROUTE.indexOf("async function deriveIdentity()")
    const body = ROUTE.slice(start, start + 1800)
    expect(body).toContain("if (!ownerKey && userId) ownerKey = await profileUsernameFor(supabase, userId);")
    // the wallet is NOT taken from the profile: it is the watchlist + quota key
    expect(body).toContain("userWallet: row?.wallet_addr ?? null,")
  })
  it("get_my_feedback_status answers a signed-in member who has an email but no username", () => {
    const start = ROUTE.indexOf('if (toolName === "get_my_feedback_status") {')
    expect(ROUTE.slice(start, start + 300)).toContain("if (!ctx.ownerKey && !ctx.userEmail) {")
  })
})

describe("the concierge context route uses the same fallback", () => {
  const CTX = readFileSync(join(process.cwd(), "app", "api", "support-chat", "context", "route.ts"), "utf8")
  it("welcome-back and shipped-feedback lines reach members with no allow_list row", () => {
    expect(CTX).toContain("if (!ownerKey && uid) ownerKey = await profileUsernameFor(supabase, uid);")
  })
})

describe("signed-in dashboard pills", () => {
  const SC = readFileSync(join(process.cwd(), "components", "SupportChat.tsx"), "utf8")
  it("lead with the member's own collection, not the generic bug/feature pills", () => {
    const line = SC.split("\n").find((l) => l.trim().startsWith("dashboard: ["))
    expect(line).toBeTruthy()
    expect(line).toContain("What's my collection worth?")
    expect(line).not.toContain("Report a bug")
  })
})
