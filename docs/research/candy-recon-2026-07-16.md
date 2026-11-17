# Candy Digital recon — 2026-07-16 (drop-delay window)

Trevor-directed sweep of Candy's public surfaces (candy.io, blog, X, checklist sheet, JS bundles) during the Drop-1 delay. Read-only; no account created, no auth probed. Complements [candy-audit-final-2026-07-08.md](../audits/candy-audit-final-2026-07-08.md) — this doc captures what changed since + product/feature detail the audit didn't need.

## 1. Drop status (as of 2026-07-16 morning PT)

- **Delay is official on X** (@CandyDigital, ~17-18h ago): "2026 MLB Base Series Drop Update: We are experiencing a delay on the drop time… we work to get the drop live on candy.io" + follow-up "We will be setting a new drop time and it will be announced prior." **No new date yet.** A same-day hype tweet ("Rainbow Variant ICONs are stuffed in today's… packs") confirms they intended to ship Jul 15.
- **Nothing on the blog** (newest post still Jul 8) — X/Discord are the fast channels; the daily `candy-solana-launch-watch` covers candy.io+blog+ME, and X checks are worth adding manually when the watch fires.
- **candy.io is actively deploying**: two Vercel deploys observed serving concurrently during the sweep — `dpl_5FgLcANa…` still ships the July-15-branded hero (`header_hero_1x1_j15.png`), newer `dpl_AX9sQumU…` swapped to a generic "New drops, Coming Soon" hero. They're iterating toward relaunch in real time.

## 2. Drop 1 mechanics (Jul 8 blog + X, supersedes Jun 17 where they conflict)

| Item | Value |
|---|---|
| Price | $10/pack + sales tax + **minting fees** (+card processing) |
| Contents | 10 ICONs/pack, Cores only |
| Drop 1 supply | 500 packs |
| Total 2026 Base Series | **2,500 packs (Jul 8)** — Jun 17 post said 9,990; scope was cut ~4x between posts |
| Txn limit | 10 packs/txn, **no cooldown** |
| Core mint count | /250 per player |
| Rainbow inserts | /15 per color per player; 5 players (Skenes, Trout, Murakami, Witt Jr., Caminero); 5 colors (Orange/Yellow/Green/Blue/Pink); **15% pull odds (Jul 8 + X)** — Jun 17 said 1-in-16/6.26% |
| Cadence | drops ~every 2 weeks through summer |
| Serials | pack + ICON serials randomized |

- **Checklist (public Google Sheet, CSV-exportable):** 103 rows, all 30 teams, 10 First Mint debuts (Pages, Jung Hoo Lee, Eldridge, Otto Lopez, Soriano, Murakami, DeLauter, McGonigle, Ben Rice, Okamoto), 4 rookies. Sheet: `docs.google.com/spreadsheets/d/e/2PACX-1vREsVZuO9HqIGv07TkeH1dwd3m7juR2cSmI0_gxPAGM7IDwbwuEwblM2LQdRDLL1PuszDti5WDV3QoJ` (`/pub?output=csv`). **This is a ready-made edition-catalog seed** (player+team+parallel structure) for the day we index.
- **Collection Quests** (end when Base Series goes off sale): 100/100 → Ohtani Reward ICON; any 50 → Judge Reward ICON; full 5-color Rainbow per player → Rainbow Reward ICON per set. **"Qualifying ICONs must be held in your Candy.io account at the quest deadline"** — see implications.
- **Diamond Economy:** burn → platform credits (2026 assets 0.50, legacy 0.25, values dynamic per drop/rarity/quest); credits → Gold/Diamond Auctions later ("Rares, Epics, Legendaries" tiers named); credits non-cash, platform-only.

## 3. On-chain shape (Candy's own X thread, Jul 15, retweeted by @metaplex)

> "One on-chain account per ICON / Self-custody in your own @solana wallet / **Traits like Rainbow Insert + First Mint stored on the asset** / Native burning that powers the Diamond Economy"

- Confirms the prebuild's assumptions: Metaplex Core, per-serial asset accounts, attributes on-asset (Rainbow color + First Mint should appear in `content.metadata.attributes` → our TODO_3/4/5 derivations).
- Card backs show **live 2026 stats** (team/position/number "as the season happens") → dynamic off-chain metadata; the Arweave-refresh pipeline need from the Jul 8 audit stands.
- Native Core burn = **`circulation_count` must be treated as decreasing** for Candy editions; burns are on-chain events we can index later.

## 4. Platform/feature surface (FAQ rev. May 2026 + site)

- Wallets: Candy **generates** a self-custody Solana wallet per fan at first login; **external wallet connect is only "being evaluated"** — no timeline. Purchases mint directly to the wallet.
- Payments: credit/debit only (+ platform credits); prices USD.
- Secondary: "supported third-party Solana marketplaces including Magic Eden, with more to be announced" — still future-tense; Candy runs no order book.
- Legacy: non-migrated assets accessible on candy.io through ≥Dec 31 2026; inactive accounts pay $2/mo from Jul 1 2026 and risk asset acquisition/sale after Dec 31 2026 (Jul 1 ToU update tightened "dormant" definitions). Candy Cash → credits (100% bonus) or withdrawal since Jun 16.
- Site tech: Next.js App Router (Turbopack) on Vercel; **data plane is same-origin `/api/*`, login-gated** — only `/api/auth/sign-out` + `/api/balance` appear in public chunks; `/user` (collection browser) redirects to `/login`; legacy `/mlb/editions/<uuid>` URLs catch-all to the landing page pre-drop. **No public catalog/market API — unchanged from the Jul 8 audit; on-chain (Helius DAS) + ME remain our only data path.**

## 5. RPC implications (ranked)

1. **Quest custody rule suppresses early secondary liquidity.** Quests require ICONs held in the Candy.io account until Base Series goes off sale — rational collectors won't list their set pieces on ME during the quest window. Expect the 30-day-sales gate to fill slowly even after trading opens; don't misread thin volume as product failure.
2. **Wallet-paste UX may lag:** users hold Candy-generated wallets; addresses should be visible in Candy's UI (self-custody), but external-wallet connect is unshipped, so verify how easily fans can find their pubkey before designing `wallet-backfill-candy` onboarding copy.
3. **Reward ICONs (Ohtani/Judge/Rainbow rewards) + future Gold/Diamond tiers (Rares/Epics/Legendaries) are distinct edition classes** — the normalize layer's tier mapping should anticipate more than "Core/Rainbow".
4. **Burns shrink supply** — plan for decreasing circulation_count + a burn-event lane (Core native burn) when the ingest goes live.
5. **Checklist sheet = catalog pre-seed** — player/team/parallel matrix known ahead of any on-chain data.
6. **Discrepancies to not trip on:** 2,500 (not 9,990) total packs; 15% (not 6.26%) Rainbow odds — Jul 8 + X figures govern.

## Open items

- New drop date: unannounced; X will carry it first ("announced prior"). Daily watch covers site/blog/ME; check X when it fires.
- Helius secrets (Trevor) remain the only RPC-side blocker to same-day discovery.
