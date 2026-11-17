# Hybrid Custody CapabilityFilter withdraw probe — Task 1 live capability result

**Date:** 2026-07-13 · **Author:** Claude Code (interactive) · **Type:** on-chain read-only probe

## Question

Does Dapper's Hybrid Custody `CapabilityFilter` on a Top Shot account-link **allowlist the
`A.0b2a3299cc857e29.TopShot.Collection` Provider (withdraw) capability to the parent** — i.e. is
account-linked gifting/transfer on-chain-executable, or can RPC only observe-and-orchestrate?

This is **not** answerable from `linked_accounts` / `wallet_links`: those record link existence,
restricted-vs-owned, and last-event tx, but **not the filter contents or the withdraw entitlement**.
That gap is on-chain only.

## Answer: **TRUE** — withdraw is filter-allowed AND end-to-end resolvable.

Every moment-holding pair in `linked_accounts` is `relationship='restricted'` (filter-gated Hybrid
Custody, not unrestricted `owned`). The probe tests what that restriction actually permits.

## Pairs tested (both live-active, from the corrected precondition)

| Role | Parent | Child | TS moments |
|---|---|---|---|
| PRIMARY | `0xaa40b06e5c62d145` | `0xf0b0962e08150ca3` | 13,445 |
| REFERENCE | `0xecb483dc2eb0698d` | `0xb15fc4893980c527` | 13,396 |

