# Flow execution-state checkpoint tools (pre-2023-11-08 history without Dune)

Flow publishes the full ledger at every spork root in the public bucket
`gs://flow-genesis-bootstrap/mainnet-NN-execution/public-root-information/root.checkpoint*`
(mainnet-20…24: 16 parts, 193–339 GB; 1–19: one file). mainnet-15 (2021-12) onward is atree storage; mainnet-6…14
(2021-03…10) is the older one-register-per-value format (`decode_old_wallet.py`); mainnet-1…5 parse fine.
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
| `decode_old_wallet.py <dir> <owner_hex> <out.json>` | holdings in the PRE-atree format (mainnet-6..14, 2021-03..10): reads each collection register's `ownedNFTs` key array (authoritative; standalone `…/ownedNFTs/<id>` registers can be empty-value tombstones). Old CBOR uses location `{0:addr,1:name}`. |
| `decode_topshot_meta.py [--merge] <dir>...` | Top Shot moment id → setID/playID/serial (atree: follows the `data` slab ref to `TopShot.MomentData`; pre-atree: adjacent fields). Join `set:play` to `editions.external_id` for names (90/90 agree with known names). |
| `decode_allday_meta.py` | All Day moment id → editionID/serial; join `editions.external_id` (611/625 agree with known names; rest are suffix spellings). |
| `ckpt_find.py <url> <ids.json> <out> <start> <end>` | which ACCOUNT holds given Top Shot / All Day ids in a checkpoint part (any owner): matches `"id": UInt64(n)`, walks back to the payload's owner, keeps payloads naming the contract. |
| `match_purchases.py [out.csv]` | moments that entered a wallet between snapshots × purchased Flowty listings (expects `w{spork}_{owner}.json` and `L{spork}/` in cwd) |

Atree field order inside a composite VARIES (e.g. `data` before `id`) — search both sides of an anchor field, never one.
Run a full checkpoint as 16 parallel processes (one per part, or 16 byte ranges of a single file):
~20 min for mainnet-24 (334 GB) from a cloud sandbox. Validations and the leaf-payload layout:
`docs/reference/apis-and-cadence.md` ("STATE below the floor is free and public").
