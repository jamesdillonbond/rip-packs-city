# @RipPacksCity posts — Mon 2026-11-23

Drafted in one Cowork cloud thread (scheduled "RPC daily X draft" run at 8:14 AM PT, then live with Trevor through the evening). The image in this folder is the one posted.

## The week's top 10 sales — https://x.com/rippackscity/status/2125065405966537203

Image: `top-sales-top10.png` (10 cards, 5×2). Buyers on the image are **marketplace usernames**; X handles appear only in the post text (Trevor, 11-23).

```
This past week's top 10 sales, 11/16-11/23 📈

1. Erling Haaland, Base Mosaic Black #1/1 — $10,000 on @PaniniAmerica · bought by @spinotron
2. Trinity Rodman, Base Prizms Gold Vinyl #1/1 — $7,500 on @PaniniAmerica · bought by @spinotron
3. Olivia Miles, Base Prizms Gold Vinyl #1/1 — $5,000 on @PaniniAmerica · bought by @spinotron
4. Shohei Ohtani, BC 2021 Absolute Kaboom #31/219 — $2,250 on @PaniniAmerica · bought by KindCollector
5. Lionel Messi, Base Prizms Pink Mojo #5/25 — $2,010 on @PaniniAmerica · bought by SingaporeTexan
6. Shohei Ohtani, BC 2021 Absolute Kaboom #211/219 — $1,950 on @PaniniAmerica · bought by Phiwah
7. Shohei Ohtani, BC 2021 Absolute Kaboom #92/219 — $1,850 on @PaniniAmerica · bought by kdmaiden
8. Cooper Flagg, Rookie Revelation #3/29 — $1,800 on @NBATopShot · bought by @incog_eth #MFFL
9. Lionel Messi, Base Prizms Aguila #5/11 — $1,750 on @PaniniAmerica · bought by ragingharden
10. Shohei Ohtani, BC 2021 Absolute Kaboom #139/219 — $1,750 on @PaniniAmerica · bought by DASni

💰17 sales cleared $1,000 in the last 7 days.
```

2/2 reply:

```
Every sale on the board 👇
https://www.rippackscity.com/insights/top-sales?w=1123c
```

(`?w=1123` unfurled a blank grey card: X had cached the bare og:image URL. og:image now carries `?d=<PT date>` — `lib/og/card-day-key.ts`.)

### What changed between the 8:14 AM draft and the post
- **#1 and #2 were missing from the draft.** Neither card was catalogued, so `v_panini_top_sales` dropped both sales. Catalogued (`20261123164815`, `20261123165822`; identity confirmed on Panini's CDN art), and the board now reports what it drops (`v_panini_top_sales_uncatalogued` → `meta.uncatalogued` → x-draft warning).
- **Verified:** Flagg $1,800 on Flow (offer accepted, NFT 51493836 moved); Skenes 22.75 SOL on Solana (dropped to #12 once the two were restored). Panini sales checked for tx hash, distinct parties, no duplicates.
- **Handles confirmed:** Incog8 → @incog_eth, spinotron → @spinotron. **Hashtag confirmed:** Mavericks #MFFL. #RepTheHalo and #VamosArgentina showed no logo in the composer — not used.
