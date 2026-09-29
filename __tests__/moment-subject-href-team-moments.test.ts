import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { isTeamMoment, momentSubjectHref } from "@/lib/entity-href"

// ── Team Moments linked to a player page that has never existed (2026-09-04) ──
// Top Shot's convention for a TEAM highlight is `player_name = team_name`: a *Clamps* Moment of
// the Sacramento Kings stores "Sacramento Kings" in BOTH fields. Every surface built the "who"
// link as `/<collection>/player/<slug>`, which for these is a 404 — verified live:
//     /nba-top-shot/player/sacramento-kings   404
//     /nba-top-shot/team/sacramento-kings     200
//     /nba-top-shot/player/domantas-sabonis   200   (a real player is unaffected)
// Measured over the catalog: **370** Top Shot editions are team Moments and **not one has a
// `players` row**, so the link never resolved for any of them. 150 of the 370 are parallels, and
// ~107 of those only acquired a player_name at all in `20260904152154` — so this fix is also the
// blast radius of that one, checked rather than assumed.
describe("momentSubjectHref — a team Moment goes to the team page, not a 404 player page", () => {
  it("sends player_name === team_name to /team", () => {
    expect(momentSubjectHref("nba-top-shot", "Sacramento Kings", "Sacramento Kings"))
      .toBe("/nba-top-shot/team/sacramento-kings")
  })

  it("still sends a real player to /player", () => {
    expect(momentSubjectHref("nba-top-shot", "Domantas Sabonis", "Sacramento Kings"))
      .toBe("/nba-top-shot/player/domantas-sabonis")
  })

  it("treats surrounding whitespace as the same name (the DB carries both spellings)", () => {
    expect(momentSubjectHref("nba-top-shot", "Cleveland Cavaliers ", "Cleveland Cavaliers"))
      .toBe("/nba-top-shot/team/cleveland-cavaliers")
  })

  it("a player with no team is still a player, never a team", () => {
    expect(momentSubjectHref("nba-top-shot", "Domantas Sabonis", null))
      .toBe("/nba-top-shot/player/domantas-sabonis")
  })

  it("no name means no link at all — never a link to an empty slug", () => {
    expect(momentSubjectHref("nba-top-shot", null, "Sacramento Kings")).toBeNull()
    expect(momentSubjectHref("nba-top-shot", "", "Sacramento Kings")).toBeNull()
  })

  // Ratchet: the raw spelling is what produced the 404s. Any NEW call site that rebuilds
  // `/player/${slugifyName(<a moment's player name>)}` by hand reintroduces it, so the three
  // surfaces a team Moment can actually appear on must go through the helper.
  it("the three Moment surfaces build the subject link through the helper, not by hand", () => {
    const files = [
      "app/(collections)/[collection]/edition/[slug]/page.tsx",
      "components/collection/CollectionMomentTable.tsx",
      "app/(collections)/[collection]/market/MarketClient.tsx",
    ]
    for (const f of files) {
      const src = fs.readFileSync(path.join(process.cwd(), f), "utf8")
      // The PROPERTY (the helper is imported from its module), not the spelling of
      // the import line — the edition page imports two more helpers from it now.
      expect(src, `${f} must import momentSubjectHref`).toMatch(
        /import \{[^}]*\bmomentSubjectHref\b[^}]*\} from "@\/lib\/entity-href"/,
      )
      // no hand-rolled player href built from a row/detail/listing's player name
      const handRolled = src.match(/\/player\/\$\{[^}]*[Pp]layer[Nn]ame[^}]*\}/g) ?? []
      expect(handRolled, `${f} still builds a player href by hand: ${handRolled.join(" | ")}`)
        .toHaveLength(0)
    }
  })
})

// ── All Day's Team Melt stores the CITY (2026-09-29) ─────────────────────────
// "Denver — Banner Year" (edition 5441) carries player_name "Denver", team_name "Denver Broncos".
// No `players` row exists for a city, so /nfl-all-day/player/denver 404'd — and the sitemap
// listed it (and 13 more). Measured live: /nfl-all-day/team/denver-broncos 200. Zero names that DO
// have a players row start a team_name + " " in any collection, so no real player is rerouted.
describe("isTeamMoment / momentSubjectHref — All Day Team Melt city names", () => {
  it("a city that prefixes its franchise is a team Moment, linked to the FRANCHISE page", () => {
    expect(isTeamMoment("Denver", "Denver Broncos")).toBe(true)
    expect(momentSubjectHref("nfl-all-day", "Denver", "Denver Broncos")).toBe("/nfl-all-day/team/denver-broncos")
    expect(momentSubjectHref("nfl-all-day", "New England", "New England Patriots")).toBe("/nfl-all-day/team/new-england-patriots")
  })

  it("a real player is never a team, even when a word is shared", () => {
    expect(isTeamMoment("Von Miller", "Denver Broncos")).toBe(false)
    expect(isTeamMoment("Denver", "Denverx Broncos")).toBe(false)
    expect(momentSubjectHref("nfl-all-day", "Von Miller", "Denver Broncos")).toBe("/nfl-all-day/player/von-miller")
  })

  it("the sitemap uses the same predicate, so its player list cannot drift from the links", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "lib/sitemap-data.ts"), "utf8")
    expect(src).toMatch(/import \{[^}]*\bisTeamMoment\b[^}]*\} from '@\/lib\/entity-href'/)
    expect(src).not.toMatch(/player_name\.trim\(\) === e\.team_name\.trim\(\)/)
  })
})
