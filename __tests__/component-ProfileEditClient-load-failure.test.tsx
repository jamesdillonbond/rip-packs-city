// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react"
import ProfileEditClient from "@/app/profile/edit/ProfileEditClient"

// /profile/edit — the profile editor.
//
// ⚠ THE DEFECT HERE WAS NOT A FALSE CLAIM, IT WAS SILENT DATA LOSS, and that is
// what makes it the sharpest instance of this class found so far. A failed
// `/api/profile/bio` read left the form at its EMPTY initial state with NO
// failure branch — `loading ? "Loading…" : <form>` — so the user was handed a
// blank but fully editable profile over their real data. `save()` POSTs every
// field unconditionally (`displayName: form.display_name.trim() || null`, and
// the same for tagline / twitter / discord / avatarUrl), so editing one thing
// and hitting Save overwrote the rest with nulls. The favourite-teams leg is a
// second, independent loss vector: that POST replaces the FULL list, so an
// unread picks map deletes every team — which is precisely what /my-teams reads.
//
// ⚠ It lived as a `"use client"` page.tsx, measured by NEITHER coverage gate.
// It is now ProfileEditClient.tsx so the component gate sees it and this test
// can render the failure for real instead of grepping the source for a string.

function jsonRes(body: unknown, ok = true, status = ok ? 200 : 503) {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response
}

const BIO = {
  bio: {
    username: "trevor",
    display_name: "Trevor",
    tagline: "Blazers Team Captain",
    twitter: "tdillonbond",
    discord: null,
    avatar_url: null,
    accent_color: "#E03A2F",
    equipped_border: null,
    equipped_banner: null,
  },
}

