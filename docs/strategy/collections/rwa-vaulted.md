# RWA Vaulted — collection roadmap (refreshed 2026-10-17, PT)
> Dated snapshot; every number is a dated sample — re-derive before quoting. Canonical plan: [roadmap-2026-10-17.md](../roadmap-2026-10-17.md). Defects: [known-issues.md](../../reference/known-issues.md) (item text wins over this file).

## Where it stands
**A reserved placeholder slot with nothing behind it: no data, no lanes and no product.** It is the 8th entry in [lib/collections.ts](../../../lib/collections.ts):
- `id: "rwa"`, label "RWA Vaulted", `chain: "rwa"`, `dbChain: null`, partner "Courtyard / Beezie"
- `pages: overview, collection, sniper, vault`, `published: false`
- pitch: "Reserved for real-world-asset vaulted card coverage."

What renders today:
- **Signed in:** the layout's "Coming Soon" shell, with a "Back to NBA Top Shot" button.
- **Anonymous:** `rwa` is absent from the anon allowlists in [proxy.ts](../../../proxy.ts), so anonymous readers are gated.
- It stays out of the sitemap, SEO and the chain badge, because all of those filter on `published`.

Live reads, ~6:00 PM PT 10-17:
- No `collections` row for RWA (7 rows exist).
- No `rwa` / `courtyard` tables, and no pg_cron job or `pipeline_runs` lane.
- The one related row, `evm_nft_contracts` id 1 `beezie_collectibles` (Base, chain 8453), is `is_active=false`.
- **There is no `vault` route** under `app/(collections)/[collection]/`, so that registry tab points at nothing.

## Shipped recently (since mid-September)
Nothing for RWA. The only change that touched it: on 10-10 the collection ticker stopped falling back to Top Shot's copy for a collection with no list of its own. The code comment names `rwa` ([components/collection-chrome.tsx](../../../components/collection-chrome.tsx)). The `PopularOnCollection` test also uses `rwa` as its "outside the facade" control.

## Open issues
- **The `pitch` and `partner` fields make claims nothing backs.**
  - Beezie is **retired** ([chain-strategy.md](../../reference/chain-strategy.md), Flow EVM section). Its Base plane holds no active contract.
  - No Courtyard ingest exists, and no doc evaluates one.
  - The fields render only on the Coming Soon shell and the banner, so the blast radius is small. They are still claims.
- **`"vault"` and `"sniper"` sit in `pages` with no backing.** `vault` has no route. A sniper is a deal-finder on a venue we do not index.
- **`chain: "rwa"` is a registry-only chain value.** It has no `chain_type` enum member and no [lib/address.ts](../../../lib/address.ts) arm. Any code that dispatches on `chain` needs a defined answer for it. `dbChain: null` is the established "not established" value.

## Next — prioritized

✅ **DECIDED 2026-10-17 (Trevor): "RWA can be a future add, but not right now."** The slot stays unpublished. No work is scheduled.

**Now**
- Nothing. The partner label no longer names Courtyard / Beezie: it reads "Real-world assets" (`lib/collections.ts`), because the signed-in "Coming Soon" banner rendered it.

**Next**
- Nothing until Trevor scopes it.

**Later**
- **When it is scoped:** evaluate one RWA source against the multi-chain thesis, and name the partner then.
  - *Precondition:* the accuracy gate is met on the existing collections.
  - *Falsifier:* no free, verifiable sales or ownership source exists.

## Decisions on record (do not re-litigate)
- **Beezie/Base is parked, then retired**, for want of a product consumer ([roadmap-2026-07-18](../roadmap-2026-07-18.md); [chain-strategy.md](../../reference/chain-strategy.md)). Its `evm-transfers-ingest` trigger was disabled 08-02. The live `evm-transfers-ingest` lane now serves **Flow EVM Top Shot**, not RWA.
- **Accuracy is the gate.** No new collection ships ahead of the existing ones beating the incumbents ([roadmap-2026-08-03](../roadmap-2026-08-03.md)).
- **Read-only product:** there is no vault, custody or redemption action to offer.

## Needs Trevor

- Nothing now. He decided 10-17: a future add, not now.

## Where the detail lives
- [lib/collections.ts](../../../lib/collections.ts) (the entry and `publishedCollections()`)
- [app/(collections)/[collection]/layout.tsx](../../../app/(collections)/[collection]/layout.tsx) (the Coming Soon branch)
- [chain-strategy.md](../../reference/chain-strategy.md) (Beezie/Base, Flow EVM)
- [multi-chain-thesis-2026-05-30.md](../multi-chain-thesis-2026-05-30.md)
