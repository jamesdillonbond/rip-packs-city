# Badge Audit — RPC vs live NBA Top Shot (v2.nbatopshot.com)

**Wallet:** `0xbd94cade097e50ac` — jamesdillonbond (tdillonbond@gmail.com)
**Date:** 2026-07-10
**Scope:** top **150** NBA Top Shot moments by RPC FMV → **130** distinct editions.

**RPC badge source:** `get_edition_badges_unified()` — exactly what renders on RPC edition/moment pages.
**Top Shot source:** the **Badges region** on each live `https://v2.nbatopshot.com/moment/<id>` page (composited client-side from `getMintedMoment` play/setPlay tags). Every discrepancy below was individually opened and read on its live v2 moment page; the model was validated against the badge chip labels **and** the SVG/PNG icon files v2 serves.

> Badges are an **edition-level** property, so a discrepancy on an edition applies to every serial Trevor owns in it. Each class table lists the specific affected moment(s) — serial number links to the live v2 page, followed by the on-chain NFT id.

## Bottom line

**43 of 130 editions** disagree, covering **44 of the 150 moments**. They fall into **5 classes** — only two are true data errors; the other three are systematic display-rule differences in RPC's `get_edition_badges_unified()`.

| # | Class | Editions | Moments | Nature |
|---|---|---:|---:|---|
| A | RPC hides **Challenge Reward** that v2 shows | 35 | 35 | **Systematic RPC bug** — the `challengereward` suppression in `get_edition_badges_unified` is wrong; v2 badges it (icon `challengeReward.svg`) |
| B | RPC shows **"Codename: Mercury"**, v2 shows **"Leaderboard Reward"** | 3 | 3 | **Stale title** — same badge (v2's chip still loads `codenameMercury.svg`); RPC kept the pre-release codename |
| C | RPC shows generic **"Rookie / Rookie Revelation"**, v2 shows real **Rookie Year + Rookie Mint** | 3 | 4 | **Data error** — `badge_editions` never synced for set 243; RPC fell back to set-name derivation |
| D | **Three-Star Rookie** composite mismatch | 1 | 1 | RPC's 3-star rule needs Top Shot Debut; v2's needs Rookie Mint. Same moment, different rendering |
| E | RPC shows **"Playoffs"** that v2 doesn't badge | 1 | 1 | **Over-badge** — RPC derived "Playoffs" from the set name; v2 shows no badge |

---

## Class A — RPC hides "Challenge Reward" (35 editions, 35 moments)

`get_edition_badges_unified` ends with `AND norm_key <> 'challengereward'` (comment: *"TopShot does not badge 'Challenge Reward' on the moment page"*). **That premise is false on v2** — every one of these moment pages renders a "Challenge Reward" badge (verified live on Damian Lillard, SGA, Caitlin Clark, Jimmy Butler, LaMelo; icon `challengeReward.svg`). This is the single largest source of drift. **Fix:** drop that suppression line.

| Edition | Player | Set | FMV | Affected moment(s) — serial / nft | RPC shows | v2 shows |
|---|---|---|---:|---|---|---|
| `121:4255` | Damian Lillard | Run It Back: Legacies 2014-19 | $975 | [#5](https://v2.nbatopshot.com/moment/43604624) `43604624` | — | Challenge Reward |
| `134:5039` | Victor Wembanyama | Metallic Gold LE | $974.8 | [#127](https://v2.nbatopshot.com/moment/46802027) `46802027` | Rookie of the Year, Rookie Year, Rookie Mint | Rookie Year, Rookie of the Year, Rookie Mint, Challenge Reward |
| `169:6630` | Jalen Williams | Holo Icon | $764.1 | [#11](https://v2.nbatopshot.com/moment/49312738) `49312738` | Championship Year | Championship Year, Challenge Reward |
| `148:5637` | Caitlin Clark | WNBA Metallic Gold LE 2024 | $439.2 | [#39](https://v2.nbatopshot.com/moment/47300339) `47300339` | Rookie of the Year, Rookie Year, Rookie Mint | Rookie Year, Rookie of the Year, Rookie Mint, Challenge Reward |
| `166:6772` | Shai Gilgeous-Alexander | Metallic Gold LE | $420 | [#14](https://v2.nbatopshot.com/moment/49471536) `49471536` | Championship Year, MVP Year | Championship Year, MVP Year, Challenge Reward |
| `106:3802` | Jabari Smith Jr. | Rookie Revelation | $340 | [#6](https://v2.nbatopshot.com/moment/42447552) `42447552` | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint, Challenge Reward |
| `172:6767` | LeBron James | Throwdowns | $201 | [#90](https://v2.nbatopshot.com/moment/49471817) `49471817` | — | Challenge Reward |
| `212:7283` | Walt Frazier | Run It Back: 1970s | $199.5 | [#102](https://v2.nbatopshot.com/moment/50247478) `50247478` | Championship Year, Top Shot Debut | Top Shot Debut, Championship Year, Challenge Reward |
| `183:6634` | Josh Hart | Ascension | $186.7 | [#24](https://v2.nbatopshot.com/moment/49318577) `49318577` | — | Challenge Reward |
| `205:7136` | Patrick Ewing | Run It Back: Phantom Threads | $183.15 | [#41](https://v2.nbatopshot.com/moment/50158181) `50158181` | — | Challenge Reward |
| `205:7137` | Dominique Wilkins | Run It Back: Phantom Threads | $178.5 | [#63](https://v2.nbatopshot.com/moment/50157805) `50157805` | — | Challenge Reward |
| `173:6770` | Victor Wembanyama | Denied! | $160.65 | [#78](https://v2.nbatopshot.com/moment/49471458) `49471458` | — | Challenge Reward |
| `166:6310` | Stephon Castle | Metallic Gold LE | $154 | [#13](https://v2.nbatopshot.com/moment/48752897) `48752897` | Rookie of the Year, Rookie Year, Rookie Mint | Rookie Year, Rookie of the Year, Rookie Mint, Challenge Reward |
| `201:7039` | Kyrie Irving | Run It Back: Origins | $150 | [#134](https://v2.nbatopshot.com/moment/49944973) `49944973` | Rookie of the Year, Rookie Year | Rookie Year, Rookie of the Year, Challenge Reward |
| `216:7356` | Dell Curry | Run It Back: Family Business | $118.25 | [#76](https://v2.nbatopshot.com/moment/50252389) `50252389` | — | Challenge Reward |
| `201:7040` | Jalen Brunson | Run It Back: Origins | $115 | [#35](https://v2.nbatopshot.com/moment/49945117) `49945117` | Rookie Premiere, Rookie Year | Rookie Year, Rookie Premiere, Challenge Reward |
| `148:5348` | Angel Reese | WNBA Metallic Gold LE 2024 | $110.11 | [#126](https://v2.nbatopshot.com/moment/47048843) `47048843` | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint, Challenge Reward |
| `159:5467` | David Robinson | Run It Back | $105 | [#28](https://v2.nbatopshot.com/moment/47412100) `47412100` | Top Shot Debut | Top Shot Debut, Challenge Reward |
| `166:6035` | Giannis Antetokounmpo | Metallic Gold LE | $97.7 | [#49](https://v2.nbatopshot.com/moment/48143834) `48143834` | — | Challenge Reward |
| `32:1203` | LaMelo Ball | Cool Cats | $94 | [#874](https://v2.nbatopshot.com/moment/14677418) `14677418` | Rookie of the Year, Rookie Year, Rookie Mint | Rookie Year, Rookie of the Year, Rookie Mint, Challenge Reward |
| `201:7042` | Allen Iverson | Run It Back: Origins | $91.6 | [#126](https://v2.nbatopshot.com/moment/49996590) `49996590` | Rookie of the Year, Rookie Year | Rookie Year, Rookie of the Year, Challenge Reward |
| `170:6769` | Trae Young | For The Win | $89.17 | [#14](https://v2.nbatopshot.com/moment/49471253) `49471253` | — | Challenge Reward |
| `21:272` | Jimmy Butler | The Finals | $89.09 | [#251](https://v2.nbatopshot.com/moment/642740) `642740` | — | Challenge Reward |
| `167:6508` | Shaedon Sharpe | Metallic Silver | $87.3 | [#44](https://v2.nbatopshot.com/moment/49103837) `49103837` | — | Challenge Reward |
| `205:7138` | Hakeem Olajuwon | Run It Back: Phantom Threads | $86 | [#21](https://v2.nbatopshot.com/moment/50162834) `50162834` | — | Challenge Reward |
| `157:5583` | Derrick Rose | Run It Back: Origins | $84.15 | [#102](https://v2.nbatopshot.com/moment/47388057) `47388057` | Rookie of the Year, Rookie Year | Rookie Year, Rookie of the Year, Challenge Reward |
| `157:5569` | Vince Carter | Run It Back: Origins | $83.75 | [#158](https://v2.nbatopshot.com/moment/47387844) `47387844` | Rookie of the Year, Rookie Year | Rookie Year, Rookie of the Year, Challenge Reward |
| `35:825` | Anthony Edwards | Rising Stars | $83.67 | [#689](https://v2.nbatopshot.com/moment/7599018) `7599018` | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint, Challenge Reward |
| `167:5812` | Victor Wembanyama | Metallic Silver | $82.67 | [#188](https://v2.nbatopshot.com/moment/47492387) `47492387` | — | Challenge Reward |
| `166:5978` | Victor Wembanyama | Metallic Gold LE | $79.86 | [#44](https://v2.nbatopshot.com/moment/48060654) `48060654` | — | Challenge Reward |
| `134:4643` | Chet Holmgren | Metallic Gold LE | $79.67 | [#92](https://v2.nbatopshot.com/moment/45473224) `45473224` | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint, Challenge Reward |
| `205:7135` | Dennis Rodman | Run It Back: Phantom Threads | $77.66 | [#28](https://v2.nbatopshot.com/moment/50157966) `50157966` | — | Challenge Reward |
| `148:5633` | Kamilla Cardoso | WNBA Metallic Gold LE 2024 | $73.63 | [#106](https://v2.nbatopshot.com/moment/47297582) `47297582` | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint, Challenge Reward |
| `180:6631` | Sam Hauser | Breakout | $71 | [#97](https://v2.nbatopshot.com/moment/49318501) `49318501` | — | Challenge Reward |
| `157:5466` | Anfernee Hardaway | Run It Back: Origins | $71 | [#101](https://v2.nbatopshot.com/moment/47412401) `47412401` | Rookie Year, Top Shot Debut | Rookie Year, Top Shot Debut, Challenge Reward |

## Class B — "Codename: Mercury" → v2's "Leaderboard Reward" (3 editions, 3 moments)

RPC's `badge_editions` stored the raw GraphQL tag title `Codename: Mercury`; v2 displays the same badge as **"Leaderboard Reward"** (its chip still loads `static/momentTags/static/codenameMercury.svg` — confirmed on all 3). RPC is showing a stale pre-release codename. **Fix:** remap the title on ingest/display.

| Edition | Player | Set | FMV | Affected moment(s) — serial / nft | RPC shows | v2 shows |
|---|---|---|---:|---|---|---|
| `149:5370` | Victor Wembanyama | 2023-24 Honors | $430.88 | [#17](https://v2.nbatopshot.com/moment/47038246) `47038246` | Rookie of the Year, Rookie Year, Codename: Mercury, Rookie Mint | Rookie Year, Rookie of the Year, Rookie Mint, Leaderboard Reward |
| `118:4153` | Team Moment | 2022-23 Season Rewind | $109.45 | [#33](https://v2.nbatopshot.com/moment/43434744) `43434744` | Codename: Mercury | Leaderboard Reward |
| `149:5388` | Chet Holmgren | 2023-24 Honors | $93 | [#55](https://v2.nbatopshot.com/moment/47042134) `47042134` | Rookie Year, Codename: Mercury, Rookie Mint | Rookie Year, Rookie Mint, Leaderboard Reward |

## Class C — RPC set-name fallback instead of real rookie badges (3 editions, 4 moments) — genuine data gap

These "Rookie Revelation" editions (set 243) have **no `badge_editions` row** (never swept), so `get_edition_badges_unified` fell through to `derive_badges_from_set_name()`, emitting generic **"Rookie" + "Rookie Revelation"**. v2 shows the true synced badges **Rookie Year + Rookie Mint** (icons `rookieYear.svg` / `rookieMint.svg`, confirmed live). **Fix:** run the badge sweep for set 243 (and any recent Rookie Revelation set).

| Edition | Player | Set | FMV | Affected moment(s) — serial / nft | RPC shows | v2 shows |
|---|---|---|---:|---|---|---|
| `243:8276::21` | Caleb Love | Rookie Revelation | $250 | [#2](https://v2.nbatopshot.com/moment/51492984) `51492984` | Rookie, Rookie Revelation | Rookie Year, Rookie Mint |
| `243:8276` | Caleb Love | Rookie Revelation | $158.33 | [#5](https://v2.nbatopshot.com/moment/51492625) `51492625`<br>[#28](https://v2.nbatopshot.com/moment/51492648) `51492648` | Rookie, Rookie Revelation | Rookie Year, Rookie Mint |
| `243:8268` | Sion James | Rookie Revelation | $119.75 | [#8](https://v2.nbatopshot.com/moment/51493228) `51493228` | Rookie, Rookie Revelation | Rookie Year, Rookie Mint |

## Class D — Three-Star Rookie composite definition mismatch (1 edition, 1 moment)

v2 collapses **Rookie Year + Rookie Mint + Rookie Premiere** into one "Three-Star Rookie" badge (Top Shot Debut **not** required). RPC's `is_three_star_rookie` requires **Rookie Year + Rookie Premiere + Top Shot Debut** instead — so on a rookie that has the Mint but no Debut, RPC shows the three components while v2 shows the single composite. Same underlying qualification, different chip. **Fix:** align RPC's 3-star rule to Year+Mint+Premiere.

| Edition | Player | Set | FMV | Affected moment(s) — serial / nft | RPC shows | v2 shows |
|---|---|---|---:|---|---|---|
| `176:7003` | Donovan Clingan | 2024 Rookie Ultimates | $2100 | [#1](https://v2.nbatopshot.com/moment/49744949) `49744949` | Rookie Premiere, Rookie Year, Rookie Mint | Three-Star Rookie |

## Class E — RPC over-badges "Playoffs" (1 edition, 1 moment)

RPC derived a **"Playoffs"** badge from the set name "2025 NBA Playoffs: Legendary" (`derive_badges_from_set_name`). The play carries no badge tag and **v2 renders no badge** on this moment (no Badges region at all — confirmed live). **Fix:** don't derive "Playoffs" from set name.

| Edition | Player | Set | FMV | Affected moment(s) — serial / nft | RPC shows | v2 shows |
|---|---|---|---:|---|---|---|
| `187:6766` | Aaron Nesmith | 2025 NBA Playoffs: Legendary | $83 | [#29](https://v2.nbatopshot.com/moment/49471143) `49471143` | Playoffs | — |

---

## Full comparison — all 130 editions (FMV desc)

`Δ` = disagreement (class letter). RPC = `get_edition_badges_unified`; v2 = live Badges region.

| Edition | Player | Set | FMV | Ser | Δ | RPC shows | v2 shows |
|---|---|---|---:|---:|:-:|---|---|
| `176:7003` | Donovan Clingan | 2024 Rookie Ultimates | $2100 | 1 | **D** | Rookie Premiere, Rookie Year, Rookie Mint | Three-Star Rookie |
| `100:3345` | LeBron James | The Anthology: LeBron James | $2016.67 | 1 | · | — | — |
| `5:133` | LeBron James | Metallic Gold LE | $1955 | 1 | · | Championship Year, Top Shot Debut | Top Shot Debut, Championship Year |
| `165:6563` | Kevin Durant | Supernova | $1750 | 1 | · | Rookie of the Year, Rookie Premiere, Rookie Year | Rookie Year, Rookie Premiere, Rookie of the Year |
| `121:4255` | Damian Lillard | Run It Back: Legacies 2014-19 | $975 | 1 | **A** | — | Challenge Reward |
| `134:5039` | Victor Wembanyama | Metallic Gold LE | $974.8 | 1 | **A** | Rookie of the Year, Rookie Year, Rookie Mint | Rookie Year, Rookie of the Year, Rookie Mint, Challenge Reward |
| `2:133` | LeBron James | Base Set | $867 | 1 | · | Championship Year, Top Shot Debut | Top Shot Debut, Championship Year |
| `230:7975` | Deni Avdija | Kingmaker | $800 | 1 | · | — | — |
| `169:6630` | Jalen Williams | Holo Icon | $764.1 | 1 | **A** | Championship Year | Championship Year, Challenge Reward |
| `4:127` | Zion Williamson | Holo MMXX | $725.5 | 1 | · | Rookie Year, Top Shot Debut, Rookie Mint | Rookie Year, Top Shot Debut, Rookie Mint |
| `4:82` | James Harden | Holo MMXX | $625 | 1 | · | Top Shot Debut | Top Shot Debut |
| `185:6531` | Stephon Castle | Rookie Revelation | $594.67 | 1 | · | Rookie of the Year, Rookie Year, Rookie Mint | Rookie Year, Rookie of the Year, Rookie Mint |
| `109:5299` | Kevin Durant | The Anthology: Kevin Durant | $442.29 | 1 | · | Rookie of the Year, Rookie Year | Rookie Year, Rookie of the Year |
| `103:3775` | Steph Curry | Top Shot 50 | $439.2 | 2 | · | — | — |
| `148:5637` | Caitlin Clark | WNBA Metallic Gold LE 2024 | $439.2 | 1 | **A** | Rookie of the Year, Rookie Year, Rookie Mint | Rookie Year, Rookie of the Year, Rookie Mint, Challenge Reward |
| `149:5370` | Victor Wembanyama | 2023-24 Honors | $430.88 | 1 | **B** | Rookie of the Year, Rookie Year, Codename: Mercury, Rookie Mint | Rookie Year, Rookie of the Year, Rookie Mint, Leaderboard Reward |
| `8:145` | Damian Lillard | Cosmic | $425 | 2 | · | Top Shot Debut | Top Shot Debut |
| `166:6772` | Shai Gilgeous-Alexander | Metallic Gold LE | $420 | 1 | **A** | Championship Year, MVP Year | Championship Year, MVP Year, Challenge Reward |
| `16:210` | LeBron James | First Round | $377.5 | 1 | · | Championship Year | Championship Year |
| `238:8028` | Dylan Harper | Freshman Gems | $371.75 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `131:5124` | Anthony Davis | Holo Icon | $350.5 | 1 | · | — | — |
| `106:3802` | Jabari Smith Jr. | Rookie Revelation | $340 | 1 | **A** | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint, Challenge Reward |
| `2:147` | Steph Curry | Base Set | $339.86 | 1 | · | Top Shot Debut | Top Shot Debut |
| `4:12` | Domantas Sabonis | Holo MMXX | $299.7 | 1 | · | Top Shot Debut | Top Shot Debut |
| `211:7876` | Billy Cunningham | Heroes of the Game | $287 | 1 | · | Top Shot Debut | Top Shot Debut |
| `139:4962` | Scoot Henderson | Rookie Revelation | $270 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `243:8276::21` | Caleb Love | Rookie Revelation | $250 | 1 | **C** | Rookie, Rookie Revelation | Rookie Year, Rookie Mint |
| `4:76` | Andre Drummond | Holo MMXX | $243 | 2 | · | Top Shot Debut | Top Shot Debut |
| `5:62` | Giannis Antetokounmpo | Metallic Gold LE | $233.75 | 1 | · | MVP Year, Top Shot Debut | Top Shot Debut, MVP Year |
| `185:6539` | Kyshawn George | Rookie Revelation | $225 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `4:67` | Bradley Beal | Holo MMXX | $224.1 | 1 | · | Top Shot Debut | Top Shot Debut |
| `219:7408` | Cooper Flagg | Rookie Debut | $219.09 | 1 | · | Three-Star Rookie, Rookie of the Year, Top Shot Debut | Three-Star Rookie, Top Shot Debut, Rookie of the Year |
| `139:4957` | Cam Whitmore | Rookie Revelation | $207.5 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `233:7726` | Kon Knueppel | Metallic Gold LE | $204 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `125:4340` | Victor Wembanyama | Rookie Debut6 | $202.98 | 3 | · | Three-Star Rookie, Rookie of the Year, Top Shot Debut | Three-Star Rookie, Top Shot Debut, Rookie of the Year |
| `172:6767` | LeBron James | Throwdowns | $201 | 1 | **A** | — | Challenge Reward |
| `144:5259` | Caitlin Clark | WNBA Rookie Debut 2024 | $200.27 | 1 | · | Three-Star Rookie, Rookie of the Year, Top Shot Debut | Three-Star Rookie, Top Shot Debut, Rookie of the Year |
| `212:7283` | Walt Frazier | Run It Back: 1970s | $199.5 | 1 | **A** | Championship Year, Top Shot Debut | Top Shot Debut, Championship Year, Challenge Reward |
| `2:151` | LeBron James | Base Set | $196 | 1 | · | Championship Year | Championship Year |
| `223:7518` | VJ Edgecombe | Origins | $191.86 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `183:6634` | Josh Hart | Ascension | $186.7 | 1 | **A** | — | Challenge Reward |
| `205:7136` | Patrick Ewing | Run It Back: Phantom Threads | $183.15 | 1 | **A** | — | Challenge Reward |
| `205:7137` | Dominique Wilkins | Run It Back: Phantom Threads | $178.5 | 1 | **A** | — | Challenge Reward |
| `185:6510` | Zaccharie Risacher | Rookie Revelation | $170.1 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `185:6519` | Kel'el Ware | Rookie Revelation | $169.2 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `185:6518` | Zach Edey | Rookie Revelation | $163.5 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `173:6770` | Victor Wembanyama | Denied! | $160.65 | 1 | **A** | — | Challenge Reward |
| `243:8276` | Caleb Love | Rookie Revelation | $158.33 | 2 | **C** | Rookie, Rookie Revelation | Rookie Year, Rookie Mint |
| `2:136` | Luka Dončić | Base Set | $155.71 | 1 | · | Top Shot Debut | Top Shot Debut |
| `131:4868` | Damian Lillard | Holo Icon | $155.5 | 2 | · | — | — |
| `166:6310` | Stephon Castle | Metallic Gold LE | $154 | 1 | **A** | Rookie of the Year, Rookie Year, Rookie Mint | Rookie Year, Rookie of the Year, Rookie Mint, Challenge Reward |
| `185:6537` | Alex Sarr | Rookie Revelation | $150.5 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `201:7039` | Kyrie Irving | Run It Back: Origins | $150 | 1 | **A** | Rookie of the Year, Rookie Year | Rookie Year, Rookie of the Year, Challenge Reward |
| `185:6524` | Ajay Mitchell | Rookie Revelation | $144.5 | 1 | · | Championship Year, Rookie Year, Rookie Mint | Rookie Year, Championship Year, Rookie Mint |
| `2:37` | Nikola Jokić | Base Set | $141.78 | 1 | · | Top Shot Debut | Top Shot Debut |
| `4:115` | Deandre Ayton | Holo MMXX | $140 | 2 | · | Top Shot Debut | Top Shot Debut |
| `185:6530` | Donovan Clingan | Rookie Revelation | $133 | 2 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `185:6512` | Matas Buzelis | Rookie Revelation | $132 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `223:7504` | Kon Knueppel | Origins | $129.4 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `243:8268` | Sion James | Rookie Revelation | $119.75 | 1 | **C** | Rookie, Rookie Revelation | Rookie Year, Rookie Mint |
| `160:5586` | Brandon Roy | Run It Back: Legacies | $118.43 | 2 | · | Top Shot Debut | Top Shot Debut |
| `216:7356` | Dell Curry | Run It Back: Family Business | $118.25 | 1 | **A** | — | Challenge Reward |
| `185:6527` | Jared McCain | Rookie Revelation | $117 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `2:63` | Shai Gilgeous-Alexander | Base Set | $115.1 | 1 | · | Top Shot Debut | Top Shot Debut |
| `201:7040` | Jalen Brunson | Run It Back: Origins | $115 | 1 | **A** | Rookie Premiere, Rookie Year | Rookie Year, Rookie Premiere, Challenge Reward |
| `106:3810` | Shaedon Sharpe | Rookie Revelation | $115 | 3 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `185:6515` | Reed Sheppard | Rookie Revelation | $115 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `135:4718` | Chet Holmgren | Freshman Gems | $112.5 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `148:5348` | Angel Reese | WNBA Metallic Gold LE 2024 | $110.11 | 1 | **A** | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint, Challenge Reward |
| `53:2067` | Miles Bridges | Holo Icon | $110 | 1 | · | — | — |
| `118:4153` | Team Moment | 2022-23 Season Rewind | $109.45 | 1 | **B** | Codename: Mercury | Leaderboard Reward |
| `159:5467` | David Robinson | Run It Back | $105 | 1 | **A** | Top Shot Debut | Top Shot Debut, Challenge Reward |
| `139:4958` | Jaime Jaquez Jr. | Rookie Revelation | $103.5 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `4:4` | John Collins | Holo MMXX | $103.12 | 1 | · | Top Shot Debut | Top Shot Debut |
| `106:3805` | Bennedict Mathurin | Rookie Revelation | $100 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `4:142` | Victor Oladipo | Holo MMXX | $97.75 | 1 | · | Top Shot Debut | Top Shot Debut |
| `166:6035` | Giannis Antetokounmpo | Metallic Gold LE | $97.7 | 1 | **A** | — | Challenge Reward |
| `219:7421` | Dylan Harper | Rookie Debut | $96.65 | 1 | · | Three-Star Rookie, Top Shot Debut | Three-Star Rookie, Top Shot Debut |
| `28:1331` | CJ McCollum | Holo Icon | $95 | 1 | · | — | — |
| `32:1203` | LaMelo Ball | Cool Cats | $94 | 1 | **A** | Rookie of the Year, Rookie Year, Rookie Mint | Rookie Year, Rookie of the Year, Rookie Mint, Challenge Reward |
| `149:5388` | Chet Holmgren | 2023-24 Honors | $93 | 1 | **B** | Rookie Year, Codename: Mercury, Rookie Mint | Rookie Year, Rookie Mint, Leaderboard Reward |
| `147:5334` | Dereck Lively II | 2024 NBA Finals | $92 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `201:7042` | Allen Iverson | Run It Back: Origins | $91.6 | 1 | **A** | Rookie of the Year, Rookie Year | Rookie Year, Rookie of the Year, Challenge Reward |
| `106:3808` | Ousmane Dieng | Rookie Revelation | $90 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `170:6769` | Trae Young | For The Win | $89.17 | 1 | **A** | — | Challenge Reward |
| `103:3792` | Jerami Grant | Top Shot 50 | $89.1 | 2 | · | — | — |
| `216:7353` | Bill Walton | Run It Back: Family Business | $89.1 | 1 | · | Championship Year, Top Shot Debut | Top Shot Debut, Championship Year |
| `21:272` | Jimmy Butler | The Finals | $89.09 | 1 | **A** | — | Challenge Reward |
| `29:435` | James Harden | Metallic Gold LE | $89 | 1 | · | — | — |
| `185:6533` | Jamal Shead | Rookie Revelation | $88.5 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `219:7404` | Kon Knueppel | Rookie Debut | $88.4 | 1 | · | Three-Star Rookie, Top Shot Debut | Three-Star Rookie, Top Shot Debut |
| `53:2025` | Brandon Ingram | Holo Icon | $88.2 | 1 | · | — | — |
| `185:6528` | Justin Edwards | Rookie Revelation | $87.64 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `167:6508` | Shaedon Sharpe | Metallic Silver | $87.3 | 1 | **A** | — | Challenge Reward |
| `185:6521` | Terrence Shannon Jr. | Rookie Revelation | $87.3 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `2:62` | Giannis Antetokounmpo | Base Set | $86.9 | 1 | · | MVP Year, Top Shot Debut | Top Shot Debut, MVP Year |
| `205:7138` | Hakeem Olajuwon | Run It Back: Phantom Threads | $86 | 1 | **A** | — | Challenge Reward |
| `135:4700` | Brandon Miller | Freshman Gems | $85.5 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `114:4164` | Steph Curry | The Anthology: Steph Curry | $84.83 | 1 | · | Championship Year, MVP Year | Championship Year, MVP Year |
| `157:5583` | Derrick Rose | Run It Back: Origins | $84.15 | 1 | **A** | Rookie of the Year, Rookie Year | Rookie Year, Rookie of the Year, Challenge Reward |
| `157:5569` | Vince Carter | Run It Back: Origins | $83.75 | 1 | **A** | Rookie of the Year, Rookie Year | Rookie Year, Rookie of the Year, Challenge Reward |
| `35:825` | Anthony Edwards | Rising Stars | $83.67 | 1 | **A** | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint, Challenge Reward |
| `187:6766` | Aaron Nesmith | 2025 NBA Playoffs: Legendary | $83 | 1 | **E** | Playoffs | — |
| `53:2698` | Jusuf Nurkić | Holo Icon | $82.8 | 3 | · | — | — |
| `167:5812` | Victor Wembanyama | Metallic Silver | $82.67 | 1 | **A** | — | Challenge Reward |
| `103:3540` | Damian Lillard | Top Shot 50 | $82.5 | 3 | · | — | — |
| `28:610` | Carmelo Anthony | Holo Icon | $81.95 | 1 | · | — | — |
| `166:5978` | Victor Wembanyama | Metallic Gold LE | $79.86 | 1 | **A** | — | Challenge Reward |
| `134:4643` | Chet Holmgren | Metallic Gold LE | $79.67 | 1 | **A** | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint, Challenge Reward |
| `196:6959` | Stephon Castle | 2024-25 Honors | $79.67 | 1 | · | Rookie of the Year, Rookie Year, Rookie Mint | Rookie Year, Rookie of the Year, Rookie Mint |
| `185:6526` | Adem Bona | Rookie Revelation | $79.34 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `205:7135` | Dennis Rodman | Run It Back: Phantom Threads | $77.66 | 1 | **A** | — | Challenge Reward |
| `205:7128` | Gary Payton | Run It Back: Phantom Threads | $77 | 1 | · | — | — |
| `185:6514` | Quinten Post | Rookie Revelation | $76.5 | 2 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `185:6532` | Ja'Kobe Walter | Rookie Revelation | $76 | 2 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `29:1339` | LaMelo Ball | Metallic Gold LE | $74.6 | 1 | · | Rookie of the Year, Rookie Year, Rookie Mint | Rookie Year, Rookie of the Year, Rookie Mint |
| `148:5633` | Kamilla Cardoso | WNBA Metallic Gold LE 2024 | $73.63 | 1 | **A** | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint, Challenge Reward |
| `2:111` | Jayson Tatum | Base Set | $73.38 | 1 | · | Top Shot Debut | Top Shot Debut |
| `185:6538` | Carlton Carrington | Rookie Revelation | $72.9 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `231:8306` | DeMar DeRozan | Holo Icon | $72.25 | 1 | · | — | — |
| `26:404` | Anthony Edwards | Base Set | $71.73 | 2 | · | Three-Star Rookie, Top Shot Debut | Three-Star Rookie, Top Shot Debut |
| `212:7277` | Moses Malone | Run It Back: 1970s | $71.6 | 1 | · | MVP Year, Top Shot Debut | Top Shot Debut, MVP Year |
| `185:6536` | Kyle Filipowski | Rookie Revelation | $71.5 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `185:6513` | Ron Holland II | Rookie Revelation | $71.1 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `180:6631` | Sam Hauser | Breakout | $71 | 1 | **A** | — | Challenge Reward |
| `157:5466` | Anfernee Hardaway | Run It Back: Origins | $71 | 1 | **A** | Rookie Year, Top Shot Debut | Rookie Year, Top Shot Debut, Challenge Reward |
| `185:6534` | Jonathan Mogbo | Rookie Revelation | $70.2 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |
| `2:137` | Ja Morant | Base Set | $67.6 | 1 | · | Rookie of the Year, Rookie Year, Top Shot Debut, Rookie Mint | Rookie Year, Top Shot Debut, Rookie of the Year, Rookie Mint |
| `183:6488` | Payton Pritchard | Ascension | $67.5 | 2 | · | — | — |
| `28:1315` | Saddiq Bey | Holo Icon | $67.5 | 1 | · | Rookie Year, Rookie Mint | Rookie Year, Rookie Mint |

---

*Method note:* v2 badges were read live from each moment page's `region[aria-label="Badges"]` (rendered DOM = what is painted; the badge chips' `img alt` + icon asset URLs corroborate every label). Gameplay/skill tags (Dunk, Jump Shot, Score, Solo, Footwork, …) that ride along in `play.tags` are **not** badges on either surface and were excluded. Serial-level badges (SERIAL_NUMBER_ONE, PERFECT_MINT, JERSEY_MATCH) are out of scope — this audit is edition-wide badges only.
