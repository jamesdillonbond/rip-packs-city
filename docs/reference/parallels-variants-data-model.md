# Parallels & Variants — the three collection models (reference)

Established 2026-06-23 (Cowork, live-DB verified). How each collection represents the "same play/character, different printing" concept. **Key takeaway: all three are de-conflated — each printing is an independently-keyed, independently-priced edition/render. Only Top Shot needed engineering to get there (the `::subID` work); All Day and Pinnacle are de-conflated by their native data model.**

## Top Shot — `::subID` parallels on the base play

- **Keying:** base edition `external_id = setID:playID` (e.g. `233:8121`); each parallel is a distinct edition `setID:playID::subID` (e.g. `233:8121::19` = Hexwave). The base ("Standard") has no `::`.
- **Parallel names (19, from `topshot_ipfs_assets.parallel`):** Base, Astra, Bit, Blockchain, Bubbled, Club Collection, Coded, Diced, Explosion, Galactic, Halftone, Hardcourt, Hexwave, Jukebox, Omega, Rippled, Torn, Vibe, Vortex. The on-chain subID→name map comes from `TopShot.getAllSubeditions()` (19=Hexwave, 20=Jukebox, …, 22=Omega).
- **History:** TS ingest originally conflated parallel sales onto the BASE edition (one blended price). The 2026-06-20/21 program split them — cataloged 1,374 `::` editions, remapped sales/wmc/moments, per-parallel circulation + FMV. This is why TS has a `topshot_moment_subeditions` table and the conflation guards.
- **Art:** the `::` parallels' canonical art is **IPFS** (`ipfs.dapperlabs.com/ipfs/<cid>`); base-edition thumbnails recovered to IPFS 2026-06-23 (`audit_20260623_recover_ts_base_thumbnails_from_ipfs`, parallel='Base' hero_cid).

## NFL All Day — parallels as distinct `(Parallel)` sets

- **Keying:** parallels are **separate sets** with a `(Parallel)` suffix in `set_name` (e.g. `Wild Card Weekend Gold (Parallel)`, `Super Bowl LX Icon (Parallel)`). Each parallel edition has its own numeric `external_id`, `circulation_count`, and FMV. **No `::subID`** (verified: 0 AllDay editions carry `::`).
- **Scale:** 17 distinct `(Parallel)` set families · 912 parallel editions · 461 priced. All AllDay editions are `edition_kind = 'LE'`.
- **De-conflation:** inherent — because each parallel is a distinct set/edition row, sales never blend across printings. No remap work was ever needed (unlike TS).
- **Scarcity board handling:** `allday_scarcity_board` families = `(set_name, tier)`, so each `(Parallel)` set is its own family — a parallel edition is ranked against its parallel-set siblings. Correct.

## Disney Pinnacle — `variant` per render

- **Keying:** the catalog (`pinnacle_catalog`) is keyed by `render_id`; each render carries a `variant`. There is **one row per (character × set × variant)** — no base/parallel suffix, no `::`. `parallel_type` is unused (NULL); `variant` is the field.
- **Variants (15):** Standard + Apex, Brushed Silver, Color Splash, Colored Enamel, Digital Display, Embellished Enamel, Genesis, Golden, Luxe Marble, Quartis, Quinova, Radiant Chrome, Silver Sparkle, Xenith. Distribution: 667 Standard renders · 1,605 special-variant renders · 118 chasers (`is_chaser`).
- **De-conflation (verified):** per-variant FMV is independent. Example — *74-Z Speeder Bike* (Star Wars Vehicles Vol.2): Standard $2.04 (mint 396) · Golden $14 (145) · Silver Sparkle $22.50 (207) · Digital Display $27 (145). A ~13× Standard→premium spread, each priced on its own sales/floor.
- **Scarcity board handling:** `pinnacle_scarcity_board` families = `variant` (a render ranked vs all renders of the same variant, across sets). That's the established design.

## Implications / status

- **FMV correctness:** all three are priced per-printing today. No conflation outstanding on any collection. (TS's conflation guards remain as a tripwire; AllDay/Pinnacle never needed them.)
- **ASK_ONLY parity (shipped 2026-06-23):** floor×0.90 ≤$10k applies per-edition (AllDay) and per-render (Pinnacle), so a scarce parallel/variant with a live floor gets its own ASK_ONLY price.
- **Scarcity boards:** TS = squeeze (lock/burn); AllDay = `allday_scarcity_board` (set+tier family); Pinnacle = `pinnacle_scarcity_board` (variant family). Each uses the collection's natural comparable cohort.
- **Serial-FMV / special serials:** TS-only. AllDay serial capture is sparse (`allday_moment_serials` ~64 rows) → data-gated. Pinnacle has no serial axis (render-keyed art).
