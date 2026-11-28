# 2026-11-27 (Fri) — draft: what the 2026 rookie year-end lines cost today

**Draft only. Trevor posts.** Not on the calendar: kept in `docs/social/post-ideas.md` for the calendar revamp (Trevor, 11-27).

The numbers come from the "Year-end cut lines today" strip that went live on every 2026 rookie's Top Shot player page on 11-27 (`lib/topshot/rookie-cut-lines.ts`). Read live 11-27 at about 4:15 PM PT:

```sql
select p.player_name, t.* from topshot_2026_rookie_players p,
  lateral get_topshot_player_rank_thresholds(p.player_name) t
where t.rank_cutoff in (3, 26)
```

The six rookies below are the ones with the highest #26 line. All six teams have a hashtag Trevor confirmed (`TEAM_HASHTAG` in `scripts/social/x-draft.mjs`).

## Main post (image or text-only; no link)

```
What it takes to make a 2026 rookie's top 26 on @NBATopShot today, the Rookie Yearbook line 📈

1. Cameron Boozer — 3 Moments · $312 #GrindCity
2. AJ Dybantsa — 3 Moments · $302 #ForTheDistrict
3. Darius Acuff Jr. — 2 Moments · $274 #LightTheBeam
4. Yaxel Lendeborg — 3 Moments · $240 #DubNation
5. Caleb Wilson — 3 Moments · $237 #SeeRed
6. Darryn Peterson — 3 Moments · $225 #TakeNote

Top 3 (Blue Chip, All-Rookie players only): Peterson $1,531 · Dybantsa $1,140 · Wilson $1,128 · Boozer $1,003 · Lendeborg $791 · Acuff $782
```

## 2/2 reply

```
Every 2026 rookie's lines, updated daily 👇 https://www.rippackscity.com/nba-top-shot/player/cameron-boozer?utm_source=x&utm_medium=social&utm_campaign=cutlines_1127

Top Shot ranks by locked Top Shot Score. These count every Moment held, at RPC value, so treat them as a guide.
```

## Facts to know before posting

- "N Moments · $X" is what the 26th (or 3rd) collector of that player holds today. Moment counts do not rise with the cut: the board is ranked by value, so the #3 collector can hold fewer Moments than #26 (Bogoljub Markovic: 1 Moment at #3, 4 at #26).
- Collectors per player range from 153 (Meleek Thomas) to 230 (Bryce Hopkins). Every 2026 rookie has passed 26 collectors, so no #26 line is open.
- The Boozer page (the link above) returned 200 and rendered the strip on 11-27.
- The numbers move daily. Re-run the query on the day of posting.

## House rules

No collector named or tagged, official collection account only, no FMV confidence, dollars only, no buy advice.
