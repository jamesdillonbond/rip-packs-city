# Pinnacle Pack EV — MEASURED finding (do NOT ship the handoff's uniform-EV method)

Date: 2026-07-01 (Claude Code, from the "do everything you can" pass over `docs/handoff-2026-07-01-post-audit-remaining-work.md` #5).
Status: **Investigated end-to-end, NOT shipped — by design.** The handoff's proposed EV method is disproven by measurement; the correct method is central pricing logic on a thin, one-drop surface and should have Trevor's review before shipping.

## TL;DR

- The odds/EV source (`searchDistributions` GQL, studio-platform, no secret) **works and is confirmed** — reachable from egress, Pinnacle typename `A.edf9df96c92f4595.PackNFT.NFT`, `editionIds` map 1:1 to `pinnacle_catalog.edition_id`, `pinnacle_catalog.fmv_usd` per edition.
- **The handoff's "uniform average of editionIds when `packOdds` is empty" method produces GARBAGE** and must not be shipped: it reports a **$4.99 pack with EV $2,651 (value_ratio 531×)**, $4.99/188×, $4.99/111×, $99.99/11.6×. It reads actively-misleading "fake deals" — the exact class the whole repo guards against.
- Root cause: Pinnacle's `searchDistributions` "distributions" are **rarity FACETS of a single pack, not separately-buyable packs**, and the true per-facet odds are **not exposed** (`packOdds` is `[]` on every Pinnacle distribution). Uniform-averaging over a 4-edition pool of ultra-thin rare parallels (mint 1–25, FMV $500–$4,500, some ASK_ONLY-inflated) yields nonsense.
- **A supply-weighted odds-reconstruction model IS viable and I validated it live**: `P(facet) ∝ facet total_supply`, grouped by parent pack → the $4.99 Standard pack EV ≈ **$27.87 (5.6×)**, which is sane (rare tail drives EV at <1% odds). But that is a genuine pricing model (parent grouping + odds inference) = review-gated, and Pinnacle has had **exactly one pack drop ever** ("Summer Splash", mostly sold out).

## What was confirmed (reusable when a build is greenlit)

GQL: `POST https://api.production.studio-platform.dapperlabs.com/graphql`, header `Origin: https://disneypinnacle.com` (same path the green pinnacle-catalog crons use; reachable from Vercel egress + local, NOT WAF-blocked).

```graphql
query($first:Int,$after:String){
  searchDistributions(input:{first:$first,after:$after,sortBy:CREATED_AT_DESC}){
    totalCount pageInfo{endCursor hasNextPage}
    edges{node{ uuid id title state packType numberOfPackSlots
      totalSupply availableSupply price{value currency}
      packOdds{tier value displayValue} editionIds packNftTypename }}}}
```

Facts:
- `byPackNftTypename` filter is BROKEN for Pinnacle (returns 0). Page unfiltered (`CREATED_AT_DESC`) and client-filter `packNftTypename === 'A.edf9df96c92f4595.PackNFT.NFT'`. `totalCount` ≈ 8,698 (mostly Top Shot); Pinnacle = **8 unique distributions with a pool** (dedup on `uuid`; the raw scan shows ~18 due to pagination overlap). Skip `[OLD]`/`totalSupply=0`/`editionIds=[]`.
- `packOdds` is `[]` on ALL Pinnacle distributions → no exposed odds.
- The single drop = **"Summer Splash"**: `Premium` ($99.99, 3 slots, sold out), `Legendary` ($499, 3 slots, sold out), and the `$4.99 Standard` pack split into facets `LE Standard` / `LE Chasers` / `Apex` / `Quinova` / `Xenith` / `Quartis` (the parallels). Only the $4.99 Standard facets are still buyable (avail>0).

## The two models, measured (2026-07-01, live `pinnacle_catalog`)

Uniform (handoff's proposed method) — **GARBAGE**:

| facet | price | slots | avg_fmv | EV | value_ratio |
|---|---|---|---|---|---|
| Legendary | $499 | 3 | $342 | $1,027 | 2.06× |
| Premium | $99.99 | 3 | $386 | $1,159 | 11.6× |
| LE Chasers | $4.99 | 1 | $39.91 | $39.91 | **8.0×** |
| LE Standard | $4.99 | 1 | $9.84 | $9.84 | 1.97× |
| Quartis | $4.99 | 1 | $553 | $553 | **111×** |
| Quinova | $4.99 | 1 | $2,651 | $2,651 | **531×** |
| Xenith | $4.99 | 1 | $938 | $938 | **188×** |

Supply-weighted reconstruction for the **$4.99 Standard pack** (P(facet) ∝ facet `total_supply`; grouped) — **SANE**:

| facet | supply | P(odds) | facet_avg_fmv | EV contribution |
|---|---|---|---|---|
| LE Standard | 2115 | 85.5% | $9.84 | $8.41 |
| LE Chasers | 321 | 12.97% | $39.91 | $5.18 |
| Quartis | 23 | 0.93% | $553 | $5.14 |
| Xenith | 10 | 0.40% | $938 | $3.79 |
| Quinova | 5 | 0.20% | $2,651 | $5.36 |
| Apex | 1 | 0.04% | NO_DATA | — |
| **Total EV** | | | | **≈ $27.87 → 5.6× vs $4.99** |

The rare tail (Quinova/Xenith/Quartis) contributes ~$14 of the $27.87 EV despite <2% combined odds — economically correct for a chase-parallel pack, and high-variance (sensitive to thin ASK_ONLY/low-sales parallel FMV).

## Recommendation (for Trevor to greenlight, not autonomous)

If/when Pinnacle Pack EV is wanted:
1. **Use the supply-weighted model, NOT uniform.** Group `searchDistributions` facets into the parent pack by shared `title` prefix (`"Summer Splash - Standard - *"`) + shared `price`; `P(facet) ∝ facet total_supply`; `EV = Σ P(facet) × avg_fmv(facet) × slots`.
2. For the multi-rarity 3-slot packs (Premium/Legendary — single distribution, 27/53 mixed-rarity editions, NOT facet-split), reconstruct per-edition odds from mint scarcity (`P(edition) ∝ 1/total_minted` or ∝ available), since there's no facet split to supply-weight.
3. Flag EV `low_confidence` when the pool leans on ASK_ONLY / `fmv_sales_count_30d < N` parallels (mirror the existing thin-FMV deal guard).
4. **Only one drop exists and it's ~sold out**, so payoff is thin today; the pipeline's value is auto-coverage of the NEXT Pinnacle drop. Reasonable to defer until Pinnacle drops packs again.

**Do NOT** wire a uniform-EV Pinnacle pack surface. It would publish 531× "value ratios" — misleading, and reputationally worse than no coverage.