/** Route the four seams by URL so one leg can fail while the others succeed. */
function installFetch(handlers: {
  bio?: () => Response | Promise<Response> | never
  teams?: () => Response | Promise<Response>
  master?: () => Response | Promise<Response>
}) {
  // ⚠ BOTH params are declared even though only `input` is read for routing:
  // vi.fn infers the call tuple from the signature, so a one-arg mock types
  // `.mock.calls` as `[input: unknown]` and every `c[1]` read is a tsc error.
  // vitest never runs tsc, so the suite goes green while `typecheck` reds — the
  // repo's single most-repeated CI breakage.
  const fn = vi.fn(async (input: unknown, _init?: RequestInit) => {
    void _init
    const url = String(input)
    if (url.startsWith("/api/profile/bio")) return handlers.bio ? handlers.bio() : jsonRes(BIO)
    if (url.startsWith("/api/profile/teams")) return handlers.teams ? handlers.teams() : jsonRes({ teams: [] })
    if (url.startsWith("/api/teams")) return handlers.master ? handlers.master() : jsonRes({ teams: [] })
    throw new Error(`unstubbed fetch: ${url}`)
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

type FetchMock = ReturnType<typeof vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>>

/** Every POST the component issued, so a SUPPRESSED leg is assertable. */
function posts(fn: FetchMock) {
  return fn.mock.calls
    .filter((c) => c[1]?.method === "POST")
    .map((c) => ({ url: String(c[0]), body: JSON.parse(String(c[1]!.body)) }))
}

/** The parsed body of the first POST to `prefix`. Throws if none went out. */
function postBody(fn: FetchMock, prefix: string): Record<string, unknown> {
  const hit = posts(fn).find((p) => p.url.startsWith(prefix))
  if (!hit) throw new Error(`no POST to ${prefix}`)
  return hit.body
}

describe("ProfileEditClient — a failed load must not present an editable blank form", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}))
  afterEach(() => {
    // ⚠ EXPLICIT cleanup: this config does not enable vitest globals, so
    // testing-library's auto-cleanup never registers. Without it the previous
    // test's component stays mounted, its in-flight load effect resolves after
    // `unstubAllGlobals` has removed the fetch stub, and the NEXT test fails
    // looking for an editor that a stale unmount-less tree never rendered —
    // which reads as a bug in the component, not in the harness.
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("WITHHOLDS the form when the bio read fails", async () => {
    // ⚠ The assertion that matters is the ABSENCE of the editor, not the
    // presence of an error message. A banner over a blank editable form still
    // lets a save go out, and this page's save is the destructive act — so the
    // fix has to remove the ability to submit, not merely describe itself.
    installFetch({ bio: () => jsonRes({ error: "statement timeout" }, false) })
    render(<ProfileEditClient />)

    await screen.findByText(/couldn.t load your profile/i)
    expect(screen.queryByLabelText(/public username/i), "the editor must not render").toBeNull()
    expect(screen.queryByRole("button", { name: /save profile/i }), "no save button on a failed load").toBeNull()
    // The copy must not imply anything was lost.
    expect(screen.getByText(/your profile is untouched/i)).toBeTruthy()
  })

  it("WITHHOLDS the form when the bio fetch THROWS", async () => {
    // ⚠ `fetch` throws on a network failure rather than resolving non-ok, and
    // the load effect originally had only a `finally` — so the rejection
    // escaped while `loading` still went false, rendering the blank form. Model
    // the failure that actually happens offline, not only the tidy 503.
    installFetch({
      bio: () => {
        throw new TypeError("Failed to fetch")
      },
    })
    render(<ProfileEditClient />)

    await screen.findByText(/couldn.t load your profile/i)
    expect(screen.queryByLabelText(/public username/i)).toBeNull()
  })

  it("renders the editor, populated, when the read SUCCEEDS", async () => {
    // The other direction. A fix that hid the form whenever anything went
    // slightly wrong would break the page's only purpose.
    installFetch({})
    render(<ProfileEditClient />)

    const username = (await screen.findByLabelText(/public username/i)) as HTMLInputElement
    expect(username.value).toBe("trevor")
    expect(screen.queryByText(/couldn.t load your profile/i)).toBeNull()
  })

  it("an EMPTY profile still opens the editor — that is a new account, not a failure", async () => {
    // A user who has never saved a profile gets `{ bio: null }` at HTTP 200.
    // Treating that as a failure would lock every new account out of the one
    // page that creates a profile.
    installFetch({ bio: () => jsonRes({ bio: null }) })
    render(<ProfileEditClient />)

    const username = (await screen.findByLabelText(/public username/i)) as HTMLInputElement
    expect(username.value).toBe("")
    expect(screen.queryByText(/couldn.t load your profile/i)).toBeNull()
  })
})

describe("ProfileEditClient — a failed TEAMS read must not delete the user's teams", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}))
  afterEach(() => {
    // ⚠ EXPLICIT cleanup: this config does not enable vitest globals, so
    // testing-library's auto-cleanup never registers. Without it the previous
    // test's component stays mounted, its in-flight load effect resolves after
    // `unstubAllGlobals` has removed the fetch stub, and the NEXT test fails
    // looking for an editor that a stale unmount-less tree never rendered —
    // which reads as a bug in the component, not in the harness.
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("says the pickers are empty because we could not read them", async () => {
    // ⚠ A SEPARATE flag from the bio one, because it is a separate loss vector
    // and the right remedy differs: the bio failure hides the whole form, but
    // the rest of the profile is still safely editable when only the teams leg
    // failed — so this discloses and suppresses ONE leg rather than the page.
    installFetch({ teams: () => jsonRes({ error: "boom" }, false) })
    render(<ProfileEditClient />)

    await screen.findByLabelText(/public username/i)
    await waitFor(() => expect(screen.getByText(/saved teams couldn.t be loaded/i)).toBeTruthy())
    // The rest of the editor stays usable.
    expect(screen.getByLabelText(/public username/i)).toBeTruthy()
  })

  it("stays silent when the teams read SUCCEEDS with no favourites", async () => {
    // Having no favourite teams is the normal state for most accounts; a
    // permanent notice there is its own false claim, and it would train the
    // reader to ignore the one that matters.
    installFetch({ teams: () => jsonRes({ teams: [] }) })
    render(<ProfileEditClient />)

    await screen.findByLabelText(/public username/i)
    await waitFor(() => expect(screen.getByText(/Fan Affinity/i)).toBeTruthy())
    expect(screen.queryByText(/saved teams couldn.t be loaded/i)).toBeNull()
  })
})

