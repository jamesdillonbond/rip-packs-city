// Which kind of run the residential Panini runner should do (2026-10-03, Trevor chose "more runs").
//
// The walk refreshes ~290-370 editions a run against ~15.7k catalogue editions (~8-day rotation). The
// task moves from every 4 h to every 2 h, but every run also re-enumerates the sport grids first (~45
// min, measured 10-03) — so doubling FULL runs would add as much grid time as card time. Instead the
// runs alternate:
//   "full" — grids (discovery of new cards/products), the secondary pack grid and pack pages, then cards.
//   "walk" — cards only: priority (aged + held) and the stalest known editions, for the whole run.
// The four-hourly slots the box has always run (2, 6, 10 AM/PM PT) stay FULL; the new in-between
// slots (12, 4, 8 AM/PM PT) are WALK. A late start (a missed run caught up) at any other hour is FULL.
// `PANINI_RUN_MODE` = "full" | "walk" pins it (unset/"auto" = by the clock).

export type PaniniRunMode = "full" | "walk"

/** The America/Los_Angeles hour (0-23) of `at`. */
export function ptHour(at: Date): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" }).format(at)
  return Number(h) % 24
}

export function paniniRunMode(at: Date, override: string | undefined = process.env.PANINI_RUN_MODE): PaniniRunMode {
  if (override === "full" || override === "walk") return override
  return ptHour(at) % 4 === 0 ? "walk" : "full"
}
