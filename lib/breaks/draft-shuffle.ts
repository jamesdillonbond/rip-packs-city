// lib/breaks/draft-shuffle.ts
//
// Deterministic seeded shuffle for team-draft / random-team breaks.
//
// Entropy source: Flow's RandomBeaconHistory — read in the draft route
// once the locked-break's target sealed block is available, then passed in
// here as a 32-byte buffer. Same seed + same input always produces the
// same output, so the assignment is reproducible from on-chain data and
// auditable by any buyer.
//
// Implementation: Fisher–Yates with 32-bit indices pulled from the seed
// buffer four bytes at a time. When the cursor exhausts the buffer we
// re-hash with SHA-256 and reset — this lets us shuffle arrays larger
// than 8 entries from a 32-byte seed without re-using bytes.

import { createHash } from "crypto"

export const CANONICAL_NBA_TEAMS: readonly string[] = Object.freeze([
  "Atlanta Hawks",
  "Boston Celtics",
  "Brooklyn Nets",
  "Charlotte Hornets",
  "Chicago Bulls",
  "Cleveland Cavaliers",
  "Dallas Mavericks",
  "Denver Nuggets",
  "Detroit Pistons",
  "Golden State Warriors",
  "Houston Rockets",
  "Indiana Pacers",
  "LA Clippers",
  "Los Angeles Lakers",
  "Memphis Grizzlies",
  "Miami Heat",
  "Milwaukee Bucks",
  "Minnesota Timberwolves",
  "New Orleans Pelicans",
  "New York Knicks",
  "Oklahoma City Thunder",
  "Orlando Magic",
  "Philadelphia 76ers",
  "Phoenix Suns",
  "Portland Trail Blazers",
  "Sacramento Kings",
  "San Antonio Spurs",
  "Toronto Raptors",
  "Utah Jazz",
  "Washington Wizards",
])

export function deterministicShuffle<T>(items: T[], seed: Buffer): T[] {
  const arr = items.slice()
  let entropy = seed
  let cursor = 0

  for (let i = arr.length - 1; i >= 1; i--) {
    if (cursor + 4 > entropy.length) {
      entropy = createHash("sha256").update(entropy).digest()
      cursor = 0
    }
    const u32 = entropy.readUInt32BE(cursor)
    cursor += 4
    const j = u32 % (i + 1)
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }

  return arr
}

export function assignTeamsToSpots(
  teamPool: string[],
  spotCount: number,
  seed: Buffer
): string[] {
  if (spotCount > teamPool.length) {
    throw new Error(
      `assignTeamsToSpots: spotCount ${spotCount} exceeds teamPool length ${teamPool.length}`
    )
  }
  const shuffled = deterministicShuffle(teamPool, seed)
  return shuffled.slice(0, spotCount)
}
