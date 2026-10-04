# Flowty wallet export

Flowty shut down in 2026. Its web client read every user's activity from its own event index
(Firestore project `flowty-prod`), and that index is still publicly readable. `flowty_export.py`
turns it into CSVs for any set of wallets: trades (storefront listings and accepted offers), loans,
rentals, listings created (sale / loan request / rental, with outcome), offers made, plus every raw event. Each row has the transaction hash and time, back to
Flowty's launch in 2022, including the years before 2023-11-08 that Flow's public history nodes
no longer serve.

```
FLOWTY_FIREBASE_KEY=<key> python3 scripts/flowty-export/flowty_export.py OUT_DIR 0xWALLET [0xWALLET ...] [--names] [--verify]
```

- Pass **every** wallet the person used (Dapper and Flow wallets) in one run so trades between
  them are attributed once.
- `FLOWTY_FIREBASE_KEY`: the public Firebase web API key in Flowty's archived web bundle
  (`main.*.js` on the Wayback Machine, next to `projectId:"flowty-prod"`).
- `--names` fills NFT title/set/serial from `api2.flowty.io/nft` (one request per NFT).
- `--verify` re-reads post-2023-11-08 trade transactions on Flow's history nodes
  (`access-001.mainnet24..27.nodes.onflow.org:8070`, then `rest-mainnet.onflow.org`).
- Each query's page walk must equal the server-side count, or the run stops: no partial export.
- Standard library only; times written in America/Los_Angeles.

Measured on one 3-wallet export (2026-10-03): 7,942 trades, 248 loans, 22 rentals, 1,400 listings, 2,842 offers.
⚠ `--names` uses Flowty's card titles, which are WRONG for some Top Shot moments (164 of 5,788 checked: `TopShot #<id>`
placeholders, play-type suffixes, the id in the serial field). For Top Shot / All Day prefer names from the chain
(`scripts/flow-checkpoint/decode_topshot_meta.py`, `decode_allday_meta.py`) joined to `editions`.
That matched a separate on-chain walk plus spork-snapshot reconstruction everywhere both covered.
Known gaps: Flowty's index is missing 2 loan repayments from the 2025-12-29 network upgrade (the
loan shows `NO END EVENT`; check the chain) and a few trades (5 of ~7,950 in that export).
Background and controls: `docs/reference/apis-and-cadence.md` ("Flowty's own event index").