describe("ProfileEditClient — save()", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}))
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("SKIPS the teams POST when the teams read failed — the whole point of the flag", async () => {
    // ⚠ THE DESTRUCTIVE PROPERTY, and the reason `teamsLoadFailed` is tracked
    // apart from the bio failure. /api/profile/teams REPLACES the full list, so
    // posting a picks map we never managed to populate deletes every favourite
    // team — which is exactly what /my-teams reads back. Leaving them untouched
    // is the only safe answer when we do not know what they are.
    const fn = installFetch({ teams: () => jsonRes({ error: "boom" }, false) })
    render(<ProfileEditClient />)
    await screen.findByLabelText(/public username/i)
    await waitFor(() => expect(screen.getByText(/saved teams couldn.t be loaded/i)).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: /save profile/i }))

    await waitFor(() => expect(posts(fn).some((p) => p.url.startsWith("/api/profile/bio"))).toBe(true))
    expect(
      posts(fn).some((p) => p.url.startsWith("/api/profile/teams")),
      "the destructive teams POST must not go out",
    ).toBe(false)
  })

  it("DOES post teams when the read succeeded — the suppression must not be permanent", async () => {
    // The other direction: a fix that never posts teams would break the only
    // way to set them, which is a worse outcome than the bug.
    const fn = installFetch({ teams: () => jsonRes({ teams: [] }) })
    render(<ProfileEditClient />)
    await screen.findByLabelText(/public username/i)

    fireEvent.click(screen.getByRole("button", { name: /save profile/i }))
    await waitFor(() =>
      expect(posts(fn).some((p) => p.url.startsWith("/api/profile/teams"))).toBe(true),
    )
  })

  it("round-trips the LOADED values rather than the empty form", async () => {
    // The blank-form defect showed up here: save() sends every field
    // unconditionally, so what it posts is exactly what a failed load would
    // have overwritten the profile with.
    const fn = installFetch({})
    render(<ProfileEditClient />)
    await screen.findByLabelText(/public username/i)

    fireEvent.click(screen.getByRole("button", { name: /save profile/i }))
    await waitFor(() => expect(posts(fn).length).toBeGreaterThan(0))
    const bio = posts(fn).find((p) => p.url.startsWith("/api/profile/bio"))!
    expect(bio.body).toMatchObject({
      username: "trevor",
      displayName: "Trevor",
      tagline: "Blazers Team Captain",
      twitter: "tdillonbond",
    })
  })

  it("rejects a malformed username BEFORE any POST", async () => {
    // Client-side validation that never fires is worse than none: the user gets
    // a server error for a rule the form claimed to enforce.
    const fn = installFetch({})
    render(<ProfileEditClient />)
    const input = await screen.findByLabelText(/public username/i)
    fireEvent.change(input, { target: { value: "a b" } })
    fireEvent.click(screen.getByRole("button", { name: /save profile/i }))

    await screen.findByText(/username must be 3.32 chars/i)
    expect(posts(fn), "nothing may be written on a rejected form").toEqual([])
  })

  it("a FAILED save surfaces the server's reason and does not claim success", async () => {
    const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === "POST") return jsonRes({ error: "username is taken" }, false, 409)
      if (url.startsWith("/api/profile/bio")) return jsonRes(BIO)
      return jsonRes({ teams: [] })
    })
    vi.stubGlobal("fetch", fn)
    render(<ProfileEditClient />)
    await screen.findByLabelText(/public username/i)

    fireEvent.click(screen.getByRole("button", { name: /save profile/i }))
    await screen.findByText(/username is taken/i)
    // ⚠ A "Saved" stamp beside a failed save is the same class of lie as the
    // rest of this file, one layer up: it is a claim about what WE did.
    expect(screen.queryByText(/^saved /i)).toBeNull()
  })
})

describe("ProfileEditClient — the pick handlers carry real rules", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}))
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const NBA_TEAMS = {
    teams: [
      { slug: "portland-trail-blazers", team_name: "Portland Trail Blazers", abbreviation: "POR", primary_color: "#E03A2F", has_moments: true },
      { slug: "new-york-knicks", team_name: "New York Knicks", abbreviation: "NYK", primary_color: "#006BB6", has_moments: true },
    ],
  }

  function withTeamMaster() {
    return installFetch({
      master: () => jsonRes(NBA_TEAMS),
      teams: () => jsonRes({ teams: [] }),
    })
  }

  it("edits flow through to what save() posts", async () => {
    const fn = withTeamMaster()
    render(<ProfileEditClient />)
    const tagline = await screen.findByLabelText(/tagline/i)
    fireEvent.change(tagline, { target: { value: "Rip packs, not people" } })
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "T" } })
    fireEvent.change(screen.getByLabelText(/discord/i), { target: { value: "trev#1" } })

    fireEvent.click(screen.getByRole("button", { name: /save profile/i }))
    await waitFor(() => expect(posts(fn).length).toBeGreaterThan(0))
    const body = postBody(fn, "/api/profile/bio")
    expect(body).toMatchObject({ tagline: "Rip packs, not people", displayName: "T", discord: "trev#1" })
  })

  it("clearing a league's team also clears its PRIMARY flag", async () => {
    // ⚠ The rule the handler exists for: you cannot be "primary" on a team you
    // did not pick. Without it the flag survives the selection that made it
    // meaningful, and the saved row claims a primary league with no team.
    const fn = withTeamMaster()
    render(<ProfileEditClient />)
    await screen.findByLabelText(/public username/i)
    const nbaSelect = await screen.findByLabelText(/^NBA favorite team$/)

    fireEvent.change(nbaSelect, { target: { value: "portland-trail-blazers" } })
    fireEvent.click(screen.getAllByRole("radio")[0])
    fireEvent.change(nbaSelect, { target: { value: "" } })

    fireEvent.click(screen.getByRole("button", { name: /save profile/i }))
    await waitFor(() =>
      expect(
        posts(fn).some((p) => p.url.startsWith("/api/profile/teams")),
      ).toBe(true),
    )
    const teamsBody = postBody(fn, "/api/profile/teams")
    // An empty slug is filtered out entirely, so the cleared league must not
    // appear at all — primary or otherwise.
    expect(teamsBody.teams).toEqual([])
  })

  it("primary is EXCLUSIVE across leagues", async () => {
    const fn = withTeamMaster()
    render(<ProfileEditClient />)
    await screen.findByLabelText(/public username/i)

    fireEvent.change(await screen.findByLabelText(/^NBA favorite team$/), {
      target: { value: "portland-trail-blazers" },
    })
    const radios = screen.getAllByRole("radio")
    fireEvent.click(radios[0])
    expect((radios[0] as HTMLInputElement).checked).toBe(true)

    fireEvent.click(screen.getByRole("button", { name: /save profile/i }))
    await waitFor(() =>
      expect(
        posts(fn).some((p) => p.url.startsWith("/api/profile/teams")),
      ).toBe(true),
    )
    const teamsBody = postBody(fn, "/api/profile/teams")
    const picked = teamsBody.teams as Array<{ is_primary: boolean }>
    expect(picked.filter((t) => t.is_primary)).toHaveLength(1)
  })
})

