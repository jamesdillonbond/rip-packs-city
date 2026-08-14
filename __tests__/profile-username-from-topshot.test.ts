import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  handleFromTopShotUsername,
  HANDLE_RE,
  RESERVED_HANDLES,
} from "@/lib/profile/username-from-topshot"
import { claimUsernameFromTopShot } from "@/lib/profile/claim-username"

// ─────────────────────────────────────────────────────────────────────────────
// Defaulting the RPC public handle to the collector's Dapper/Top Shot username.
//
// `/profile/<username>` only exists once profile_bio.username is set, and
// nothing set it except a manual visit to /profile/edit — so 16 of 20 signed-up
// collectors had no public profile at all. Every one of them had already told
// us their Dapper username to load their collection.
//
// The normalization is pinned against the REAL production names (below), not
// invented examples, and the claim rules are pinned as three separate
// properties because each one protects a different person: never overwrite
// (the collector's own identity), never steal (someone else's), never throw
// (the wallet association this runs inside).
// ─────────────────────────────────────────────────────────────────────────────

describe("handleFromTopShotUsername — normalization", () => {
  // Every Dapper username in production on 2026-08-13, with the handle it must
  // produce. Four collectors had already set a handle by hand and every one
  // matches this rule exactly (alxo, jamesdillonbond, tetrislblock, tomwagmi),
  // which is the evidence the convention is theirs rather than ours.
  it.each([
    ["AbsolutSiikness", "absolutsiikness"],
    ["alxo", "alxo"],
    ["Banana_Boat", "banana_boat"],
    ["BLAISE_27", "blaise_27"],
    ["brianw4", "brianw4"],
    ["BrooksBaldwin", "brooksbaldwin"],
    ["dbarri12", "dbarri12"],
    ["Edogg1976", "edogg1976"],
    ["GiannisToCleveland", "giannistocleveland"],
    ["Jamesdillonbond", "jamesdillonbond"],
    ["Juiceshack", "juiceshack"],
    ["LiqaDoncic", "liqadoncic"],
    ["MiaFLSurf", "miaflsurf"],
    ["Nemi", "nemi"],
    ["Rigged", "rigged"],
    ["RipPacksCity", "rippackscity"],
    ["Samwise222", "samwise222"],
    ["tetrisLblock", "tetrislblock"],
    ["ThunderHour", "thunderhour"],
    ["tomwagmi", "tomwagmi"],
    ["VinoSuas", "vinosuas"],
  ])("%s -> %s", (raw, expected) => {
    const r = handleFromTopShotUsername(raw)
    // RipPacksCity normalizes to a RESERVED handle; asserted separately below.
    if (expected === "rippackscity") {
      expect(r.ok).toBe(false)
      return
    }
    expect(r).toEqual({ ok: true, handle: expected })
  })

  it("produces handles that satisfy the editor's own contract", () => {
    // The handle has to round-trip through /profile/edit, whose USERNAME_RE is
    // the same pattern. A handle this function emits that the editor rejects
    // would be uneditable by the person who owns it.
    for (const raw of ["Banana_Boat", "BLAISE_27", "tetrisLblock"]) {
      const r = handleFromTopShotUsername(raw)
      expect(r.ok && HANDLE_RE.test(r.handle)).toBe(true)
    }
  })

  it("strips characters the handle contract forbids", () => {
    expect(handleFromTopShotUsername("Nemi.eth")).toEqual({ ok: true, handle: "nemieth" })
    expect(handleFromTopShotUsername("a b c d")).toEqual({ ok: true, handle: "abcd" })
    expect(handleFromTopShotUsername("Ünïcodé")).toEqual({ ok: true, handle: "ncod" })
  })

  it("measures length AFTER stripping, not before", () => {
    // "@!@!" is four characters and normalizes to zero. A raw-length check
    // would pass it and then try to publish an empty handle.
    expect(handleFromTopShotUsername("@!@!")).toEqual({ ok: false, reason: "empty" })
    expect(handleFromTopShotUsername("a.b")).toEqual({ ok: false, reason: "too_short" })
  })

  it("truncates an over-long name rather than refusing it a handle", () => {
    // The 32-char ceiling is ours, not Dapper's. Rejecting outright would leave
    // exactly the collectors this exists to help without a profile.
    //
    // ⚠ The fixture is a plausible username, not `"x".repeat(60)` — my first
    // draft used that and it came back `blocklisted`, because a run of x's
    // contains a blocklist term. A synthetic fixture can exercise a branch you
    // did not mean to reach and read as a bug in the code under test.
    const long = "GiannisToClevelandPleaseAndThankYou"
    expect(long.length).toBeGreaterThan(32)
    const r = handleFromTopShotUsername(long)
    expect(r).toEqual({ ok: true, handle: long.toLowerCase().slice(0, 32) })
  })

  it("blocklists on the TRUNCATED handle, i.e. the string it would publish", () => {
    // Checking the pre-truncation form could clear a name whose visible handle
    // is the offending substring.
    const r = handleFromTopShotUsername("fuck" + "a".repeat(40))
    expect(r).toEqual({ ok: false, reason: "blocklisted" })
  })

  it.each([[""], [null], [undefined], ["  "]])("rejects %s", (raw) => {
    expect(handleFromTopShotUsername(raw as string).ok).toBe(false)
  })

  it("refuses handles that are real path segments", () => {
    // ⚠ Not politeness — `app/profile/edit` is a STATIC route and Next resolves
    // a static segment before the [username] dynamic one, so a collector handed
    // the handle "edit" gets a URL that can never render their profile.
    expect(handleFromTopShotUsername("edit")).toEqual({ ok: false, reason: "reserved" })
    expect(handleFromTopShotUsername("Settings")).toEqual({ ok: false, reason: "reserved" })
    expect(RESERVED_HANDLES.has("edit")).toBe(true)
    expect(RESERVED_HANDLES.has("settings")).toBe(true)
  })

  it("refuses an identity that would read as official", () => {
    expect(handleFromTopShotUsername("RipPacksCity").ok).toBe(false)
    expect(handleFromTopShotUsername("admin").ok).toBe(false)
  })

  it("applies the shared profanity blocklist", () => {
    // Reuses lib/user/blocklist rather than a second list, so ops extending
    // blocklist.json covers this path too.
    expect(handleFromTopShotUsername("fuckface")).toEqual({ ok: false, reason: "blocklisted" })
  })
})

