# @RipPacksCity post ideas — not on the calendar

Ideas Trevor wants kept for the calendar revamp. Nothing here is scheduled. When one gets a slot, move it into `x-calendar.md` with its format and delete it here.

House rules still apply to every idea: no collector named or tagged without consent, official collection accounts only, team hashtags only from `TEAM_HASHTAG`, no FMV confidence, dollars only, no buy advice.

## Ideas

### Whale Watch launch (added 11-27)

- **What:** announce /insights/whales: the collectors behind each collection's biggest sales, what they spent this week and month, and their latest big buys.
- **Data:** `whale_watch_board` (refreshed hourly); the share card at `/api/og/insights/whales` is the image.
- **Caveats to carry:** totals only, no collector named (house rule). Don't headline the single biggest Panini buy; the top Panini accounts trade big cards back and forth.
- **First draft:** `docs/social/posts/2026-11-27/whale-watch-launch-draft.md` (not posted). Re-read the numbers on the day.

### 2026 rookie year-end cut lines (added 11-27)

- **What:** what it takes today to make a 2026 rookie's top 26 (Rookie Yearbook) and top 3 (Blue Chip, All-Rookie players only) on Top Shot. One line per rookie: Moments held and RPC value at that rank.
- **Why now:** Top Shot's 2026-27 rookie leaderboards lock one week after the All-Rookie teams are named, so the lines matter more as the season goes on. It could run weekly until then.
- **Data:** `get_topshot_player_rank_thresholds(player_name)` for each `topshot_2026_rookie_players` row; the same numbers are in the "Year-end cut lines today" strip on each rookie's player page.
- **Caveat to carry:** Top Shot ranks by locked Top Shot Score; these count every Moment held at RPC value, so they are a guide.
- **First draft:** `docs/social/posts/2026-11-27/cut-lines-draft.md` (not posted). Re-run the query on the day; the numbers move daily.
