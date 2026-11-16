# Wallet search could answer in ~1–2 s instead of 7–15 s by reading moment metadata from our own cache — but the cache names and counts differ from the chain, so it is a product call (needs Trevor; NOT changed)

Filed 2026-11-15 ~4:58 PM PT by Claude Code cloud (autonomous pass). Measurements only; no behaviour changed by this filing.

## The numbers

- Per-stage timing (new `[wallet-search] timing` line, deploy `95b3f0fc8`), 6 uncached searches: total 7.5–15.0 s; **`enrich_moments` 6.0–12.8 s** (one Flow chain script per moment, 8 at a time), `fetch_owned_ids` 0.8–4.5 s (on-chain ID list); fill, FMV and acquisitions 0.1–1.5 s.
- `wallet_moments_cache` already holds player, team, set, series, serial, circulation and set/play ids for walked wallets. Compared field by field with production's chain-sourced rows (264 rows, 11 wallets): **127 / 264 identical; 214 / 264 identical once circulation is excluded.**
- The 50 identity differences are mostly the cache being the site's canonical spelling: "Steph Curry" (chain "Stephen Curry"), "KJ Martin" ("Kenyon Martin Jr."), "Jimmy Butler III" ("Jimmy Butler"), "Las Vegas Aces" ("Aces"), and a team moment "Houston Rockets" where the chain gives no name ("Unknown (error loading)").
- Circulation: the chain's `numMomentsInEdition` vs the cache's `mint_count` (e.g. 4,099 vs 4,000; one Jimmy Butler moment 16,000 vs 4,000).

## The decision

Reading the cache first (chain only for moments the cache lacks) would make the product's core action several times faster and make names match the rest of the site, but a collector would see different circulation numbers than today on ~half the rows. Which circulation is right for "#/N" (chain edition count now vs the cache's) should be settled first; the names are arguably a fix. Not shipped.

Already shipped tonight on this path: the failure branch now normalises "Base Set6" (ledger ~4:51 PM PT); a dead-host breaker for the GraphQL leg (no latency change, measured; ledger ~4:22 PM PT).
