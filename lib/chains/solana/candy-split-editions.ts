// lib/chains/solana/candy-split-editions.ts
//
// #259 (2026-11-15, Trevor: "handle 2026-11-16T0404Z first"). These Candy edition keys MERGE DIFFERENT
// CARDS: 3,857 holdings carried a serial above their edition's circulation, in 90 editions holding 42,592
// cards, and 9 more editions carry the old baseName date bug's signature (a name ending in "/":
// "MLB Play of the Day 10/"). Magic Eden showed each sampled edition holding 2+ real cards, for three
// reasons:
//   1. a card was given ANOTHER card's metadata (a shared group fetch) and kept it — the census REUSE
//      path never re-reads a card it has seen ("Batman (1940-2011) #1 (1996/2000)", a Core card, filed
//      under -uncommon /1500);
//   2. the date bug: "MLB Play of the Day 10/26/21 (3632/3640)" lost its date (fixed in baseName);
//   3. a true key collision: the on-chain name carries no difference (2024 All-Star Helmet AL /1454 vs
//      NL /1443, both "2024 MLB AllStar <serial>"; cut ticket names).
//
// Each value is the edition's stored circulation at the time (null for the date-bug buckets). Two
// rules use this list:
//   * editionKeyFromAsset: a card whose computed key is listed and whose OWN edition size differs from
//     that circulation is keyed `<key>-n<size>` — the majority card keeps the key (its URL, sales and
//     history stay), every other card gets its own edition. Applies to every writer (census, wallet
//     refresh, sales and listings indexers) because they all key through editionKeyFromAsset.
//   * the census: a card whose stored edition is listed is RE-READ once from its own metadata (never a
//     shared group fetch, never reused) and recorded in candy_edition_split_checked, so it is never
//     fetched again for this reason.
// Generated from the DB on 2026-11-15 ~8:25 PM PT (see the ledger entry). Do not add keys by hand
// without the same measurement.
export const CANDY_SPLIT_EDITION_KEYS: Readonly<Record<string, number | null>> = {
  "c:1-of-1-player-highlights:brett-phillips-diving-catch-vs-boston-7-G3wFvLc3PwTw": null,
  "c:2021-play-of-the-day:mlb-play-of-the-day-10": 650,
  "c:2022-cal-ripken-jr-rookie-collection:cal-ripken-jr-rookie-year-uncommon": 330,
  "c:2022-play-of-the-day:2022-end-of-regular-season": 45,
  "c:2022-tickets:2022-world-series-game-4": 2737,
  "c:2022-tickets:atlanta-braves-at-philadelphia-phillies-10": 787,
  "c:2022-tickets:cleveland-guardians-at-new": 1471,
  "c:2022-tickets:los-angeles-dodgers-at-san-diego-padres-10": null,
  "c:2022-tickets:new-york-yankees-at": 430,
  "c:2022-tickets:new-york-yankees-at-cleveland-guardians-10": null,
  "c:2022-tickets:new-york-yankees-at-houston": 581,
  "c:2022-tickets:new-york-yankees-at-houston-astros-10": null,
  "c:2022-tickets:philadelphia-phillies-at": 1620,
  "c:2022-tickets:san-diego-padres-at-los": 4955,
  "c:2022-tickets:san-diego-padres-at-philadelphia-phillies-10": null,
  "c:2022-tickets:san-diego-padres-at-philadephia-phillies-10": null,
  "c:2022-tickets:seattle-mariners-at-houston-astros-10": null,
  "c:2022-tickets:wander-franco-night": 1325,
  "c:2023-players-of-the-month:adam-duvall-al-player-of-the-core": 57,
  "c:2023-players-of-the-month:james-outman-nl-rookie-of-th-rare": 17,
  "c:2023-players-of-the-month:shohei-ohtani-al-player-of-th-epic": 6,
  "c:2023-tickets-hsco:2023-home-opener-ticket": 1309,
  "c:2023-tickets-hsco:2023-player-virtual-meet": 20,
  "c:2024-fresh-threads-gems:shohei-ohtani-home-run-rare": 100,
  "c:2024-mlb-all-star-commemorative-helmet:2024-mlb-allstar": 797,
  "c:2025-candy-ambassadors:2025-signed-baseball": 1078,
  "c:2025-candy-ambassadors:signed-baseball-giveaway": 1022,
  "c:2025-icon-chasers:2025-mlb-rookie-icons-chaser": 24,
  "c:2025-icon-chasers:2025-mlb-speedway-classic": 89,
  "c:2025-icon-chasers:2025-mlb-tokyo-series-rainbow": 11,
  "c:2025-icon-chasers:2025-speedway-classic-icons": 27,
  "c:2025-mlb-gems-july:cody-bellinger-double-play-epic": 25,
  "c:2025-mlb-gems-march-april:elly-de-la-cruz-diving-catch-unique": 30,
  "c:absolute-batman-2024-1:absolute-batman-2024-1-epic": 400,
  "c:absolute-batman-2024-10:absolute-batman-2024-10-rare": 300,
  "c:absolute-batman-2024-5:absolute-batman-2024-5-uncommon": 400,
  "c:absolute-batman-2024-9:absolute-batman-2024-9-core": 162,
  "c:absolute-flash-2025-4:absolute-flash-2025-4-core": 40,
  "c:absolute-green-lantern-2025-3:abs-green-lantern-3-epic": 350,
  "c:absolute-martian-manhunter-2025-4:abs-martian-manhunter-4-core": 72,
  "c:absolute-superman-2024-1:absolute-superman-2024-1-uncommon": 800,
  "c:absolute-wonder-woman-2024-1:abs-wonder-woman-1-uncommon": 800,
  "c:absolute-wonder-woman-2024-5:abs-wonder-woman-5-core": 78,
  "c:action-comics-1938-2011-242:action-comics-242-uncommon": 1463,
  "c:aquaman-59-multiverse-edition:aquaman-59-rare": 242,
  "c:batman-1940-2011-1:batman-1940-2011-uncommon": 1500,
  "c:batman-1940-2011-181:batman-1940-2011-181-core": 800,
  "c:batman-1940-2011-405:batman-1940-2011-405-epic": 1225,
  "c:batman-1940-2011-608:batman-1940-2011-608-uncommon": 1200,
  "c:batman-2016-158:batman-2016-legendary": 30,
  "c:batman-2025-1-crafted-edition:batman-1-crafted-edition-epic": 141,
  "c:batman-2025-1:batman-2025-core": 289,
  "c:batman-beyond-1999-1:batman-beyond-1999-1-core": 2000,
  "c:batman-crimson-mist-1998:batman:-crimson-mist-1998-epic": 200,
  "c:batman-dark-victory-issue-0-2025-sdcc-edition-20:batman-dark-victory-issue-0-core": 2440,
  "c:batman-one-bad-day-penguin-2022-1:batman-one-bad-day-penguin-1-legendary": 100,
  "c:batman-the-long-halloween:batman:-the-long-halloween-uncommon": 600,
  "c:blackest-night-2009-2010-1:blackest-night-1-core": 400,
  "c:blue-beetle-2006-2009-1:blue-beetle-2006-2009-1-uncommon": 421,
  "c:dark-nights-death-metal-2020-2021-1:dark-nights-death-metal-1-uncommon": 1200,
  "c:dc-comics-presents-1978-1986-26:dc-comics-presents-26-uncommon": 1050,
  "c:dc3-super-power-packs-series-3-crisis-on-infinit:crisis-on-infinite-earths-rare": 2750,
  "c:dc3-super-power-packs-series-jla-the-nail:justice-league-of-america-rare": 2750,
  "c:dc3-super-power-packs-series-jla-the-nail:justice-league-of-america-uncommon": 4750,
  "c:dc3-super-power-packs-series-justice-league-vs-s:justice-league-vs-suicide-legendary": 181,
  "c:detective-comics-1937-2011-140:detective-comics-140-rare": 458,
  "c:detective-comics-1937-2011-140:detective-comics-140-uncommon": 891,
  "c:detective-comics-1937-2011-58:detective-comics-58-uncommon": 1118,
  "c:flash-comics-1940-1949-1:flash-comics-1940-1949-1-core": 1000,
  "c:flash-comics-1940-1949-1:flash-comics-1940-1949-1-rare": 375,
  "c:from-the-dc-vault-death-in-the-family-robin-live-ekwo:from-the-dc-vault-death-in-legendary": 250,
  "c:gcdk-ranks:gcdk-rank-apprentice-of-core": 247,
  "c:harley-quinn-2000-2004-1:harley-quinn-2000-2004-1-uncommon": 9000,
  "c:harley-quinn-crew-ranks:harley-quinn-crew-rank-rare": 387,
  "c:house-of-mystery-1951-1983-174:house-of-mystery-174-uncommon": 280,
  "c:justice-league-2011-2016-1:justice-league-1-core": 454,
  "c:justice-league-2011-2016-1:justice-league-1-legendary": 1325,
  "c:justice-league-the-atom-project-2025-5:justice-league-the-atom-pr-5-rare": 300,
  "c:justice-league-unlimited-2024-1:justice-league-unl-1-legendary": 200,
  "c:justice-league-unlimited-2024-3:justice-league-unl-3-rare": 300,
  "c:justice-league-unlimited-2024-5:justice-league-unl-5-rare": 300,
  "c:more-fun-comics-1936-1947-73:more-fun-comics-73-uncommon": 1050,
  "c:peacemaker-tries-hard-2023-2:peacemaker-tries-hard-2-legendary": 75,
  "c:sensation-comics-1942-1952-1:sensation-comics-1-rare": 739,
  "c:showcase-1956-1978-4:showcase-1956-1978-4-uncommon": 1489,
  "c:supergirl-woman-of-tomorrow-2021-2022-1:supergirl-woman-of-tomorrow-uncommon": 510,
  "c:superman-1939-2011-199:superman-1939-2011-199-core": 800,
  "c:superman-unlimited-2025-3:superman-unlimited-2025-3-core": 39,
  "c:the-batman:the-batman-limited-edition-legendary": 360,
  "c:the-brave-and-the-bold-1955-1983-28:the-brave-and-the-bold-28-rare": 600,
  "c:the-demon-1972-1973-1:the-demon-1972-1973-1-uncommon": 291,
  "c:the-flash-1959-1985-123:the-flash-1959-1985-123-uncommon": 1492,
  "c:the-flash-the-fastest-man-alive-2022-1:the-flash-the-fastest-man-uncommon": 3021,
  "c:whiz-comics-1940-1952-2:whiz-comics-1940-1952-2-epic": 480,
  "c:whiz-comics-1940-1952-2:whiz-comics-1940-1952-2-uncommon": 1484,
  "c:wonder-woman-1942-1986-1:wonder-woman-1942-1986-1-core": 1400,
  "c:wonder-woman-1987-2006-1:wonder-woman-1987-2006-1-uncommon": 563,
}

/** True when this stored edition key is one of the merged editions (its cards are re-read once). */
export function isSplitEditionKey(key: string | null | undefined): boolean {
  return !!key && Object.prototype.hasOwnProperty.call(CANDY_SPLIT_EDITION_KEYS, key)
}

/**
 * The key a card with this computed key and own edition size belongs to: the listed key's majority
 * size keeps it; any other known size gets `-n<size>`. An unknown size, an unlisted key, or a
 * date-bug bucket (null) returns the key unchanged.
 */
export function splitEditionKey(key: string, size: number | null): string {
  if (!isSplitEditionKey(key)) return key
  const keep = CANDY_SPLIT_EDITION_KEYS[key]
  if (keep == null || size == null || size <= 0 || size === keep) return key
  return `${key}-n${size}`
}