(Trevor's `0xbd94cade097e50ac` is **not** in `linked_accounts` — not used, per corrected precondition.)

## Result (identical for both pairs)

- **Filter type:** `A.d8a7e05a7ac670c0.CapabilityFilter.AllowlistFilter` (an allowlist, not deny/allow-all)
- **`allowed_count`:** 54 collection types
- **`A.0b2a3299cc857e29.TopShot.Collection` → present in allowlist ⇒ `topshot_allowed = true`**
- All four published RPC-Flow collections are allowlisted:
  - `A.0b2a3299cc857e29.TopShot.Collection` — **true**
  - `A.e4cf4bdc1751c65d.AllDay.Collection` — **true**
  - `A.87ca73a41bb50ad5.Golazos.Collection` — **true**
  - `A.329feb3ab062d289.UFC_NFT.Collection` — **true**
  - (`A.edf9df96c92f4595.Pinnacle` is **NOT** in the list — Pinnacle is not gift-linkable under this filter.)

### End-to-end resolution (the strong claim, not just the filter)

Reading the filter only proves the *type gate* passes. The full `getCapability` path also requires
(a) a `CapabilityFactory` factory registered for the NFT-Provider type and (b) a live Provider
capability controller on the child's `/storage/MomentCollection`. Verified all three via a
`Manage`-entitled Manager borrow (`getAuthAccount` read-only in a script):

```
num_controllers_on_momentcollection : 8
provider_controller_exists           : true   (controller id 76)
withdraw_cap_resolvable              : true   (filter AND factory both pass)
provider_borrowed                    : true
provider_type                        : A.0b2a3299cc857e29.TopShot.Collection
```

So the parent's `HybridCustody.Manager` resolves a **working
`auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}`** that borrows to the child's real
Top Shot collection. A transaction *signed by the parent* can withdraw/transfer the child's moments.

## What "RPC-executable" means precisely (honesty caveat)

The **on-chain filter + capability graph permits** account-linked withdrawal today. Execution still
requires a signature from the parent account (the user's Dapper-linked parent). RPC does not custody
user keys, so "executable" = RPC can construct the exact valid transaction for the user's parent
wallet to sign (FCL), or execute directly only where RPC controls the parent. The binary the probe
asked — *does the filter allowlist the Provider* — is **yes**, and the capability is live-resolvable
(not a dead controller / missing factory).

## Method / provenance (per CLAUDE.md rules)

- **Contract signatures verified via Cadence MCP before writing any script** (`HybridCustody`,
  `CapabilityFilter`, `NFTProviderFactory` at `0xd8a7e05a7ac670c0`). Key API:
  `ManagerPublic.borrowAccountPublic(addr) → &{AccountPublic}`; `AccountPublic.getCapabilityFilter()
  → &{CapabilityFilter.Filter}?`; `Filter.getDetails()` returns `{type, allowedTypes}` for an
  AllowlistFilter; `AccountPrivate.getCapability(controllerID, type)` gates on
  `filter.allowed(cap) && managerFilter?.allowed(cap)`; factory requires
  `auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}`.
- **Authoritative reads ran through the `hybrid-custody-proxy` worker** (`POST /script`,
  base64 Cadence, Bearer auth) — never direct to a Flow endpoint, proxy secret never echoed. Both
  the filter read and the full withdraw-resolution deep-check returned HTTP 200 through the proxy.
- **Filter contents read live from current chain state** rather than reconstructed from the
  reference redeem tx `e3cf0160…506b51`. The live installed filter *is* what that redeem tx set up,
  and is strictly more authoritative than parsing the historical setup tx; the proxy also exposes
  only `/events` `/script` `/head` (no tx-lookup route), so staying on-proxy meant reading live state.
- **No withdraw was executed.** All reads are `view`/script-only.

## Reproduce

Read-only Cadence (hardcode the pair, run via `POST /script` on the proxy). Filter read:

```cadence
import HybridCustody from 0xd8a7e05a7ac670c0
import CapabilityFilter from 0xd8a7e05a7ac670c0
access(all) fun main(): {String: AnyStruct} {
    let parent: Address = 0xaa40b06e5c62d145
    let child: Address = 0xf0b0962e08150ca3
    let out: {String: AnyStruct} = {}
    let mgr = getAccount(parent).capabilities
        .get<&{HybridCustody.ManagerPublic}>(HybridCustody.ManagerPublicPath).borrow()!
    let acct = mgr.borrowAccountPublic(addr: child)!
    let filter = acct.getCapabilityFilter()!
    out["filterType"] = filter.getType().identifier
    let d = filter.getDetails() as! {String: AnyStruct}
    if let allowed = d["allowedTypes"] as? [Type] {
        out["allowed_count"] = allowed.length
        out["topshot_allowed"] = allowed.contains(CompositeType("A.0b2a3299cc857e29.TopShot.Collection")!)
    }
    return out
}
```

Withdraw-resolution deep-check (uses `getAuthAccount` for a `Manage`-entitled Manager borrow;
read-only in a script) — see git history of this doc's session for the full body.

## Full 54-type allowlist (both pairs)

YoungBoysBern, **UFC_NFT**, MFLPlayer, FlovatarComponent, InceptionAvatar, RogueBunnies_NFT, Car,
DGD_NFT, AeraNFT, Flunks, Tires, MFLPack, BarterYardClubWerewolf, Bobblz_NFT, MFLClub, Backpack,
CarClub, Seussibles, MintStoreItem, FriendsOfFlow_NFT, DimensionX, Canes_Vault_NFT, TicalUniverse,
Flobot, Helmet, CNN_NFT, Fuchibola_NFT, aiSportsMinter, DriverzNFT, CryptoPiggo, Wheel, Pickem,
NBA_NFT, OpenLockerIncBoneYardHuskyzClub, **Golazos**, RaceDay_NFT, **TopShot**, InceptionBlackBox,
FlowversePass, OpenLockerInc, JollyJokers, **AllDay**, TuneGONFT, Cimelio_NFT, AtlantaHawks_NFT,
NFL_NFT, Costacos_NFT, YBees, FLOAT, Doodles, Flovatar, Gaia, Gamisodes, CryptoPiggoV2.

## Implication for RPC

The gate is open for TopShot/AllDay/Golazos/UFC → **account-linked gifting is on-chain-executable**
(pending a parent signature). Pinnacle is excluded by this filter. Next step is a product/auth
decision on how the parent signature is obtained (FCL flow), not a further on-chain feasibility check.