describe("ProfileEditClient — the live preview must agree with the form", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}))
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("avatar and accent edits reach both the preview and the save body", async () => {
    // ⚠ These two controls are why the preview exists: the accent is a bare
    // colour input and the avatar a raw URL, so before the preview shipped they
    // were set BLIND. A preview that disagreed with the form would be worse
    // than none — it would be a confident picture of something you are not
    // about to save.
    const fn = installFetch({})
    render(<ProfileEditClient />)
    // Relabelled "Or paste an image URL" on 2026-08-16, when "Choose from your
    // Moments" became the primary path and the text field became the fallback.
    const avatar = await screen.findByLabelText(/paste an image url/i)
    fireEvent.change(avatar, { target: { value: "https://cdn.example/a.png" } })
    fireEvent.change(screen.getByLabelText(/accent color/i), { target: { value: "#00ff00" } })

    // The hex is echoed beside the swatch, so the value is readable rather than
    // only visible as a colour.
    await waitFor(() => expect(screen.getByText("#00ff00")).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: /save profile/i }))
    await waitFor(() =>
      expect(posts(fn).length).toBeGreaterThan(0),
    )
    const body = postBody(fn, "/api/profile/bio")
    expect(body).toMatchObject({ avatarUrl: "https://cdn.example/a.png", accentColor: "#00ff00" })
  })

  it("a blank optional field posts NULL, not an empty string", async () => {
    // The distinction the profile row cares about: "" would render as a set-
    // but-empty tagline on the public profile, where null omits the line. It is
    // also exactly the value a failed load would have posted for every field,
    // which is what made the blank-form defect destructive rather than inert.
    const fn = installFetch({})
    render(<ProfileEditClient />)
    const tagline = await screen.findByLabelText(/tagline/i)
    fireEvent.change(tagline, { target: { value: "   " } })

    fireEvent.click(screen.getByRole("button", { name: /save profile/i }))
    await waitFor(() =>
      expect(posts(fn).length).toBeGreaterThan(0),
    )
    const body = postBody(fn, "/api/profile/bio")
    expect(body.tagline).toBeNull()
  })
})

// 2026-09-02 (onboarding QA #9): the "Public URL" preview echoed whatever was
// typed — `qa 0903!` previewed as a URL that could never save.
describe("ProfileEditClient — the public URL preview only promises a handle that would save", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("previews a valid handle, states the rule for an invalid one, and the placeholder for none", async () => {
    installFetch({})
    render(<ProfileEditClient />)
    const box = (await screen.findByLabelText(/username/i)) as HTMLInputElement
    fireEvent.change(box, { target: { value: "qa 0903!" } })
    expect(screen.getByText(/lowercase letters, numbers/i)).toBeTruthy()
    fireEvent.change(box, { target: { value: "qa0903" } })
    expect(screen.getAllByText(/rippackscity\.com\/profile\/qa0903/).length).toBeGreaterThan(0)
    fireEvent.change(box, { target: { value: "" } })
    expect(screen.getByText(/set a username to enable/i)).toBeTruthy()
  })
})
