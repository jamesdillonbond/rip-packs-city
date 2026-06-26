# Panini Prizm World Cup 2026 — canonical product spec (seed reference)

DRAFT / not wired. Compiled 2026-06-25 from the Panini Blockchain blog + the community Pack Pull Tracker.
This is the structural ladder the ingest seeds against; the full player×edition matrix is enumerated at ingest
time from the feed (Plane A). Source of truth at go-live = the live feed, not this file.

RPC collection: `panini_blockchain` · UUID `d1a0a7f5-609a-49f4-a1a7-4eaac55b020b` · chain `ethereum` · `is_active=false`.
Platform: Panini Blockchain (`nft.paniniamerica.net`), product "2026 Panini Prizm FIFA World Cup", Soccer, 48 nations.

## Base parallel ladder (per player)

| Parallel | Cap (#/) | Rarity (sheet) | RPC tier_type (proposed) | In Hobby? |
|---|---|---|---|---|
| Base Prizms Silver | 259 | Uncommon | COMMON | yes (2/pack) |
| Base Prizms Red | 124 | Rare | RARE | yes |
| Base Prizms Blue | 49 | Ultra Rare | RARE | yes |
| Base Prizms Cracked Ice | 25 | Epic | LEGENDARY | yes |
| Base Prizms Gold | 10 | Epic | LEGENDARY | yes |
| Base Choice Prizms Zebra | 5 | Epic | LEGENDARY | yes |
| Base Prizms Black | 1/1 | Legendary | ULTIMATE | yes |

## FOTL-exclusive parallels (NOT in Hobby packs)

| Parallel | Cap | Rarity | Notes |
|---|---|---|---|
| Base Prizms Aguila | 11 | Epic | Mexico host parallel — Spanish-language back |
| Base Prizms Maple Leaf | 9 | Epic | Canada host parallel — French-language back |
| Base Prizms Old Glory | 7 | Epic | USA host parallel |
| Base Choice Prizms Nebula | 1/1 | Legendary | top FOTL chase |

## Inserts

Tiered inserts — Silver #/49, Gold #/10, Black 1/1:
Scorers Club · New Era · Connections · Aces · Phenomenon · Global Reach · Trophy Hunting · Screamers ·
National Landmarks · World Cup Posters · Team Badges.

Non-tiered inserts — #/25:
Color Blast · Color Blast Duals · Prizmania · Color Wheel · Manga · National Pride · Alter Ego.
(Tracker also shows National Landmarks parallels: base /49 Ultra Rare, Gold /10, Black 1/1.)

## Craft-pack + challenge-reward parallels (minted via events, not standard packs)

- Floral Craft Pack: Plum Blossom · Cherry Blossom · Lotus Flower (base parallels).
- Animal Print Craft Pack: Giraffe · Elephant (base parallels).
- Rainbow challenge rewards: Pink Wave · Rattlesnake · Genesis · Tiger Stripe. Plus base-variation challenge rewards.

## Pack definitions

| Pack | Count | Price | Cards | Slot structure |
|---|---|---|---|---|
| FOTL | 13,960 | $150 | 5 | 2× Base Silver (/259) + 1× non-Silver base parallel (max /124) + 1× non-Silver **or** 35% insert (max /49) + 1× FOTL-exclusive (Aguila/Maple Leaf/Old Glory/Nebula) |
| Hobby | 50,480 | $25 | 4 | 2× Base Silver + 1× non-Silver + 1× non-Silver **or** 35% insert |

## Chase-player tiers (from the tracker — the high-attention subset, not the full checklist)

- **Tier 1 APEX:** Messi, Lamine Yamal, Mbappé, Cristiano Ronaldo, Haaland, Estêvão, Michael Olise, Maradona, Zidane, Ronaldo (R9).
- **Tier 1 ELITE:** Bellingham, Vinícius Jr, Musiala, Kane, Wirtz, Pedri, Foden, Saka, Nico Williams, Endrick, Kenan Yıldız,
  Salah, João Neves, Arda Güler, Mastantuono, Gilberto Mora, Désiré Doué, Iniesta, Neymar, Platini, Rooney, Ibrahimović.

(Full set is 500 base cards across 48 nations — the ingest enumerates every player×parallel edition from the feed; these tiers
are a curated "chase" overlay for squeeze/EV ranking.)

## Derived metrics (definitions — the product differentiators)

- **cards_still_in_packs(edition)** = `mint_cap − pulled_count`, where `pulled_count` = the platform's per-edition circulation
  (cards opened out of packs into wallets). Decreases as packs are ripped → the squeeze input.
- **rip_pct(edition)** = `pulled_count / mint_cap`.
- **pack_odds(parallel)** = `total_packs ÷ total_count_of_that_parallel_across_players` → "1:N packs".
- **fotl_packs_ripped_pct** = derived from FOTL-exclusive pulls ÷ FOTL pack count.