describe("claimUsernameFromTopShot — the three DB rules", () => {
  const makeDb = (opts: {
    existing?: { username: string | null } | null
    readError?: unknown
    writeError?: { code?: string } | null
  }) => {
    const calls: { upserts: any[] } = { upserts: [] }
    const db = {
      from: () => {
        const b: any = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({
            data: opts.existing ?? null,
            error: opts.readError ?? null,
          }),
          upsert: async (payload: any) => {
            calls.upserts.push(payload)
            return { error: opts.writeError ?? null }
          },
        }
        return b
      },
    }
    return { db, calls }
  }

  it("claims a free handle", async () => {
    const { db, calls } = makeDb({ existing: null })
    const r = await claimUsernameFromTopShot(db, "u-1", "Rigged")
    expect(r).toEqual({ claimed: true, handle: "rigged" })
    expect(calls.upserts[0]).toMatchObject({ user_id: "u-1", username: "rigged" })
  })

  it("NEVER overwrites a handle the collector already has", async () => {
    // Their handle is their identity and the URL other people have shared. This
    // path re-runs every time a collector refreshes their collection.
    const { db, calls } = makeDb({ existing: { username: "chosen-by-hand" } })
    const r = await claimUsernameFromTopShot(db, "u-1", "Rigged")
    expect(r).toEqual({ claimed: false, reason: "already_set", handle: "chosen-by-hand" })
    expect(calls.upserts).toHaveLength(0)
  })

  it("NEVER steals a handle someone else holds, and never suffixes one", async () => {
    // Silently handing someone `rigged2` presents a consolation prize as their
    // name. 23505 is the UNIQUE(username) index.
    const { db } = makeDb({ existing: null, writeError: { code: "23505" } })
    const r = await claimUsernameFromTopShot(db, "u-1", "Rigged")
    expect(r).toEqual({ claimed: false, reason: "taken", handle: "rigged" })
  })

  it("does not treat a FAILED READ as an absent handle", async () => {
    // Otherwise a collector who already has a handle proceeds to the write and
    // collides with their OWN row's value — reported as "taken", an outcome
    // invented from a transient error.
    const { db, calls } = makeDb({ readError: { message: "timeout" } })
    const r = await claimUsernameFromTopShot(db, "u-1", "Rigged")
    expect(r).toEqual({ claimed: false, reason: "error" })
    expect(calls.upserts).toHaveLength(0)
  })

  it("upserts rather than updates, since a collector may have no bio row yet", async () => {
    // Measured: 1 of 21 collectors had saved wallets and no profile_bio row. An
    // UPDATE would match zero rows and report success.
    const { db, calls } = makeDb({ existing: null })
    await claimUsernameFromTopShot(db, "u-2", "Nemi")
    expect(calls.upserts[0]).toHaveProperty("user_id", "u-2")
  })

  it("reports a non-unique write failure as an error, not as taken", async () => {
    const { db } = makeDb({ existing: null, writeError: { code: "57014" } })
    expect(await claimUsernameFromTopShot(db, "u-1", "Rigged")).toEqual({
      claimed: false,
      reason: "error",
    })
  })

  it("NEVER throws — the wallet association is the point, the handle is a bonus", async () => {
    const exploding = {
      from: () => {
        throw new Error("db exploded")
      },
    }
    expect(await claimUsernameFromTopShot(exploding, "u-1", "Rigged")).toEqual({
      claimed: false,
      reason: "error",
    })
  })

  it("does not write at all for an unusable name", async () => {
    const { db, calls } = makeDb({ existing: null })
    for (const bad of ["edit", "@!", null]) {
      const r = await claimUsernameFromTopShot(db, "u-1", bad)
      expect(r).toEqual({ claimed: false, reason: "unusable" })
    }
    expect(calls.upserts).toHaveLength(0)
  })
})
