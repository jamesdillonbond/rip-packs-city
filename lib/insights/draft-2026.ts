// lib/insights/draft-2026.ts
//
// The 2026 NBA Draft, pick number by player — for the rookie-sales board and the @RipPacksCity
// Wednesday rookie post (Trevor, 11-14: "Is there a good way to incorporate their draft position").
// No RPC table carries draft position, so it lives here as a fixed fact.
//
// Source: basketball-reference.com/draft/NBA_2026.html, read 2026-11-14; picks 1-12 and 34 also
// matched nba.com/news/2026-nba-draft-order the same day. The pick is the selection slot, whoever
// made it (Meleek Thomas was Sacramento's No. 34 and was traded to Cleveland).
//
// A player who is not here was not drafted in 2026 (an undrafted rookie, or a draft-and-stash
// from an earlier draft such as Bogoljub Marković). `draftPick2026` returns null for them — never
// a guess.

const PICKS: readonly string[] = [
  "AJ Dybantsa", "Darryn Peterson", "Cameron Boozer", "Caleb Wilson", "Keaton Wagler",
  "Mikel Brown Jr.", "Darius Acuff Jr.", "Kingston Flemings", "Morez Johnson Jr.", "Brayden Burries",
  "Yaxel Lendeborg", "Aday Mara", "Nate Ament", "Hannes Steinbach", "Dailyn Swain",
  "Bennett Stirtz", "Ebuka Okorie", "Christian Anderson Jr.", "Allen Graves", "Jayden Quaintance",
  "Karim López", "Labaron Philon Jr.", "Zuby Ejiofor", "Cameron Carr", "Sergio de Larrea",
  "Tarris Reed Jr.", "Chris Cenac Jr.", "Joshua Jefferson", "Alex Karaban", "Koa Peat",
  "Bruce Thornton", "Richie Saunders", "Isaiah Evans", "Meleek Thomas", "Trevon Brazile",
  "Baba Miller", "Ryan Conwell", "Braden Smith", "Jack Kayil", "Dillon Mitchell",
  "Otega Oweh", "Ja'Kobi Gillespie", "Tyler Bilodeau", "Maliq Brown", "Emanuel Sharp",
  "Felix Okpara", "Tyler Nickel", "Tobi Lawal", "Bryce Hopkins", "Jaden Bradley",
  "Izaiyah Nelson", "Henri Veesaar", "Ugonna Onyenso", "Lajae Jones", "Nick Martinelli",
  "Vsevolod Ishchenko", "Narcisse Ngoy", "Jaron Pierre Jr.", "Trey Kaufman-Renn", "Malique Lewis",
]

/** Accent-, case- and punctuation-insensitive key ("Karim López" === "Karim Lopez"). */
export function draftNameKey(name: string): string {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
}

const BY_KEY = new Map(PICKS.map((n, i) => [draftNameKey(n), i + 1]))

/** The player's 2026 NBA Draft pick (1-60), or null when they were not drafted in 2026. */
export function draftPick2026(playerName: string): number | null {
  return BY_KEY.get(draftNameKey(playerName)) ?? null
}

export const DRAFT_2026_PICK_COUNT = PICKS.length
