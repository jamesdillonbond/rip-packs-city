# @RipPacksCity — 2026-11-16: "Where every Moment sits", 2025 rookie class

Trevor, in a claude.ai thread (~10:35 AM – 11:25 AM PT), after the 11-15 2026-class post: "Can you also do one like this but for the 2025 rookies?" → "Keep digging and double checking all of these facts" → "These should only be for their rookie season".

Posted: https://x.com/rippackscity/status/2122407037539922412 (Mon 11/16, ~11:25 AM PT). Image: `rookie-2025-top10-supply.png` (data: `rows2025.json`).

```
Where all 16,994 @NBATopShot rookie-season Moments of the top 10 2025 Rookies sit today 📊

Locked: 8,459
Unlocked: 5,339
Burned: 2,386
In packs: 747
Minted, not in packs: 63
```

Lines run largest to smallest (Sunday's 2026 post led with "In packs"; reorder to match if wanted).

## Who's in it

The 2025 class (`topshot_2025_rookie_players`, 61 names) ranked by all-time Top Shot sales on rookie-season editions, every edition and parallel (same metric as the Wednesday 2026 post, restricted to the 2025-26 season):

| # | Player | Team | Rookie-season sales | Moments |
|---|---|---|---|---|
| 1 | Cooper Flagg | Mavericks | $517,536 · 1,050 | 1,682 |
| 2 | Dylan Harper | Spurs | $211,587 · 1,198 | 1,876 |
| 3 | Kon Knueppel | Hornets | $200,041 · 1,086 | 1,682 |
| 4 | VJ Edgecombe | 76ers | $137,281 · 1,077 | 1,846 |
| 5 | Ace Bailey | Jazz | $72,766 · 905 | 1,677 |
| 6 | Derik Queen | Pelicans | $64,443 · 1,030 | 1,682 |
| 7 | Cedric Coward | Grizzlies | $46,338 · 920 | 1,682 |
| 8 | Tre Johnson | Wizards | $42,576 · 931 | 1,677 |
| 9 | Collin Murray-Boyles | Raptors | $42,556 · 873 | 1,677 |
| 10 | Jeremiah Fears | Pelicans | $37,548 · 899 | 1,513 |
| (11) | Nique Clifford | Kings | $34,178 · 831 | — |

⚠ #8 and #9 are $20 apart. Atlas only reports the last 90 days, so the older ledger can't be checked against it; one missing sale could swap them.

## Per player (unlocked · locked · in packs · minted-not-in-packs · burned)

Flagg 452·1027·67·0·136 · Harper 434·915·74·3·450 · Knueppel 541·902·86·3·150 · Edgecombe 517·895·82·10·342 · Bailey 537·879·81·9·171 · Queen 634·718·61·13·256 · Coward 589·762·84·7·240 · Johnson 496·909·74·9·189 · Murray-Boyles 502·786·70·8·311 · Fears 637·666·68·1·141.

The image says 10:45 AM PT. The full live re-read at 11:21 AM PT (`scripts/social/supply-breakdown-live-check.js`, 191 editions, 95 distributions + 20 newer ids probed, 348 calls, 0 errors) returned these same numbers exactly; every row sums to minted.

## What was checked

- **Minted / locked / burned / unlocked:** RPC's `badge_editions` matched Atlas exactly on all 197 editions (all seasons) of the ten players, per player. Flagg's base Rookie Debut on nbatopshot.com showed #/907 and 16 listed (= 1,000 − 93 burned; unlocked 255 = 239 owned + 16 listed).
- **In packs / minted, not in packs:** read live from Atlas `GetDistributionEditions` (hideOpened) over every distribution RPC has ever seen holding these editions, plus the 20 ids above RPC's newest (all 404). The SQL estimate had been 960 / 98 (all seasons); live was 954 / 104.
- **Rookie season only:** Flagg and Bailey each had a 2026-27 Season Tip-Off edition (199 + Hexwave 25 + Jukebox 10 = 234 each, 468 in total, many still in packs). Removed. 2026 Playoff Premieres and 2026 NBA Finals are Series 2025-26 and stay.
- **Cohort:** no player in the 2025-26 Rookie Debut set outside `topshot_2025_rookie_players` ranks in the top 12.
- **Sales ledger vs Atlas, last 30 / 90 days:** equal for all 11 players, except Flagg −3 sales (−$1.7K) and Coward −1 (−$33) at 90 days. Ranking unaffected.
- **Teams:** Atlas `CurrentTeam` = the team shown for all ten.
- **Not a gap:** Atlas `atlas_set_refresh_state.total_count` is 30 for sets 241 and 260 while RPC holds 15 each — Atlas's `setId` filter matches by set name ("Signature Series"), so 30 = 15 + 15. RPC has all 30.

## Drafts Trevor rejected (do not repeat)

- The first version counted every Moment of the ten players (17,462), including Flagg's and Bailey's 2026-27 Season Tip-Off — "These should only be for their rookie season".
