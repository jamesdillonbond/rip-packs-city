# 2026-11-27 (Fri) — draft: Whale Watch launch (/insights/whales)

**Draft only. Trevor posts.** Not on the calendar: kept in `docs/social/post-ideas.md` for the calendar revamp (Trevor, 11-27).

Whale Watch went live 11-27 (`docs/operations/big-spender-watch.md`). It covers everyone who has bought one of a collection's 25 biggest sales in a month, what they spent this week and month, and their latest big buys, across every collection RPC tracks.

⛔ **House rule: no collector named or tagged without consent.** The page shows usernames (as /insights/top-sales already does); the post does not. Totals only.
⛔ **Don't headline the month's single biggest buy.** On 11-27 that was a $57,500 Panini card bought by an account that trades big cards back and forth with a few others. Lead with the weekly totals instead.

Numbers read 11-27 at about 6:00 PM PT from `whale_watch_board`. **Re-read on the day; the board refreshes hourly.**

```sql
select board->'tracked_wallets', board->'active_7d', board->'spend_7d_usd', board->'new_tracked_7d'
from whale_watch_board;
```

## Main post (image, no link)

Image: the board's share card, https://www.rippackscity.com/api/og/insights/whales (live numbers; save it as a PNG on the day).

```
🐋 Whale Watch is live on Rip Packs City.

Everyone who has bought one of the biggest sales on @NBATopShot, @NFLAllDay, @PaniniAmerica Blockchain, @CandyDigital and @DisneyPinnacle, and what they've spent since.

This week: 186 whales active, $139,707 spent.

Filter by collection, tap a name to see their collection, tap a buy to see the card.
```

Handles follow `docs/social/x-calendar.md`: official accounts only, and Panini always as "@PaniniAmerica Blockchain" (Trevor, 11-27). Golazos and UFC are left out because no whale bought there in the last 30 days.

## 2/2 reply

```
Who's spending big right now 👇 https://www.rippackscity.com/insights/whales?utm_source=x&utm_medium=social&utm_campaign=whales_launch
```
