// app/special-serial-owners/board-seed.ts — the board's URL seed, in a SERVER-SAFE
// module. It lived in SpecialSerialOwnersClient.tsx ("use client"), and page.tsx (a
// server component) CALLED it: Next turns every export of a client module into a
// client reference, so the call threw "Attempted to call boardSeed() from the server"
// and the signed-in page 500'd (CI build-render, 2026-10-26, a33bf9e). Keep anything a
// server component calls out of a "use client" file.

export type BoardCollection = "nba-top-shot" | "nfl-all-day"

const BOARD_COLLECTION_BY_PARAM: Record<string, BoardCollection> = {
  "nba-top-shot": "nba-top-shot",
  nba_top_shot: "nba-top-shot",
  "nfl-all-day": "nfl-all-day",
  nfl_all_day: "nfl-all-day",
}

/** Seeds from the URL (2026-10-26): edition pages link `?player=<name>[&collection=nfl-all-day]`, and the
 *  board read neither, so every link landed on the unfiltered Top Shot board.
 *
 *  ⛔ 2026-10-27: a PRESENT `?collection=` the board does not cover returns `collection: null` — the page
 *  refuses — instead of falling back to Top Shot: `?player=Ohtani&collection=candy-mlb` would otherwise open
 *  Top Shot's holders for that name, answering a Candy question with Top Shot rows (substitution). Only an
 *  ABSENT param defaults to Top Shot. */
export function boardSeed(sp: { player?: string | string[]; collection?: string | string[] } | null | undefined): { player: string; collection: BoardCollection | null } {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ""
  const player = one(sp?.player).trim().slice(0, 80)
  const raw = one(sp?.collection).trim().toLowerCase()
  const collection: BoardCollection | null = raw === "" ? "nba-top-shot" : (BOARD_COLLECTION_BY_PARAM[raw] ?? null)
  return { player, collection }
}
