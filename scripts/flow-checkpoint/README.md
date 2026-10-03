# Flow execution-state checkpoint tools (pre-2023-11-08 history without Dune)

Flow publishes the full ledger at every spork root in the public bucket
`gs://flow-genesis-bootstrap/mainnet-NN-execution/public-root-information/root.checkpoint*`
(mainnet-20…24: 16 parts, 193–339 GB; 17–19: one file; 16 and older predate atree storage).
These scripts stream a checkpoint over HTTP Range requests (nothing is stored but matching
payloads) and decode Cadence storage. No events — STATE only — but contracts that keep their
records (Flowty Funding / storefront listings, NFT collections) are fully recoverable.

| script | does |
|---|---|
| `ckpt_extract.py <url> <out.jsonl> [start] [end]` | every payload OWNED by the target addresses (`CKPT_OWNERS=hex,hex` env overrides defaults). Handles 2-part (mainnet-19+) and 3-part (17/18) register keys. |
| `ckpt_listings.py <url> <out.jsonl>` | every Flowty `NFTStorefrontV2.ListingDetails` in the ledger, any owner (seller, nft, price, purchased). |
| `decode_fundings.py "<dir>/*.jsonl" <out.csv>` | `Flowty.Funding` → lender / borrower addresses (from the raw `access(contract)` capabilities) |
| `decode_flags.py <dir> <out.json>` | funding id → (repaid, settled) at that snapshot |
| `decode_wallet.py <dir> <owner_hex> <out.json>` | an account's NFT ids per collection + storefront listings |
| `decode_rentals.py <dir> <out.json>` | `FlowtyRentals.Rental` → renter / owner, returned / settled, start, term, fee, deposit, NFT (rentals persist with flags, so every snapshot carries the whole book: 586 at mainnet-24) |
| `match_purchases.py [out.csv]` | moments that entered a wallet between snapshots × purchased Flowty listings (expects `w{spork}_{owner}.json` and `L{spork}/` in cwd) |

Run a full checkpoint as 16 parallel processes (one per part, or 16 byte ranges of a single file):
~20 min for mainnet-24 (334 GB) from a cloud sandbox. Validations and the leaf-payload layout:
`docs/reference/apis-and-cadence.md` ("STATE below the floor is free and public").
